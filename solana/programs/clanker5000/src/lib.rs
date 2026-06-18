//! Clanker 5000 — native-Solana settlement core for The Clanker 500.
//!
//! This is the Solana/Anchor port of the project's two EVM settlement
//! contracts:
//!   * `chain/contracts/RaceEscrow.sol` -> the `race_*` instructions below
//!     (two-driver staked race, USDC held in a per-race PDA vault).
//!   * `contracts/RaceMarket.sol`       -> the `*_market` / `place_bet` /
//!     `claim` instructions (parimutuel betting, one-human-one-bet enforced
//!     by a per-nullifier PDA).
//!
//! Token payments use SPL (USDC, 6 decimals) via CPI, replacing the ERC-20
//! `transferFrom`/`permit` flow. On Solana the driver/bettor signs their own
//! transaction, so the EVM "facilitator relays an EIP-712 authorization"
//! pattern collapses into a direct signer — see `docs/SOLANA_PORT.md`.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

// Placeholder program id. Run `anchor keys sync` after the first build to
// replace this with the keypair-derived id (and update Anchor.toml).
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

/// Maximum lanes in a parimutuel market (guard, courier, plus fruit-obstacle
/// lanes for the show). Mirrors the unbounded EVM mapping with a fixed array
/// so account space is deterministic.
pub const MAX_RACERS: usize = 8;

/// Parimutuel payout `floor(amount * total_pool / win_pool)`, computed in u128.
/// A `u64 * u64` product always fits in a `u128`, so this can never overflow.
/// Returns 0 when the winning pool is empty (no winning bets). Pure function so
/// the money math is unit-testable without a validator (see `mod tests`).
pub fn parimutuel_payout(amount: u64, total_pool: u64, win_pool: u64) -> u64 {
    if win_pool == 0 {
        return 0;
    }
    ((amount as u128) * (total_pool as u128) / (win_pool as u128)) as u64
}

#[program]
pub mod clanker5000 {
    use super::*;

    // ----- Race escrow (port of RaceEscrow.sol) -----------------------------

    /// One-time program configuration. `authority` is the operator (the only
    /// key that can rotate the facilitator), mirroring the EVM `operator`.
    pub fn initialize(ctx: Context<Initialize>, facilitator: Pubkey) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.authority = ctx.accounts.authority.key();
        cfg.facilitator = facilitator;
        cfg.treasury = ctx.accounts.treasury_token.key();
        cfg.usdc_mint = ctx.accounts.usdc_mint.key();
        cfg.next_race_id = 0;
        cfg.total_fees_collected = 0;
        cfg.bump = ctx.bumps.config;
        Ok(())
    }

    /// Open a race for `race_id` (must equal the running counter). Facilitator
    /// only. Creates the race account and its USDC vault.
    pub fn open_race(
        ctx: Context<OpenRace>,
        race_id: u64,
        local_round_id: [u8; 32],
        stake_amount: u64,
        fee_amount: u64,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.facilitator.key(),
            ctx.accounts.config.facilitator,
            ClankerError::NotFacilitator
        );
        require!(stake_amount > 0, ClankerError::BadAmount);
        require!(race_id == ctx.accounts.config.next_race_id, ClankerError::BadRaceId);

        let race = &mut ctx.accounts.race;
        race.race_id = race_id;
        race.status = RaceStatus::Created;
        race.local_round_id = local_round_id;
        race.stake_amount = stake_amount;
        race.fee_amount = fee_amount;
        race.vault = ctx.accounts.vault.key();
        race.created_at = Clock::get()?.unix_timestamp;
        race.bump = ctx.bumps.race;

        ctx.accounts.config.next_race_id = race_id
            .checked_add(1)
            .ok_or(ClankerError::Overflow)?;

        emit!(RaceOpened { race_id, local_round_id, stake_amount, fee_amount });
        Ok(())
    }

    /// Join a race in `slot` (0 = challenger, 1 = opponent). The driver signs
    /// directly and funds the stake from their own ATA; the fee goes to the
    /// treasury token account.
    pub fn join_race(
        ctx: Context<JoinRace>,
        _race_id: u64,
        slot: u8,
        stake_amount: u64,
        fee_amount: u64,
    ) -> Result<()> {
        require!(slot <= 1, ClankerError::BadSlot);
        let race = &mut ctx.accounts.race;
        require!(
            race.status == RaceStatus::Created || race.status == RaceStatus::Joined,
            ClankerError::BadState
        );
        require!(
            stake_amount == race.stake_amount && fee_amount == race.fee_amount,
            ClankerError::BadAmount
        );

        let driver = ctx.accounts.driver.key();
        if slot == 0 {
            require!(!race.challenger_joined, ClankerError::AlreadyJoined);
            race.challenger = driver;
            race.challenger_joined = true;
        } else {
            require!(!race.opponent_joined, ClankerError::AlreadyJoined);
            require!(driver != race.challenger, ClankerError::BadDriver);
            race.opponent = driver;
            race.opponent_joined = true;
        }

        // Stake -> vault.
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.driver_token.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.driver.to_account_info(),
                },
            ),
            stake_amount,
        )?;

        // Fee -> treasury.
        if fee_amount > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.driver_token.to_account_info(),
                        to: ctx.accounts.treasury_token.to_account_info(),
                        authority: ctx.accounts.driver.to_account_info(),
                    },
                ),
                fee_amount,
            )?;
            race.fees_collected = race.fees_collected.saturating_add(fee_amount);
            ctx.accounts.config.total_fees_collected = ctx
                .accounts
                .config
                .total_fees_collected
                .saturating_add(fee_amount);
        }

        if race.challenger_joined && race.opponent_joined {
            race.status = RaceStatus::Joined;
        }

        emit!(RaceJoined { race_id: race.race_id, driver, slot, stake_amount, fee_amount });
        Ok(())
    }

    pub fn lock_race(ctx: Context<FacilitatorRace>, _race_id: u64) -> Result<()> {
        let race = &mut ctx.accounts.race;
        require!(
            race.status == RaceStatus::Joined
                && race.challenger_joined
                && race.opponent_joined,
            ClankerError::BadState
        );
        race.status = RaceStatus::Locked;
        race.locked_at = Clock::get()?.unix_timestamp;
        emit!(RaceLocked { race_id: race.race_id });
        Ok(())
    }

    pub fn start_race(ctx: Context<FacilitatorRace>, _race_id: u64) -> Result<()> {
        let race = &mut ctx.accounts.race;
        require!(race.status == RaceStatus::Locked, ClankerError::BadState);
        race.status = RaceStatus::Started;
        race.started_at = Clock::get()?.unix_timestamp;
        emit!(RaceStarted { race_id: race.race_id });
        Ok(())
    }

    pub fn finish_race(
        ctx: Context<FacilitatorRace>,
        _race_id: u64,
        winner_slot: u8,
        proof_hash: [u8; 32],
    ) -> Result<()> {
        require!(winner_slot <= 1, ClankerError::BadSlot);
        let race = &mut ctx.accounts.race;
        require!(race.status == RaceStatus::Started, ClankerError::BadState);
        race.status = RaceStatus::Finished;
        race.winner_slot = winner_slot;
        race.proof_hash = proof_hash;
        race.finished_at = Clock::get()?.unix_timestamp;
        emit!(RaceFinished { race_id: race.race_id, winner_slot, proof_hash });
        Ok(())
    }

    /// Pay the full 2x stake to the winner. `winner_token` must be owned by the
    /// winning slot's driver.
    pub fn settle_race(ctx: Context<SettleRace>, _race_id: u64) -> Result<()> {
        let race = &mut ctx.accounts.race;
        require!(race.status == RaceStatus::Finished, ClankerError::BadState);

        let winner = if race.winner_slot == 0 { race.challenger } else { race.opponent };
        require_keys_eq!(ctx.accounts.winner_token.owner, winner, ClankerError::BadDriver);

        let payout = race
            .stake_amount
            .checked_mul(2)
            .ok_or(ClankerError::Overflow)?;
        race.status = RaceStatus::Settled;

        let bump = ctx.bumps.vault_authority;
        let signer: &[&[&[u8]]] = &[&[VAULT_AUTH_SEED, &[bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.winner_token.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer,
            ),
            payout,
        )?;

        emit!(RaceSettled { race_id: race.race_id, winner, payout });
        Ok(())
    }

    /// Refund staked drivers and void the race. `challenger_token`/
    /// `opponent_token` must be owned by the respective drivers.
    pub fn cancel_race(ctx: Context<CancelRace>, _race_id: u64, reason: String) -> Result<()> {
        let race = &mut ctx.accounts.race;
        require!(
            matches!(race.status, RaceStatus::Created | RaceStatus::Joined | RaceStatus::Locked | RaceStatus::Started),
            ClankerError::BadState
        );
        race.status = RaceStatus::Canceled;

        let bump = ctx.bumps.vault_authority;
        let signer: &[&[&[u8]]] = &[&[VAULT_AUTH_SEED, &[bump]]];

        if race.challenger_joined && race.stake_amount > 0 {
            require_keys_eq!(
                ctx.accounts.challenger_token.owner,
                race.challenger,
                ClankerError::BadDriver
            );
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.challenger_token.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                    },
                    signer,
                ),
                race.stake_amount,
            )?;
        }
        if race.opponent_joined && race.stake_amount > 0 {
            require_keys_eq!(
                ctx.accounts.opponent_token.owner,
                race.opponent,
                ClankerError::BadDriver
            );
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.opponent_token.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                    },
                    signer,
                ),
                race.stake_amount,
            )?;
        }

        emit!(RaceCanceled { race_id: race.race_id, reason });
        Ok(())
    }

    pub fn set_facilitator(ctx: Context<OperatorOnly>, facilitator: Pubkey) -> Result<()> {
        ctx.accounts.config.facilitator = facilitator;
        emit!(FacilitatorChanged { facilitator });
        Ok(())
    }

    // ----- Parimutuel market (port of RaceMarket.sol) -----------------------

    /// Open a parimutuel market. The signer becomes the judge (the guard
    /// robot's wallet that attests the finish); `operator` is the Ledger-
    /// governed key allowed to rotate the judge.
    pub fn open_market(
        ctx: Context<OpenMarket>,
        market_id: u64,
        num_racers: u8,
        operator: Pubkey,
    ) -> Result<()> {
        require!(num_racers as usize <= MAX_RACERS && num_racers > 0, ClankerError::BadRacerCount);
        let m = &mut ctx.accounts.market;
        m.market_id = market_id;
        m.judge = ctx.accounts.judge.key();
        m.operator = operator;
        m.usdc_mint = ctx.accounts.usdc_mint.key();
        m.open = true;
        m.settled = false;
        m.winner = 0;
        m.num_racers = num_racers;
        m.pools = [0u64; MAX_RACERS];
        m.total_pool = 0;
        m.vault = ctx.accounts.vault.key();
        m.settled_at = 0;
        m.winning_proof_hash = [0u8; 32];
        m.walrus_blob_id = String::new();
        m.bump = ctx.bumps.market;
        emit!(MarketOpened { market_id, num_racers });
        Ok(())
    }

    /// Place a single bet. One bet per bettor (enforced by the `bet` PDA) and
    /// one bet per human (enforced by the `nullifier` PDA — a reused World ID
    /// nullifier collides on an already-initialized account and fails).
    pub fn place_bet(
        ctx: Context<PlaceBet>,
        _market_id: u64,
        racer: u8,
        amount: u64,
        world_nullifier: [u8; 32],
    ) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.open && !m.settled, ClankerError::MarketClosed);
        require!(racer < m.num_racers, ClankerError::BadRacer);
        require!(amount > 0, ClankerError::BadAmount);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.bettor_token.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.bettor.to_account_info(),
                },
            ),
            amount,
        )?;

        let bet = &mut ctx.accounts.bet;
        bet.market = m.key();
        bet.bettor = ctx.accounts.bettor.key();
        bet.racer = racer;
        bet.amount = amount;
        bet.claimed = false;
        bet.bump = ctx.bumps.bet;

        ctx.accounts.nullifier.used = true;
        ctx.accounts.nullifier.value = world_nullifier;

        m.pools[racer as usize] = m.pools[racer as usize]
            .checked_add(amount)
            .ok_or(ClankerError::Overflow)?;
        m.total_pool = m.total_pool.checked_add(amount).ok_or(ClankerError::Overflow)?;

        emit!(BetPlaced { market_id: m.market_id, bettor: bet.bettor, racer, amount, world_nullifier });
        Ok(())
    }

    /// Judge settles the market with the Gemini-verified finish proof (sha256
    /// hash + Walrus blob id).
    pub fn settle_market(
        ctx: Context<SettleMarket>,
        _market_id: u64,
        winner: u8,
        proof_hash: [u8; 32],
        walrus_blob_id: String,
    ) -> Result<()> {
        require!(walrus_blob_id.len() <= 64, ClankerError::StringTooLong);
        let m = &mut ctx.accounts.market;
        require!(m.open && !m.settled, ClankerError::BadState);
        require!(winner < m.num_racers, ClankerError::BadRacer);
        m.open = false;
        m.settled = true;
        m.winner = winner;
        // Anchor the finish proof on-chain (parity with `finish_race`'s
        // `race.proof_hash`) so the Walrus blob + verdict hash are queryable
        // state, not just an emitted log.
        m.winning_proof_hash = proof_hash;
        m.walrus_blob_id = walrus_blob_id.clone();
        m.settled_at = Clock::get()?.unix_timestamp;
        emit!(MarketSettled { market_id: m.market_id, winner, proof_hash, walrus_blob_id });
        Ok(())
    }

    /// Claim a pro-rata share of the pool: `stake * total_pool / winning_pool`.
    pub fn claim(ctx: Context<Claim>, _market_id: u64) -> Result<()> {
        let m = &ctx.accounts.market;
        require!(m.settled, ClankerError::NotSettled);
        let bet = &mut ctx.accounts.bet;
        require!(!bet.claimed, ClankerError::AlreadyClaimed);
        require!(bet.racer == m.winner, ClankerError::Lost);

        let payout = parimutuel_payout(bet.amount, m.total_pool, m.pools[m.winner as usize]);
        bet.claimed = true;

        if payout > 0 {
            let market_key = m.key();
            let bump = ctx.bumps.market_vault_authority;
            let seeds: &[&[u8]] = &[MARKET_VAULT_AUTH_SEED, market_key.as_ref(), &[bump]];
            let signer: &[&[&[u8]]] = &[seeds];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.bettor_token.to_account_info(),
                        authority: ctx.accounts.market_vault_authority.to_account_info(),
                    },
                    signer,
                ),
                payout,
            )?;
        }

        emit!(Claimed { market_id: m.market_id, bettor: ctx.accounts.bettor.key(), payout });
        Ok(())
    }

    pub fn set_judge(ctx: Context<SetJudge>, _market_id: u64, new_judge: Pubkey) -> Result<()> {
        ctx.accounts.market.judge = new_judge;
        emit!(JudgeChanged { market_id: ctx.accounts.market.market_id, judge: new_judge });
        Ok(())
    }

    // ----- Reputation (port of ReputationRegistry.sol, ERC-8004) ------------

    /// Register who owns `agent_id` (the robot's wallet), so the registry can
    /// reject self-feedback. Mirrors `setAgentOwner` (first writer wins — here
    /// the PDA can only be initialized once).
    pub fn register_agent(ctx: Context<RegisterAgent>, agent_id: u64, owner: Pubkey) -> Result<()> {
        let agent = &mut ctx.accounts.agent;
        agent.agent_id = agent_id;
        agent.owner = owner;
        agent.count = 0;
        agent.sum = 0;
        agent.bump = ctx.bumps.agent;
        emit!(AgentRegistered { agent_id, owner });
        Ok(())
    }

    /// The requester rates an agent. The signer must not be the agent owner
    /// ("self-feedback not allowed"). Each feedback is stored in its own PDA
    /// (index = running count), and the agent's running count/sum back the
    /// leaderboard average. Emits `NewFeedback` for indexers/BigQuery.
    #[allow(clippy::too_many_arguments)]
    pub fn give_feedback(
        ctx: Context<GiveFeedback>,
        _agent_id: u64,
        value: i64,
        value_decimals: u8,
        tag1: String,
        tag2: String,
        endpoint: String,
        feedback_uri: String,
        feedback_hash: [u8; 32],
    ) -> Result<()> {
        require!(tag1.len() <= 32 && tag2.len() <= 32, ClankerError::StringTooLong);
        require!(endpoint.len() <= 96 && feedback_uri.len() <= 160, ClankerError::StringTooLong);
        let agent = &mut ctx.accounts.agent;
        require_keys_neq!(ctx.accounts.client.key(), agent.owner, ClankerError::SelfFeedback);

        let index = agent.count;
        let fb = &mut ctx.accounts.feedback;
        fb.agent = agent.key();
        fb.client = ctx.accounts.client.key();
        fb.index = index;
        fb.value = value;
        fb.value_decimals = value_decimals;
        fb.tag1 = tag1.clone();
        fb.tag2 = tag2;
        fb.endpoint = endpoint;
        fb.feedback_uri = feedback_uri;
        fb.feedback_hash = feedback_hash;
        fb.ts = Clock::get()?.unix_timestamp;
        fb.bump = ctx.bumps.feedback;

        agent.count = index.checked_add(1).ok_or(ClankerError::Overflow)?;
        agent.sum = agent
            .sum
            .checked_add(value as i128)
            .ok_or(ClankerError::Overflow)?;

        emit!(NewFeedback {
            agent_id: agent.agent_id,
            client: fb.client,
            feedback_index: index,
            value,
            value_decimals,
            tag1,
            feedback_hash,
        });
        Ok(())
    }

    // ----- EventPass (port of EventPass.sol) --------------------------------

    /// One-time init. `minter` is the guard robot's wallet (the only key that
    /// can mint passes).
    pub fn init_event_pass(ctx: Context<InitEventPass>, minter: Pubkey) -> Result<()> {
        let c = &mut ctx.accounts.pass_config;
        c.minter = minter;
        c.next_id = 0;
        c.bump = ctx.bumps.pass_config;
        Ok(())
    }

    /// Mint an access pass to `to` at the auction-settled `price_usdc6`. The
    /// pass is a program-native record (PDA per id); `holds(who)` is an
    /// off-chain getProgramAccounts query filtered by `owner` (the Solana
    /// idiom in place of an ERC-721 balanceOf). Minter only.
    pub fn mint_pass(ctx: Context<MintPass>, pass_id: u64, to: Pubkey, price_usdc6: u64) -> Result<()> {
        let c = &mut ctx.accounts.pass_config;
        require_keys_eq!(ctx.accounts.minter.key(), c.minter, ClankerError::NotMinter);
        require!(pass_id == c.next_id, ClankerError::BadPassId);
        let pass = &mut ctx.accounts.pass;
        pass.id = pass_id;
        pass.owner = to;
        pass.price_usdc6 = price_usdc6;
        pass.bump = ctx.bumps.pass;
        c.next_id = pass_id.checked_add(1).ok_or(ClankerError::Overflow)?;
        emit!(PassMinted { id: pass_id, to, price_usdc6 });
        Ok(())
    }

    // ----- Treasury (port of Treasury.sol) ----------------------------------

    /// Init the fleet treasury. `owner` is the Ledger hardware-wallet address;
    /// the USDC vault is a PDA token account.
    pub fn init_treasury(ctx: Context<InitTreasury>, owner: Pubkey) -> Result<()> {
        let t = &mut ctx.accounts.treasury_config;
        t.owner = owner;
        t.usdc_mint = ctx.accounts.usdc_mint.key();
        t.vault = ctx.accounts.vault.key();
        t.bump = ctx.bumps.treasury_config;
        Ok(())
    }

    /// Withdraw fleet earnings. Owner-gated (the Ledger-held key) — the
    /// governance boundary for the demo climax. Kept minimal so a Ledger Solana
    /// clear-sign renders "Withdraw <amount> USDC to <recipient>".
    pub fn withdraw_treasury(ctx: Context<WithdrawTreasury>, amount: u64) -> Result<()> {
        let bump = ctx.bumps.treasury_authority;
        let signer: &[&[&[u8]]] = &[&[TREASURY_AUTH_SEED, &[bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.recipient.to_account_info(),
                    authority: ctx.accounts.treasury_authority.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;
        emit!(TreasuryWithdraw { to: ctx.accounts.recipient.key(), amount });
        Ok(())
    }

    pub fn set_treasury_owner(ctx: Context<SetTreasuryOwner>, new_owner: Pubkey) -> Result<()> {
        ctx.accounts.treasury_config.owner = new_owner;
        emit!(TreasuryOwnerChanged { new_owner });
        Ok(())
    }

    // ----- AttestationConsumer (port of AttestationConsumer.sol, Chainlink CRE) --

    /// Init the consensus-verdict gate. `forwarder` is the Chainlink forwarder
    /// authorized to write reports; `Pubkey::default()` (all zeros) = unrestricted
    /// (sim/demo), matching the EVM `forwarder == address(0)` escape hatch.
    pub fn init_attestation(ctx: Context<InitAttestation>, forwarder: Pubkey) -> Result<()> {
        let c = &mut ctx.accounts.attest_config;
        c.owner = ctx.accounts.owner.key();
        c.forwarder = forwarder;
        c.bump = ctx.bumps.attest_config;
        Ok(())
    }

    pub fn set_forwarder(ctx: Context<SetForwarder>, forwarder: Pubkey) -> Result<()> {
        ctx.accounts.attest_config.forwarder = forwarder;
        emit!(ForwarderSet { forwarder });
        Ok(())
    }

    /// Land the DON's consensus verdict for a job (keyed by `job_hash` =
    /// sha256/keccak of the job string, computed client-side). The robot's own
    /// claim never settles anything — this is the verdict downstream reads via
    /// `verified`. Reporter must be the configured forwarder (or any, if unset).
    pub fn write_attestation(
        ctx: Context<WriteAttestation>,
        _job_hash: [u8; 32],
        job: String,
        score: u64,
        proof_hash: [u8; 32],
    ) -> Result<()> {
        require!(job.len() <= 64, ClankerError::StringTooLong);
        let cfg = &ctx.accounts.attest_config;
        require!(
            cfg.forwarder == Pubkey::default() || ctx.accounts.reporter.key() == cfg.forwarder,
            ClankerError::Unauthorized
        );
        let verified = score >= ATTESTATION_THRESHOLD;
        let a = &mut ctx.accounts.attestation;
        a.score = score;
        a.proof_hash = proof_hash;
        a.timestamp = Clock::get()?.unix_timestamp;
        a.verified = verified;
        a.exists = true;
        a.bump = ctx.bumps.attestation;
        emit!(AttestationVerified { job, score, proof_hash, verified, timestamp: a.timestamp });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

pub const CONFIG_SEED: &[u8] = b"config";
pub const RACE_SEED: &[u8] = b"race";
pub const VAULT_SEED: &[u8] = b"vault";
pub const VAULT_AUTH_SEED: &[u8] = b"vault_auth";
pub const MARKET_SEED: &[u8] = b"market";
pub const MARKET_VAULT_SEED: &[u8] = b"market_vault";
pub const MARKET_VAULT_AUTH_SEED: &[u8] = b"market_vault_auth";
pub const BET_SEED: &[u8] = b"bet";
pub const NULLIFIER_SEED: &[u8] = b"nullifier";
pub const AGENT_SEED: &[u8] = b"agent";
pub const FEEDBACK_SEED: &[u8] = b"feedback";
pub const PASS_CONFIG_SEED: &[u8] = b"pass_config";
pub const PASS_SEED: &[u8] = b"pass";
pub const TREASURY_CONFIG_SEED: &[u8] = b"treasury_config";
pub const TREASURY_VAULT_SEED: &[u8] = b"treasury_vault";
pub const TREASURY_AUTH_SEED: &[u8] = b"treasury_auth";
pub const ATTEST_CONFIG_SEED: &[u8] = b"attest_config";
pub const ATTEST_SEED: &[u8] = b"attest";

/// Consensus score required to settle (matches AttestationConsumer.THRESHOLD).
pub const ATTESTATION_THRESHOLD: u64 = 70;

// ---------------------------------------------------------------------------
// Accounts: race escrow
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(constraint = treasury_token.mint == usdc_mint.key() @ ClankerError::BadMint)]
    pub treasury_token: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(race_id: u64)]
pub struct OpenRace<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub facilitator: Signer<'info>,
    #[account(
        init,
        payer = facilitator,
        space = 8 + Race::INIT_SPACE,
        seeds = [RACE_SEED, &race_id.to_le_bytes()],
        bump
    )]
    pub race: Account<'info, Race>,
    #[account(
        init,
        payer = facilitator,
        seeds = [VAULT_SEED, race.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = vault_authority
    )]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: PDA authority over all race vaults; never holds data.
    #[account(seeds = [VAULT_AUTH_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(constraint = usdc_mint.key() == config.usdc_mint @ ClankerError::BadMint)]
    pub usdc_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(race_id: u64)]
pub struct JoinRace<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [RACE_SEED, &race_id.to_le_bytes()], bump = race.bump)]
    pub race: Account<'info, Race>,
    #[account(mut)]
    pub driver: Signer<'info>,
    #[account(mut, constraint = driver_token.owner == driver.key() @ ClankerError::BadDriver)]
    pub driver_token: Account<'info, TokenAccount>,
    #[account(mut, address = race.vault @ ClankerError::BadVault)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, address = config.treasury @ ClankerError::BadTreasury)]
    pub treasury_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(race_id: u64)]
pub struct FacilitatorRace<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        constraint = facilitator.key() == config.facilitator @ ClankerError::NotFacilitator
    )]
    pub facilitator: Signer<'info>,
    #[account(mut, seeds = [RACE_SEED, &race_id.to_le_bytes()], bump = race.bump)]
    pub race: Account<'info, Race>,
}

#[derive(Accounts)]
#[instruction(race_id: u64)]
pub struct SettleRace<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(constraint = facilitator.key() == config.facilitator @ ClankerError::NotFacilitator)]
    pub facilitator: Signer<'info>,
    #[account(mut, seeds = [RACE_SEED, &race_id.to_le_bytes()], bump = race.bump)]
    pub race: Account<'info, Race>,
    #[account(mut, address = race.vault @ ClankerError::BadVault)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: PDA authority over all race vaults.
    #[account(seeds = [VAULT_AUTH_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub winner_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(race_id: u64)]
pub struct CancelRace<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(constraint = facilitator.key() == config.facilitator @ ClankerError::NotFacilitator)]
    pub facilitator: Signer<'info>,
    #[account(mut, seeds = [RACE_SEED, &race_id.to_le_bytes()], bump = race.bump)]
    pub race: Account<'info, Race>,
    #[account(mut, address = race.vault @ ClankerError::BadVault)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: PDA authority over all race vaults.
    #[account(seeds = [VAULT_AUTH_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub challenger_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub opponent_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct OperatorOnly<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(constraint = authority.key() == config.authority @ ClankerError::NotOperator)]
    pub authority: Signer<'info>,
}

// ---------------------------------------------------------------------------
// Accounts: parimutuel market
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct OpenMarket<'info> {
    #[account(
        init,
        payer = judge,
        space = 8 + Market::INIT_SPACE,
        seeds = [MARKET_SEED, &market_id.to_le_bytes()],
        bump
    )]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub judge: Signer<'info>,
    #[account(
        init,
        payer = judge,
        seeds = [MARKET_VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = market_vault_authority
    )]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: per-market PDA authority over the betting vault.
    #[account(seeds = [MARKET_VAULT_AUTH_SEED, market.key().as_ref()], bump)]
    pub market_vault_authority: UncheckedAccount<'info>,
    pub usdc_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(market_id: u64, racer: u8, amount: u64, world_nullifier: [u8; 32])]
pub struct PlaceBet<'info> {
    #[account(mut, seeds = [MARKET_SEED, &market_id.to_le_bytes()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub bettor: Signer<'info>,
    #[account(mut, constraint = bettor_token.owner == bettor.key() @ ClankerError::BadDriver)]
    pub bettor_token: Account<'info, TokenAccount>,
    #[account(mut, address = market.vault @ ClankerError::BadVault)]
    pub vault: Account<'info, TokenAccount>,
    // One bet per bettor: init fails if this PDA already exists.
    #[account(
        init,
        payer = bettor,
        space = 8 + Bet::INIT_SPACE,
        seeds = [BET_SEED, market.key().as_ref(), bettor.key().as_ref()],
        bump
    )]
    pub bet: Account<'info, Bet>,
    // One human per market: init fails if this nullifier was already used.
    #[account(
        init,
        payer = bettor,
        space = 8 + Nullifier::INIT_SPACE,
        seeds = [NULLIFIER_SEED, market.key().as_ref(), &world_nullifier],
        bump
    )]
    pub nullifier: Account<'info, Nullifier>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct SettleMarket<'info> {
    #[account(mut, seeds = [MARKET_SEED, &market_id.to_le_bytes()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(constraint = judge.key() == market.judge @ ClankerError::NotJudge)]
    pub judge: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct Claim<'info> {
    #[account(seeds = [MARKET_SEED, &market_id.to_le_bytes()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub bettor: Signer<'info>,
    #[account(
        mut,
        seeds = [BET_SEED, market.key().as_ref(), bettor.key().as_ref()],
        bump = bet.bump,
        constraint = bet.bettor == bettor.key() @ ClankerError::BadDriver
    )]
    pub bet: Account<'info, Bet>,
    #[account(mut, address = market.vault @ ClankerError::BadVault)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: per-market PDA authority over the betting vault.
    #[account(seeds = [MARKET_VAULT_AUTH_SEED, market.key().as_ref()], bump)]
    pub market_vault_authority: UncheckedAccount<'info>,
    #[account(mut, constraint = bettor_token.owner == bettor.key() @ ClankerError::BadDriver)]
    pub bettor_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct SetJudge<'info> {
    #[account(mut, seeds = [MARKET_SEED, &market_id.to_le_bytes()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(constraint = operator.key() == market.operator @ ClankerError::NotOperator)]
    pub operator: Signer<'info>,
}

// ---------------------------------------------------------------------------
// Accounts: reputation
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(agent_id: u64)]
pub struct RegisterAgent<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Agent::INIT_SPACE,
        seeds = [AGENT_SEED, &agent_id.to_le_bytes()],
        bump
    )]
    pub agent: Account<'info, Agent>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(agent_id: u64)]
pub struct GiveFeedback<'info> {
    #[account(mut, seeds = [AGENT_SEED, &agent_id.to_le_bytes()], bump = agent.bump)]
    pub agent: Account<'info, Agent>,
    #[account(mut)]
    pub client: Signer<'info>,
    #[account(
        init,
        payer = client,
        space = 8 + Feedback::INIT_SPACE,
        seeds = [FEEDBACK_SEED, agent.key().as_ref(), &agent.count.to_le_bytes()],
        bump
    )]
    pub feedback: Account<'info, Feedback>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// Accounts: EventPass + Treasury
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitEventPass<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + PassConfig::INIT_SPACE,
        seeds = [PASS_CONFIG_SEED],
        bump
    )]
    pub pass_config: Account<'info, PassConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(pass_id: u64)]
pub struct MintPass<'info> {
    #[account(mut, seeds = [PASS_CONFIG_SEED], bump = pass_config.bump)]
    pub pass_config: Account<'info, PassConfig>,
    #[account(mut)]
    pub minter: Signer<'info>,
    #[account(
        init,
        payer = minter,
        space = 8 + Pass::INIT_SPACE,
        seeds = [PASS_SEED, &pass_id.to_le_bytes()],
        bump
    )]
    pub pass: Account<'info, Pass>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitTreasury<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + TreasuryConfig::INIT_SPACE,
        seeds = [TREASURY_CONFIG_SEED],
        bump
    )]
    pub treasury_config: Account<'info, TreasuryConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        seeds = [TREASURY_VAULT_SEED],
        bump,
        token::mint = usdc_mint,
        token::authority = treasury_authority
    )]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: PDA authority over the treasury vault.
    #[account(seeds = [TREASURY_AUTH_SEED], bump)]
    pub treasury_authority: UncheckedAccount<'info>,
    pub usdc_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct WithdrawTreasury<'info> {
    #[account(seeds = [TREASURY_CONFIG_SEED], bump = treasury_config.bump)]
    pub treasury_config: Account<'info, TreasuryConfig>,
    #[account(constraint = owner.key() == treasury_config.owner @ ClankerError::NotOwner)]
    pub owner: Signer<'info>,
    #[account(mut, address = treasury_config.vault @ ClankerError::BadVault)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: PDA authority over the treasury vault.
    #[account(seeds = [TREASURY_AUTH_SEED], bump)]
    pub treasury_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub recipient: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SetTreasuryOwner<'info> {
    #[account(mut, seeds = [TREASURY_CONFIG_SEED], bump = treasury_config.bump)]
    pub treasury_config: Account<'info, TreasuryConfig>,
    #[account(constraint = owner.key() == treasury_config.owner @ ClankerError::NotOwner)]
    pub owner: Signer<'info>,
}

// ---------------------------------------------------------------------------
// Accounts: AttestationConsumer
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitAttestation<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + AttestConfig::INIT_SPACE,
        seeds = [ATTEST_CONFIG_SEED],
        bump
    )]
    pub attest_config: Account<'info, AttestConfig>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetForwarder<'info> {
    #[account(mut, seeds = [ATTEST_CONFIG_SEED], bump = attest_config.bump)]
    pub attest_config: Account<'info, AttestConfig>,
    #[account(constraint = owner.key() == attest_config.owner @ ClankerError::NotOwner)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(job_hash: [u8; 32])]
pub struct WriteAttestation<'info> {
    #[account(seeds = [ATTEST_CONFIG_SEED], bump = attest_config.bump)]
    pub attest_config: Account<'info, AttestConfig>,
    #[account(mut)]
    pub reporter: Signer<'info>,
    // Upsert: re-reporting the same job overwrites the verdict (matches EVM).
    #[account(
        init_if_needed,
        payer = reporter,
        space = 8 + Attestation::INIT_SPACE,
        seeds = [ATTEST_SEED, &job_hash],
        bump
    )]
    pub attestation: Account<'info, Attestation>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub facilitator: Pubkey,
    pub treasury: Pubkey,
    pub usdc_mint: Pubkey,
    pub next_race_id: u64,
    pub total_fees_collected: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Race {
    pub race_id: u64,
    pub status: RaceStatus,
    pub local_round_id: [u8; 32],
    pub challenger: Pubkey,
    pub opponent: Pubkey,
    pub challenger_joined: bool,
    pub opponent_joined: bool,
    pub stake_amount: u64,
    pub fee_amount: u64,
    pub fees_collected: u64,
    pub winner_slot: u8,
    pub proof_hash: [u8; 32],
    pub created_at: i64,
    pub locked_at: i64,
    pub started_at: i64,
    pub finished_at: i64,
    pub vault: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub market_id: u64,
    pub judge: Pubkey,
    pub operator: Pubkey,
    pub usdc_mint: Pubkey,
    pub open: bool,
    pub settled: bool,
    pub winner: u8,
    pub num_racers: u8,
    pub pools: [u64; MAX_RACERS],
    pub total_pool: u64,
    pub vault: Pubkey,
    pub settled_at: i64,
    pub winning_proof_hash: [u8; 32],
    #[max_len(64)]
    pub walrus_blob_id: String,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Bet {
    pub market: Pubkey,
    pub bettor: Pubkey,
    pub racer: u8,
    pub amount: u64,
    pub claimed: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Nullifier {
    pub used: bool,
    pub value: [u8; 32],
}

#[account]
#[derive(InitSpace)]
pub struct Agent {
    pub agent_id: u64,
    pub owner: Pubkey,
    pub count: u64,
    pub sum: i128,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Feedback {
    pub agent: Pubkey,
    pub client: Pubkey,
    pub index: u64,
    pub value: i64,
    pub value_decimals: u8,
    #[max_len(32)]
    pub tag1: String,
    #[max_len(32)]
    pub tag2: String,
    #[max_len(96)]
    pub endpoint: String,
    #[max_len(160)]
    pub feedback_uri: String,
    pub feedback_hash: [u8; 32],
    pub ts: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct PassConfig {
    pub minter: Pubkey,
    pub next_id: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Pass {
    pub id: u64,
    pub owner: Pubkey,
    pub price_usdc6: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct TreasuryConfig {
    pub owner: Pubkey,
    pub usdc_mint: Pubkey,
    pub vault: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct AttestConfig {
    pub owner: Pubkey,
    pub forwarder: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Attestation {
    pub score: u64,
    pub proof_hash: [u8; 32],
    pub timestamp: i64,
    pub verified: bool,
    pub exists: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum RaceStatus {
    Created,
    Joined,
    Locked,
    Started,
    Finished,
    Settled,
    Canceled,
}

impl Default for RaceStatus {
    fn default() -> Self {
        RaceStatus::Created
    }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct RaceOpened {
    pub race_id: u64,
    pub local_round_id: [u8; 32],
    pub stake_amount: u64,
    pub fee_amount: u64,
}
#[event]
pub struct RaceJoined {
    pub race_id: u64,
    pub driver: Pubkey,
    pub slot: u8,
    pub stake_amount: u64,
    pub fee_amount: u64,
}
#[event]
pub struct RaceLocked {
    pub race_id: u64,
}
#[event]
pub struct RaceStarted {
    pub race_id: u64,
}
#[event]
pub struct RaceFinished {
    pub race_id: u64,
    pub winner_slot: u8,
    pub proof_hash: [u8; 32],
}
#[event]
pub struct RaceSettled {
    pub race_id: u64,
    pub winner: Pubkey,
    pub payout: u64,
}
#[event]
pub struct RaceCanceled {
    pub race_id: u64,
    pub reason: String,
}
#[event]
pub struct FacilitatorChanged {
    pub facilitator: Pubkey,
}
#[event]
pub struct MarketOpened {
    pub market_id: u64,
    pub num_racers: u8,
}
#[event]
pub struct BetPlaced {
    pub market_id: u64,
    pub bettor: Pubkey,
    pub racer: u8,
    pub amount: u64,
    pub world_nullifier: [u8; 32],
}
#[event]
pub struct MarketSettled {
    pub market_id: u64,
    pub winner: u8,
    pub proof_hash: [u8; 32],
    pub walrus_blob_id: String,
}
#[event]
pub struct Claimed {
    pub market_id: u64,
    pub bettor: Pubkey,
    pub payout: u64,
}
#[event]
pub struct JudgeChanged {
    pub market_id: u64,
    pub judge: Pubkey,
}
#[event]
pub struct AgentRegistered {
    pub agent_id: u64,
    pub owner: Pubkey,
}
#[event]
pub struct NewFeedback {
    pub agent_id: u64,
    pub client: Pubkey,
    pub feedback_index: u64,
    pub value: i64,
    pub value_decimals: u8,
    pub tag1: String,
    pub feedback_hash: [u8; 32],
}
#[event]
pub struct PassMinted {
    pub id: u64,
    pub to: Pubkey,
    pub price_usdc6: u64,
}
#[event]
pub struct TreasuryWithdraw {
    pub to: Pubkey,
    pub amount: u64,
}
#[event]
pub struct TreasuryOwnerChanged {
    pub new_owner: Pubkey,
}
#[event]
pub struct ForwarderSet {
    pub forwarder: Pubkey,
}
#[event]
pub struct AttestationVerified {
    pub job: String,
    pub score: u64,
    pub proof_hash: [u8; 32],
    pub verified: bool,
    pub timestamp: i64,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum ClankerError {
    #[msg("caller is not the facilitator")]
    NotFacilitator,
    #[msg("caller is not the operator")]
    NotOperator,
    #[msg("caller is not the judge")]
    NotJudge,
    #[msg("invalid race state for this action")]
    BadState,
    #[msg("slot must be 0 or 1")]
    BadSlot,
    #[msg("driver invalid for this slot")]
    BadDriver,
    #[msg("amount does not match the race terms")]
    BadAmount,
    #[msg("race id does not match the running counter")]
    BadRaceId,
    #[msg("driver already joined this slot")]
    AlreadyJoined,
    #[msg("wrong mint")]
    BadMint,
    #[msg("wrong vault account")]
    BadVault,
    #[msg("wrong treasury account")]
    BadTreasury,
    #[msg("market is closed")]
    MarketClosed,
    #[msg("market not settled")]
    NotSettled,
    #[msg("bet already claimed")]
    AlreadyClaimed,
    #[msg("bet did not pick the winner")]
    Lost,
    #[msg("invalid racer index")]
    BadRacer,
    #[msg("racer count out of range")]
    BadRacerCount,
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("self-feedback not allowed")]
    SelfFeedback,
    #[msg("string field exceeds max length")]
    StringTooLong,
    #[msg("caller is not the pass minter")]
    NotMinter,
    #[msg("pass id does not match the running counter")]
    BadPassId,
    #[msg("caller is not the treasury owner (Ledger approval required)")]
    NotOwner,
    #[msg("reporter is not the authorized forwarder")]
    Unauthorized,
}

// ---------------------------------------------------------------------------
// Unit tests (pure logic — run with `cargo test`, no validator required)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::parimutuel_payout;

    #[test]
    fn empty_winning_pool_pays_zero() {
        // No bets on the winning lane -> nobody can claim against an empty pool.
        assert_eq!(parimutuel_payout(100, 500, 0), 0);
    }

    #[test]
    fn sole_winner_takes_the_whole_pool() {
        // One winner staked the entire winning pool -> they get every lamport.
        assert_eq!(parimutuel_payout(100, 250, 100), 250);
    }

    #[test]
    fn pro_rata_split_is_exact_when_divisible() {
        // total 300, winning lane 200 split 120/80 -> 180/120, summing to total.
        assert_eq!(parimutuel_payout(120, 300, 200), 180);
        assert_eq!(parimutuel_payout(80, 300, 200), 120);
        assert_eq!(180 + 120, 300);
    }

    #[test]
    fn flooring_never_overpays_the_vault() {
        // total 1000, winning lane = three equal 1-unit bets -> floor(1000/3)=333.
        let each = parimutuel_payout(1, 1000, 3);
        assert_eq!(each, 333);
        // Dust (1000 - 999 = 1) stays in the vault; payouts never exceed it.
        assert!(3 * each <= 1000);
    }

    #[test]
    fn no_overflow_at_u64_extremes() {
        // amount == win_pool so payout == total_pool even at the u64 ceiling;
        // the intermediate u128 product (2^64-1)^2 cannot overflow.
        assert_eq!(parimutuel_payout(u64::MAX, u64::MAX, u64::MAX), u64::MAX);
    }
}

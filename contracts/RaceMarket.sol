// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title RaceMarket — parimutuel betting on rover races (Arc testnet, USDC 6dp)
/// @notice Deliberately simple: open -> bet -> judge settles -> claim pro-rata.
/// One bet per World-ID-verified human is enforced off-chain before relay;
/// the worldNullifier is stored on-chain for transparency/auditability.
interface IERC20 {
    function transferFrom(address f, address t, uint256 a) external returns (bool);
    function transfer(address t, uint256 a) external returns (bool);
}

contract RaceMarket {
    IERC20 public immutable usdc;
    address public judge;      // the GUARD robot's wallet (attests the finish)
    address public operator;   // Ledger-governed: only key that can rotate judge

    struct Race {
        bool open;
        bool settled;
        uint8 winner;                       // racer index
        uint8 numRacers;
        mapping(uint8 => uint256) pool;     // racer -> total staked
        uint256 totalPool;
        mapping(address => uint8) pick;
        mapping(address => uint256) stake;
        mapping(uint256 => bool) usedNullifier; // World ID one-human-one-bet
    }
    mapping(uint256 => Race) private races;
    uint256 public nextRaceId;

    event RaceOpened(uint256 indexed raceId, uint8 numRacers);
    event Bet(uint256 indexed raceId, address indexed bettor, uint8 racer, uint256 amount, uint256 worldNullifier);
    event Settled(uint256 indexed raceId, uint8 winner, bytes32 proofHash, string walrusBlobId);
    event Claimed(uint256 indexed raceId, address indexed bettor, uint256 payout);

    modifier onlyJudge() { require(msg.sender == judge, "not judge"); _; }
    modifier onlyOperator() { require(msg.sender == operator, "not operator"); _; }

    constructor(address _usdc, address _judge, address _operator) {
        usdc = IERC20(_usdc);
        judge = _judge;
        operator = _operator;
    }

    function openRace(uint8 numRacers) external onlyJudge returns (uint256 raceId) {
        raceId = nextRaceId++;
        Race storage r = races[raceId];
        r.open = true;
        r.numRacers = numRacers;
        emit RaceOpened(raceId, numRacers);
    }

    function bet(uint256 raceId, uint8 racer, uint256 amount, uint256 worldNullifier) external {
        Race storage r = races[raceId];
        require(r.open && !r.settled, "closed");
        require(racer < r.numRacers, "bad racer");
        require(r.stake[msg.sender] == 0, "already bet");
        require(!r.usedNullifier[worldNullifier], "human already bet");
        r.usedNullifier[worldNullifier] = true;
        require(usdc.transferFrom(msg.sender, address(this), amount), "pay");
        r.pick[msg.sender] = racer;
        r.stake[msg.sender] = amount;
        r.pool[racer] += amount;
        r.totalPool += amount;
        emit Bet(raceId, msg.sender, racer, amount, worldNullifier);
    }

    /// @notice Judge (GUARD robot) settles with the proof anchor: the Gemini-
    /// verified finish photo's sha256 + its Walrus blobId.
    function settle(uint256 raceId, uint8 winner, bytes32 proofHash, string calldata walrusBlobId)
        external onlyJudge
    {
        Race storage r = races[raceId];
        require(r.open && !r.settled, "bad state");
        r.open = false;
        r.settled = true;
        r.winner = winner;
        emit Settled(raceId, winner, proofHash, walrusBlobId);
    }

    function claim(uint256 raceId) external {
        Race storage r = races[raceId];
        require(r.settled, "not settled");
        require(r.pick[msg.sender] == r.winner, "lost");
        uint256 stake = r.stake[msg.sender];
        require(stake > 0, "none");
        r.stake[msg.sender] = 0;
        uint256 winPool = r.pool[r.winner];
        uint256 payout = winPool == 0 ? 0 : (stake * r.totalPool) / winPool;
        require(usdc.transfer(msg.sender, payout), "pay");
        emit Claimed(raceId, msg.sender, payout);
    }

    /// @notice Operator action — gated by Ledger clear-signing in the UI
    /// (ERC-7730 descriptor renders "Rotate race judge to 0x…").
    function setJudge(address newJudge) external onlyOperator {
        judge = newJudge;
    }
}

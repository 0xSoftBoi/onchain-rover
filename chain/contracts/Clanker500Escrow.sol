// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Clanker500Escrow
/// @notice Two-driver native ETH race escrow for the Clanker500 stage flow.
contract Clanker500Escrow is ReentrancyGuard {
    enum Status {
        None,
        Created,
        Joined,
        Locked,
        Started,
        Finished,
        Settled,
        Canceled
    }

    struct RaceView {
        Status status;
        bytes32 localRoundId;
        address challenger;
        address opponent;
        bool challengerJoined;
        bool opponentJoined;
        uint256 stakeWei;
        uint8 winnerSlot;
        bytes32 proofHash;
        uint256 createdAt;
        uint256 lockedAt;
        uint256 startedAt;
        uint256 finishedAt;
    }

    struct Race {
        Status status;
        bytes32 localRoundId;
        address challenger;
        address opponent;
        bool challengerJoined;
        bool opponentJoined;
        uint256 stakeWei;
        uint8 winnerSlot;
        bytes32 proofHash;
        uint256 createdAt;
        uint256 lockedAt;
        uint256 startedAt;
        uint256 finishedAt;
    }

    address public operator;
    address public facilitator;
    uint256 public nextRaceId;

    mapping(uint256 => Race) private races;

    event RaceOpened(uint256 indexed raceId, bytes32 indexed localRoundId, uint256 stakeWei);
    event RaceJoined(uint256 indexed raceId, address indexed driver, uint8 indexed slot, uint256 stakeWei);
    event RaceLocked(uint256 indexed raceId);
    event RaceStarted(uint256 indexed raceId);
    event RaceFinished(uint256 indexed raceId, uint8 indexed winnerSlot, bytes32 proofHash);
    event RaceSettled(uint256 indexed raceId, address indexed winner, uint256 payoutWei);
    event RaceCanceled(uint256 indexed raceId, string reason);
    event FacilitatorChanged(address indexed facilitator);
    event OperatorChanged(address indexed operator);

    error NotFacilitator();
    error NotOperator();
    error BadState();
    error BadSlot();
    error BadAmount();
    error AlreadyJoined();
    error SameDriver();
    error TransferFailed();

    modifier onlyFacilitator() {
        if (msg.sender != facilitator) revert NotFacilitator();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(address operator_, address facilitator_) {
        require(operator_ != address(0), "operator required");
        require(facilitator_ != address(0), "facilitator required");
        operator = operator_;
        facilitator = facilitator_;
    }

    function openRace(bytes32 localRoundId, uint256 stakeWei)
        external
        onlyFacilitator
        returns (uint256 raceId)
    {
        if (stakeWei == 0) revert BadAmount();
        raceId = nextRaceId++;
        Race storage race = races[raceId];
        race.status = Status.Created;
        race.localRoundId = localRoundId;
        race.stakeWei = stakeWei;
        race.createdAt = block.timestamp;
        emit RaceOpened(raceId, localRoundId, stakeWei);
    }

    function joinRace(uint256 raceId, uint8 slot) external payable nonReentrant {
        Race storage race = races[raceId];
        if (race.status != Status.Created && race.status != Status.Joined) revert BadState();
        if (slot > 1) revert BadSlot();
        if (msg.value != race.stakeWei) revert BadAmount();

        if (slot == 0) {
            if (race.challengerJoined) revert AlreadyJoined();
            if (race.opponent == msg.sender) revert SameDriver();
            race.challenger = msg.sender;
            race.challengerJoined = true;
        } else {
            if (race.opponentJoined) revert AlreadyJoined();
            if (race.challenger == msg.sender) revert SameDriver();
            race.opponent = msg.sender;
            race.opponentJoined = true;
        }

        if (race.challengerJoined && race.opponentJoined) {
            race.status = Status.Joined;
        }
        emit RaceJoined(raceId, msg.sender, slot, msg.value);
    }

    function lockRace(uint256 raceId) external onlyFacilitator {
        Race storage race = races[raceId];
        if (race.status != Status.Joined || !race.challengerJoined || !race.opponentJoined) revert BadState();
        race.status = Status.Locked;
        race.lockedAt = block.timestamp;
        emit RaceLocked(raceId);
    }

    function startRace(uint256 raceId) external onlyFacilitator {
        Race storage race = races[raceId];
        if (race.status != Status.Locked) revert BadState();
        race.status = Status.Started;
        race.startedAt = block.timestamp;
        emit RaceStarted(raceId);
    }

    function finishRace(uint256 raceId, uint8 winnerSlot, bytes32 proofHash) external onlyFacilitator {
        Race storage race = races[raceId];
        if (race.status != Status.Started) revert BadState();
        if (winnerSlot > 1) revert BadSlot();
        race.status = Status.Finished;
        race.winnerSlot = winnerSlot;
        race.proofHash = proofHash;
        race.finishedAt = block.timestamp;
        emit RaceFinished(raceId, winnerSlot, proofHash);
    }

    function settleRace(uint256 raceId) external nonReentrant onlyFacilitator {
        Race storage race = races[raceId];
        if (race.status != Status.Finished) revert BadState();
        address winner = race.winnerSlot == 0 ? race.challenger : race.opponent;
        uint256 payout = race.stakeWei * 2;
        race.status = Status.Settled;
        (bool ok,) = payable(winner).call{value: payout}("");
        if (!ok) revert TransferFailed();
        emit RaceSettled(raceId, winner, payout);
    }

    function cancelRace(uint256 raceId, string calldata reason) external nonReentrant onlyFacilitator {
        Race storage race = races[raceId];
        if (
            race.status == Status.None ||
            race.status == Status.Finished ||
            race.status == Status.Settled ||
            race.status == Status.Canceled
        ) revert BadState();

        race.status = Status.Canceled;
        uint256 stake = race.stakeWei;
        address challenger = race.challenger;
        address opponent = race.opponent;
        bool challengerJoined = race.challengerJoined;
        bool opponentJoined = race.opponentJoined;

        if (challengerJoined) {
            (bool challengerOk,) = payable(challenger).call{value: stake}("");
            if (!challengerOk) revert TransferFailed();
        }
        if (opponentJoined) {
            (bool opponentOk,) = payable(opponent).call{value: stake}("");
            if (!opponentOk) revert TransferFailed();
        }

        emit RaceCanceled(raceId, reason);
    }

    function setFacilitator(address facilitator_) external onlyOperator {
        require(facilitator_ != address(0), "facilitator required");
        facilitator = facilitator_;
        emit FacilitatorChanged(facilitator_);
    }

    function setOperator(address operator_) external onlyOperator {
        require(operator_ != address(0), "operator required");
        operator = operator_;
        emit OperatorChanged(operator_);
    }

    function getRace(uint256 raceId) external view returns (RaceView memory) {
        Race storage race = races[raceId];
        return RaceView({
            status: race.status,
            localRoundId: race.localRoundId,
            challenger: race.challenger,
            opponent: race.opponent,
            challengerJoined: race.challengerJoined,
            opponentJoined: race.opponentJoined,
            stakeWei: race.stakeWei,
            winnerSlot: race.winnerSlot,
            proofHash: race.proofHash,
            createdAt: race.createdAt,
            lockedAt: race.lockedAt,
            startedAt: race.startedAt,
            finishedAt: race.finishedAt
        });
    }
}

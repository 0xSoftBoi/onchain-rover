// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @title AttestationConsumer — the on-chain endpoint of the decentralized
/// verification layer for The Onchain Rover.
///
/// A Chainlink CRE workflow runs on a DON: each node independently calls the
/// robot's GET /attest, reaches *median consensus* on the verification score,
/// and calls writeReport(), which lands here via onReport(). The robot's own
/// claim never settles anything — this consensus verdict does. Downstream
/// (EventPass mint, x402 payment release, ERC-8004 reputation) reads
/// isVerified(job) and only proceeds once a decentralized network agreed.
interface IReceiver {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

contract AttestationConsumer is IReceiver {
    struct Attestation {
        uint256 score;      // 0..100, DON median of robot self-confidence
        bytes32 proofHash;  // sha256 of the Walrus-anchored proof photo
        uint64 timestamp;
        bool verified;      // score >= THRESHOLD
        bool exists;
    }

    uint256 public constant THRESHOLD = 70; // consensus score required to settle

    address public owner;
    address public forwarder; // Chainlink forwarder; 0 = unrestricted (sim/demo)
    mapping(bytes32 => Attestation) private _byJob;

    event AttestationVerified(
        string job, uint256 score, bytes32 proofHash, bool verified, uint64 timestamp
    );
    event ForwarderSet(address forwarder);

    constructor(address _forwarder) {
        owner = msg.sender;
        forwarder = _forwarder;
    }

    function setForwarder(address f) external {
        require(msg.sender == owner, "only owner");
        forwarder = f;
        emit ForwarderSet(f);
    }

    /// @notice Called by the Chainlink forwarder with the DON's consensus report.
    /// report = abi.encode(string job, uint256 score, bytes32 proofHash)
    function onReport(bytes calldata, bytes calldata report) external override {
        require(forwarder == address(0) || msg.sender == forwarder, "unauthorized");
        (string memory job, uint256 score, bytes32 proofHash) =
            abi.decode(report, (string, uint256, bytes32));
        bool ok = score >= THRESHOLD;
        _byJob[keccak256(bytes(job))] =
            Attestation(score, proofHash, uint64(block.timestamp), ok, true);
        emit AttestationVerified(job, score, proofHash, ok, uint64(block.timestamp));
    }

    function getAttestation(string calldata job) external view returns (Attestation memory) {
        return _byJob[keccak256(bytes(job))];
    }

    /// @notice The gate downstream settlement reads.
    function isVerified(string calldata job) external view returns (bool) {
        return _byJob[keccak256(bytes(job))].verified;
    }
}

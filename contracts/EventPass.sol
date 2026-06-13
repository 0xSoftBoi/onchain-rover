// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title EventPass — the access NFT the GUARD mints to a robot that paid.
/// @notice Minimal ERC-721. The guard wallet is the minter. Each pass records
/// the negotiated price it was sold for (from the Dutch auction) on-chain.
contract EventPass {
    string public constant name = "Rover EventPass";
    string public constant symbol = "PASS";

    address public minter;            // the guard robot's wallet
    uint256 public nextId;

    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => uint256) public priceOf;   // negotiated price, 6dp USDC

    event Transfer(address indexed from, address indexed to, uint256 indexed id);
    event Minted(address indexed to, uint256 indexed id, uint256 priceUsdc6);

    constructor(address _minter) {
        minter = _minter;
    }

    modifier onlyMinter() {
        require(msg.sender == minter, "not minter");
        _;
    }

    /// @param priceUsdc6 the auction-settled price in USDC 6-decimals (e.g. 1.25 => 1250000)
    function mint(address to, uint256 priceUsdc6) external onlyMinter returns (uint256 id) {
        id = nextId++;
        ownerOf[id] = to;
        balanceOf[to] += 1;
        priceOf[id] = priceUsdc6;
        emit Transfer(address(0), to, id);
        emit Minted(to, id, priceUsdc6);
    }

    function holds(address who) external view returns (bool) {
        return balanceOf[who] > 0;
    }
}

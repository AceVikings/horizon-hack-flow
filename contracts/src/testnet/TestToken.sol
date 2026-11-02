// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestToken (HashKey Chain TESTNET 133 only)
/// @notice Free-to-mint stand-in for USDT / WBTC / WHSK on testnet, where real WHSK is scarce (faucet 1 HSK / 24 h).
/// - `faucet()`: anyone, `faucetAmount` per call, at most once per `FAUCET_COOLDOWN` per address.
/// - `mint(to, amount)`: owner only (deploy script: pool liquidity + vault seeds).
/// No value; never deploy on mainnet.
contract TestToken is ERC20 {
    uint256 public constant FAUCET_COOLDOWN = 1 hours;

    uint8 private immutable _decimals;
    uint256 public immutable faucetAmount;
    address public owner;
    mapping(address => uint256) public lastFaucetAt;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner(address caller);
    error FaucetCooldown(uint256 nextAt);

    /// @param owner_ explicit (the script deploys through the CREATE2 factory, so msg.sender is not the deployer).
    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 faucetAmount_, address owner_)
        ERC20(name_, symbol_)
    {
        require(owner_ != address(0), "owner=0");
        _decimals = decimals_;
        faucetAmount = faucetAmount_;
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Mints `faucetAmount` to the caller; once per hour per address.
    function faucet() external {
        uint256 last = lastFaucetAt[msg.sender];
        if (last != 0 && block.timestamp < last + FAUCET_COOLDOWN) revert FaucetCooldown(last + FAUCET_COOLDOWN);
        lastFaucetAt[msg.sender] = block.timestamp;
        _mint(msg.sender, faucetAmount);
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _mint(to, amount);
    }

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}

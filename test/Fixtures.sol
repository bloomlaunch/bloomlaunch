// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {FeeMath} from "../contracts/FeeMath.sol";
import {FeeEscrow} from "../contracts/FeeEscrow.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// Test-only boundary doubles. These do not implement a real Uniswap pool/vault.
contract MockGraduationExecutor {
    bool public fail = true;
    bool public reportLocked = true;
    mapping(bytes32 => bool) private locked;
    function setFail(bool value) external { fail = value; }
    function setReportLocked(bool value) external { reportLocked = value; }
    function execute(address token, address quote, uint256, uint256) external returns (bytes32 id) {
        require(!fail, "executor failed");
        id = keccak256(abi.encode(token, quote));
        locked[id] = true;
    }
    function isLocked(bytes32 id) external view returns (bool) { return reportLocked && locked[id]; }
    function feeHook() external pure returns (address) { return address(0); }
}
contract MockBuybackFunding {
    mapping(address => mapping(address => uint256)) public balances;
    function deposit(address token, address quote, address beneficiary, uint256 amount) external {
        require(IERC20(quote).transferFrom(msg.sender, address(this), amount));
        balances[token][beneficiary] += amount;
    }
}

// Test-only swap/oracle boundary. Production must use a real canonical-market
// adapter with time-weighted observations; this configurable quote is not one.
contract MockBuybackAdapter {
    uint256 public rate = 1e9;
    uint256 public maximum = 1e18;
    uint8 public mode;
    function configure(uint256 rate_, uint256 maximum_, uint8 mode_) external {
        rate = rate_; maximum = maximum_; mode = mode_;
    }
    function limits(address, address, uint256 amount) external view returns (uint256, uint256) {
        return (amount * rate, maximum);
    }
    function swap(address token, address quote, uint256 amount, uint256 minimum,
        address recipient, uint256 deadline) external
    {
        require(block.timestamp <= deadline && mode != 1, "swap rejected");
        uint256 spend = mode == 3 ? amount / 2 : mode == 4 ? amount + 1 : amount;
        require(IERC20(quote).transferFrom(msg.sender, address(this), spend));
        require(IERC20(token).transfer(recipient, mode == 2 ? minimum - 1 : minimum));
    }
}

contract MockQuote is ERC20 {
    constructor() ERC20("Mock Quote", "MQ") { _mint(msg.sender, 1e30); }
}
contract TaxedQuote is ERC20 {
    constructor() ERC20("Taxed Quote", "TQ") { _mint(msg.sender, 1e30); }
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            super._update(from, address(0), value / 100);
            value -= value / 100;
        }
        super._update(from, to, value);
    }
}
contract FeeHarness {
    function fees(uint256 gross, uint256 rate) external pure returns (uint256,uint256,uint256) {
        return FeeMath.fees(gross, rate);
    }
    function allocate(uint256 amount, uint256 holders, uint256 buyback) external pure returns (uint256,uint256,uint256) {
        return FeeMath.allocate(amount, holders, buyback);
    }
    function grossForNet(uint256 net, uint256 rate) external pure returns (uint256) {
        return FeeMath.grossForNet(net, rate);
    }
}
contract RejectNative {
    function claim(FeeEscrow escrow, address payable recipient) external { escrow.claim(address(0), recipient); }
    receive() external payable { revert("reject"); }
}

/// Test-only wrapped native asset with WETH9 semantics.
contract MockWETH is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}
    function deposit() external payable { _mint(msg.sender, msg.value); }
    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "withdraw failed");
    }
    receive() external payable { _mint(msg.sender, msg.value); }
}
/// Deterministic deployer used to place the fee hook at an address whose low
/// bits encode its V4 permissions. Deployment scripts use the same scheme.
contract Create2Deployer {
    event Deployed(address addr);
    function deploy(bytes32 salt, bytes calldata initCode) external returns (address addr) {
        bytes memory code = initCode;
        assembly { addr := create2(0, add(code, 0x20), mload(code), salt) }
        require(addr != address(0), "create2 failed");
        emit Deployed(addr);
    }
}
/// Test-only quote assets with non-18 decimals (stablecoin-like) and a stock-like token.
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin (test)", "USDC") { _mint(msg.sender, 1e15); }
    function decimals() public pure override returns (uint8) { return 6; }
}
contract MockStock is ERC20 {
    constructor() ERC20("Tokenized Stock (test)", "tSTOCK") { _mint(msg.sender, 1e27); }
}
/// Test-only external token whose transfers to a blocked address revert, used to
/// show one failing refund leg cannot block the other.
contract MockBlockable is ERC20 {
    mapping(address => bool) public blocked;
    constructor() ERC20("Old Community Coin", "OLD") { _mint(msg.sender, 1e30); }
    function setBlocked(address account, bool value) external { blocked[account] = value; }
    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[to], "blocked");
        super._update(from, to, value);
    }
}
/// Test-only external community token for local migration demos.
contract MockOldToken is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) { _mint(msg.sender, 1e30); }
}

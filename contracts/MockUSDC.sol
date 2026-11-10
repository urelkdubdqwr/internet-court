// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal EIP-3009-compatible test asset (USDC mechanics: 6 decimals,
/// EIP-712 TransferWithAuthorization). Lets the demo run x402 "exact" scheme
/// with a self-hosted verifier/settler on Base Sepolia where test USDC is hard
/// to obtain. Same authorization flow as real USDC.
contract MockUSDC {
    string public name = "Mock USD Coin (demo)";
    string public version = "2";
    string public symbol = "mUSDC";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    address public immutable owner;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // authorization state for EIP-3009
    mapping(address => mapping(bytes32 => bool)) public authorizationState; // from -> nonce -> used

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    bytes32 public immutable DOMAIN_SEPARATOR;

    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
        keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");

    constructor(string memory _name, address _minter) {
        name = _name;
        owner = msg.sender;
        bytes32 d = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(_name)),
                keccak256(bytes("2")),
                block.chainid,
                address(this)
            )
        );
        DOMAIN_SEPARATOR = d;
        _mint(_minter, 1_000_000 * 10 ** 6); // 1,000,000 mUSDC to the deployer
    }

    function _mint(address to, uint256 v) internal {
        totalSupply += v;
        balanceOf[to] += v;
        emit Transfer(address(0), to, v);
    }

    function transfer(address to, uint256 v) external returns (bool) {
        _move(msg.sender, to, v);
        return true;
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        emit Approval(msg.sender, s, v);
        return true;
    }

    function transferFrom(address f, address t, uint256 v) external returns (bool) {
        uint256 a = allowance[f][msg.sender];
        require(a >= v, "allowance");
        if (a != type(uint256).max) {
            allowance[f][msg.sender] = a - v;
        }
        _move(f, t, v);
        return true;
    }

    function _move(address f, address t, uint256 v) internal {
        require(balanceOf[f] >= v, "balance");
        balanceOf[f] -= v;
        balanceOf[t] += v;
        emit Transfer(f, t, v);
    }

    function _authorizationHash(
        address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes32 typehash
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                hex"1901",
                DOMAIN_SEPARATOR,
                keccak256(abi.encode(typehash, from, to, value, validAfter, validBefore, nonce))
            )
        );
    }

    function _use(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s, bool receive_only) internal {
        require(block.timestamp > validAfter, "auth:not-yet-valid");
        require(block.timestamp < validBefore, "auth:expired");
        require(!authorizationState[from][nonce], "auth:nonce-used");
        bytes32 digest = _authorizationHash(from, to, value, validAfter, validBefore, nonce, receive_only ? RECEIVE_WITH_AUTHORIZATION_TYPEHASH : TRANSFER_WITH_AUTHORIZATION_TYPEHASH);
        address rec = ecrecover(digest, v, r, s);
        require(rec == from, "auth:bad-signature");
        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _move(from, to, value);
    }

    /// Anyone may settle with the payer's signature.
    function transferWithAuthorization(
        address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s
    ) external {
        _use(from, to, value, validAfter, validBefore, nonce, v, r, s, false);
    }

    /// Only the payee may pull with this variant (what x402 servers use).
    function receiveWithAuthorization(
        address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s
    ) external {
        require(msg.sender == to, "auth:caller-not-payee");
        _use(from, to, value, validAfter, validBefore, nonce, v, r, s, true);
    }
}

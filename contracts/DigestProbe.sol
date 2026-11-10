// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Debug helper: exposes the exact EIP-712 digest + ecrecover result for the
/// deployed demo token, so off-chain and on-chain computation can be compared.
contract DigestProbe {
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");

    address public immutable token;

    constructor(address _token) {
        token = _token;
    }

    function domainSeparator() public view returns (bytes32) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("DOMAIN_SEPARATOR()"));
        require(ok, "ds failed");
        return abi.decode(data, (bytes32));
    }

    function digest(
        address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce
    ) public view returns (bytes32) {
        bytes32 ds = domainSeparator();
        return keccak256(
            abi.encodePacked(
                hex"1901",
                ds,
                keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce))
            )
        );
    }

    function recover(uint8 v, bytes32 r, bytes32 s) public pure returns (address) {
        return ecrecover(keccak256("probe"), v, r, s);
    }
}

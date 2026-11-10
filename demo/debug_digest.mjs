// debug_digest.mjs — compare the exact digest Solidity builds vs EIP-712 JS digest
import fs from 'fs';
import { ethers } from 'ethers';
import { buildAuthorization, signPayment, EIP3009_TYPES } from './x402.mjs';

const cfg = JSON.parse(fs.readFileSync(new URL('./deployed.json', import.meta.url), 'utf8'));
const buyerKey = fs.readFileSync(new URL('./.keys/buyer.key', import.meta.url), 'utf8').trim();
const buyer = new ethers.Wallet(buyerKey.startsWith('0x') ? buyerKey : '0x' + buyerKey);

const domain = { name: cfg.token.name, version: cfg.token.version, chainId: 84532, verifyingContract: cfg.token.address };
const accept = {
  scheme: 'exact', network: cfg.network, maxAmountRequired: '100',
  resource: 'http://x/x', description: 'x', mimeType: 'application/json',
  payTo: '0x1A24e5C53B1438f15B25c819fEe1F894e6D131f2', maxTimeoutSeconds: 120,
  asset: cfg.token.address, extra: { name: cfg.token.name, version: cfg.token.version },
};
const auth = buildAuthorization(accept, buyer.address);
const signed = await signPayment(buyer, accept, auth);

const eip712Digest = ethers.TypedDataEncoder.hash(domain, EIP3009_TYPES, auth);

// replicate Solidity: keccak256(0x1901 || DOMAIN_SEPARATOR || keccak256(abi.encode(typehash,...)))
const TRANSFER_TYPEHASH = ethers.id('TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)');
const RECEIVE_TYPEHASH = ethers.id('ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)');
const structHash = (typehash) => ethers.solidityPackedKeccak256(
  ['bytes1', 'bytes1', 'bytes32', 'bytes32'],
  ['0x19', '0x01', domain_separator, ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'address', 'address', 'uint256', 'uint256', 'uint256', 'bytes32'],
    [typehash, auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce]))]);

const domain_separator = ethers.TypedDataEncoder.hashDomain(domain);
const digestTransfer = structHash(TRANSFER_TYPEHASH);
const digestReceive = structHash(RECEIVE_TYPEHASH);

console.log('eip712 (js)     ', eip712Digest);
console.log('solidity Transfer', digestTransfer, digestTransfer === eip712Digest ? 'MATCH' : 'DIFF');
console.log('solidity Receive ', digestReceive, digestReceive === eip712Digest ? 'MATCH' : 'DIFF');
console.log('recover(transfer)', ethers.recoverAddress(digestTransfer, signed.signature), 'buyer:', buyer.address);
console.log('recover(eip712)  ', ethers.recoverAddress(eip712Digest, signed.signature));

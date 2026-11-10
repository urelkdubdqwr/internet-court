// debug_settle.mjs — surface the on-chain revert reason for the EIP-3009 settle
import fs from 'fs';
import { ethers } from 'ethers';
import { buildAuthorization, signPayment, EIP3009_TYPES } from './x402.mjs';

const cfg = JSON.parse(fs.readFileSync(new URL('./deployed.json', import.meta.url), 'utf8'));
const agents = JSON.parse(fs.readFileSync(new URL('./agents.json', import.meta.url), 'utf8'));
const buyerKey = fs.readFileSync(new URL('./.keys/buyer.key', import.meta.url), 'utf8').trim();
const sellerKey = fs.readFileSync(new URL('./.keys/seller.key', import.meta.url), 'utf8').trim();
const provider = new ethers.JsonRpcProvider(cfg.rpc, cfg.chainId);
const buyer = new ethers.Wallet(buyerKey.startsWith('0x') ? buyerKey : '0x' + buyerKey, provider);
const seller = new ethers.Wallet(sellerKey.startsWith('0x') ? sellerKey : '0x' + sellerKey, provider);

const accept = {
  scheme: 'exact', network: cfg.network, maxAmountRequired: '100',
  resource: 'http://127.0.0.1:1/x', description: 'x', mimeType: 'application/json',
  payTo: agents.seller.address, maxTimeoutSeconds: 120,
  asset: cfg.token.address, extra: { name: cfg.token.name, version: cfg.token.version },
};
const auth = buildAuthorization(accept, buyer.address);
const signed = await signPayment(buyer, accept, auth);

const token = new ethers.Contract(cfg.token.address, [
  'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)',
  'function receiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function balanceOf(address) view returns (uint256)',
  'function authorizationState(address,bytes32) view returns (bool)',
], seller);

console.log('chainId', (await provider.getNetwork()).chainId.toString());
console.log('contract DOMAIN_SEPARATOR', await token.DOMAIN_SEPARATOR());
const domain = { name: cfg.token.name, version: cfg.token.version, chainId: Number(cfg.chainId), verifyingContract: cfg.token.address };
console.log('js  digest', ethers.TypedDataEncoder.hash(domain, EIP3009_TYPES, auth));
const sig = ethers.Signature.from(signed.signature);

try {
  await token.transferWithAuthorization.staticCall(
    auth.from, auth.to, BigInt(auth.value), BigInt(auth.validAfter), BigInt(auth.validBefore), auth.nonce, sig.v, sig.r, sig.s,
  );
  console.log('staticCall OK');
} catch (e) {
  console.log('staticCall FAILED:');
  console.log(' shortMessage:', e.shortMessage || e.message);
  console.log(' reason:', e.reason);
  console.log(' data:', e.data);
}

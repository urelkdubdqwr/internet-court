// debug_sig.mjs — reproduce sign/verify mismatch and print the exact typed-data inputs
import fs from 'fs';
import { ethers } from 'ethers';
import { EIP3009_TYPES, buildAuthorization, signPayment } from './x402.mjs';

const cfg = JSON.parse(fs.readFileSync(new URL('./deployed.json', import.meta.url), 'utf8'));
const key = fs.readFileSync(new URL('./.keys/buyer.key', import.meta.url), 'utf8').trim();
const buyer = new ethers.Wallet(key.startsWith('0x') ? key : '0x' + key);

const accept = {
  scheme: 'exact', network: cfg.network, maxAmountRequired: '100',
  resource: 'http://127.0.0.1:7791/api/price-oracle', description: 'x', mimeType: 'application/json',
  payTo: '0x1A24e5C53B1438f15B25c819fEe1F894e6D131f2', maxTimeoutSeconds: 120,
  asset: cfg.token.address, extra: { name: cfg.token.name, version: cfg.token.version },
};
const auth = buildAuthorization(accept, buyer.address);
const signed = await signPayment(buyer, accept, auth);
const domain = { name: accept.extra.name, version: accept.extra.version, chainId: 84532, verifyingContract: accept.asset };
console.log('domain', JSON.stringify(domain));
console.log('auth  ', JSON.stringify(auth));
console.log('sig   ', signed.signature);
console.log('recovered', ethers.verifyTypedData(domain, EIP3009_TYPES, auth, signed.signature));
console.log('expected ', buyer.address);
// juga cek hashDomain vs kontrak
console.log('digest', ethers.TypedDataEncoder.hash(domain, EIP3009_TYPES, auth));

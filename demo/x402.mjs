// x402.mjs — tiny, dependency-light x402 "exact" scheme implementation
// (EIP-3009 transferWithAuthorization, same mechanics as USDC).
//
// Server side : 402 challenge -> verify authorization -> settle on-chain -> 200
// Client side : payFetch() retries the request with an X-PAYMENT header.
import { ethers } from 'ethers';

export const PAYMENT_HEADER = 'X-PAYMENT';
export const PAYMENT_RESPONSE_HEADER = 'X-PAYMENT-RESPONSE';

export const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

export function randomNonce() {
  return ethers.hexlify(ethers.randomBytes(32));
}

/// 402 response body (x402 v1 shape) for one offer. `accept.extra` carries the
/// EIP-712 domain info (name/version) the signer and settler must agree on.
export function challenge(accept) {
  const extra = accept.extra || {};
  return {
    x402Version: 1,
    error: 'X-PAYMENT header is required',
    accepts: [{
      scheme: 'exact',
      network: accept.network,
      maxAmountRequired: String(accept.maxAmountRequired),
      resource: accept.resource,
      description: accept.description,
      mimeType: 'application/json',
      payTo: accept.payTo,
      maxTimeoutSeconds: accept.maxTimeoutSeconds ?? 120,
      asset: accept.asset,
      extra: { name: extra.name, version: extra.version },
    }],
  };
}

/// Step 1 (server): turn an offer into an expected authorization template.
export function buildAuthorization(accept, from, { validForSeconds = 120 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    from,
    to: accept.payTo,
    value: String(accept.maxAmountRequired),
    validAfter: String(now - 5),
    validBefore: String(now + validForSeconds),
    nonce: randomNonce(),
  };
}

/// Step 2 (client): sign the authorization (off-chain, gas paid by the settler).
export async function signPayment(wallet, accept, authorization) {
  const domain = {
    name: accept.extra.name,
    version: accept.extra.version,
    chainId: accept.network === 'base-sepolia' ? 84532 : Number(accept.network),
    verifyingContract: accept.asset,
  };
  const signature = await wallet.signTypedData(domain, EIP3009_TYPES, authorization);
  return { signature, authorization };
}

export function encodePayment(accept, { signature, authorization }) {
  const payload = {
    x402Version: 1,
    scheme: 'exact',
    network: accept.network,
    payload: { signature, authorization },
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

export function decodePayment(header) {
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/// Step 3 (server): verify the signature locally before spending gas.
export async function verifyPayment(payment, accept, provider) {
  if (!payment || payment.scheme !== 'exact') return { valid: false, reason: 'bad scheme' };
  const { authorization, signature } = payment.payload || {};
  if (!authorization || !signature) return { valid: false, reason: 'missing payload' };
  if (authorization.to.toLowerCase() !== accept.payTo.toLowerCase()) return { valid: false, reason: 'wrong payTo' };
  if (BigInt(authorization.value) < BigInt(accept.maxAmountRequired)) return { valid: false, reason: 'underpaid' };
  const now = Math.floor(Date.now() / 1000);
  if (Number(authorization.validBefore) < now) return { valid: false, reason: 'expired' };

  const domain = {
    name: accept.extra.name,
    version: accept.extra.version,
    chainId: accept.network === 'base-sepolia' ? 84532 : Number(accept.network),
    verifyingContract: accept.asset,
  };
  const recovered = ethers.verifyTypedData(domain, EIP3009_TYPES, authorization, signature);
  if (recovered.toLowerCase() !== authorization.from.toLowerCase()) {
    return { valid: false, reason: 'signature mismatch' };
  }

  const token = new ethers.Contract(accept.asset, [
    'function balanceOf(address) view returns (uint256)',
    'function authorizationState(address,bytes32) view returns (bool)',
  ], provider);
  const [balance, used] = await Promise.all([
    token.balanceOf(authorization.from),
    token.authorizationState(authorization.from, authorization.nonce),
  ]);
  if (used) return { valid: false, reason: 'nonce already used' };
  if (BigInt(balance) < BigInt(authorization.value)) return { valid: false, reason: 'insufficient balance' };

  return { valid: true, payer: authorization.from };
}

/// Step 4 (server): settle on-chain — the payee pulls the funds.
export async function settlePayment(accept, authorization, signature, settlerWallet) {
  const token = new ethers.Contract(accept.asset, [
    'function receiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)',
    'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)',
    'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  ], settlerWallet);

  const sig = ethers.Signature.from(signature);
  const args = [
    authorization.from, authorization.to, BigInt(authorization.value),
    BigInt(authorization.validAfter), BigInt(authorization.validBefore), authorization.nonce,
    sig.v, sig.r, sig.s,
  ];
  // The EIP-3009 authorization is signed over TransferWithAuthorization, so the
  // settler submits that (open) variant: any party can push the signed transfer
  // on-chain exactly once, and the nonce makes it replay-proof.
  const tx = await token.transferWithAuthorization(...args);
  const receipt = await tx.wait();
  return { txHash: receipt.hash, block: receipt.blockNumber, status: receipt.status };
}

/// Client helper: do a request; on 402 pay and retry. Returns {response, payment, settlement}.
export async function payFetch(url, { wallet, fetchImpl = fetch, method = 'GET', body, headers = {}, maxPayment } = {}) {
  const first = await fetchImpl(url, { method, body, headers });
  if (first.status !== 402) return { response: first, paid: false };

  const challengeBody = await first.json();
  const accept = (challengeBody.accepts || [])[0];
  if (!accept) throw new Error('402 without accepts[]');
  if (maxPayment !== undefined && BigInt(accept.maxAmountRequired) > BigInt(maxPayment)) {
    throw new Error(`refusing to pay ${accept.maxAmountRequired} > cap ${maxPayment}`);
  }

  const authorization = buildAuthorization(accept, wallet.address);
  const signed = await signPayment(wallet, accept, authorization);
  const header = encodePayment(accept, signed);

  const retry = await fetchImpl(url, { method, body, headers: { ...headers, [PAYMENT_HEADER]: header } });
  const settlementHeader = retry.headers.get(PAYMENT_RESPONSE_HEADER);
  return {
    response: retry,
    paid: true,
    accept,
    authorization,
    settlement: settlementHeader ? JSON.parse(Buffer.from(settlementHeader, 'base64').toString('utf8')) : null,
  };
}

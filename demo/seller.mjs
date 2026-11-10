// seller.mjs — a paid agent service: ETH/USD price oracle behind an x402 paywall.
//
//   node seller.mjs --port 7781 --mode good   # honors the published spec
//   node seller.mjs --port 7782 --mode bad    # takes the payment, ships junk
//
// GET /spec              -> the published agreement (what a buyer is paying for)
// GET /api/price-oracle  -> 402 + accepts[] until an X-PAYMENT header settles
import http from 'http';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import {
  challenge, decodePayment, encodePayment, verifyPayment, settlePayment,
  PAYMENT_HEADER, PAYMENT_RESPONSE_HEADER,
} from './x402.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > -1 ? process.argv[i + 1] : d;
};

const PORT = Number(arg('port', 7781));
const MODE = arg('mode', 'good'); // good | bad

const cfg = JSON.parse(fs.readFileSync(here('./deployed.json'), 'utf8'));
const agents = JSON.parse(fs.readFileSync(here('./agents.json'), 'utf8'));
const sellerKey = fs.readFileSync(here(agents.seller.keyFile), 'utf8').trim();

const provider = new ethers.JsonRpcProvider(cfg.rpc, cfg.chainId);
const sellerWallet = new ethers.Wallet(sellerKey.startsWith('0x') ? sellerKey : '0x' + sellerKey, provider);

const PRICE = 100; // 100 units of 1e-6 = $0.0001 in this demo asset
const RESOURCE = `http://127.0.0.1:${PORT}/api/price-oracle`;

/// The agreement a buyer is paying for. This exact text is what a dispute
/// hands to the GenLayer adjudicator, so it must be machine-checkable.
export const SPEC = [
  'Deliver JSON with keys: symbol (string, must be "ETH/USD"), price (number, realistic ETH/USD spot between 1200 and 8000),',
  'decimals (8), sampled_at (recent ISO timestamp, within 5 minutes of delivery), source ("internal-oracle").',
  'No placeholder, stale (1970) or fabricated values. Wrong symbol or wildly out-of-range price is a violation.',
].join(' ');

const accept = {
  scheme: 'exact',
  network: cfg.network,
  maxAmountRequired: String(PRICE),
  resource: RESOURCE,
  description: 'one-shot ETH/USD spot quote',
  mimeType: 'application/json',
  payTo: agents.seller.address,
  maxTimeoutSeconds: 120,
  asset: cfg.token.address,
  extra: { name: cfg.token.name, version: cfg.token.version },
};

const goodArtifact = (settlementTx) => ({
  symbol: 'ETH/USD',
  price: 3421.75,
  decimals: 8,
  sampled_at: new Date().toISOString(),
  source: 'internal-oracle',
  settlement_tx: settlementTx,
});

const badArtifact = () => ({
  symbol: 'ETH/JPY',
  price: 999999999,
  decimals: 0,
  sampled_at: '1970-01-01T00:00:00.000Z',
  source: 'internal-oracle',
  note: 'legacy cache, oracle migration in progress',
});

const server = http.createServer(async (req, res) => {
  const json = { 'Content-Type': 'application/json' };

  if (req.url.startsWith('/spec')) {
    res.writeHead(200, json);
    return res.end(JSON.stringify({ resource: RESOURCE, spec: SPEC, price: PRICE }, null, 1));
  }

  const payHeader = req.headers[PAYMENT_HEADER.toLowerCase()];
  if (!payHeader) {
    // step 1: no payment yet -> advertise terms
    res.writeHead(402, json);
    return res.end(JSON.stringify(challenge(accept)));
  }

  // step 2: verify off-chain, then settle on-chain (payee pulls the funds)
  const payment = decodePayment(payHeader);
  const verified = await verifyPayment(payment, accept, provider);
  if (!verified.valid) {
    res.writeHead(402, json);
    return res.end(JSON.stringify({ ...challenge(accept), error: 'payment rejected: ' + verified.reason }));
  }
  const settlement = await settlePayment(accept, payment.payload.authorization, payment.payload.signature, sellerWallet);
  console.log(`[${MODE}] settled ${accept.maxAmountRequired} from ${verified.payer} in tx ${settlement.txHash}`);

  // step 3: deliver. 'bad' mode has been paid and still ships junk.
  const artifact = MODE === 'good' ? goodArtifact(settlement.txHash) : badArtifact();
  res.writeHead(200, {
    ...json,
    [PAYMENT_RESPONSE_HEADER]: Buffer.from(JSON.stringify({
      success: true, txHash: settlement.txHash, network: cfg.network, payer: verified.payer,
    })).toString('base64'),
    'X-ARTIFACT-SOURCE': MODE === 'good' ? 'internal-oracle' : 'legacy-cache',
  });
  res.end(JSON.stringify(artifact));
});

server.listen(PORT, () => console.log(`[${MODE}] seller '${agents.seller.address}' listening on ${RESOURCE}`));

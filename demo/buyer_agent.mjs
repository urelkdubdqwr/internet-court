// buyer_agent.mjs — an autonomous buyer that pays via x402 and ENFORCES the
// published spec through the GenLayer adjudicated paywall contract.
//
//   node buyer_agent.mjs --url http://127.0.0.1:7781 --wallet buyer [--contract 0x..]
//
// Flow:
//   1. GET /spec                      -> the machine-checkable agreement
//   2. payFetch(resource)             -> 402 -> sign EIP-3009 -> retry -> settle -> artifact
//   3. verify artifact against spec   -> violation? open a GenLayer case on-chain
//   4. adjudicate                     -> LLM-led verdict, reputation updated
import fs from 'fs';
import { ethers } from 'ethers';
import { payFetch, PAYMENT_RESPONSE_HEADER } from './x402.mjs';
import { openCase, adjudicate, getCase, getReputation } from './genlayer.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > -1 ? process.argv[i + 1] : d;
};

const URL_BASE = arg('url', 'http://127.0.0.1:7781');
const CONTRACT = arg('contract', JSON.parse(fs.readFileSync(new URL('./deployed.json', import.meta.url))).genlayerContract || '');
const RESOURCE = URL_BASE.replace(/\/$/, '') + '/api/price-oracle';

const cfg = JSON.parse(fs.readFileSync(new URL('./deployed.json', import.meta.url), 'utf8'));
const agents = JSON.parse(fs.readFileSync(new URL('./agents.json', import.meta.url), 'utf8'));
const buyerKey = fs.readFileSync(new URL(agents.buyer.keyFile, import.meta.url), 'utf8').trim();
const provider = new ethers.JsonRpcProvider(cfg.rpc, cfg.chainId);
const wallet = new ethers.Wallet(buyerKey.startsWith('0x') ? buyerKey : '0x' + buyerKey, provider);

// --- local spec check (mirrors what the on-chain adjudicator is asked to rule on)
function checkSpec(spec, artifact) {
  const violations = [];
  const expectSymbol = (spec.match(/symbol \(string, must be "([^"]+)"\)/) || [])[1];
  const expectSource = (spec.match(/source \("([^"]+)"\)/) || [])[1];
  const range = spec.match(/between (\d+) and (\d+)/);
  const lo = range ? Number(range[1]) : 0;
  const hi = range ? Number(range[2]) : Infinity;

  if (!artifact || typeof artifact !== 'object') return ['artifact is not JSON'];
  if (expectSymbol && artifact.symbol !== expectSymbol) violations.push(`symbol expected ${expectSymbol}, got ${artifact.symbol}`);
  if (typeof artifact.price !== 'number') violations.push(`price not a number`);
  else if (artifact.price < lo || artifact.price > hi) violations.push(`price ${artifact.price} out of range [${lo}, ${hi}]`);
  if (expectSource && artifact.source !== expectSource) violations.push(`source expected ${expectSource}, got ${artifact.source}`);
  const t = Date.parse(artifact.sampled_at);
  if (Number.isNaN(t)) violations.push(`sampled_at unparseable: ${artifact.sampled_at}`);
  else {
    if (t < Date.UTC(2000, 0, 1)) violations.push('sampled_at is a placeholder epoch');
    else if (Date.now() - t > 5 * 60 * 1000) violations.push('sampled_at older than 5 minutes');
  }
  return violations;
}

const result = { url: URL_BASE, resource: RESOURCE, buyer: wallet.address };

// 1. published agreement
const specRes = await fetch(URL_BASE.replace(/\/$/, '') + '/spec');
const specBody = await specRes.json();
result.spec = specBody.spec;
console.log('[buyer] published spec fetched');

// 2. pay
const paid = await payFetch(RESOURCE, { wallet, maxPayment: cfg.x402Cap || 1000000 });
result.paid = paid.paid;
result.settlement = paid.settlement;
if (!paid.paid || paid.response.status !== 200) {
  result.error = 'payment or delivery failed';
  console.log('[buyer] FAILED at payment/delivery');
} else {
  const settlementHeader = paid.response.headers.get(PAYMENT_RESPONSE_HEADER);
  const artifact = await paid.response.json();
  result.artifact = artifact;
  let hdr = {};
  try { hdr = settlementHeader ? JSON.parse(Buffer.from(settlementHeader, 'base64').toString('utf8')) : {}; } catch { /* keep {} */ }
  result.paymentRef = hdr.txHash || paid.settlement?.txHash;
  console.log(`[buyer] delivered artifact: ${JSON.stringify(artifact).slice(0, 140)}`);

  // 3. enforce
  const violations = checkSpec(specBody.spec, artifact);
  result.violations = violations;
  if (violations.length === 0) {
    console.log('[buyer] artifact conforms — deal closed, no dispute');
  } else if (!CONTRACT) {
    console.log('[buyer] violations:', violations.join('; '), '— no contract wired, cannot dispute');
  } else {
    console.log('[buyer] SPEC VIOLATION -> opening GenLayer case:', violations.join('; '));
    const caseId = 'demo-' + Date.now();
    await openCase(CONTRACT, {
      caseId,
      seller: paid.accept.payTo,
      amountAtto: (BigInt(paid.accept.maxAmountRequired) * 10n ** 12n).toString(),
      spec: specBody.spec,
      paymentRef: result.paymentRef || 'unknown',
      deliveryUrl: RESOURCE,
      deliveryInline: JSON.stringify(artifact),
    });
    result.caseId = caseId;
    await adjudicate(CONTRACT, caseId);
    const c = await getCase(CONTRACT, caseId);
    result.verdict = c;
    console.log(`[buyer] verdict: ${c.verdict ?? c.status ?? JSON.stringify(c).slice(0, 200)}`);
    const rep = await getReputation(CONTRACT, paid.accept.payTo);
    result.reputation = rep;
    console.log(`[buyer] seller reputation: score=${rep.score} deals=${rep.deals} releases=${rep.releases} partials=${rep.partials} refunds=${rep.refunds} unpaid=${rep.unpaid_atto}`);
  }
}

fs.writeFileSync(new URL(`./buyer_result_${URL_BASE.split(':').pop()}.json`, import.meta.url), JSON.stringify(result, null, 2));
console.log('[buyer] result written');

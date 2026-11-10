// run_demo.mjs — full Internet Court demo, one command:
//   node run_demo.mjs
//
// 1. spawns a good seller (7781) and a bad seller (7782), both x402-paid
// 2. buyer agent pays + accepts the conforming artifact (release, no dispute)
// 3. buyer agent pays the bad seller, detects the violation, opens a case
//    on the GenLayer adjudicated paywall contract, runs adjudication, and
//    reads back the on-chain verdict + seller reputation
// 4. writes evidence_<ts>.json and prints a machine-readable summary
import { spawn } from 'child_process';
import { setTimeout as sleep } from 'timers/promises';
import fs from 'fs';

const here = (p) => new URL(p, import.meta.url);
const CONTRACT = process.env.GL_CONTRACT || '';
if (!CONTRACT) { console.error('run_demo: set GL_CONTRACT=<intelligent-contract address>'); process.exit(1); }

const waitHealthy = async (port, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/spec`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  return false;
};

const run = (args) => new Promise((resolve) => {
  const p = spawn('node', args, { cwd: import.meta.dirname, env: process.env });
  let out = '';
  p.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
  p.stderr.on('data', (d) => { out += d; process.stderr.write(d); });
  p.on('exit', (code) => resolve({ code, out }));
});

const summary = { started_at: new Date().toISOString(), contract: CONTRACT, legs: {} };

// 1. sellers
const good = spawn('node', ['seller.mjs', '--port', '7781', '--mode', 'good'], { cwd: import.meta.dirname });
const bad  = spawn('node', ['seller.mjs', '--port', '7782', '--mode', 'bad'],  { cwd: import.meta.dirname });
good.stdout.on('data', (d) => process.stdout.write(d));
bad.stdout.on('data', (d) => process.stdout.write(d));
console.log('[demo] sellers spawning…');
summary.legs.good_up = await waitHealthy(7781);
summary.legs.bad_up  = await waitHealthy(7782);

// 2. honest leg
console.log('\n===== LEG 1: honest seller =====');
summary.legs.good = await run(['buyer_agent.mjs', '--url', 'http://127.0.0.1:7781', '--contract', CONTRACT]);

// 3. dishonest leg (pay -> junk -> on-chain dispute)
console.log('\n===== LEG 2: bad seller -> dispute =====');
summary.legs.bad = await run(['buyer_agent.mjs', '--url', 'http://127.0.0.1:7782', '--contract', CONTRACT]);

good.kill(); bad.kill();

// 4. evidence file + compact verdict
const readResult = (port) => {
  try { return JSON.parse(fs.readFileSync(here(`./buyer_result_${port}.json`), 'utf8')); }
  catch { return null; }
};
const g = readResult('7781'), b = readResult('7782');
summary.summary = {
  leg1_paid: !!g?.paid, leg1_conforms: (g?.violations || []).length === 0,
  leg2_paid: !!b?.paid, leg2_violations: b?.violations ?? null,
  leg2_case: b?.caseId ?? null, leg2_verdict: b?.verdict?.verdict ?? null,
  leg2_reputation: b?.reputation ? { score: b.reputation.score, deals: b.reputation.deals, releases: b.reputation.releases, partials: b.reputation.partials, refunds: b.reputation.refunds } : null,
};
const evidence = `evidence_${Date.now()}.json`;
fs.writeFileSync(here('./' + evidence), JSON.stringify(summary, null, 2));
console.log(`\n[demo] evidence: ${evidence}`);
console.log('[demo] SUMMARY ' + JSON.stringify(summary.summary, null, 1));
// keep the full per-leg transcripts next to the evidence (jangan cuma tail)
fs.writeFileSync(here('./' + evidence.replace('evidence_', 'transcript_')),
  JSON.stringify({ good: summary.legs.good?.out, bad: summary.legs.bad?.out }, null, 1));

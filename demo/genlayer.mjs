// genlayer.mjs — client for the AdjudicatedPaywall Intelligent Contract through
// the `genlayer` CLI (works with studionet/testnet-bradbury). Non-interactive:
// the keystore password is piped from GL_PW_FILE (default ~/.config/genlayer-demo/pw.txt).
import { execFile } from 'child_process';
import fs from 'fs';

const PW_FILE = process.env.GL_PW_FILE || process.env.HOME + '/.config/genlayer-demo/pw.txt';

function gl(args, { timeoutMs = 240000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = execFile('genlayer', args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !/ACCEPTED|Result|address/i.test(stdout)) {
        return reject(new Error(`genlayer ${args[0]} failed: ${String(err.message)}\n${stdout}${stderr}`));
      }
      resolve(stdout + (stderr ? '\n' + stderr : ''));
    });
    try {
      p.stdin.write(fs.readFileSync(PW_FILE, 'utf8').trim() + '\n');
      p.stdin.end();
    } catch { /* password optional for pure views */ }
  });
}

const extract = (label, out) => {
  const i = out.lastIndexOf(label);
  if (i === -1) return null;
  const start = out.indexOf('{', i);
  if (start === -1) return out.slice(i);
  const stop = out.indexOf('✔', start);
  const end = out.lastIndexOf('}', stop === -1 ? out.length : stop);
  return out.slice(start, end + 1);
};

export async function openCase(contract, c) {
  const out = await gl(['write', contract, 'open_case', '--args',
    c.caseId, c.seller, String(c.amountAtto), c.spec, c.paymentRef, c.deliveryUrl, c.deliveryInline]);
  console.log('genlayer open_case ->', extract('status_name', out)?.trim() || 'sent');
  return out;
}

export async function adjudicate(contract, caseId) {
  const out = await gl(['write', contract, 'adjudicate', '--args', caseId]);
  return out;
}

export async function view(contract, method, args = []) {
  const out = await gl(['call', contract, method, '--args', ...args.map(String)], { timeoutMs: 120000 });
  const block = extract('Result', out) ?? out;
  return block;
}

export async function getCase(contract, caseId) {
  const out = await view(contract, 'get_case', [caseId]);
  const grabStr = (k) => {
    const m = out.match(new RegExp(`['"]?${k}['"]?\\s*:\\s*(['"])([\\s\\S]*?)\\1`));
    return m ? m[2] : undefined;
  };
  // long fields (reasoning) may span a lot; capture lazily to the trailing quote+comma+newline
  const grabLong = (k) => {
    const m = out.match(new RegExp(`['"]?${k}['"]?\\s*:\\s*(['"])([\\s\\S]*?)\\1,\\s*\\n`));
    return m ? m[2].replace(/\\'/g, "'").replace(/\\"/g, '"') : undefined;
  };
  return {
    status: grabStr('status'),
    verdict: grabStr('verdict'),
    quality_bucket: grabStr('quality_bucket'),
    reasoning: grabLong('reasoning') ?? grabStr('reasoning') ?? '',
    raw: out,
  };
}

export async function getReputation(contract, agent) {
  const out = await view(contract, 'get_reputation', [agent]);
  const grabStr = (k) => {
    const m = out.match(new RegExp(`['"]?${k}['"]?\\s*:\\s*'([^']*)'`));
    return m ? m[1] : undefined;
  };
  const grabNum = (k) => {
    const m = out.match(new RegExp(`['"]?${k}['"]?\\s*:\\s*\\(?(-?\\d+)`));
    return m ? Number(m[1]) : 0;
  };
  return {
    agent: grabStr('agent') || agent,
    score: grabNum('score'),
    deals: grabNum('deals'),
    releases: grabNum('releases'),
    partials: grabNum('partials'),
    refunds: grabNum('refunds'),
    unpaid_atto: grabStr('unpaid_atto') ?? '0',
    raw: out,
  };
}

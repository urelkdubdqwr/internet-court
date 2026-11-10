// check_case.mjs — re-read a case + reputation from the deployed adjudicator
//   node check_case.mjs <caseId>
import { getCase, getReputation } from './genlayer.mjs';
import fs from 'fs';

const cfg = JSON.parse(fs.readFileSync(new URL('./deployed.json', import.meta.url), 'utf8'));
const agents = JSON.parse(fs.readFileSync(new URL('./agents.json', import.meta.url), 'utf8'));
const caseId = process.argv[2];
const c = await getCase(cfg.genlayerContract, caseId);
console.log('status     :', c.status);
console.log('verdict    :', c.verdict);
console.log('bucket     :', c.quality_bucket);
console.log('reasoning  :', (c.reasoning || '').slice(0, 300));
const rep = await getReputation(cfg.genlayerContract, agents.seller.address);
console.log('seller rep :', JSON.stringify({ score: rep.score, deals: rep.deals, releases: rep.releases, partials: rep.partials, refunds: rep.refunds, unpaid_atto: rep.unpaid_atto }));

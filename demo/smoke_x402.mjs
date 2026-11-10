// smoke_x402.mjs — quick E2E of the x402 leg: buyer pays the good seller once.
import fs from 'fs';
import http from 'http';
import { ethers } from 'ethers';
import { payFetch } from './x402.mjs';

const provider = new ethers.JsonRpcProvider((JSON.parse(fs.readFileSync(new URL('./deployed.json', import.meta.url), 'utf8'))).rpc, 84532);
const buyerKey = fs.readFileSync(new URL('./.keys/buyer.key', import.meta.url), 'utf8').trim();
const buyer = new ethers.Wallet(buyerKey.startsWith('0x') ? buyerKey : '0x' + buyerKey, provider);
console.log('buyer', buyer.address);

const port = 7791;
const srv = http.createServer(() => {});
const { spawn } = await import('node:child_process');
const seller = spawn('node', ['seller.mjs', '--port', String(port), '--mode', 'good'], { cwd: new URL('.', import.meta.url).pathname, stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 1500));

try {
  // unpaid probe
  const probe = await fetch(`http://127.0.0.1:${port}/api/price-oracle`);
  console.log('probe status:', probe.status, (await probe.json()).error);
  // paid
  const { response, paid, settlement } = await payFetch(`http://127.0.0.1:${port}/api/price-oracle`, { wallet: buyer });
  const body = await response.json();
  console.log('paid:', paid, 'status:', response.status);
  console.log('artifact:', JSON.stringify(body));
  console.log('settlement:', JSON.stringify(settlement));
} finally {
  seller.kill();
  process.exit(0);
}

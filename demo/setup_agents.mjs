// setup_agents.mjs — one-time demo provisioning on Base Sepolia.
// Creates buyer + seller wallets, funds both with gas (from the operator wallet
// key227) and with demo tokens minted at deploy time (operator holds 1M).
// Keys land in demo/.keys/ (gitignored). Everything here is worthless demo asset.
import fs from 'fs';
import { ethers } from 'ethers';

const cfg = JSON.parse(fs.readFileSync(new URL('./deployed.json', import.meta.url), 'utf8'));
const provider = new ethers.JsonRpcProvider(cfg.rpc, cfg.chainId);
const mnemonic = 'test test test test test test test test test test test junk'; // deterministic demo wallet (never valued)
const m0 = ethers.HDNodeWallet.fromPhrase(mnemonic, 'm/44\'/60\'/0\'/0/0');
const m1 = ethers.HDNodeWallet.fromPhrase(mnemonic, 'm/44\'/60\'/0\'/0/1');
const buyer = m0.connect(provider);
const seller = m1.connect(provider);

const opKey = fs.readFileSync(process.env.OPERATOR_KEY_FILE || (process.env.HOME + '/.config/internet-court/operator.key'), 'utf8').trim();
const operator = new ethers.Wallet(opKey.startsWith('0x') ? opKey : '0x' + opKey, provider);
const token = new ethers.Contract(cfg.token.address, [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
], operator);

console.log('operator', operator.address);
console.log('buyer   ', buyer.address);
console.log('seller  ', seller.address);

for (const [label, w] of [['buyer', buyer], ['seller', seller]]) {
  const gas = await provider.getBalance(w.address);
  if (gas < ethers.parseEther('0.0008')) {
    const tx = await operator.sendTransaction({ to: w.address, value: ethers.parseEther('0.001') });
    await tx.wait();
    console.log(`gas funded ${label}: 0.001 ETH -> ${w.address} (${tx.hash})`);
  }
  const bal = await token.balanceOf(w.address);
  if (bal === 0n) {
    const tx = await token.transfer(w.address, 1000 * 10 ** 6); // 1,000 mUSDC
    await tx.wait();
    console.log(`tokens funded ${label}: 1000 mUSDC (${tx.hash})`);
  }
  console.log(`${label}: gas=${ethers.formatEther(await provider.getBalance(w.address))} ETH, tokens=${(await token.balanceOf(w.address)).toString()} (1e6)`);
}

const demoDir = new URL('.', import.meta.url).pathname;
fs.mkdirSync(demoDir + '.keys', { recursive: true });
for (const [label, w] of [['buyer', buyer], ['seller', seller]]) {
  fs.writeFileSync(demoDir + '.keys/' + label + '.key', w.privateKey, { mode: 0o600 });
}
fs.writeFileSync(demoDir + 'agents.json', JSON.stringify({
  note: 'generated demo wallets (mnemonic: all-test-words). TURN GARBAGE DEMO ASSETS.',
  buyer: { address: buyer.address, keyFile: './.keys/buyer.key' },
  seller: { address: seller.address, keyFile: './.keys/seller.key' },
}, null, 1));
console.log('agents.json + .keys/ written');

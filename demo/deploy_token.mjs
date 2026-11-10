// deploy_token.mjs - compile & deploy the demo payment token on Base Sepolia.
// Deployer key comes from OPERATOR_KEY_FILE (never committed). Output: demo/deployed.json.
import fs from 'fs';
import { ethers } from 'ethers';
import solc from 'solc';

const RPC = 'https://sepolia.base.org';
const CHAIN = 84532;
const KEY = fs.readFileSync(process.env.OPERATOR_KEY_FILE || (process.env.HOME + '/.config/internet-court/operator.key'), 'utf8').trim();

const src = fs.readFileSync(new URL('../contracts/MockUSDC.sol', import.meta.url), 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'MockUSDC.sol': { content: src } },
  settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const c = out.contracts['MockUSDC.sol'].MockUSDC;
const abi = c.abi, bytecode = '0x' + c.evm.bytecode.object;

const provider = new ethers.JsonRpcProvider(RPC, CHAIN);
const w = new ethers.Wallet(KEY.startsWith('0x') ? KEY : '0x' + KEY, provider);
console.log('deployer', w.address, 'balance', (await provider.getBalance(w.address)).toString());

const f = new ethers.ContractFactory(abi, bytecode, w);
const token = await f.deploy('IC Demo USDC (Base Sepolia)', w.address);
await token.waitForDeployment();
const addr = await token.getAddress();
console.log('TOKEN', addr);
const rc = token.deploymentTransaction();
console.log('TX', rc.hash, 'gas', rc.gasUsed?.toString?.() ?? '');

const demoDir = new URL('.', import.meta.url).pathname;
fs.mkdirSync(demoDir, { recursive: true });
fs.writeFileSync(demoDir + 'deployed.json', JSON.stringify({
  network: 'base-sepolia',
  chainId: CHAIN,
  rpc: RPC,
  token: { name: 'IC Demo USDC (Base Sepolia)', symbol: 'mUSDC', address: addr, decimals: 6, version: '2' },
  deployTx: rc.hash,
  deployer: w.address,
}, null, 1));
console.log('saved deployed.json');

import { ethers } from 'ethers';
const a = 'transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)';
const b = 'receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)';
console.log('transfer sel', ethers.id(a).slice(0, 10));
console.log('receive  sel', ethers.id(b).slice(0, 10));

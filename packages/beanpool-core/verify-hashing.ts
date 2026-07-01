import * as cryptoJs from 'crypto-js';
import * as cryptoNode from 'crypto';

// The payload to stress test
const payloadString = JSON.stringify({
    id: "did:beanpool:test-hashing-node",
    timestamp: 1678888888,
    amount: 15.20,
    tags: ["test", "verification"]
});

console.log("== BEANPOOL ISOMORPHIC HASHING CHECK ==");
console.log(`Payload: ${payloadString}`);
console.log("---------------------------------------");

// 1. Native Node.js crypto
const hashNode = cryptoNode.createHash('sha256').update(payloadString).digest('hex');
console.log(`Node.js crypto: ${hashNode}`);

// 2. crypto-js (Used in React Native, Web, etc)
const hashJS = cryptoJs.SHA256(payloadString).toString(cryptoJs.enc.Hex);
console.log(`crypto-js:      ${hashJS}`);

console.log("---------------------------------------");
if (hashNode === hashJS) {
    console.log("✅ MATCH: Isomorphic hashing is deterministic and safe for Merkle syncing.");
    process.exit(0);
} else {
    console.error("❌ MISMATCH: The hashing implementations differ! Committing to this will fracture global state.");
    process.exit(1);
}

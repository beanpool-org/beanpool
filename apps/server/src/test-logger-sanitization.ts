import { sanitizeMessage } from './logger.js';

console.log("Starting logger sanitization verification tests...");

const testCases = [
    {
        name: "BIP39 Mnemonic Phrase (12 words)",
        input: "The mnemonic is 'apple banana cherry dog elephant fox grape horse ink jacket king lemon' and it is secret.",
        expected: "The mnemonic is '[REDACTED_MNEMONIC]' and it is secret."
    },
    {
        name: "PEM Private Key",
        input: "Before: -----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQD\n-----END PRIVATE KEY-----\nAfter key.",
        expected: "Before: [REDACTED_PRIVATE_KEY]\nAfter key."
    },
    {
        name: "JSON field - password",
        input: '{"username": "admin", "password": "superSecretPassword123"}',
        expected: '{"username": "admin", "password": "[REDACTED_CREDENTIAL]"}'
    },
    {
        name: "JSON field - privateKey",
        input: 'private_key="ab12cd34ef56gh78ij90kl"',
        expected: 'private_key="[REDACTED_CREDENTIAL]"'
    },
    {
        name: "Hex Seed String (64 chars) - standalone",
        input: "Hex: 4a2f8b9c1d0e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a",
        expected: "Hex: [REDACTED_HEX_KEY_64]"
    },
    {
        name: "Hex Seed String (64 chars) - keyword-prefixed",
        input: "Seed: 4a2f8b9c1d0e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a",
        expected: "Seed: [REDACTED_CREDENTIAL]"
    },
    {
        name: "Hex Seed String (128 chars)",
        input: "Hex128: 4a2f8b9c1d0e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a4a2f8b9c1d0e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a",
        expected: "Hex128: [REDACTED_HEX_KEY_128]"
    },
    // A community server's logs never record an internet address (log-address.ts, sanitize-message.ts).
    {
        name: "IPv4 address, with a port, and ending a sentence",
        input: "wrong password from 203.0.113.7:443, then 198.51.100.9.",
        expected: "wrong password from [REDACTED_ADDRESS]:443, then [REDACTED_ADDRESS]."
    },
    {
        name: "IPv6 address, a /64 limiter key, a bracketed one with a port, an IPv4-mapped one",
        input: "from 2001:db8:1:2::abcd and 2001:db8:1:2::/64 and [2001:db8::1]:443 and ::ffff:203.0.113.7",
        expected: "from [REDACTED_ADDRESS] and [REDACTED_ADDRESS]/64 and [[REDACTED_ADDRESS]]:443 and [REDACTED_ADDRESS]"
    },
    {
        name: "An address inside a multiaddr and in JSON metadata",
        input: '/ip4/203.0.113.7/tcp/4001 {"ip":"2001:db8::7"}',
        expected: '/ip4/[REDACTED_ADDRESS]/tcp/4001 {"ip":"[REDACTED_ADDRESS]"}'
    },
    {
        name: "Not addresses: a time, a MAC address, a version, a C++ scope, a ratio, an out-of-range quad, a log tag",
        input: "at 2026-09-29T10:22:33.123Z [10:22:33] aa:bb:cc:dd:ee:ff v1.2.3.4 app 1.2.3 std::vector 3:2:1 999.1.1.1 ip#Ab_12-xYz9",
        expected: "at 2026-09-29T10:22:33.123Z [10:22:33] aa:bb:cc:dd:ee:ff v1.2.3.4 app 1.2.3 std::vector 3:2:1 999.1.1.1 ip#Ab_12-xYz9"
    }
];

let failed = false;
for (const tc of testCases) {
    const res = sanitizeMessage(tc.input);
    if (res !== tc.expected) {
        console.error(`❌ Test failed for "${tc.name}":\nExpected: "${tc.expected}"\nGot:      "${res}"`);
        failed = true;
    } else {
        console.log(`✅ Test passed for "${tc.name}"`);
    }
}

if (failed) {
    console.error("\n❌ Some sanitization tests FAILED!");
    process.exit(1);
} else {
    console.log("\n🎉 ALL LOGGER SANITIZATION TESTS PASSED!");
}

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

/**
 * Integration test for TOTP utility functions in `totp.ts`.
 *
 * Verifies:
 * 1. verifyTotpCode edge cases (null/invalid tokens, non-digits, length checks).
 * 2. verifyAndFindBackupCodeHash logic (invalid inputs, matching index lookup, non-matching code).
 * 3. generateOtpauthUri edge cases with custom account and issuer labels.
 */
import assert from 'node:assert';
import {
    generateTotpSecret,
    generateTotpCode,
    verifyTotpCode,
    generateBackupCodes,
    hashBackupCode,
    verifyAndFindBackupCodeHash,
    generateOtpauthUri,
} from './totp.js';

console.log('Running TOTP utility helper tests...');

// 1. verifyTotpCode invalid / edge cases
assert.strictEqual(verifyTotpCode(null as any, 'JBSWY3DPEHPK3PXP'), false, '1. null token must return false');
assert.strictEqual(verifyTotpCode(undefined as any, 'JBSWY3DPEHPK3PXP'), false, '1. undefined token must return false');
assert.strictEqual(verifyTotpCode(123456 as any, 'JBSWY3DPEHPK3PXP'), false, '1. non-string token must return false');
assert.strictEqual(verifyTotpCode('', 'JBSWY3DPEHPK3PXP'), false, '1. empty token must return false');
assert.strictEqual(verifyTotpCode('12345', 'JBSWY3DPEHPK3PXP'), false, '1. 5-digit token must return false');
assert.strictEqual(verifyTotpCode('1234567', 'JBSWY3DPEHPK3PXP'), false, '1. 7-digit token must return false');
assert.strictEqual(verifyTotpCode('abcdef', 'JBSWY3DPEHPK3PXP'), false, '1. non-digit token must return false');
assert.strictEqual(verifyTotpCode('12345a', 'JBSWY3DPEHPK3PXP'), false, '1. alphanumeric token must return false');

const secret = generateTotpSecret();
const validCode = generateTotpCode(secret);
assert.strictEqual(verifyTotpCode(validCode, secret), true, '1. Valid code must return true');

console.log('  1. verifyTotpCode edge cases verified');

// 2. verifyAndFindBackupCodeHash logic
assert.strictEqual(verifyAndFindBackupCodeHash(null as any, []), -1, '2. null candidate must return -1');
assert.strictEqual(verifyAndFindBackupCodeHash('code', null as any), -1, '2. null storedHashes must return -1');
assert.strictEqual(verifyAndFindBackupCodeHash('code', [] as any), -1, '2. empty storedHashes must return -1');

const backupCodes = generateBackupCodes(3);
const hashes = backupCodes.map(hashBackupCode);

assert.strictEqual(verifyAndFindBackupCodeHash(backupCodes[0], hashes), 0, '2. First code must match index 0');
assert.strictEqual(verifyAndFindBackupCodeHash(backupCodes[1], hashes), 1, '2. Second code must match index 1');
assert.strictEqual(verifyAndFindBackupCodeHash(backupCodes[2], hashes), 2, '2. Third code must match index 2');
assert.strictEqual(verifyAndFindBackupCodeHash('invalidcode', hashes), -1, '2. Non-existent code must return -1');

console.log('  2. verifyAndFindBackupCodeHash logic verified');

// 3. generateOtpauthUri formatting with parameters
const customUri = generateOtpauthUri(secret, 'user@example.com', 'CustomIssuer');
assert.ok(customUri.includes('otpauth://totp/CustomIssuer:user%40example.com?'), '3. Label must format issuer and URI-encoded user');
assert.ok(customUri.includes(`secret=${secret}`), '3. URI must contain secret parameter');
assert.ok(customUri.includes('issuer=CustomIssuer'), '3. URI must contain issuer parameter');

console.log('  3. generateOtpauthUri formatting verified');

console.log('✅ TOTP utility helper tests PASSED!');
process.exit(0);

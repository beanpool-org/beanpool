/**
 * Regression test for Issue #135: TOTP 2FA for Admin Account.
 *
 * Verifies:
 * A. TOTP secret generation, RFC 6238 code verification, and ±1 window drift tolerance
 * B. Backup code generation, SHA-256 hashing, and single-use consumption
 * C. checkAdminAuth allows password-only login when 2FA disabled
 * D. checkAdminAuth requires 2FA code (x-admin-totp header) when 2FA enabled
 * E. Valid 6-digit TOTP code grants admin access (including space/hyphen formatting)
 * F. Single-use backup code grants admin access via SHA-256 timing-safe hash lookup and is consumed
 * G. Disabling 2FA restores password-only access
 * H. Pending secret setup protection — calling /2fa/setup does NOT disarm active 2FA (#135 CR)
 * I. otpauth URI formatting preserves unencoded colon label separator (#135 CR2)
 */
import assert from 'node:assert';
import { generateTotpSecret, generateTotpCode, verifyTotpCode, generateBackupCodes, generateOtpauthUri, hashBackupCode } from './totp.js';
import { checkAdminAuth, resetAdminAuthTarpit } from './admin-auth.js';
import { getLocalConfig, updateLocalConfig } from './config/local-config.js';
import { initStateEngine } from './state-engine.js';

console.log('Running #135 TOTP 2FA admin authentication test...');

initStateEngine();

// A. TOTP Core RFC 6238 tests
const secret = generateTotpSecret();
assert.ok(secret.length >= 32, 'A. Secret must be at least 32 base32 characters (160 bits)');

const currentCode = generateTotpCode(secret);
assert.strictEqual(currentCode.length, 6, 'A. Code must be 6 digits');
assert.ok(/^\d{6}$/.test(currentCode), 'A. Code must contain only digits');

assert.strictEqual(verifyTotpCode(currentCode, secret), true, 'A. Current code must verify as valid');
assert.strictEqual(verifyTotpCode('000000', secret), false, 'A. Invalid code must fail verification');

// E. Space and hyphen formatted 6-digit codes
const formattedSpaceCode = `${currentCode.slice(0, 3)} ${currentCode.slice(3)}`;
const formattedHyphenCode = `${currentCode.slice(0, 3)}-${currentCode.slice(3)}`;
assert.strictEqual(verifyTotpCode(formattedSpaceCode, secret), true, 'E. Code with spaces (123 456) must verify as valid');
assert.strictEqual(verifyTotpCode(formattedHyphenCode, secret), true, 'E. Code with hyphens (123-456) must verify as valid');

const prevWindowCode = generateTotpCode(secret, -1);
assert.strictEqual(verifyTotpCode(prevWindowCode, secret), true, 'A. Code from 30s ago (drift window -1) must verify as valid');

// I. otpauth URI formatting test
const otpUri = generateOtpauthUri(secret, 'test-admin', 'BeanPool');
assert.ok(otpUri.includes('otpauth://totp/BeanPool:test-admin?'), 'I. otpauth URI label must preserve unencoded colon separator');
assert.ok(otpUri.includes(secret), 'I. otpauth URI must include secret');
console.log('  A & I. TOTP core generator, verifier & URI formatting working correctly');

// B. Backup codes generator test
const backupCodes = generateBackupCodes(8);
assert.strictEqual(backupCodes.length, 8, 'B. Must generate 8 backup codes');
assert.strictEqual(backupCodes[0].length, 8, 'B. Backup code must be 8 hex characters');

const backupHashes = backupCodes.map(hashBackupCode);
assert.strictEqual(backupHashes.length, 8, 'B. Must hash 8 backup codes');
assert.strictEqual(backupHashes[0].length, 64, 'B. SHA-256 hash must be 64 hex characters');
console.log('  B. Backup code generator & SHA-256 hashing working correctly');

// Setup mock ctx helper
const mockCtx = (headers: Record<string, string> = {}, body: any = {}) => ({
    get: (h: string) => headers[h.toLowerCase()],
    headers,
    request: { headers, body },
    requestBody: body,
    status: 200,
    body: null as any,
});

// Configure admin password in local config for testing
const testPass = 'TestAdminPass123!';
updateLocalConfig({
    adminHash: null,
    salt: null,
    totpEnabled: false,
    totpSecret: null,
    totpBackupCodesHashes: [],
    totpPendingSecret: null,
    totpPendingBackupCodesHashes: [],
});

// Seed password hash into local-config
import { scryptSync, randomBytes } from 'node:crypto';
const salt = randomBytes(16).toString('hex');
const adminHash = scryptSync(testPass, salt, 64).toString('hex');
updateLocalConfig({ adminHash, salt });

// C. Password-only auth when 2FA disabled
resetAdminAuthTarpit();
(async () => {
    const ctxNo2FA = mockCtx({ 'x-admin-password': testPass });
    const okNo2FA = await checkAdminAuth(ctxNo2FA);
    assert.strictEqual(okNo2FA, true, 'C. Password-only login must succeed when 2FA is disabled');
    console.log('  C. Password-only login succeeds when 2FA disabled');

    // D. Require 2FA code when enabled
    updateLocalConfig({
        totpEnabled: true,
        totpSecret: secret,
        totpBackupCodesHashes: [...backupHashes],
    });

    resetAdminAuthTarpit();
    const ctxMissing2FA = mockCtx({ 'x-admin-password': testPass });
    const okMissing2FA = await checkAdminAuth(ctxMissing2FA);
    assert.strictEqual(okMissing2FA, false, 'D. Login without 2FA code must fail when 2FA enabled');
    assert.strictEqual(ctxMissing2FA.status, 401, 'D. Missing 2FA status must be 401');
    assert.strictEqual(ctxMissing2FA.body.totpRequired, true, 'D. totpRequired flag must be true');

    resetAdminAuthTarpit();
    const ctxBad2FA = mockCtx({ 'x-admin-password': testPass, 'x-admin-totp': '999999' });
    const okBad2FA = await checkAdminAuth(ctxBad2FA);
    assert.strictEqual(okBad2FA, false, 'D. Login with bad 2FA code must fail');
    console.log('  D. 2FA enforcement correctly blocks password-only & invalid code logins');

    // E. Valid 6-digit TOTP code grants access
    resetAdminAuthTarpit();
    const validCode = generateTotpCode(secret);
    const ctxValid2FA = mockCtx({ 'x-admin-password': testPass, 'x-admin-totp': validCode });
    const okValid2FA = await checkAdminAuth(ctxValid2FA);
    assert.strictEqual(okValid2FA, true, 'E. Login with valid 6-digit TOTP code must succeed');
    console.log('  E. Valid 6-digit TOTP code grants admin access');

    // F. Single-use backup code grants access via SHA-256 hash matching and is consumed
    resetAdminAuthTarpit();
    const firstBackupCode = backupCodes[0];
    const ctxBackup = mockCtx({ 'x-admin-password': testPass, 'x-admin-totp': firstBackupCode });
    const okBackup = await checkAdminAuth(ctxBackup);
    assert.strictEqual(okBackup, true, 'F. Login with valid backup code must succeed via SHA-256 hash lookup');

    const updatedConfig = getLocalConfig();
    assert.strictEqual(updatedConfig.totpBackupCodesHashes?.length, 7, 'F. Backup code hash must be consumed after single use');

    // Trying same backup code again fails
    resetAdminAuthTarpit();
    const ctxReuseBackup = mockCtx({ 'x-admin-password': testPass, 'x-admin-totp': firstBackupCode });
    const okReuse = await checkAdminAuth(ctxReuseBackup);
    assert.strictEqual(okReuse, false, 'F. Reusing consumed backup code must fail');
    console.log('  F. Backup code SHA-256 hash verification and single-use consumption working correctly');

    // H. Pending secret setup protection (#135 CR)
    const newPendingSecret = generateTotpSecret();
    updateLocalConfig({
        totpPendingSecret: newPendingSecret,
        totpPendingBackupCodesHashes: generateBackupCodes(8).map(hashBackupCode),
    });
    // active totpEnabled must still be true and active secret must still be required for auth
    const currentActiveCode = generateTotpCode(secret);
    resetAdminAuthTarpit();
    const ctxPendingCheck = mockCtx({ 'x-admin-password': testPass, 'x-admin-totp': currentActiveCode });
    const okPendingCheck = await checkAdminAuth(ctxPendingCheck);
    assert.strictEqual(okPendingCheck, true, 'H. Active secret must still authenticate while a new setup is pending');
    console.log('  H. Pending setup secret does NOT disarm currently active 2FA');

    // G. Disabling 2FA restores password-only access
    updateLocalConfig({
        totpEnabled: false,
        totpSecret: null,
        totpBackupCodesHashes: [],
        totpPendingSecret: null,
        totpPendingBackupCodesHashes: [],
    });

    resetAdminAuthTarpit();
    const ctxAfterDisable = mockCtx({ 'x-admin-password': testPass });
    const okAfterDisable = await checkAdminAuth(ctxAfterDisable);
    assert.strictEqual(okAfterDisable, true, 'G. Password-only login succeeds after 2FA is disabled');
    console.log('  G. Disabling 2FA restores password-only access');

    console.log('✅ #135 TOTP 2FA admin authentication test PASSED!');

    // Inside the IIFE deliberately: placed after it, this would run before the async body
    // resolved and exit on a test that had not finished. See the note in the sibling suites —
    // without it this process holds the engine's handles open and hangs the pipeline.
    process.exit(0);
})();

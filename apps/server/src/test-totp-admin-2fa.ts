/**
 * Regression test for Issue #135: TOTP 2FA for Admin Account.
 *
 * Verifies:
 * A. TOTP secret generation, RFC 6238 code verification, and ±1 window drift tolerance
 * B. Backup code generation and single-use consumption
 * C. checkAdminAuth allows password-only login when 2FA disabled
 * D. checkAdminAuth requires 2FA code (x-admin-totp header) when 2FA enabled
 * E. Valid 6-digit TOTP code grants admin access
 * F. Single-use backup code grants admin access and is consumed
 * G. Disabling 2FA restores password-only access
 */
import assert from 'node:assert';
import { generateTotpSecret, generateTotpCode, verifyTotpCode, generateBackupCodes, generateOtpauthUri } from './totp.js';
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

const prevWindowCode = generateTotpCode(secret, -1);
assert.strictEqual(verifyTotpCode(prevWindowCode, secret), true, 'A. Code from 30s ago (drift window -1) must verify as valid');

const otpUri = generateOtpauthUri(secret, 'test-admin', 'BeanPool');
assert.ok(otpUri.includes('otpauth://totp/'), 'A. otpauth URI must have correct scheme');
assert.ok(otpUri.includes(secret), 'A. otpauth URI must include secret');
console.log('  A. TOTP core generator & verifier working correctly');

// B. Backup codes generator test
const backupCodes = generateBackupCodes(8);
assert.strictEqual(backupCodes.length, 8, 'B. Must generate 8 backup codes');
assert.strictEqual(backupCodes[0].length, 8, 'B. Backup code must be 8 hex characters');
console.log('  B. Backup code generator working correctly');

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
    totpBackupCodes: [],
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
        totpBackupCodes: [...backupCodes],
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

    // F. Single-use backup code grants access and is consumed
    resetAdminAuthTarpit();
    const firstBackupCode = backupCodes[0];
    const ctxBackup = mockCtx({ 'x-admin-password': testPass, 'x-admin-totp': firstBackupCode });
    const okBackup = await checkAdminAuth(ctxBackup);
    assert.strictEqual(okBackup, true, 'F. Login with valid backup code must succeed');

    const updatedConfig = getLocalConfig();
    assert.strictEqual(updatedConfig.totpBackupCodes?.length, 7, 'F. Backup code must be consumed after single use');
    assert.strictEqual(updatedConfig.totpBackupCodes?.includes(firstBackupCode), false, 'F. Used backup code must no longer exist in config');

    // Trying same backup code again fails
    resetAdminAuthTarpit();
    const ctxReuseBackup = mockCtx({ 'x-admin-password': testPass, 'x-admin-totp': firstBackupCode });
    const okReuse = await checkAdminAuth(ctxReuseBackup);
    assert.strictEqual(okReuse, false, 'F. Reusing consumed backup code must fail');
    console.log('  F. Backup code authentication and single-use consumption working correctly');

    // G. Disabling 2FA restores password-only access
    updateLocalConfig({
        totpEnabled: false,
        totpSecret: null,
        totpBackupCodes: [],
    });

    resetAdminAuthTarpit();
    const ctxAfterDisable = mockCtx({ 'x-admin-password': testPass });
    const okAfterDisable = await checkAdminAuth(ctxAfterDisable);
    assert.strictEqual(okAfterDisable, true, 'G. Password-only login succeeds after 2FA is disabled');
    console.log('  G. Disabling 2FA restores password-only access');

    console.log('✅ #135 TOTP 2FA admin authentication test PASSED!');
})();

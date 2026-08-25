/**
 * Integration tests for recovery PIN routes in apps/server/src/routes/pin.ts.
 *
 * Covers:
 * - POST /api/recovery/pin/status (authentication check, status reporting)
 * - POST /api/recovery/pin/set (authentication, member validation, PIN formatting, setting and clearing PINs)
 * - POST /api/recovery/pin/verify (anti-enumeration uniform denial, wrong PIN attempt tracking, cooldown enforcement, keeper list output)
 *
 * BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-recovery-pin.ts
 */

import crypto from 'node:crypto';
import { initStateEngine } from './state-engine.js';
import { db } from './db/db.js';
import { createPinRoutes } from './routes/pin.js';

initStateEngine();

let run = 0;
let passed = 0;

function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}

const router = createPinRoutes({
    checkAdminAuth: async () => false,
    rateLimit: () => true,
    clampLimit: (_v: unknown, d = 20) => d,
    clampOffset: () => 0,
    activeConnections: new Map(),
    calculateAnalytics: () => ({}),
    enforceReadAuth: false,
});

function handlerFor(path: string) {
    const layer = (router as any).stack.find((l: any) => l.path === path && l.methods.includes('POST'));
    if (!layer) throw new Error(`POST ${path} is not mounted`);
    return layer.stack[layer.stack.length - 1];
}

async function call(path: string, actor: string | undefined, body: Record<string, unknown> = {}) {
    const ctx: any = {
        state: actor ? { actor } : {},
        requestBody: body,
        request: { ip: '127.0.0.1' },
        ip: '127.0.0.1',
        status: 200,
        body: undefined,
    };
    await handlerFor(path)(ctx, async () => {});
    return { status: ctx.status, body: ctx.body };
}

let seq = 0;
function createTestMember(status: string = 'active'): { pubkey: string; callsign: string } {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pubkey = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    const callsign = `pinuser${++seq}`;
    db.prepare(`
        INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
        VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')
    `).run(pubkey, callsign, status);
    return { pubkey, callsign };
}

async function main(): Promise<void> {
    console.log('\nRecovery PIN route tests\n');

    const member1 = createTestMember('active');
    const member2 = createTestMember('active');
    const migratedMember = createTestMember('migrated');

    // ── 1. POST /api/recovery/pin/status ────────────────────────────────────
    console.log('── 1. PIN status endpoint ───────────────────────────────');

    const statusUnauth = await call('/api/recovery/pin/status', undefined);
    assert(statusUnauth.status === 401, 'Unauthenticated status request is rejected with 401');

    const statusInit = await call('/api/recovery/pin/status', member1.pubkey);
    assert(statusInit.status === 200 && statusInit.body.pinSet === false, 'Initially pinSet is false for active member');

    // ── 2. POST /api/recovery/pin/set ───────────────────────────────────────
    console.log('\n── 2. Setting and clearing PIN ──────────────────────────');

    const setUnauth = await call('/api/recovery/pin/set', undefined, { pin: '123456' });
    assert(setUnauth.status === 401, 'Unauthenticated PIN set is rejected with 401');

    const setUnknownMember = await call('/api/recovery/pin/set', '00'.repeat(32), { pin: '123456' });
    assert(setUnknownMember.status === 401, 'PIN set for unknown member is rejected with 401');

    const setMigratedMember = await call('/api/recovery/pin/set', migratedMember.pubkey, { pin: '123456' });
    assert(setMigratedMember.status === 401, 'PIN set for migrated member is rejected with 401');

    const setMissingPin = await call('/api/recovery/pin/set', member1.pubkey, {});
    assert(setMissingPin.status === 400 && /Missing required field/i.test(setMissingPin.body.error), 'Missing pin field returns 400 error');

    for (const badPin of ['12345', '1234567', 'abcdef', '12345a', null, undefined]) {
        if (badPin === null) continue; // null is clear pin action
        const setBadFormat = await call('/api/recovery/pin/set', member1.pubkey, { pin: badPin });
        assert(setBadFormat.status === 400 && /6 digits/i.test(setBadFormat.body.error), `Invalid PIN "${badPin}" rejected with 400`);
    }

    const setValid = await call('/api/recovery/pin/set', member1.pubkey, { pin: '123456' });
    assert(setValid.status === 200 && setValid.body.ok === true && setValid.body.pinSet === true, 'Setting valid 6-digit PIN succeeds');

    const statusAfterSet = await call('/api/recovery/pin/status', member1.pubkey);
    assert(statusAfterSet.status === 200 && statusAfterSet.body.pinSet === true, 'Status now reflects pinSet = true');

    const clearPinNull = await call('/api/recovery/pin/set', member1.pubkey, { pin: null });
    assert(clearPinNull.status === 200 && clearPinNull.body.pinSet === false, 'Clearing PIN with pin=null succeeds');

    const statusAfterClear = await call('/api/recovery/pin/status', member1.pubkey);
    assert(statusAfterClear.status === 200 && statusAfterClear.body.pinSet === false, 'Status now reflects pinSet = false after clear');

    const setValidAgain = await call('/api/recovery/pin/set', member1.pubkey, { pin: '654321' });
    assert(setValidAgain.status === 200 && setValidAgain.body.pinSet === true, 'Can update PIN to new value ("654321")');

    // ── 3. POST /api/recovery/pin/verify ───────────────────────────────────
    console.log('\n── 3. Anti-enumeration and verification ──────────────────');

    // Add recovery shares for member1 so keeper list has data upon successful PIN verify
    db.prepare(`
        INSERT INTO recovery_shares (owner_pubkey, holder_type, holder_ref, generation, share_index, encrypted_share, share_iv, share_tag, created_at)
        VALUES
            (?, 'hub', 'node', 1, 1, 'enc1', 'iv1', 'tag1', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            (?, 'member', ?, 1, 2, 'enc2', 'iv2', 'tag2', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run(member1.pubkey, member1.pubkey, member2.pubkey);

    const verifyBadCallsign = await call('/api/recovery/pin/verify', undefined, { callsign: 'nonexistent_callsign', pin: '654321' });
    assert(verifyBadCallsign.status === 200 && verifyBadCallsign.body.verified === false && verifyBadCallsign.body.keepers === null, 'Non-existent callsign returns uniform denial response');

    const verifyBadPinFormat = await call('/api/recovery/pin/verify', undefined, { callsign: member1.callsign, pin: '1234' });
    assert(verifyBadPinFormat.status === 200 && verifyBadPinFormat.body.verified === false && verifyBadPinFormat.body.keepers === null, 'Bad PIN format returns uniform denial response');

    const verifyNoPinMember = await call('/api/recovery/pin/verify', undefined, { callsign: member2.callsign, pin: '123456' });
    assert(verifyNoPinMember.status === 200 && verifyNoPinMember.body.verified === false && verifyNoPinMember.body.keepers === null, 'Member without PIN set returns uniform denial response');

    // Wrong PIN attempt 1
    const verifyWrongPin1 = await call('/api/recovery/pin/verify', undefined, { callsign: member1.callsign, pin: '111111' });
    assert(verifyWrongPin1.status === 200 && verifyWrongPin1.body.verified === false && verifyWrongPin1.body.keepers === null, 'Wrong PIN attempt 1 returns uniform denial response');

    const pinRow1 = db.prepare(`SELECT attempts FROM recovery_pin WHERE owner_pubkey = ?`).get(member1.pubkey) as { attempts: number };
    assert(pinRow1.attempts === 1, 'Attempt count incremented to 1');

    // Wrong PIN attempt 2
    const verifyWrongPin2 = await call('/api/recovery/pin/verify', undefined, { callsign: member1.callsign, pin: '111111' });
    assert(verifyWrongPin2.status === 200 && verifyWrongPin2.body.verified === false, 'Wrong PIN attempt 2 returns uniform denial response');

    const pinRow2 = db.prepare(`SELECT attempts FROM recovery_pin WHERE owner_pubkey = ?`).get(member1.pubkey) as { attempts: number };
    assert(pinRow2.attempts === 2, 'Attempt count incremented to 2 (free attempt limit reached)');

    // Wrong PIN attempt 3 -> triggers rate limit cooldown
    const verifyWrongPin3 = await call('/api/recovery/pin/verify', undefined, { callsign: member1.callsign, pin: '111111' });
    assert(verifyWrongPin3.status === 200 && verifyWrongPin3.body.verified === false, 'Attempt 3 in cooldown window returns uniform denial response');

    // Correct PIN while still in cooldown window -> still returns uniform denial
    const verifyCorrectInCooldown = await call('/api/recovery/pin/verify', undefined, { callsign: member1.callsign, pin: '654321' });
    assert(verifyCorrectInCooldown.status === 200 && verifyCorrectInCooldown.body.verified === false && verifyCorrectInCooldown.body.keepers === null, 'Correct PIN while in cooldown window is rejected with uniform denial response');

    // Clear cooldown / simulate passage of time (16 minutes ago)
    const sixteenMinsAgo = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    db.prepare(`UPDATE recovery_pin SET last_attempt_at = ? WHERE owner_pubkey = ?`).run(sixteenMinsAgo, member1.pubkey);

    // Correct PIN after cooldown expires -> succeeds and returns keeper list
    const verifySuccess = await call('/api/recovery/pin/verify', undefined, { callsign: member1.callsign, pin: '654321' });
    assert(verifySuccess.status === 200 && verifySuccess.body.verified === true, 'Correct PIN after cooldown window succeeds');
    assert(Array.isArray(verifySuccess.body.keepers) && verifySuccess.body.keepers.length === 2, 'Returns list of keeper types with counts');

    const hubKeeper = verifySuccess.body.keepers.find((k: any) => k.type === 'hub');
    const memberKeeper = verifySuccess.body.keepers.find((k: any) => k.type === 'member');
    assert(hubKeeper?.count === 1 && memberKeeper?.count === 1, 'Keeper counts by holder_type are correct');

    const pinRowSuccess = db.prepare(`SELECT attempts, last_attempt_at FROM recovery_pin WHERE owner_pubkey = ?`).get(member1.pubkey) as { attempts: number; last_attempt_at: string | null };
    assert(pinRowSuccess.attempts === 0 && pinRowSuccess.last_attempt_at === null, 'Successful verification resets attempt counter to 0');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Recovery PIN route checks PASSED.');
}

main().then(() => process.exit(0)).catch((e) => {
    console.error(e);
    process.exit(1);
});

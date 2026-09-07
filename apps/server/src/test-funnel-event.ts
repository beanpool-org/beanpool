/**
 * Integration test coverage for onboarding funnel event HTTP route:
 *   POST /api/funnel-event
 *
 * Covers:
 * - Unsigned request guard (returns 401 when missing required signature headers)
 * - Validation of event name against CLIENT_FUNNEL_EVENTS allowlist (returns 400 for unknown event)
 * - Recording valid onboarding events (returns 200 { success: true } and updates DB count)
 *
 * BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-funnel-event.ts
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { db } from './db/db.js';
import { startHttpsServer } from './https-server.js';

const PORT = 8567;
const BASE = `https://localhost:${PORT}`;

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

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
const CALLSIGN = `funneluser-${pubKeyHex.slice(0, 6)}`;

async function signedFetch(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const bodyString = method === 'GET' || method === 'HEAD' ? '' : JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const pathname = path.split('?')[0];
    const canonical = `${method}\n${pathname}\n${ts}\n${nonce}\n${bodyString}`;
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Public-Key': pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    const fetchOptions: RequestInit = { method, headers };
    if (method !== 'GET' && method !== 'HEAD') {
        fetchOptions.body = bodyString;
    }
    const res = await fetch(`${BASE}${path}`, fetchOptions);
    let parsed: any;
    try {
        parsed = await res.json();
    } catch {
        parsed = undefined;
    }
    return { status: res.status, body: parsed };
}

async function main(): Promise<void> {
    console.log('\nRunning Funnel Event Route API tests...\n');

    await initTls();
    initStateEngine();

    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`)
      .run(pubKeyHex, CALLSIGN);

    await startHttpsServer(PORT);

    // ── 1. Unsigned Request Guard Verification ──────────────────────────────────
    const unsignedRes = await fetch(`${BASE}/api/funnel-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'protection_shown' }),
    });
    assert(unsignedRes.status === 401, 'Unsigned POST /api/funnel-event is rejected with 401');

    // ── 2. Invalid/Disallowed Event Verification ─────────────────────────────────
    const invalidEventRes = await signedFetch('POST', '/api/funnel-event', {
        event: 'invite_failed',
        variant: 'A',
    });
    assert(invalidEventRes.status === 400 && invalidEventRes.body?.error === 'Unknown onboarding event',
        'POST /api/funnel-event rejects disallowed event name with 400');

    // ── 3. Valid Event Recording Verification ────────────────────────────────────
    const validEvent1 = await signedFetch('POST', '/api/funnel-event', {
        event: 'protection_shown',
        variant: 'A',
    });
    assert(validEvent1.status === 200 && validEvent1.body?.success === true,
        'POST /api/funnel-event records valid event "protection_shown" successfully');

    const validEvent2 = await signedFetch('POST', '/api/funnel-event', {
        event: 'guide_complete',
        variant: 'B',
    });
    assert(validEvent2.status === 200 && validEvent2.body?.success === true,
        'POST /api/funnel-event records valid event "guide_complete" successfully');

    const today = new Date().toISOString().slice(0, 10);
    const dbRow1 = db.prepare(`SELECT count FROM onboarding_funnel WHERE day = ? AND event = ? AND variant = ?`)
                     .get(today, 'protection_shown', 'A') as { count: number } | undefined;
    assert(dbRow1?.count === 1, 'Database table onboarding_funnel recorded protection_shown event count = 1');

    const dbRow2 = db.prepare(`SELECT count FROM onboarding_funnel WHERE day = ? AND event = ? AND variant = ?`)
                     .get(today, 'guide_complete', 'B') as { count: number } | undefined;
    assert(dbRow2?.count === 1, 'Database table onboarding_funnel recorded guide_complete event count = 1');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        throw new Error(`${run - passed} check(s) failed`);
    }
    console.log('⭐️ funnel-event route checks PASSED.');
}

main().then(() => process.exit(0)).catch(e => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});

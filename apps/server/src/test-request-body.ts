/**
 * Does a JSON POST body actually reach the handlers that read `ctx.request.body`?
 *
 * WHY THIS EXISTS. Koa core does not parse request bodies, and this server mounts no bodyparser
 * middleware — it reads the raw bytes itself (X-1 needs the exact bytes the client signed) and
 * publishes the parsed object on the context. It published it under ONE name, `ctx.requestBody`,
 * while fourteen handlers in routes/pairing.ts, routes/pricing-guide.ts and routes/manager-backups.ts
 * read the other spelling, `ctx.request.body`. That name was never assigned by anything, so all
 * fourteen received `undefined`, fell to their `|| {}` default, and ran on an empty body:
 *
 *   - POST /api/pair/init and /api/pair/transfer answered 400 "Missing …" for every request that
 *     ever arrived, so desktop↔mobile pairing could not complete at all.
 *   - POST /api/manager/backups/trigger read `nodeId` as undefined, fell through its
 *     `nodeId === 'all' || !nodeId` guard and harvested the ENTIRE fleet on a single-node request.
 *   - The four snapshot proxies resolved no node and aimed at the findNodeConfig fallback,
 *     https://localhost:8443, instead of the node the operator picked.
 *
 * WHY IT WENT UNNOTICED. test-pairing-relay and test-pricing-guide both call the service layer
 * directly — initPairingSession(), the pricing engine — so they never cross the middleware and
 * stayed green the whole time. A handler test proves the handler; it cannot prove the plumbing
 * that feeds it. Same trap as #143, same answer as test-keeper-http.ts: boot the real server and
 * make a real request.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-request-body.ts
 */

// Self-signed cert in LAN mode → relax TLS verification for the test client only.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME; // force self-signed / LAN mode

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { db } from './db/db.js';
import { startHttpsServer } from './https-server.js';

const PORT = 8557;
const BASE = `https://localhost:${PORT}`;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
const CALLSIGN = `rbody-${pubKeyHex.slice(0, 6)}`;

/** The replay-proof scheme the real middleware requires: method+path+ts+nonce+body. */
async function signedFetch(method: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
    const bodyString = JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${path}\n${ts}\n${nonce}\n${bodyString}`;
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Public-Key': pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    const res = await fetch(`${BASE}${path}`, { method, headers, body: bodyString });
    let parsed: any;
    try { parsed = await res.json(); } catch { parsed = undefined; }
    return { status: res.status, body: parsed };
}

async function main(): Promise<void> {
    console.log('\nJSON request bodies over real HTTP\n');
    await initTls();
    initStateEngine();

    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`)
      .run(pubKeyHex, CALLSIGN);

    await startHttpsServer(PORT);

    // ── 1. a handler reading ctx.request.body sees the payload ────────────────────────────────
    // /api/pair/init destructures sessionId + desktopPubHex straight off ctx.request.body and
    // answers 400 "Missing sessionId or desktopPubHex" when it sees neither. That 400 WAS the
    // permanent response before this fix, for every well-formed request.
    const sessionId = crypto.randomBytes(8).toString('hex');
    const desktopPubHex = crypto.randomBytes(32).toString('hex');
    const init = await signedFetch('POST', '/api/pair/init', { sessionId, desktopPubHex });

    assert(init.status !== 404, 'POST /api/pair/init is mounted (not a 404)');
    assert(init.body?.error !== 'Missing sessionId or desktopPubHex',
        `the handler saw its body, not {} (got ${init.status} ${init.body?.error ?? 'no error'})`);
    assert(init.status === 200, `a well-formed pairing init succeeds (got ${init.status})`);

    // ── 2. and the empty-body default still holds when the field really is absent ──────────────
    // The `|| {}` fallbacks must keep working: a genuinely empty body is a 400, not a crash.
    const empty = await signedFetch('POST', '/api/pair/init', {});
    assert(empty.status === 400 && empty.body?.error === 'Missing sessionId or desktopPubHex',
        'a genuinely empty body is still refused with 400, not a 500');

    // ── 3. a SECOND route file, on the unsigned path ──────────────────────────────────────────
    // pairing is not the only casualty, so assert across files. /api/pricing-guide/report is on
    // the signature bypass list, so this also covers the branch that never carries credentials.
    // Its two failure modes are diagnostic: "Invalid report parameters" means the handler saw an
    // empty body (the bug), "Pricing guide item not found" means it read itemId and got past
    // validation (the fix). Asserting on WHICH refusal is what makes this test fail before the fix.
    const reportRes = await fetch(`${BASE}/api/pricing-guide/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId: 'no-such-item', reportType: 'too_high' }),
    });
    const report = await reportRes.json().catch(() => ({} as any));
    assert(report?.error !== 'Invalid report parameters. itemId and valid reportType required.',
        'routes/pricing-guide.ts also receives its body (not the empty-body refusal)');
    assert(reportRes.status === 404 && report?.error === 'Pricing guide item not found',
        '...and got far enough to look the item up and honestly not find it');

    console.log(`\n${passed}/${run} passed\n`);
    if (passed !== run) process.exit(1);
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

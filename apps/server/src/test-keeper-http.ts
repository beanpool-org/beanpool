/**
 * The keyholder routes over REAL HTTP — is any of this actually reachable?
 *
 * WHY THIS EXISTS SEPARATELY. `test-keeper-routes.ts` drives the handlers directly, which is how
 * every route suite in this codebase works and is the only way to cover the refusal matrix. It
 * cannot see the layer that has already bitten this project once: #143's cross-node purchase route
 * passed its own suite while being unusable over HTTP, because the suite never crossed the
 * signature middleware. A handler test proves the handler; it does not prove the route is mounted,
 * that the middleware supplies `ctx.state.actor` at all, or that a read meant to be public is on
 * the allowlist.
 *
 * So this boots the real server and asks four questions the other suite structurally cannot:
 *
 *   1. Are the routes mounted? (a 404 here is the whole point)
 *   2. Does a correctly signed request arrive with an actor the handler recognises?
 *   3. Is an unsigned write refused by the middleware, before the handler runs?
 *   4. Is the public keeper summary reachable with NO credentials — including when
 *      ENFORCE_READ_AUTH is on, which is exactly when an allowlist omission would bite?
 *
 * RUNS IN BOTH FLAG STATES. `ENFORCE_READ_AUTH` is a module const read at import, so one process
 * sees one value and an `import` cannot be preceded by a `process.env` assignment (imports hoist).
 * test-all.sh runs this twice, which is the only way to cover a const — same treatment as
 * test-federation-purchase-route. The public-read assertion is the one that differs, and it is the
 * reason both runs exist: with the flag OFF every GET is reachable anyway, so a missing allowlist
 * entry would pass unnoticed.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-keeper-http.ts
 *   ENFORCE_READ_AUTH=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-keeper-http.ts
 */

// Self-signed cert in LAN mode → relax TLS verification for the test client only.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME; // force self-signed / LAN mode

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { db } from './db/db.js';
import { startHttpsServer } from './https-server.js';

const PORT = 8555;
const BASE = `https://localhost:${PORT}`;
const ENFORCED = process.env.ENFORCE_READ_AUTH === 'true';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
const CALLSIGN = `khttp-${pubKeyHex.slice(0, 6)}`;

/** The replay-proof scheme the real middleware requires: method+path+ts+nonce+body. */
async function signedFetch(
    method: string, path: string, body: unknown, opts: { omitSig?: boolean } = {},
): Promise<{ status: number; body: any }> {
    const bodyString = JSON.stringify(body ?? {});
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (!opts.omitSig) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const canonical = `${method}\n${path}\n${ts}\n${nonce}\n${bodyString}`;
        headers['X-Public-Key'] = pubKeyHex;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(canonical), privateKey).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: bodyString });
    let parsed: any;
    try { parsed = await res.json(); } catch { parsed = undefined; }
    return { status: res.status, body: parsed };
}

const frag = (i: number) => ({
    shareIndex: i,
    encryptedShare: Buffer.from(`share-${i}`).toString('base64'),
    shareIv: Buffer.from(`iv-${i}`).toString('base64'),
    shareTag: Buffer.from(`tag-${i}`).toString('base64'),
});

const GENERATION = [
    { holderType: 'hub', holderRef: 'node', ...frag(2) },
    { holderType: 'member', holderRef: 'b'.repeat(64), ephemeralPubkey: 'ZXBoZW1lcmFs', ...frag(3) },
];

async function main(): Promise<void> {
    console.log(`\nKeyholder routes over real HTTP (ENFORCE_READ_AUTH ${ENFORCED ? 'ON' : 'OFF'})\n`);
    await initTls();
    initStateEngine();

    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`)
      .run(pubKeyHex, CALLSIGN);

    await startHttpsServer(PORT);

    // ── 1. mounted at all ─────────────────────────────────────────────────────────────────────
    // A 404 is the failure this file exists to catch: the handler suite passes either way.
    const deposit = await signedFetch('POST', '/api/recovery/shares', { shares: GENERATION });
    assert(deposit.status !== 404, 'POST /api/recovery/shares is mounted (not a 404)');
    assert(deposit.status === 200,
        `a signed deposit succeeds through the real middleware (got ${deposit.status} ${deposit.body?.error ?? ''})`);
    assert(deposit.body?.generation === 1 && deposit.body?.shareCount === 2,
        '...and the handler saw an actor it could file the fragments under');

    // ── 2. the middleware refuses before the handler ──────────────────────────────────────────
    const unsigned = await signedFetch('POST', '/api/recovery/shares', { shares: GENERATION }, { omitSig: true });
    assert(unsigned.status === 401, 'an unsigned deposit is refused');
    assert(/signature/i.test(String(unsigned.body?.error ?? '')),
        '...by the signature middleware, before the handler runs');

    const nonce = await signedFetch('POST', '/api/recovery/sso-nonce', {});
    assert(nonce.status === 200 && typeof nonce.body?.nonce === 'string',
        'POST /api/recovery/sso-nonce is mounted and issues a nonce to a signed member');
    assert((await signedFetch('POST', '/api/recovery/sso-nonce', {}, { omitSig: true })).status === 401,
        '...and refuses an unsigned caller');

    const status = await signedFetch('POST', '/api/recovery/shares/status', {});
    assert(status.status === 200 && status.body?.total === 2,
        'POST /api/recovery/shares/status is mounted and answers for the signer');

    // DELETE carries a body, which is the part most likely to be dropped in transit — the
    // middleware only parses one for POST/PUT/DELETE with a JSON content-type.
    const noConfirm = await signedFetch('DELETE', '/api/recovery/shares', {});
    assert(noConfirm.status === 400 && noConfirm.body?.currentShareCount === 2,
        'DELETE /api/recovery/shares is mounted and reads its confirmation body');

    // ── 3. the public read, which is the whole point of the allowlist entry ───────────────────
    const publicRes = await fetch(`${BASE}/api/recovery/keepers/${CALLSIGN}`);
    const publicBody = await publicRes.json().catch(() => undefined) as any;
    assert(publicRes.status === 200,
        `GET /api/recovery/keepers/:callsign is reachable with NO credentials (got ${publicRes.status})`);
    assert(publicBody?.total === 2 && publicBody?.threshold === 3,
        '...and answers with the keeper summary a restore screen needs');
    assert(!JSON.stringify(publicBody).includes(pubKeyHex),
        '...without naming the member whose keepers they are');

    if (ENFORCED) {
        // The run that matters. With the flag off every GET is reachable regardless, so a missing
        // PUBLIC_READ_PATTERNS entry would sail through — and only surface on a node that had
        // turned enforcement on, to a user who had just lost their phone.
        assert(publicRes.status === 200,
            'ENFORCED: the keeper summary is on the public-read allowlist — a user with no identity can still see how to get back in');
        // The control: a neighbouring gated read must NOT be public, proving enforcement is
        // actually on and the assertion above is not passing because nothing is gated.
        const gated = await fetch(`${BASE}/api/members`);
        assert(gated.status === 401 || gated.status === 403,
            `...and enforcement really is on — a gated read is refused unauthenticated (got ${gated.status})`);
    } else {
        console.log('  (the allowlist assertion runs in the ENFORCE_READ_AUTH=true pass)');
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log(`⭐️ Keyholder HTTP reachability PASSED (ENFORCE_READ_AUTH ${ENFORCED ? 'ON' : 'OFF'}).`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

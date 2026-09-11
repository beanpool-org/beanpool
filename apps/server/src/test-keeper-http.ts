/**
 * The keyholder routes over REAL HTTP — is any of this actually reachable?
 *
 * Boots the real server and verifies:
 *   1. Are the routes mounted?
 *   2. Does a correctly signed request arrive with an actor the handler recognises?
 *   3. Is an unsigned write refused by the middleware, before the handler runs?
 *   4. Is the public recovery lookup reachable with NO credentials — including when
 *      ENFORCE_READ_AUTH is on?
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

async function main(): Promise<void> {
    console.log(`\nKeyholder routes over real HTTP (ENFORCE_READ_AUTH ${ENFORCED ? 'ON' : 'OFF'})\n`);
    await initTls();
    initStateEngine();

    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`)
      .run(pubKeyHex, CALLSIGN);

    db.prepare(`
        INSERT INTO recovery_shares
            (owner_pubkey, holder_type, holder_ref, share_index, encrypted_share, share_iv, share_tag, generation)
        VALUES (?, 'sso', 'google', 1, 'x', 'y', 'z', 1)
    `).run(pubKeyHex);

    await startHttpsServer(PORT);

    // ── 1. mounted and signed access ──────────────────────────────────────────────────────────
    const hubFrag = await signedFetch('POST', '/api/recovery/shares/hub-fragment', {});
    assert(hubFrag.status !== 404, 'POST /api/recovery/shares/hub-fragment is mounted (not a 404)');
    assert(hubFrag.status === 200, 'a signed hub-fragment request succeeds through the real middleware');

    // ── 2. the middleware refuses before the handler ──────────────────────────────────────────
    const unsignedHub = await signedFetch('POST', '/api/recovery/shares/hub-fragment', {}, { omitSig: true });
    assert(unsignedHub.status === 401, 'an unsigned hub-fragment request is refused');
    assert(/signature/i.test(String(unsignedHub.body?.error ?? '')),
        '...by the signature middleware, before the handler runs');

    const nonce = await signedFetch('POST', '/api/recovery/sso-nonce', {});
    assert(nonce.status === 200 && typeof nonce.body?.nonce === 'string',
        'POST /api/recovery/sso-nonce is mounted and issues a nonce to a signed member');
    assert((await signedFetch('POST', '/api/recovery/sso-nonce', {}, { omitSig: true })).status === 401,
        '...and refuses an unsigned caller');

    const status = await signedFetch('POST', '/api/recovery/shares/status', {});
    assert(status.status === 200 && status.body?.total === 1,
        'POST /api/recovery/shares/status is mounted and answers for the signer');

    // DELETE carries a body, which is the part most likely to be dropped in transit
    const noConfirm = await signedFetch('DELETE', '/api/recovery/shares', {});
    assert(noConfirm.status === 400 && noConfirm.body?.currentShareCount === 1,
        'DELETE /api/recovery/shares is mounted and reads its confirmation body');

    // ── 3. the public read, which is the whole point of the allowlist entry ───────────────────
    const publicRes = await fetch(`${BASE}/api/recovery/lookup/${CALLSIGN}`);
    const publicBody = await publicRes.json().catch(() => undefined) as any;
    assert(publicRes.status === 200,
        `GET /api/recovery/lookup/:callsign is reachable with NO credentials (got ${publicRes.status})`);
    assert(Array.isArray(publicBody) && publicBody.length === 1 && publicBody[0].callsign === CALLSIGN,
        '...and answers with the recovery lookup candidates');
    assert(publicBody[0].canRecoverByGuardians === false && publicBody[0].canRecoverBySso === true,
        '...reporting guardian recovery false and SSO recovery true');

    if (ENFORCED) {
        assert(publicRes.status === 200,
            'ENFORCED: the recovery lookup is on the public-read allowlist');
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

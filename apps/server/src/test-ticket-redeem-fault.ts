/**
 * An offline ticket's redeem that fails AFTER the node has written the member (PR #1198, confirmation finding
 * 4112075324). engine/invites.ts redeemOfflineTicket used to wrap everything, registration included, in one catch that
 * answered 400 "Malformed or broken offline ticket payload"; the web app reads a redeem's 400 as "this send made no
 * member" and let the key go, so a fault after the write lost a member's only key. Now only the ticket's decoding and
 * checking answer that 400; a fault after registration reaches Koa as a 500, which the apps keep the key for.
 *
 * The fault is a trigger that refuses the redeem's `UPDATE invite_codes ... used_by`, the statement after
 * registerMemberInternal (a full disk or SQLITE_BUSY there does the same). Over HTTP, through the real routes.
 *
 * Run: ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-ticket-redeem-fault.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { db } from './db/db.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

let BASE = '';
const MALFORMED = 'Malformed or broken offline ticket payload';

type Id = { pk: string; priv: crypto.KeyObject; name: string };
type Res = { status: number; body: any };

function keypair(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey, name };
}

/** An offline ticket, as the app signs one: the payload and its signature, base64 JSON. */
function offlineTicket(inviter: Id): string {
    const payload = JSON.stringify({ i: inviter.pk, t: Date.now() });
    const s = crypto.sign(null, Buffer.from(payload), inviter.priv).toString('base64');
    return Buffer.from(JSON.stringify({ p: payload, s })).toString('base64');
}

/** Signed by `id` when given, as both apps sign a redeem and the membership probe with the key they name. */
async function call(method: 'GET' | 'POST', id: Id | null, path: string, body?: unknown): Promise<Res> {
    resetGatewayRateLimit();
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const canonical = `${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`;
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(canonical), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? bodyString : undefined });
    let json: any; try { json = await res.json(); } catch { /* not JSON: Koa's own 500 is plain text */ }
    return { status: res.status, body: json };
}

const memberRow = (pk: string) => db.prepare('SELECT callsign, is_visitor FROM members WHERE public_key = ?').get(pk) as
    { callsign: string; is_visitor: number } | undefined;

/** The redeem's write after registration fails, for this key only, until `clear` is called. */
function faultAfterRegistration(pk: string): { clear: () => void } {
    db.exec(`CREATE TRIGGER fault_after_registration BEFORE UPDATE OF used_by ON invite_codes
             WHEN NEW.used_by = '${pk}' BEGIN SELECT RAISE(ABORT, 'injected: the write after registration failed'); END;`);
    return { clear: () => db.exec('DROP TRIGGER IF EXISTS fault_after_registration') };
}

async function main(): Promise<void> {
    console.log("An offline ticket's redeem that fails after the member is written is never answered as a broken ticket\n");
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const inviter = keypair('Inviter');
    seedGenesisMember(inviter.pk, inviter.name);

    // 1. The fault after registration.
    const rowan = keypair('Rowan');
    const ticket = offlineTicket(inviter);
    const fault = faultAfterRegistration(rowan.pk);
    let res: Res;
    try {
        res = await call('POST', rowan, '/api/invite/redeem-offline', { ticketB64: ticket, publicKey: rowan.pk, callsign: rowan.name });
    } finally {
        fault.clear();
    }
    assert(res.status !== 400, `a fault after registration is not a 400 (got ${res.status})`);
    assert(res.body?.error !== MALFORMED, 'nor is it answered "Malformed or broken offline ticket payload"');
    assert(res.status === 500, `it reaches Koa as a 500, which the apps keep the key for (got ${res.status})`);
    const row = memberRow(rowan.pk);
    assert(!!row && row.is_visitor === 0 && row.callsign === 'Rowan', 'the member was written before the fault, and stays');

    // What the web app does next: it asks the node, signed by the key, and is told "a member".
    const probe = await call('GET', rowan, `/api/community/membership/${rowan.pk}`);
    assert(probe.status === 200 && probe.body?.isMember === true, 'the membership probe, signed by the key, says it is a member');

    // A retry with the same key and ticket, once the fault has passed: answered as a member, and nothing doubled.
    const retry = await call('POST', rowan, '/api/invite/redeem-offline', { ticketB64: ticket, publicKey: rowan.pk, callsign: rowan.name });
    assert(retry.status === 200 && retry.body?.success === true && retry.body?.alreadyMember === true,
        `the same key's retry is answered "already a member" (got ${retry.status} ${JSON.stringify(retry.body)})`);
    const rows = (db.prepare('SELECT COUNT(*) AS n FROM members WHERE public_key = ?').get(rowan.pk) as { n: number }).n;
    assert(rows === 1, 'one member row for the key');

    // 2. A broken ticket is still refused 400 "Malformed", before anything is written.
    const junk = keypair('Junk');
    for (const [label, ticketB64] of [
        ['base64 of no JSON', Buffer.from('not json at all').toString('base64')],
        ['JSON with no payload', Buffer.from(JSON.stringify({ s: 'c2ln' })).toString('base64')],
        ['not a string', 12345],
    ] as const) {
        const r = await call('POST', junk, '/api/invite/redeem-offline', { ticketB64, publicKey: junk.pk, callsign: junk.name });
        assert(r.status === 400 && r.body?.error === MALFORMED, `a ticket that is ${label}: 400 "${MALFORMED}" (got ${r.status} ${JSON.stringify(r.body)})`);
    }
    assert(!memberRow(junk.pk), 'and no member was written for any of them');

    // 3. A ticket that decodes but doesn't check out: its own 400, as before.
    const stranger = keypair('Stranger');
    const bad = await call('POST', junk, '/api/invite/redeem-offline', { ticketB64: offlineTicket(stranger), publicKey: junk.pk, callsign: junk.name });
    assert(bad.status === 400 && typeof bad.body?.error === 'string' && bad.body.error !== MALFORMED,
        `a ticket signed by someone who is not a member: its own 400 (got ${bad.status} ${JSON.stringify(bad.body)})`);
    assert(!memberRow(junk.pk), 'and no member was written');

    // 4. With no fault, a fresh ticket joins as ever.
    const sky = keypair('Sky');
    const ok = await call('POST', sky, '/api/invite/redeem-offline', { ticketB64: offlineTicket(inviter), publicKey: sky.pk, callsign: sky.name });
    assert(ok.status === 200 && ok.body?.success === true && !ok.body?.alreadyMember, `a fresh ticket joins (got ${ok.status})`);
    assert(memberRow(sky.pk)?.is_visitor === 0, 'and its member is written');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ ticket-redeem-fault checks PASSED.');
}

main().then(() => process.exit(process.exitCode ?? 0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });

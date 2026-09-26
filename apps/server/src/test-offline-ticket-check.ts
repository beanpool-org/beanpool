/**
 * An offline ticket passes the join's pre-flight, sent the way both apps send it (#1218's deciding pass, 4112846555).
 *
 * The node reads a code as an offline ticket only by its `BP-` (engine/members.ts checkInvite); anything else is looked
 * up as an invite code. Both apps' checkInvite used to cut the `BP-` off before GET /api/invite/check, so every ticket
 * was answered "invalid" and the member was told it wasn't recognised, with no redeem sent. They now send the code as
 * the member has it: `?code=` + encodeURIComponent(`BP-` + ticket) (apps/native utils/db.ts and apps/pwa lib/api.ts,
 * pinned by check-invite-ticket.test.ts and check-invite.test.ts). This pins the node's half over real HTTP, with a
 * correctly signed ticket in each app's form, so the two can't drift apart again:
 *
 *  1. Sent with its `BP-`: valid, naming the inviter. Sent without it (what the apps did): invalid, as before.
 *  2. Redeemed the way the apps redeem one (`ticketB64` is the ticket alone, without `BP-`), the same check says used.
 *  3. An invite code is checked as it is, as before.
 *
 * Run: ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-offline-ticket-check.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, generateInvite } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { db } from './db/db.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

let BASE = '';

type Id = { pk: string; priv: crypto.KeyObject; name: string };
type Res = { status: number; body: any };

function keypair(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey, name };
}

/** A ticket as the phone makes one (apps/native app/(tabs)/people.tsx): base64 of { p: the payload in base64, s }. */
function phoneTicket(inviter: Id, t: number): string {
    const payload = JSON.stringify({ i: inviter.pk, t });
    const s = crypto.sign(null, Buffer.from(payload), inviter.priv).toString('base64');
    return Buffer.from(JSON.stringify({ p: Buffer.from(payload).toString('base64'), s })).toString('base64');
}

/** A ticket as the web app makes one (apps/pwa pages/InvitePage.tsx): URL-safe base64 of { p: the payload, s }, unpadded. */
function webTicket(inviter: Id, t: number): string {
    const payload = JSON.stringify({ i: inviter.pk, t });
    const s = crypto.sign(null, Buffer.from(payload), inviter.priv).toString('base64');
    return Buffer.from(JSON.stringify({ p: payload, s })).toString('base64url');
}

/** Signed by `id` when given, as both apps sign a redeem with the key it names. */
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
    let json: any; try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body: json };
}

/** The pre-flight, as both apps send it: the code as the member has it, escaped for the query. */
const inviteCheck = (code: string) => call('GET', null, `/api/invite/check?code=${encodeURIComponent(code)}`);
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body ?? null).slice(0, 120)}`;
const isMember = (pk: string) => !!db.prepare('SELECT 1 FROM members WHERE public_key = ? AND is_visitor = 0').get(pk);

async function main(): Promise<void> {
    console.log('An offline ticket passes the pre-flight, sent the way both apps send it\n');
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const ana = keypair('Ana');
    seedGenesisMember(ana.pk, ana.name);

    // A minute apart: a ticket is known by its signature (engine/members.ts codeHash), and one inviter's two tickets made
    // in the same millisecond sign the same payload, so they would be one ticket.
    const now = Date.now();
    for (const [made, ticket] of [['on a phone', phoneTicket(ana, now)], ['in the web app', webTicket(ana, now - 60_000)]] as const) {
        assert(ticket.length > 20 && !ticket.startsWith('BP-'), `setup: a ticket made ${made} (${ticket.length} characters)`);

        // 1. With its BP-, as the apps now send it; without, as they used to.
        const sent = await inviteCheck(`BP-${ticket}`);
        assert(sent.status === 200 && sent.body?.valid === true && sent.body?.inviterCallsign === 'Ana',
            `a ticket made ${made}, checked with its BP-: valid, invited by Ana (${show(sent)})`);
        const stripped = await inviteCheck(ticket);
        assert(stripped.status === 200 && stripped.body?.valid === false && stripped.body?.reason === 'invalid',
            `the same ticket checked without its BP- (what both apps sent before): invalid, read as an invite code this node never made (${show(stripped)})`);

        // 2. Redeemed as the apps redeem one: the ticket alone, signed by the key it names. The check then says used.
        const joiner = keypair(`Joiner ${made}`);
        const redeem = await call('POST', joiner, '/api/invite/redeem-offline', { ticketB64: ticket, publicKey: joiner.pk, callsign: joiner.name });
        assert(redeem.status === 200 && redeem.body?.success === true && isMember(joiner.pk),
            `redeemed as the apps redeem one (ticketB64 without BP-): a member (${show(redeem)})`);
        const after = await inviteCheck(`BP-${ticket}`);
        assert(after.status === 200 && after.body?.valid === false && after.body?.reason === 'used',
            `checked again with its BP-: used, which the apps' spent-invite steps read (${show(after)})`);
    }

    // 3. An invite code goes as it is.
    const code = generateInvite(ana.pk)!.code;
    const plain = await inviteCheck(code);
    assert(plain.status === 200 && plain.body?.valid === true && plain.body?.inviterCallsign === 'Ana',
        `an invite code (${code}) checked as it is: valid, invited by Ana (${show(plain)})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ offline-ticket-check checks PASSED.');
}

main().then(() => process.exit(process.exitCode ?? 0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });

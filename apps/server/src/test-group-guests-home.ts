/**
 * Group guests on the GUEST'S OWN community's server (slice G1b: engine/group-guest-home.ts; the host's side is
 * test-group-guests.ts). Through the real middleware: the node under test is a.example (BEANPOOL_ADDRESSES, its own node
 * key), whose members Gus and Gia are guests in groups hosted elsewhere. The hosts are played by this suite: b.example (the
 * host they answered), d.example (a host nobody here answered) and c.example (a server the owners blocked), each with its
 * own server key and key document (handed to the node's door by the test fetch hook, double-locked by
 * BEANPOOL_SSRF_TEST_HOOK=1); what the node sends a host reaches the suite through the transport hook. No other server is
 * contacted.
 *
 *   1  close the class: every notice a host brings (invite, roster, line, line with a mention, epoch, removal, edit, a
 *      line taken down) x (the host the guest answered, a host nobody answered, a blocked host, a removed guest, a key
 *      that is no member here, a standby) -> held for the guest or dropped, the answer always the same 202 (400 for a kind
 *      that is no notice)
 *   2  nothing reaches a device that isn't that guest's: one notice naming two guests -> each holds only their own wrap;
 *      each one's device reads only theirs; a member not named gets nothing
 *   3  close the class: every item a member sends a group elsewhere (yes, no, leave, line, line with a mention, epoch) x
 *      (invitation waiting, in, removed, never invited, standby) -> sent to the host once, signed, and where they stand
 *      moved; or refused, nothing stored, nothing sent
 *   4  close the class, the epoch steps: the host's roster (epoch null / stale / not stale) -> kept; the device reads it;
 *      core's guestEpochStep -> a group-epoch over exactly the chat's keys, or the line again under the current epoch;
 *      the host's epoch-stale answer reaches the device
 *   5  a removed guest gets nothing after the removal: the next epoch, line and roster are dropped
 *   6  each device confirms for itself: a notice waits until every listed device has it
 *   7  close the class, the backoff follows time (#3197 round 3 finding, g1b-must-include): (the host's fan-out, a
 *      member's sends) x (rows queued during an outage: 1 / 6 / 30) x (outage: 30 minutes / 3 hours) -> tries due at 1, 5,
 *      15, 60, 120 minutes of elapsed time, a new row costs one early try that moves nothing, and once the other side
 *      answers every row goes once, in order
 *   8  a standby copies group_guest_links and never the held notices or sent items; the door; the route lists
 *   9  close the class, invariant A (#3217 round 2): (answered host, unanswered host, blocked host, removed guest) x floods
 *      (one invitation repeated, invitations to many groups, invite-and-withdraw cycles, invitations past the size limit,
 *      lines, rosters and epochs, 1.85 MB lines past 50 MB, lines one device confirms as they come) -> what that host
 *      stores for the member stays inside its standing's allowance by count, bytes and link rows, and another host's held
 *      line is kept, its next line and a third host's invitation held
 *  10  close the class, invariant B: (yes, no, leave) x (2xx taken, 2xx refused in the answer, 400, 413, 503, timeout, a
 *      day of no answer) -> the link moves only when the host took the item; a queued item goes again and moves it then;
 *      an item not taken can be sent again
 *  11  close the class, invariant C: (the host's fan-out, a member's sends) x (success then failure, failure alone, mixed
 *      batches with and without a 2xx, a 2xx refusing in its answer, failure then success) -> the next due time; any 2xx
 *      starts the steps over, and another host's step is untouched
 *  14  close the class, a complaint about a member's line as a guest (G1b part 2: the host's moderators had it reported,
 *      and it tells this server): (a line the host took, still queued, refused by the host, failed, another member's id,
 *      a direct line's id) x (signed by the group's host, by another server) -> filed once here as "from another
 *      community" (never naming who reported it), or the one 422 every drop gets; a repeat is the same 202
 *  15  close the class, takedowns (#3233 round 2): (author delete, edited then deleted, convenor removal, account deleted,
 *      group closed) x (held with no device having it, one device having it, every device having it) -> no copy of the
 *      line's words or photo is served or kept, and each device is served the tombstone; 15e: (edit while held, twice,
 *      after one device has it, after every device has it) -> each device is served only the newest words; 15w: out of
 *      the group (leave taken, removed, the switch, group closed) -> nothing of it held is served; 15v: a host blocked
 *      since: its takedown still drops what it brought; 15d: nothing held past MAIL_HELD_DAYS is served, swept yet or not
 *      (the host offers a takedown that long and a day more)
 *  16  close the class, the order rule (G2): (removal, re-invitation, roster, takedown: every pair a host can make) x (one
 *      server; A then B after a take-over, its copy current / from before / its clock 10 minutes behind; a take-over and
 *      take-back between) x (arriving in the order made, reversed) -> what the two in the order made leave, the newest word
 *      on where the guest stands winning; 16b a counter that is no positive whole number: 400; 16c a withdrawn invitation
 *      never comes back; 16d a newer invitation to someone in that can't be held: out all the same; 16o (G2 round 2) out of
 *      the group however it comes (the host's removal, a newer invitation held, one refused so only its counter speaks,
 *      their leave) x (held: line, edit with words, takedown) x (device: fetched it, not) -> each device told it is out
 *      (but after its own leave), no words kept, a takedown still served to the device that did not fetch it; 16f every
 *      branch that holds a notice -> the answered flag stored is the allowance it was checked against; 16s each fetch's
 *      `linksAt` is strictly later than the one before, so a page read before an invitation came is known as older (two
 *      tabs: the apps' rule); 16r a home restored
 *      from an older snapshot: (line, edit, takedown, epoch, roster, removal,
 *      invitation held) x (a restore's notice, a roll-back's, an unreadable one) -> no line or edit is held after the boot
 *      (takedowns stay), and the boot wires it
 *  17  close the class, THE INVARIANT (G2 follow-ups): (an invitation, the same told again after a take-over, the host's
 *      answers to a yes, a no and a leave, each with its counter, a roster, a removal, an invitation again) x (every
 *      arrival order the transports allow) x (a device's stale tab: a page read halfway, applied after the end one) ->
 *      the same final state at the home and on the device, for every order
 *  18  close the class, GENERATED (G2 follow-ups round 2, #3266: a yes that moved nothing recorded its counter and shadowed
 *      an invitation made again): every history of up to 4 of the host's acts (invite, withdraw, invite again, the guest's
 *      yes, no and leave as the host takes them, remove, a roster) its own rules allow x every arrival order of its words
 *      at the home (notices in any order; each of the guest's items sent while the home lets them, before any word the
 *      host made after taking it, oldest first, its answer after it) x a device's stale tab -> where the guest stands at
 *      the home and on the device is what the host's newest word says, for every row; a word that applies nothing records
 *      nothing
 *
 * Run: SERVER_SUITES_ONLY=test-group-guests-home node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.BEANPOOL_SSRF_TEST_HOOK = '1';
process.env.BEANPOOL_ADDRESSES = 'a.example';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
    NODE_KEY_VALIDITY_MS, NODE_REQUEST_HEADER, applyGuestMail, buildNodeRequestHeaders, dmPublicKeyOf, groupEpochCoversExactly, guestChatId, guestEpochStep, makeGroupEpochRecord,
    makeGuestEpoch, nodeRequestSignatureVerifies, openGuestEpochKey, parseNodeRequestHeader, readGuestRoster, readNodeKeyDocument, relayEnvelopeVerifies,
    relayPayloadHash, sealGroupLine, signNodeKeyDocument, signRelayEnvelope, verifyGroupEpochRecord, type GroupEpochRecord, type RelayItemKind,
} from '@beanpool/core';
import { setSignedForHost, signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

interface Id { pk: string; seedHex: string; seed: Uint8Array; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const seed = crypto.randomBytes(32);
    const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
    const seedHex = seed.toString('hex');
    return { pk: dmPublicKeyOf(seedHex), seedHex, seed, priv: crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }), name };
}
const signerOf = (seed: Uint8Array) => (b: Uint8Array) => ed25519.sign(b, seed);
const MIN = 60_000;

interface Res { status: number; body: any }

async function main(): Promise<void> {
    const dataDir = process.env.BEANPOOL_DATA_DIR;
    if (!dataDir) throw new Error('BEANPOOL_DATA_DIR must be set to a fresh directory');
    const { generateKeyPair, privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
    fs.writeFileSync(path.join(dataDir, 'libp2p_key'), privateKeyToProtobuf(await generateKeyPair('Ed25519')));

    const { initTls } = await import('./services/tls.js');
    const { initStateEngine, seedGenesisMember } = await import('./state-engine.js');
    const { setNodeRole } = await import('./config/node-role.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { __useNodeKeyFetchForTests, NODE_SIGNED_PATHS } = await import('./engine/node-signature.js');
    const { __useRelayTransportForTests } = await import('./engine/relay-outbox.js');
    const { addConnector, removeConnector } = await import('./connector-manager.js');
    const { noteMailDevice } = await import('./engine/relay-mail.js');
    const { TABLES } = await import('./engine/replication-manifest.js');
    const { RELAY_MAIL_TABLES } = await import('./engine/relay-mail-tables.js');
    // Loaded at run time, so on a server without them (origin/main, the fail-first run) the suite reports a count, not a crash.
    const home: any = await import('./engine/group-guest-home.js').catch(() => null);
    const hostSide: any = await import('./engine/group-guests.js').catch(() => null);

    await initTls();
    initStateEngine();
    // Port 0: the system picks a free port for this server alone (never a fixed one a sibling suite could hold), and
    // startHttpsServer answers it only once the server is listening on it.
    const PORT = await startHttpsServer(0);
    const BASE = `https://localhost:${PORT}`;
    setSignedForHost('a.example');

    // ── People and servers ──────────────────────────────────────────────────────────────────
    const olive = newId('Olive');
    seedGenesisMember(olive.pk, 'Olive');
    const addLocal = (name: string): Id => {
        const id = newId(name);
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'TEST', 'active')`).run(id.pk, name, olive.pk);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
        return id;
    };
    const gus = addLocal('Gus'), gia = addLocal('Gia'), hal = addLocal('Hal'), ivy = addLocal('Ivy');
    const nobody = newId('Nobody');                      // no member here
    const ana = newId('Ana'), ben = newId('Ben');        // members at b.example
    const B = newId('B'), C = newId('C'), D = newId('D'); // the hosts' server keys
    const hostKey: Record<string, Id> = { 'b.example': B, 'c.example': C, 'd.example': D };
    const now0 = Date.now();
    const docs = new Map<string, unknown>();
    for (const [h, k] of Object.entries(hostKey)) {
        docs.set(`https://${h}/api/node/key`, await signNodeKeyDocument({ key: k.pk, validUntil: now0 + NODE_KEY_VALIDITY_MS, previousKeys: [] }, signerOf(k.seed)));
    }
    __useNodeKeyFetchForTests(async (url) => {
        if (!docs.has(url)) throw new Error('no such server');
        return docs.get(url);
    });
    // The owners blocked c.example (the connector's blocked level).
    addConnector('c.example:4001', 'blocked', 'Blocked', 'https://c.example', false);
    /**
     * Every request this suite makes (section 0 pins it): Connection: close, so no socket waits in a pool. Section 9 calls
     * the engine thousands of times without a turn, holding this process's loop, the server's with it, for seconds; on CI
     * (run 43759989771, shard server-1, Node 22) the next call went out on the pooled socket the server's 5 s keep-alive
     * was closing and read ECONNRESET. The same remedy as test-backup-owner-gate and test-moderation-notifications.
     */
    const suiteFetch = (url: string, init: RequestInit = {}) => fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), connection: 'close' } });
    // The first call: the server answers on the port it was given before anything else is asked of it (no retry).
    const keyRes = await suiteFetch(`${BASE}/api/node/key`);
    if (keyRes.status !== 200) throw new Error(`a.example is not answering on port ${PORT} (${keyRes.status})`);
    const aDoc = readNodeKeyDocument(await keyRes.json());
    if (!aDoc) throw new Error('a.example has no key document');

    // What the node sends other servers: a member's items to b.example's /api/relay/mail; the backoff table's notices.
    interface Out { host: string; path: string; signed: boolean; body: any }
    const outs: Out[] = [];
    /** Every try to each server, a failing one included. */
    const triesTo = new Map<string, number>();
    const failing = new Set<string>();
    const refuseIds = new Map<string, string>();       // item id -> the refusal b.example answers for it
    // item id -> the counter b.example's answer carries (the guest's own word, sections 17 and 18), or null for none (a yes
    // from a guest it has out). Unset: its next counter, as the host stamps every yes, no or leave it takes (group-guests.ts
    // takeGuestItem), never older than a notice this suite made before it.
    const answerSeq = new Map<string, number | null>();
    let hostClock = 0;
    const hostSeqFor = (i: any): number | null => (answerSeq.has(i.envelope.itemId) ? answerSeq.get(i.envelope.itemId)!
        : i.envelope.kind === 'group-invite' || i.envelope.kind === 'group-leave' ? (hostClock = Math.max(Date.now() + 1, hostClock + 1)) : null);
    const receivedBy = (i: any) => {
        const s = hostSeqFor(i);
        return { itemId: i.envelope.itemId, received: true, ...(s === null ? {} : { seq: s }) };
    };
    /** Each server's next answers, one a try, in order: '2xx', 'refused' (a 2xx refusing every item), a status, or 'timeout'. */
    const script = new Map<string, string[]>();
    __useRelayTransportForTests(async (url, init) => {
        const u = new URL(url);
        triesTo.set(u.host, (triesTo.get(u.host) ?? 0) + 1);
        const scripted = script.get(u.host)?.shift();
        if (failing.has(u.host) || scripted === 'timeout') throw new Error('connect ETIMEDOUT');
        const header = parseNodeRequestHeader(init.headers[NODE_REQUEST_HEADER] ?? '');
        const signed = !!header && header.key === aDoc.key && header.destination === u.host && header.origin === 'a.example'
            && nodeRequestSignatureVerifies(header, { method: 'POST', path: u.pathname, body: init.body });
        const body = JSON.parse(init.body);
        outs.push({ host: u.host, path: u.pathname, signed, body });
        if (scripted && scripted !== '2xx' && scripted !== 'refused') return { status: Number(scripted), body: { error: 'no' } };
        if (u.pathname === '/api/relay/mail') {
            return { status: 202, body: { items: body.items.map((i: any) => (scripted === 'refused' || refuseIds.has(i.envelope.itemId)
                ? { itemId: i.envelope.itemId, refused: refuseIds.get(i.envelope.itemId) ?? 'group-refused' }
                : receivedBy(i))) } };
        }
        return { status: 202, body: { received: true } };
    });

    // ── Helpers ─────────────────────────────────────────────────────────────────────────────
    async function call(method: 'GET' | 'POST', signer: Id, p: string, body?: unknown): Promise<Res> {
        resetGatewayRateLimit();
        const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const headers: Record<string, string> = {
            'X-Public-Key': signer.pk, 'X-Signature': signRequest(signer.priv, { method, path: p.split('?')[0], timestamp: ts, nonce, body: raw }),
            [SIGNED_FOR_HEADER]: signedForHost(), 'X-Timestamp': String(ts), 'X-Nonce': nonce,
        };
        if (method !== 'GET') headers['Content-Type'] = 'application/json';
        const res = await suiteFetch(`${BASE}${p}`, { method, headers, body: method === 'GET' ? undefined : raw });
        const text = await res.text();
        let parsed: any = text;
        try { parsed = JSON.parse(text); } catch { /* empty */ }
        return { status: res.status, body: parsed };
    }
    /** A host brings a notice to a.example, in a request it signed. */
    async function notice(host: string, n: unknown, opts: { origin?: string } = {}): Promise<Res> {
        const origin = opts.origin ?? host;
        const k = hostKey[origin];
        const body = JSON.stringify(n);
        const headers = await buildNodeRequestHeaders({ method: 'POST', url: 'https://a.example/api/relay/group', body, origin, keyHex: k.pk, sign: signerOf(k.seed) });
        const res = await suiteFetch(`${BASE}/api/relay/group`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
        let parsed: any = null;
        try { parsed = await res.json(); } catch { /* none */ }
        return { status: res.status, body: parsed };
    }
    let seq = 0;
    const newItemId = () => `ggh-${String(++seq).padStart(4, '0')}-${crypto.randomBytes(6).toString('hex')}`;
    async function item(from: Id, kind: RelayItemKind, group: string, payload: string, host = 'b.example', itemId = newItemId()) {
        const envelope = await signRelayEnvelope({
            kind, itemId, senderKey: from.pk, senderHome: 'a.example', recipient: `group:${group}`, recipientHome: host,
            at: Date.now(), payloadHash: relayPayloadHash(payload),
        }, signerOf(from.seed));
        return { envelope, payload };
    }
    const send = (who: Id, items: unknown[]) => call('POST', who, '/api/mail/send', { items });
    const device = () => crypto.randomBytes(16).toString('hex');
    const fetchGroup = (who: Id, dev: string) => call('GET', who, `/api/mail/group?device=${dev}`);
    const linkOf = (who: Id, host: string, g: string) => db.prepare('SELECT * FROM group_guest_links WHERE member = ? AND host = ? AND group_id = ?').get(who.pk, host, g) as any;
    const setLink = (who: Id, host: string, g: string, state: string) => db.prepare(`INSERT INTO group_guest_links (member, host, group_id, state, state_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (member, host, group_id) DO UPDATE SET state = excluded.state`).run(who.pk, host, g, state, Date.now());
    const heldCount = (who: Id, host: string, g: string) => (db.prepare('SELECT COUNT(*) AS n FROM group_guest_mail WHERE member = ? AND host = ? AND group_id = ?').get(who.pk, host, g) as { n: number }).n;
    const sentCount = () => (db.prepare('SELECT COUNT(*) AS n FROM group_guest_sent').get() as { n: number }).n;

    // What each notice kind carries, as engine/group-guests.ts sends it.
    const wrap = (who: Id) => ({ recipient: who.pk, wrapper: ana.pk, ephPub: 'e'.repeat(43) + '=', nonce: 'n'.repeat(32), wrapped: 'w'.repeat(64) });
    const record = { epoch: 1, reason: 'start', subject: null, createdBy: ana.pk, createdAt: new Date().toISOString(), keyCommit: 'k', membersDigest: 'm', wrapsDigest: 'w', sig: 's' };
    const DATA: Record<string, unknown> = {
        invite: { name: 'Seed Library', invitedBy: { key: ana.pk, name: 'Ana' } },
        roster: { name: 'Seed Library', members: [{ key: ana.pk, name: 'Ana' }], guests: [{ key: gus.pk, home: 'a.example', name: 'Gus' }, { key: gia.pk, home: 'a.example', name: 'Gia' }],
            epoch: { current: 1, stale: false, record, wraps: [wrap(gus), wrap(gia)] } },
        line: { id: 'm-1', author: ana.pk, ciphertext: 'c', nonce: 'group-xc20p-v1:n', type: 'text', metadata: null, timestamp: new Date().toISOString() },
        'line-mention': { id: 'm-2', author: ana.pk, ciphertext: 'c', nonce: 'group-xc20p-v1:n', type: 'text', metadata: { mentions: [gus.pk] }, timestamp: new Date().toISOString() },
        epoch: { record, wraps: [wrap(gus), wrap(gia)] },
        removed: { why: 'removed' },
        edit: { id: 'm-1', action: 'edited', author: ana.pk, ciphertext: 'c2', nonce: 'group-xc20p-v1:n2', metadata: { epoch: 1, sender: ana.pk }, editedAt: new Date().toISOString() },
        'line-taken-down': { id: 'm-1', action: 'removed', by: 'convenor' },
    };
    const kindOfRow = (k: string) => (k === 'line-mention' ? 'line' : k === 'line-taken-down' ? 'edit' : k);
    const noticeOf = (k: string, host: string, g: string, guests: string[]) => ({ v: 1, kind: kindOfRow(k), group: g, host, guests, data: DATA[k] });

    if (!home) {
        // The fail-first run: the engine is not there, so every check below would crash; say so in the count.
        const r = await notice('b.example', noticeOf('invite', 'b.example', 'g-ff', [gus.pk]));
        assert(r.status === 202, `the route takes a host's notice (got ${r.status} ${JSON.stringify(r.body)})`);
        console.log(`\n${passed}/${run} passed`);
        process.exit(1);
    }

    // ── 0. The suite's own requests ─────────────────────────────────────────────────────────
    console.log('\n0. The suite\'s own requests: the server on the port the system picked, and no socket left in a pool');
    // A hold of the loop past the keep-alive does not reset the next call on Node 26 (this Mac, measured both ways), only on
    // CI's Node 22 now and then, so this pins the remedy itself: every request goes through suiteFetch, which says
    // Connection: close.
    const ownSrc = fs.readFileSync(new URL(import.meta.url).pathname, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l));
    const fetchLines = ownSrc.filter((l) => /(?<![A-Za-z])fetch\(/.test(l));
    const suiteFetchLine = ownSrc.find((l) => /const suiteFetch = /.test(l)) ?? '';
    assert(PORT > 0 && fetchLines.length === 1 && fetchLines[0] === suiteFetchLine && /connection: 'close'/.test(suiteFetchLine),
        `0. port ${PORT} picked by the system; the suite's one fetch is suiteFetch's, which says Connection: close (other fetches: ${fetchLines.filter((l) => l !== suiteFetchLine).length})`);

    // ── 1. Every notice x where the guest stands ────────────────────────────────────────────
    console.log('\n1. Close the class: every notice a host brings x where the guest stands -> held or dropped, answered alike');
    const KINDS = ['invite', 'roster', 'line', 'line-mention', 'epoch', 'removed', 'edit', 'line-taken-down'] as const;
    type Standing = 'answered host' | 'unknown host' | 'blocked host' | 'removed guest' | 'no member here' | 'standby';
    const STANDINGS: Standing[] = ['answered host', 'unknown host', 'blocked host', 'removed guest', 'no member here', 'standby'];
    /** Whether the notice is held for the guest: [kind][standing]. An edit, and a line taken down, are held as a line is (G1b part 2). */
    const HELD: Record<string, Record<Standing, boolean>> = {
        invite:         { 'answered host': false, 'unknown host': true,  'blocked host': false, 'removed guest': true,  'no member here': false, standby: false },
        roster:         { 'answered host': true,  'unknown host': false, 'blocked host': false, 'removed guest': false, 'no member here': false, standby: false },
        line:           { 'answered host': true,  'unknown host': false, 'blocked host': false, 'removed guest': false, 'no member here': false, standby: false },
        'line-mention': { 'answered host': true,  'unknown host': false, 'blocked host': false, 'removed guest': false, 'no member here': false, standby: false },
        epoch:          { 'answered host': true,  'unknown host': false, 'blocked host': false, 'removed guest': false, 'no member here': false, standby: false },
        removed:        { 'answered host': true,  'unknown host': false, 'blocked host': false, 'removed guest': false, 'no member here': false, standby: false },
        edit:           { 'answered host': true,  'unknown host': false, 'blocked host': false, 'removed guest': false, 'no member here': false, standby: false },
        'line-taken-down': { 'answered host': true, 'unknown host': false, 'blocked host': false, 'removed guest': false, 'no member here': false, standby: false },
    };
    let rowN = 0;
    for (const k of KINDS) {
        for (const s of STANDINGS) {
            const g = `g1-${++rowN}`;
            const host = s === 'unknown host' ? 'd.example' : s === 'blocked host' ? 'c.example' : 'b.example';
            const who = s === 'no member here' ? nobody : gus;
            if (s === 'answered host' || s === 'blocked host' || s === 'standby') setLink(who, host, g, 'in');
            if (s === 'removed guest') setLink(who, host, g, 'removed');
            const linkBefore = JSON.stringify(linkOf(who, host, g) ?? null);
            if (s === 'standby') setNodeRole('backup');
            const r = await notice(host, noticeOf(k, host, g, [who.pk]));
            if (s === 'standby') setNodeRole('primary');
            const held = heldCount(who, host, g) === 1;
            const link = linkOf(who, host, g);
            const wantStatus: number = 202;
            const answerOk = r.status === wantStatus && (wantStatus === 400 ? r.body?.code === 'bad_notice' : r.body?.received === true);
            const linkOk = !HELD[k][s] ? JSON.stringify(link ?? null) === linkBefore
                : k === 'invite' ? link?.state === 'invited' : k === 'removed' ? link?.state === 'removed' && link.roster === null
                : k === 'roster' ? link?.state === 'in' && typeof link.roster === 'string' : link?.state === 'in';
            assert(answerOk && held === HELD[k][s] && linkOk,
                `1. ${k} x ${s}: ${HELD[k][s] ? 'held' : 'dropped'}, answered ${wantStatus} (got ${r.status} ${JSON.stringify(r.body)}, held ${held}, link ${JSON.stringify(link?.state ?? null)})`);
        }
    }
    assert(rowN === KINDS.length * STANDINGS.length && Object.keys(HELD).length === KINDS.length,
        `1z. the table has a row for every notice kind and every standing (${rowN} rows)`);
    const notSigner = await notice('b.example', noticeOf('line', 'b.example', 'g1-x', [gus.pk]), { origin: 'd.example' });
    assert(notSigner.status === 400 && notSigner.body?.code === 'wrong_host', `1y. a notice naming a host that is not its signer: 400 wrong_host (got ${notSigner.status} ${notSigner.body?.code})`);
    setLink(gus, 'b.example', 'g1-k', 'in');
    const noKind = await notice('b.example', { v: 1, kind: 'reaction', group: 'g1-k', host: 'b.example', guests: [gus.pk], data: { id: 'm-1' } });
    assert(noKind.status === 400 && noKind.body?.code === 'bad_notice' && heldCount(gus, 'b.example', 'g1-k') === 0,
        `1x. a kind that is no notice: 400 bad_notice, nothing held (got ${noKind.status} ${noKind.body?.code})`);

    // ── 2. Only that guest's ────────────────────────────────────────────────────────────────
    console.log('\n2. Nothing reaches a device that isn\'t that guest\'s');
    setLink(gus, 'b.example', 'g2', 'in');
    setLink(gia, 'b.example', 'g2', 'in');
    await notice('b.example', noticeOf('epoch', 'b.example', 'g2', [gia.pk, gus.pk]));
    await notice('b.example', noticeOf('roster', 'b.example', 'g2', [gia.pk, gus.pk]));
    const wrapsHeld = (who: Id, kind: string) => {
        const row = db.prepare('SELECT body FROM group_guest_mail WHERE member = ? AND group_id = ? AND kind = ?').get(who.pk, 'g2', kind) as { body: string } | undefined;
        const d = row ? JSON.parse(row.body) : null;
        return (kind === 'epoch' ? d?.wraps : d?.epoch?.wraps)?.map((w: any) => w.recipient) ?? null;
    };
    assert(JSON.stringify(wrapsHeld(gus, 'epoch')) === JSON.stringify([gus.pk]) && JSON.stringify(wrapsHeld(gia, 'epoch')) === JSON.stringify([gia.pk]),
        '2a. one epoch naming Gus and Gia: each holds only their own wrap');
    assert(JSON.stringify(wrapsHeld(gus, 'roster')) === JSON.stringify([gus.pk]) && JSON.stringify(wrapsHeld(gia, 'roster')) === JSON.stringify([gia.pk])
        && JSON.parse(linkOf(gus, 'b.example', 'g2').roster).epoch.wraps.every((w: any) => w.recipient === gus.pk),
        '2b. the roster too, held and kept: each only their own wrap');
    const gusDev = device();
    const gusSees = await fetchGroup(gus, gusDev);
    const halSees = await fetchGroup(hal, device());
    const gusRows = (gusSees.body?.items ?? []) as any[];
    assert(gusSees.status === 200 && gusRows.length > 0 && gusRows.every((i) => !JSON.stringify(i).includes(gia.pk) || i.kind === 'roster')
        && gusRows.filter((i) => i.group === 'g2').every((i) => (i.kind === 'epoch' ? i.data.wraps : i.data.epoch?.wraps ?? []).every((w: any) => w.recipient === gus.pk)),
        `2c. Gus's device reads only his notices, and only his wraps in them (got ${gusRows.length} notices)`);
    assert(halSees.status === 200 && halSees.body.items.length === 0 && halSees.body.groups.length === 0, '2d. Hal, a member never named, gets nothing');
    const strangerSees = await call('GET', nobody, `/api/mail/group?device=${device()}`);
    assert(strangerSees.status === 403, `2e. a key that is no member here reads nothing (got ${strangerSees.status})`);

    // ── 3. Every item a member sends x where they stand ─────────────────────────────────────
    console.log('\n3. Close the class: every item a member sends a group elsewhere x where they stand');
    const ITEMS = ['yes', 'no', 'leave', 'line', 'line-mention', 'epoch'] as const;
    type Stand = 'invited' | 'in' | 'removed' | 'never invited' | 'standby';
    const STANDS: Stand[] = ['invited', 'in', 'removed', 'never invited', 'standby'];
    /** What happens: the link it moves to (sent), or the refusal's status and code. */
    const SENT: Record<string, Record<Stand, string>> = {
        yes:            { invited: 'in',       in: '403',  removed: '403', 'never invited': '403', standby: '503' },
        no:             { invited: 'declined', in: '403',  removed: '403', 'never invited': '403', standby: '503' },
        leave:          { invited: 'left',     in: 'left', removed: '403', 'never invited': '403', standby: '503' },
        line:           { invited: '403',      in: 'in',   removed: '403', 'never invited': '403', standby: '503' },
        'line-mention': { invited: '403',      in: 'in',   removed: '403', 'never invited': '403', standby: '503' },
        epoch:          { invited: '403',      in: 'in',   removed: '403', 'never invited': '403', standby: '503' },
    };
    const payloadOf = (k: string): [RelayItemKind, string] => {
        if (k === 'yes' || k === 'no') return ['group-invite', JSON.stringify({ v: 1, answer: k })];
        if (k === 'leave') return ['group-leave', JSON.stringify({ v: 1 })];
        if (k === 'epoch') return ['group-epoch', JSON.stringify({ epoch: record })];
        return ['group-line', JSON.stringify({ ciphertext: 'c', nonce: 'group-xc20p-v1:n', metadata: k === 'line-mention' ? { mentions: [ana.pk] } : null, type: 'text' })];
    };
    let row3 = 0;
    for (const k of ITEMS) {
        for (const s of STANDS) {
            const g = `g3-${++row3}`;
            if (s === 'invited' || s === 'standby') setLink(gus, 'b.example', g, 'invited');
            if (s === 'in') setLink(gus, 'b.example', g, 'in');
            if (s === 'removed') setLink(gus, 'b.example', g, 'removed');
            const linkBefore = JSON.stringify(linkOf(gus, 'b.example', g) ?? null);
            const [kind, payload] = payloadOf(k);
            const it = await item(gus, kind, g, payload);
            const outsBefore = outs.length, sentBefore = sentCount();
            if (s === 'standby') setNodeRole('backup');
            const r = await send(gus, [it]);
            if (s === 'standby') setNodeRole('primary');
            const want = SENT[k][s];
            const went = outs.slice(outsBefore).filter((o) => o.host === 'b.example' && o.path === '/api/relay/mail');
            if (want === '403' || want === '503') {
                assert(r.status === Number(want) && r.body?.code === (want === '403' ? 'not_in_group' : 'standby') && went.length === 0 && sentCount() === sentBefore
                    && JSON.stringify(linkOf(gus, 'b.example', g) ?? null) === linkBefore,
                    `3. ${k} x ${s}: refused ${want}, nothing stored or sent (got ${r.status} ${r.body?.code}, ${went.length} sent)`);
            } else {
                assert(r.status === 200 && r.body?.items?.[0]?.state === 'sent' && went.length === 1 && went[0].signed
                    && went[0].body.items.length === 1 && went[0].body.items[0].envelope.itemId === it.envelope.itemId && relayEnvelopeVerifies(went[0].body.items[0].envelope)
                    && linkOf(gus, 'b.example', g)?.state === want,
                    `3. ${k} x ${s}: sent once to b.example, signed by a.example, and Gus is ${want} (got ${r.status} ${JSON.stringify(r.body)}, ${went.length} sent, link ${linkOf(gus, 'b.example', g)?.state})`);
            }
        }
    }
    assert(row3 === ITEMS.length * STANDS.length, `3z. the table has a row for every item and every standing (${row3} rows)`);
    const ownGroup = await send(gus, [await item(gus, 'group-line', 'g3-own', payloadOf('line')[1], 'a.example')]);
    assert(ownGroup.status === 400 && ownGroup.body?.code === 'bad_item', `3y. a group item to this community's own server is refused (got ${ownGroup.status} ${ownGroup.body?.code})`);
    const asOther = await send(gia, [await item(gus, 'group-line', 'g3-2', payloadOf('line')[1])]);
    assert(asOther.status === 400 && asOther.body?.code === 'bad_item', `3x. Gia can't send Gus's item (got ${asOther.status} ${asOther.body?.code})`);

    // ── 4. The epoch steps ──────────────────────────────────────────────────────────────────
    console.log('\n4. Close the class: the roster\'s epoch (null / stale / not stale) -> kept, read, and what is sent');
    const G4 = 'g4-library';
    const members4 = [ana, ben];
    const recipients4 = [ana.pk, ben.pk, gus.pk, gia.pk];
    const made = makeGroupEpochRecord({ myEdPrivHex: ana.seedHex, groupId: G4, epoch: 2, reason: 'rotate', subject: null, createdAt: new Date().toISOString(), recipients: recipients4 });
    const { groupId: _gid, wraps: allWraps, ...hostRecord } = made.record;
    const rosterWith = (epoch: unknown) => ({
        name: 'Library', members: members4.map((m) => ({ key: m.pk, name: m.name })),
        guests: [gus, gia].map((m) => ({ key: m.pk, home: 'a.example', name: m.name })), epoch,
    });
    const notStaleEpoch = { current: 2, stale: false, record: hostRecord, wraps: allWraps!.map((w) => ({ ...w, wrapper: ana.pk })) };
    const STEPS: Array<{ name: string; epoch: unknown; joining: boolean; send: string; epochNo?: number; reason?: string }> = [
        { name: 'null, after the yes', epoch: null, joining: true, send: 'group-epoch', epochNo: 1, reason: 'join' },
        { name: 'stale, after the yes', epoch: { current: 2, stale: true }, joining: true, send: 'group-epoch', epochNo: 3, reason: 'join' },
        { name: 'stale, already in', epoch: { current: 2, stale: true }, joining: false, send: 'group-epoch', epochNo: 3, reason: 'rotate' },
        { name: 'not stale', epoch: notStaleEpoch, joining: false, send: 'group-line', epochNo: 2 },
    ];
    for (const st of STEPS) {
        setLink(gus, 'b.example', G4, 'in');
        const r = await notice('b.example', { v: 1, kind: 'roster', group: G4, host: 'b.example', guests: [gia.pk, gus.pk], data: rosterWith(st.epoch) });
        const dev = device();
        const seen = await fetchGroup(gus, dev);
        const kept = (seen.body?.groups ?? []).find((x: any) => x.host === 'b.example' && x.group === G4);
        const roster = readGuestRoster(kept?.roster);
        assert(r.status === 202 && !!roster && (st.epoch === null ? roster.epoch === null : JSON.stringify(roster.epoch && 'stale' in roster.epoch ? roster.epoch.stale : null) === JSON.stringify((st.epoch as any).stale)),
            `4. ${st.name}: the roster is kept and the device reads it (got ${JSON.stringify(kept?.roster?.epoch ?? kept ?? null).slice(0, 120)})`);
        if (!roster) continue;
        const step = guestEpochStep(roster, gus.pk, { joining: st.joining });
        const outsBefore = outs.length;
        let sentOk = false;
        if (step.send === 'group-epoch') {
            const { payload } = makeGuestEpoch(step, G4, gus.pk, gus.seedHex, new Date().toISOString());
            const s4 = await send(gus, [await item(gus, 'group-epoch', G4, payload)]);
            const went = outs.slice(outsBefore).find((o) => o.host === 'b.example');
            const rec = went ? JSON.parse(went.body.items[0].payload).epoch as GroupEpochRecord : null;
            let verifies = false;
            try { verifyGroupEpochRecord(rec!, { groupId: G4, epoch: st.epochNo!, activeMembers: recipients4 }); verifies = true; } catch { /* stays false */ }
            sentOk = s4.status === 200 && !!rec && verifies && groupEpochCoversExactly(rec, recipients4) && rec.epoch === st.epochNo && rec.reason === st.reason;
        } else if (step.send === 'group-line') {
            // Step 4: the key Gus opens from his wrap is the host's epoch key, and the line goes again under that epoch.
            const key = openGuestEpochKey(step, G4, gus.seedHex);
            const messageId = crypto.randomUUID();
            const sealed = sealGroupLine('Hello from Gus', { groupKey: key, groupId: G4, epoch: step.epoch, messageId, myEdPrivHex: gus.seedHex, after: null });
            const s4 = await send(gus, [await item(gus, 'group-line', G4, JSON.stringify({ ...sealed, clientId: messageId, type: 'text', metadata: { epoch: step.epoch } }))]);
            const went = outs.slice(outsBefore).find((o) => o.host === 'b.example');
            sentOk = s4.status === 200 && Buffer.from(key).equals(Buffer.from(made.groupKey)) && step.epoch === st.epochNo
                && !!went && went.body.items[0].envelope.kind === 'group-line' && JSON.parse(went.body.items[0].payload).ciphertext === sealed.ciphertext;
        }
        assert(step.send === st.send && sentOk, `4. ${st.name} -> ${st.send}${st.reason ? ` (${st.reason}, epoch ${st.epochNo})` : ` under epoch ${st.epochNo}`}, sent to the host (got ${step.send}${'why' in step ? ` ${step.why}` : ''})`);
    }
    // The host's epoch-stale answer reaches the device, which then waits for the roster (step 2).
    const stale = await item(gus, 'group-line', G4, JSON.stringify({ ciphertext: 'c', nonce: 'group-xc20p-v1:n', type: 'text' }));
    refuseIds.set(stale.envelope.itemId, 'epoch-stale');
    const staleSent = await send(gus, [stale]);
    const ticks = await fetchGroup(gus, device());
    const tick = (ticks.body?.sent ?? []).find((t: any) => t.itemId === stale.envelope.itemId);
    assert(staleSent.body?.items?.[0]?.state === 'refused' && staleSent.body.items[0].refused === 'epoch-stale' && tick?.state === 'refused' && tick.refused === 'epoch-stale',
        `4e. the host answers epoch-stale: the send's answer and the device's tick say so (got ${JSON.stringify(staleSent.body)} / ${JSON.stringify(tick)})`);

    // ── 5. A removed guest gets nothing after the removal ───────────────────────────────────
    console.log('\n5. A removed guest gets nothing after the removal');
    const G5 = 'g5-orchard';
    const inv = await notice('b.example', noticeOf('invite', 'b.example', G5, [ivy.pk]));
    const dev5 = device();
    const seenInvite = (await fetchGroup(ivy, dev5)).body?.items?.some((i: any) => i.group === G5 && i.kind === 'invite');
    const yes5 = await send(ivy, [await item(ivy, 'group-invite', G5, JSON.stringify({ v: 1, answer: 'yes' }))]);
    await notice('b.example', noticeOf('roster', 'b.example', G5, [ivy.pk]));
    assert(inv.status === 202 && seenInvite && yes5.body?.items?.[0]?.state === 'sent' && linkOf(ivy, 'b.example', G5)?.state === 'in' && !!linkOf(ivy, 'b.example', G5)?.roster,
        '5a. invited, her device sees it, she says yes through a.example, and the roster that follows is kept');
    await notice('b.example', noticeOf('removed', 'b.example', G5, [ivy.pk]));
    const afterRemoval = heldCount(ivy, 'b.example', G5);
    for (const k of ['epoch', 'line', 'roster', 'line-mention'] as const) await notice('b.example', noticeOf(k, 'b.example', G5, [ivy.pk]));
    const lineAfter = await send(ivy, [await item(ivy, 'group-line', G5, payloadOf('line')[1])]);
    assert(linkOf(ivy, 'b.example', G5)?.state === 'removed' && linkOf(ivy, 'b.example', G5)?.roster === null && heldCount(ivy, 'b.example', G5) === afterRemoval
        && lineAfter.status === 403,
        `5b. removed: the next epoch, line and roster are dropped, the kept roster goes, and she can send nothing there (held ${heldCount(ivy, 'b.example', G5)} vs ${afterRemoval}, send ${lineAfter.status})`);

    // The invitation caps: Gus has more than GROUP_INVITES_WAITING_PER_HOST waiting from b.example after the tables above.
    const waitingB = db.prepare("SELECT COUNT(*) FROM group_guest_links WHERE member = ? AND host = 'b.example' AND state = 'invited'").pluck().get(gus.pk) as number;
    const capped = await notice('b.example', noticeOf('invite', 'b.example', 'g5-capped', [gus.pk]));
    const elsewhere = await notice('d.example', noticeOf('invite', 'd.example', 'g5-other', [gus.pk]));
    assert(waitingB >= home.GROUP_INVITES_WAITING_PER_HOST && capped.status === 202 && capped.body?.received === true && heldCount(gus, 'b.example', 'g5-capped') === 0
        && !linkOf(gus, 'b.example', 'g5-capped') && heldCount(gus, 'd.example', 'g5-other') === 1,
        `5c. past ${home.GROUP_INVITES_WAITING_PER_HOST} invitations waiting from one host, its next is dropped and answered alike; another host's is held (waiting ${waitingB})`);

    // ── 6. Each device confirms for itself ──────────────────────────────────────────────────
    console.log('\n6. Each device confirms for itself');
    const G6 = 'g6-choir';
    setLink(gia, 'b.example', G6, 'in');
    const phone = device(), browser = device();
    await fetchGroup(gia, phone);
    await fetchGroup(gia, browser);
    await notice('b.example', noticeOf('line', 'b.example', G6, [gia.pk]));
    const onPhone = (await fetchGroup(gia, phone)).body.items.filter((i: any) => i.group === G6);
    const c1 = await call('POST', gia, '/api/mail/group/confirm', { ids: onPhone.map((i: any) => i.id), device: phone });
    const phoneAgain = (await fetchGroup(gia, phone)).body.items.filter((i: any) => i.group === G6);
    const onBrowser = (await fetchGroup(gia, browser)).body.items.filter((i: any) => i.group === G6);
    assert(onPhone.length === 1 && c1.body?.confirmed === 1 && phoneAgain.length === 0 && onBrowser.length === 1 && heldCount(gia, 'b.example', G6) === 1,
        '6a. the phone confirms: it reads it no more, the browser still does, and it is still held');
    await call('POST', gia, '/api/mail/group/confirm', { ids: onBrowser.map((i: any) => i.id), device: browser });
    assert(heldCount(gia, 'b.example', G6) === 0, '6b. the browser confirms too: it goes');
    const otherConfirms = await call('POST', gus, '/api/mail/group/confirm', { ids: onPhone.map((i: any) => i.id), device: phone });
    assert(otherConfirms.body?.confirmed === 0, '6c. another member confirming her notice ids touches nothing');

    // ── 7. The backoff follows time ─────────────────────────────────────────────────────────
    console.log('\n7. Close the class: the backoff follows time, not tries (the host\'s fan-out and a member\'s sends)');
    const EXPECTED_MIN = [1, 6, 21, 81, 201, 321, 441];   // when the waiting rows are due, after a first failure at 0
    type Side = 'host fan-out' | 'member sends';
    const SIDES: Side[] = ['host fan-out', 'member sends'];
    let gN = 0;
    let simNow = Date.now();
    hostSide.__useFanoutClockForTests(() => simNow);
    for (const side of SIDES) {
        for (const n of [1, 6, 30]) {
            for (const outage of [30, 180]) {
                const far = `z${++gN}.example`;
                const t0 = Date.now() + 10 * 24 * 60 * MIN * gN;    // each row its own stretch of time, far from any real row
                const rowAt = (i: number) => (i === 0 ? t0 : t0 + Math.floor(i * outage * MIN / n) + 30_000);
                const queue = (i: number, t: number) => {
                    if (side === 'host fan-out') {
                        // A line's takedown: the one kind that goes whatever this server holds (a line once down stays down: the send rule, #3233 round 5).
                        db.prepare('INSERT INTO group_guest_outbox (id, group_id, home, kind, body, attempts, next_try_at, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
                            .run(crypto.randomUUID(), 'g7', far, 'edit', JSON.stringify({ v: 1, kind: 'edit', group: 'g7', host: 'a.example', guests: [gus.pk], data: { id: `l7-${i}`, action: 'removed', by: 'author', i } }), t, t);
                    } else {
                        db.prepare(`INSERT INTO group_guest_sent (sender_key, item_id, kind, host, group_id, state, item, attempts, next_try_at, created_at, updated_at)
                                    VALUES (?, ?, 'group-line', ?, 'g7', 'queued', ?, 0, ?, ?, ?)`)
                            .run(gus.pk, `bk-${gN}-${String(i).padStart(3, '0')}`, far, JSON.stringify({ envelope: { itemId: `bk-${gN}-${String(i).padStart(3, '0')}` }, payload: String(i) }), t, t, t);
                    }
                };
                // The suite walks the outage on its own clock: due rows by it, and each try stamped by it (__useFanoutClockForTests).
                const flush = (t: number) => { simNow = t; return side === 'host fan-out' ? hostSide.flushGuestOutbox(t) : home.retryGroupSent(t); };
                const due = (): number | null => (side === 'host fan-out'
                    ? db.prepare('SELECT MIN(next_try_at) FROM group_guest_outbox WHERE home = ?').pluck().get(far)
                    : db.prepare("SELECT MIN(next_try_at) FROM group_guest_sent WHERE host = ? AND state = 'queued'").pluck().get(far)) as number | null;
                failing.add(far);
                const schedule: number[] = [];
                // Events in time order: each row as it is queued (with its own flush, as flushSoon and a member's send do), and
                // each time the waiting rows fall due (the timer, exactly then). Every try is counted by the transport hook.
                let next = 1;
                queue(0, t0);
                await flush(t0);
                const recordDue = () => { const d = due(); if (d !== null && schedule[schedule.length - 1] !== d) schedule.push(d); };
                recordDue();
                for (;;) {
                    const d = due();
                    const r = next < n ? rowAt(next) : Infinity;
                    const t = Math.min(d ?? Infinity, r);
                    if (t > t0 + outage * MIN) break;
                    if (t === r) { queue(next, r); next++; }
                    await flush(t);
                    recordDue();
                }
                const dueMin = schedule.map((d) => Math.round((d - t0) / 1000) / 60);
                const want = EXPECTED_MIN.filter((m) => m <= outage).concat(EXPECTED_MIN.find((m) => m > outage)!);
                // One try for the first row, one early try for each row after it, and one each time the rows fell due.
                const tries = triesTo.get(far) ?? 0;
                const wantTries = 1 + (n - 1) + EXPECTED_MIN.filter((m) => m <= outage).length;
                // Then the other side answers, at the next time the rows are due: every row once, in the order queued.
                failing.delete(far);
                const before = outs.length;
                await flush(due()!);
                const delivered = outs.slice(before).filter((o) => o.host === far)
                    .flatMap((o) => (side === 'host fan-out' ? [o.body.data.i] : o.body.items.map((x: any) => Number(x.payload))));
                const left = side === 'host fan-out'
                    ? (db.prepare('SELECT COUNT(*) FROM group_guest_outbox WHERE home = ?').pluck().get(far) as number)
                    : (db.prepare("SELECT COUNT(*) FROM group_guest_sent WHERE host = ? AND state = 'queued'").pluck().get(far) as number);
                assert(JSON.stringify(dueMin) === JSON.stringify(want) && tries === wantTries
                    && JSON.stringify(delivered) === JSON.stringify([...Array(n).keys()]) && left === 0,
                    `7. ${side} x ${n} row(s) queued during the outage x ${outage} min: due at ${want.join(', ')} min, ${wantTries} tries, then all ${n} once, in order (got due at ${dueMin.join(', ')}; ${tries} tries; delivered ${JSON.stringify(delivered).slice(0, 80)}; left ${left})`);
            }
        }
    }
    hostSide.__useFanoutClockForTests(null);
    const step = hostSide.nextFanoutTry;
    assert(JSON.stringify(step(0, 0, 1000)) === JSON.stringify({ attempts: 1, nextTryAt: 61_000 }) && JSON.stringify(step(2, 10 * MIN, 3 * MIN)) === JSON.stringify({ attempts: 2, nextTryAt: 10 * MIN })
        && JSON.stringify(step(2, 10 * MIN, 10 * MIN)) === JSON.stringify({ attempts: 3, nextTryAt: 25 * MIN }) && step(9, 0, 0).nextTryAt === 120 * MIN,
        '7z. nextFanoutTry: a first failure waits a minute; an early try keeps the wait; a due one moves a step on; the last step repeats');

    // ── 8. A standby, the door, the route lists ─────────────────────────────────────────────
    console.log('\n8. A standby copies the links and never the notices or sent items; the door; the route lists');
    assert((TABLES as any).group_guest_links?.kind === 'replicated' && (TABLES as any).group_guest_links?.plain === true,
        '8a. group_guest_links is a plain copied table: a promoted standby still knows which hosts its members answered');
    assert(['group_guest_mail', 'group_guest_mail_got', 'group_guest_sent'].every((t) => (TABLES as any)[t]?.kind === 'local' && (RELAY_MAIL_TABLES as readonly string[]).includes(t)),
        '8b. the held notices, their confirms and the sent items are this server\'s own, and no copy holds them');
    const linksBefore = db.prepare('SELECT COUNT(*) FROM group_guest_links').pluck().get();
    const sentBefore8 = sentCount();
    setNodeRole('backup');
    const sbRetry = await home.retryGroupSent(Date.now() + 365 * 24 * 60 * MIN);
    setNodeRole('primary');
    assert(sbRetry === 0 && db.prepare('SELECT COUNT(*) FROM group_guest_links').pluck().get() === linksBefore && sentCount() === sentBefore8,
        '8c. a standby\'s timer sends nothing and writes no link');
    const unsigned = await suiteFetch(`${BASE}/api/relay/group`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(noticeOf('line', 'b.example', 'g8', [gus.pk])) });
    const asMember = await call('POST', gus, '/api/relay/group', noticeOf('line', 'b.example', 'g8', [gus.pk]));
    assert(unsigned.status >= 400 && unsigned.status < 500 && asMember.status >= 400 && asMember.status < 500 && heldCount(gus, 'b.example', 'g8') === 0,
        `8d. the door: unsigned, or a member's signature, at /api/relay/group is refused (got ${unsigned.status}, ${asMember.status})`);
    const guestView = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'test-guest-view.ts'), 'utf8');
    assert(NODE_SIGNED_PATHS.has('/api/relay/group') && ['POST /api/relay/group', 'GET /api/mail/group', 'POST /api/mail/group/confirm'].every((r) => guestView.includes(`'${r}'`)),
        '8e. the host\'s path takes only a server\'s signature, and the three routes are in the guest-view list');

    // ── 9. A host's standing bounds what it stores here ─────────────────────────────────────
    console.log('\n9. Close the class (invariant A): a host\'s standing bounds what it stores here, by count and bytes, whatever the repetition; nothing from one host drops or pushes out another\'s');
    const take = (host: string, n: unknown) => home.receiveGroupNotice(host, n);
    const n9 = (kind: string, host: string, g: string, who: Id, data: unknown) => ({ v: 1, kind, group: g, host, guests: [who.pk], data });
    const heldFrom = (who: Id, host: string) => db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM group_guest_mail WHERE member = ? AND host = ?').get(who.pk, host) as { n: number; b: number };
    const linksFrom = (who: Id, host: string) => db.prepare('SELECT COUNT(*) FROM group_guest_links WHERE member = ? AND host = ?').pluck().get(who.pk, host) as number;
    const lineOf = (i: number, pad = 1) => ({ id: `m-${i}`, author: ana.pk, ciphertext: 'c'.repeat(pad), nonce: 'group-xc20p-v1:n', type: 'text', metadata: null, timestamp: new Date().toISOString() });
    const inviteOf = (pad = 0) => ({ name: 'Seed Library' + 'x'.repeat(pad), invitedBy: { key: ana.pk, name: 'Ana' } });
    type Standing9 = 'answered host' | 'unanswered host' | 'blocked host' | 'removed guest';
    const STANDINGS9: Standing9[] = ['answered host', 'unanswered host', 'blocked host', 'removed guest'];
    const HOST9: Record<Standing9, string> = { 'answered host': 'b.example', 'unanswered host': 'd.example', 'blocked host': 'c.example', 'removed guest': 'b.example' };
    const R = 520;                                       // past every count allowance (5, 20, 500)
    // The engine's numbers (as on e8c99714 where it had none yet, so the fail-first run measures what is held, not a missing name).
    const PER_HOST = (home.GROUP_INVITES_WAITING_PER_HOST ?? 5) as number, INVITE_MAX = (home.GROUP_INVITE_MAX_CHARS ?? 2048) as number;
    const HOST_ITEMS = (home.GROUP_MAIL_PER_HOST_ITEMS ?? 500) as number, HOST_BYTES = (home.GROUP_MAIL_PER_HOST_BYTES ?? 50 * 1024 * 1024) as number;
    /** What a host of each standing may store for one member, whatever it sends: notices (count, bytes) and link rows. */
    const BOUND: Record<Standing9, { n: number; b: number; links: number }> = {
        // Under the group they answered: the allowance no device has and as much again one device has; invitations to others as a stranger's.
        'answered host': { n: 2 * HOST_ITEMS + PER_HOST, b: 2 * HOST_BYTES + PER_HOST * INVITE_MAX, links: 1 + PER_HOST },
        'unanswered host': { n: PER_HOST, b: PER_HOST * INVITE_MAX, links: PER_HOST },
        'blocked host': { n: 0, b: 0, links: 1 },
        'removed guest': { n: PER_HOST, b: PER_HOST * INVITE_MAX, links: 1 + PER_HOST },
    };
    const FLOODS: Record<string, (who: Id, host: string) => void> = {
        'the same invitation x520': (who, host) => { for (let i = 0; i < R; i++) take(host, n9('invite', host, 'g9', who, inviteOf())); },
        'invitations to 520 groups': (who, host) => { for (let i = 0; i < R; i++) take(host, n9('invite', host, `g9-${i}`, who, inviteOf())); },
        'invite then withdraw x520': (who, host) => {
            for (let i = 0; i < R; i++) { take(host, n9('invite', host, 'g9', who, inviteOf())); take(host, n9('removed', host, 'g9', who, { why: 'removed' })); }
        },
        'invite then withdraw, 520 groups': (who, host) => {
            for (let i = 0; i < R; i++) { take(host, n9('invite', host, `g9-${i}`, who, inviteOf())); take(host, n9('removed', host, `g9-${i}`, who, { why: 'removed' })); }
        },
        'invitations past the size limit': (who, host) => { for (let i = 0; i < 10; i++) take(host, n9('invite', host, `g9-big-${i}`, who, inviteOf(INVITE_MAX))); },
        'lines x520': (who, host) => { for (let i = 0; i < R; i++) take(host, n9('line', host, 'g9', who, lineOf(i))); },
        'rosters and epochs x520': (who, host) => {
            for (let i = 0; i < R / 2; i++) { take(host, n9('roster', host, 'g9', who, DATA.roster)); take(host, n9('epoch', host, 'g9', who, DATA.epoch)); }
        },
        'lines of 1.85 MB past 50 MB': (who, host) => { for (let i = 0; i < 29; i++) take(host, n9('line', host, 'g9', who, lineOf(i, 1_850_000))); },
        'invite then withdraw, 520 groups, one device of two confirming': (who, host) => {
            const phone = device();
            noteMailDevice(who.pk, phone);
            noteMailDevice(who.pk, device());                // listed, never confirms: what the phone has stays held
            for (let i = 0; i < R; i++) {
                take(host, n9('invite', host, `g9-${i}`, who, inviteOf()));
                take(host, n9('removed', host, `g9-${i}`, who, { why: 'removed' }));
                if (i % 10 === 9) home.confirmGroupMail(who.pk, phone, db.prepare('SELECT id FROM group_guest_mail WHERE member = ? AND host = ?').pluck().all(who.pk, host));
            }
        },
        'invite then withdraw, 520 groups, their only device confirming': (who, host) => {
            const phone = device();
            noteMailDevice(who.pk, phone);                   // every notice it confirms goes
            for (let i = 0; i < R; i++) {
                take(host, n9('invite', host, `g9-${i}`, who, inviteOf()));
                take(host, n9('removed', host, `g9-${i}`, who, { why: 'removed' }));
                if (i % 10 === 9) home.confirmGroupMail(who.pk, phone, db.prepare('SELECT id FROM group_guest_mail WHERE member = ? AND host = ?').pluck().all(who.pk, host));
            }
        },
        'lines x1100, one device confirming as they come': (who, host) => {
            const phone = device(), laptop = device();
            noteMailDevice(who.pk, phone);
            noteMailDevice(who.pk, laptop);                  // listed, never confirms
            for (let i = 0; i < 1100; i++) {
                take(host, n9('line', host, 'g9', who, lineOf(i)));
                if (i % 100 === 99) home.confirmGroupMail(who.pk, phone, db.prepare('SELECT id FROM group_guest_mail WHERE member = ?').pluck().all(who.pk));
            }
        },
    };
    let row9 = 0;
    for (const s of STANDINGS9) {
        for (const [flood, run9] of Object.entries(FLOODS)) {
            const who = addLocal(`Mo${++row9}`);
            const host = HOST9[s];
            if (s === 'answered host' || s === 'blocked host') setLink(who, host, 'g9', 'in');
            if (s === 'removed guest') setLink(who, host, 'g9', 'removed');
            // The witnesses: e.example, a host they answered, whose line is held before the flood; f.example, a host nobody answered.
            setLink(who, 'e.example', 'w9', 'in');
            take('e.example', n9('line', 'e.example', 'w9', who, lineOf(0)));
            const before = db.prepare("SELECT id FROM group_guest_mail WHERE member = ? AND host = 'e.example'").pluck().get(who.pk) as string | undefined;
            run9(who, host);
            const held = heldFrom(who, host);
            const links = linksFrom(who, host);
            const b = BOUND[s];
            const witnessKept = !!before && !!db.prepare('SELECT 1 FROM group_guest_mail WHERE id = ?').get(before);
            const eBefore = heldFrom(who, 'e.example').n, fBefore = heldFrom(who, 'f.example').n;
            take('e.example', n9('line', 'e.example', 'w9', who, lineOf(1, 1_000_000)));   // a megabyte: room another host's notices must not take
            take('f.example', n9('invite', 'f.example', 'w9-f', who, inviteOf()));
            const witnessesHeld = heldFrom(who, 'e.example').n === eBefore + 1 && heldFrom(who, 'f.example').n === fBefore + 1;
            // One invitation repeated is held once, wherever they stand with that host.
            const once = flood !== 'the same invitation x520' || held.n === (s === 'unanswered host' || s === 'removed guest' ? 1 : 0);
            assert(held.n <= b.n && held.b <= b.b && links <= b.links && witnessKept && witnessesHeld && once,
                `9. ${s} x ${flood}: at most ${b.n} notices, ${b.b} bytes, ${b.links} links; another host's held line kept, its next line and another's invitation held (got ${held.n} notices, ${held.b} bytes, ${links} links; kept ${witnessKept}, next held ${witnessesHeld})`);
            db.prepare('DELETE FROM group_guest_mail_got WHERE member = ?').run(who.pk);
            db.prepare('DELETE FROM group_guest_mail WHERE member = ?').run(who.pk);
        }
    }
    assert(row9 === STANDINGS9.length * Object.keys(FLOODS).length, `9z. the table has a row for every standing and every flood (${row9} rows)`);

    // ── 10. A link moves only on the host's answer ──────────────────────────────────────────
    console.log('\n10. Close the class (invariant B): a link moves only on the host\'s answer: (yes, no, leave) x the answer -> where they stand, and what goes again');
    const K = 'k.example';
    type Answer10 = '2xx taken' | '2xx refused' | '400' | '413' | '503' | 'timeout' | 'a day of no answer';
    const ANSWERS10: Answer10[] = ['2xx taken', '2xx refused', '400', '413', '503', 'timeout', 'a day of no answer'];
    const SCRIPT10: Record<Answer10, string> = { '2xx taken': '2xx', '2xx refused': 'refused', 400: '400', 413: '413', 503: '503', timeout: 'timeout', 'a day of no answer': 'timeout' };
    /** [item][answer]: the link after the answer, and the item's state. */
    const MOVE: Record<'yes' | 'no' | 'leave', Record<Answer10, [string, string]>> = {
        yes: { '2xx taken': ['in', 'sent'], '2xx refused': ['invited', 'refused'], 400: ['invited', 'failed'], 413: ['invited', 'failed'], 503: ['joining', 'queued'], timeout: ['joining', 'queued'], 'a day of no answer': ['invited', 'failed'] },
        no: { '2xx taken': ['declined', 'sent'], '2xx refused': ['invited', 'refused'], 400: ['invited', 'failed'], 413: ['invited', 'failed'], 503: ['invited', 'queued'], timeout: ['invited', 'queued'], 'a day of no answer': ['invited', 'failed'] },
        leave: { '2xx taken': ['left', 'sent'], '2xx refused': ['in', 'refused'], 400: ['in', 'failed'], 413: ['in', 'failed'], 503: ['in', 'queued'], timeout: ['in', 'queued'], 'a day of no answer': ['in', 'failed'] },
    };
    const TAKEN: Record<'yes' | 'no' | 'leave', string> = { yes: 'in', no: 'declined', leave: 'left' };
    const itemOf10 = (k: 'yes' | 'no' | 'leave', g: string) => (k === 'leave' ? item(gus, 'group-leave', g, JSON.stringify({ v: 1 }), K) : item(gus, 'group-invite', g, JSON.stringify({ v: 1, answer: k }), K));
    let row10 = 0;
    for (const k of ['yes', 'no', 'leave'] as const) {
        for (const a of ANSWERS10) {
            const g = `g10-${++row10}`;
            setLink(gus, K, g, k === 'leave' ? 'in' : 'invited');
            const it = await itemOf10(k, g);
            script.set(K, [SCRIPT10[a]]);
            const r = await send(gus, [it]);
            if (a === 'a day of no answer') home.sweepGroupGuestMail(Date.now() + 25 * 60 * MIN);
            const rowState = () => db.prepare('SELECT state FROM group_guest_sent WHERE sender_key = ? AND item_id = ?').pluck().get(gus.pk, it.envelope.itemId);
            const [wantLink, wantState] = MOVE[k][a];
            // Where Gus stands as his device reads it (a yes queued reads `joining`); the copied row never says `joining` (12).
            const view10 = (home.heldGroupMailFor(gus.pk, 'f'.repeat(32)).groups as any[]).find((x) => x.host === K && x.group === g);
            const linkThen = view10?.state ?? linkOf(gus, K, g)?.state ?? null, itemThen = rowState();
            const first = linkThen === wantLink && itemThen === wantState && r.status === 200;
            // What goes again: a queued item is tried again by the timer and the link moves when the host takes it (a second
            // answer, or a line after a leave, is refused while it waits; a roster meanwhile is kept for a yes); an item not
            // taken leaves the member free to send it again; after one taken, a line goes only once in.
            let again = false, detail = '';
            if (wantState === 'queued') {
                const second = await send(gus, [k === 'leave' ? await item(gus, 'group-line', g, payloadOf('line')[1], K) : await itemOf10(k, g)]);
                if (k === 'yes') home.receiveGroupNotice(K, { v: 1, kind: 'roster', group: g, host: K, guests: [gus.pk], data: DATA.roster });
                const before = outs.length;
                script.set(K, ['2xx']);
                await home.retryGroupSent(Date.now() + 2 * MIN);
                const wentAgain = outs.slice(before).some((o) => o.host === K && o.body.items.some((x: any) => x.envelope.itemId === it.envelope.itemId));
                const link = linkOf(gus, K, g);
                again = second.status === 403 && wentAgain && link?.state === TAKEN[k] && rowState() === 'sent' && (k !== 'yes' || typeof link.roster === 'string');
                detail = `second ${second.status}, went again ${wentAgain}, then ${link?.state}${k === 'yes' ? `, roster kept ${typeof link?.roster === 'string'}` : ''}`;
            } else if (wantState === 'sent') {
                const line = await send(gus, [await item(gus, 'group-line', g, payloadOf('line')[1], K)]);
                again = line.status === (k === 'yes' ? 200 : 403);
                detail = `a line then ${line.status}`;
            } else {
                const before = outs.length;
                const resend = await send(gus, [await itemOf10(k, g)]);
                const went = outs.slice(before).filter((o) => o.host === K).length;
                again = resend.status === 200 && resend.body?.items?.[0]?.state === 'sent' && went === 1 && linkOf(gus, K, g)?.state === TAKEN[k];
                detail = `sent again ${resend.status} ${resend.body?.items?.[0]?.state}, ${went} request(s), then ${linkOf(gus, K, g)?.state}`;
            }
            assert(first && again, `10. ${k} x ${a}: link ${wantLink}, item ${wantState}; then ${wantState === 'queued' ? 'tried again and taken' : wantState === 'sent' ? 'a line only once in' : 'free to send it again'} (got ${r.status}, link ${linkThen}, item ${itemThen}; ${detail})`);
            script.delete(K);
        }
    }
    assert(row10 === 3 * ANSWERS10.length, `10z. the table has a row for every item and every answer (${row10} rows)`);

    // ── 11. The backoff step is each host's own, and any 2xx starts it over ─────────────────
    console.log('\n11. Close the class (invariant C): the backoff step is per host and starts over on any 2xx: (host fan-out, member sends) x answers in one send -> next due');
    const SEQS: Array<{ name: string; a0: number; answers: string[]; attempts: number; waitMin: number; left: number }> = [
        { name: 'success then failure', a0: 4, answers: ['2xx', 'timeout'], attempts: 1, waitMin: 1, left: 2 },
        { name: 'failure alone', a0: 4, answers: ['timeout'], attempts: 5, waitMin: 120, left: 3 },
        { name: 'mixed: 2xx, 400, failure', a0: 4, answers: ['2xx', '400', 'timeout'], attempts: 1, waitMin: 1, left: 1 },
        { name: 'mixed: 400, failure (no 2xx)', a0: 4, answers: ['400', 'timeout'], attempts: 5, waitMin: 120, left: 2 },
        { name: 'refused in the answer, then failure', a0: 4, answers: ['refused', 'timeout'], attempts: 1, waitMin: 1, left: 2 },
        { name: 'failure then success, then a new row fails', a0: 2, answers: ['timeout'], attempts: 3, waitMin: 15, left: 3 },
    ];
    let row11 = 0;
    simNow = Date.now() + 2000 * 24 * 60 * MIN;
    hostSide.__useFanoutClockForTests(() => simNow);
    for (const side of SIDES) {
        for (const sq of SEQS) {
            const X = `x${++row11}.example`, Y = `y${row11}.example`;
            const t = simNow;
            const queue11 = (h: string, i: number, attempts: number, nextTry: number, created: number) => {
                if (side === 'host fan-out') {
                    // A line's takedown: the one kind that goes whatever this server holds (a line once down stays down: the send rule, #3233 round 5).
                    db.prepare('INSERT INTO group_guest_outbox (id, group_id, home, kind, body, attempts, next_try_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                        .run(crypto.randomUUID(), 'g11', h, 'edit', JSON.stringify({ v: 1, kind: 'edit', group: 'g11', host: 'a.example', guests: [gus.pk], data: { id: `l11-${i}`, action: 'removed', by: 'author', i } }), attempts, nextTry, created);
                } else {
                    const id = `c11-${row11}-${h[0]}-${String(i).padStart(3, '0')}`;
                    // Each row larger than half a request, so each goes in a request of its own.
                    db.prepare(`INSERT INTO group_guest_sent (sender_key, item_id, kind, host, group_id, state, item, attempts, next_try_at, created_at, updated_at)
                                VALUES (?, ?, 'group-line', ?, 'g11', 'queued', ?, ?, ?, ?, ?)`)
                        .run(gus.pk, id, h, JSON.stringify({ envelope: { itemId: id }, payload: 'p'.repeat(40_000) }), attempts, nextTry, created, created);
                }
            };
            const rows11 = (h: string) => (side === 'host fan-out'
                ? db.prepare('SELECT attempts, next_try_at AS due FROM group_guest_outbox WHERE home = ?').all(h)
                : db.prepare("SELECT attempts, next_try_at AS due FROM group_guest_sent WHERE host = ? AND state = 'queued'").all(h)) as Array<{ attempts: number; due: number }>;
            const flush11 = () => (side === 'host fan-out' ? hostSide.flushGuestOutbox(simNow) : home.retryGroupSent(simNow));
            for (let i = 0; i < 3; i++) queue11(X, i, sq.a0, t - 1, t - 10 * MIN + i);
            // Y, another host, waiting on its own step: nothing X's answers do moves it.
            for (let i = 0; i < 2; i++) queue11(Y, i, 3, t + 30 * MIN, t - 10 * MIN + i);
            script.set(X, [...sq.answers]);
            await flush11();
            const got = rows11(X);
            let ok = got.length === sq.left && got.every((r) => r.attempts === sq.attempts && r.due === t + sq.waitMin * MIN);
            let detail = `${got.length} left, ${JSON.stringify(got.map((r) => [r.attempts, (r.due - t) / MIN]))}`;
            if (sq.name.startsWith('failure then success')) {
                // At the wait's end the host takes all three; a row queued after that fails: the steps start over.
                simNow = t + 15 * MIN;
                script.set(X, ['2xx', '2xx', '2xx']);
                await flush11();
                const emptied = rows11(X).length === 0;
                simNow += MIN;
                queue11(X, 9, 0, simNow, simNow);
                script.set(X, ['timeout']);
                await flush11();
                const after = rows11(X);
                ok &&= emptied && after.length === 1 && after[0].attempts === 1 && after[0].due === simNow + MIN;
                detail += `; then emptied ${emptied}, a new row ${JSON.stringify(after.map((r) => [r.attempts, (r.due - simNow) / MIN]))}`;
            }
            const yRows = rows11(Y);
            const yKept = yRows.length === 2 && yRows.every((r) => r.attempts === 3 && r.due === t + 30 * MIN);
            assert(ok && yKept, `11. ${side} x ${sq.name}: ${sq.left} left at step ${sq.attempts}, due in ${sq.waitMin} min; another host's step untouched (got ${detail}; other host kept ${yKept})`);
            script.delete(X);
            if (side === 'host fan-out') db.prepare('DELETE FROM group_guest_outbox WHERE home IN (?, ?)').run(X, Y);
            else db.prepare('DELETE FROM group_guest_sent WHERE host IN (?, ?)').run(X, Y);
            simNow += 24 * 60 * MIN;
        }
    }
    hostSide.__useFanoutClockForTests(null);
    assert(row11 === SIDES.length * SEQS.length, `11z. the table has a row for every side and every sequence (${row11} rows)`);

    // ── 12. Every state the copied table holds settles from the copy alone ──────────────────
    console.log('\n12. Close the class (invariant D, #3217 round 2): where a member stands with a group elsewhere x (main server, standby, promoted standby holding only the copy) x every action -> answered sensibly, and nothing left stuck');
    // A host of its own, with its own key document, so this table's rows meet no other section's.
    const H12 = 'h.example', HK12 = newId('H');
    hostKey[H12] = HK12;
    docs.set(`https://${H12}/api/node/key`, await signNodeKeyDocument({ key: HK12.pk, validUntil: Date.now() + NODE_KEY_VALIDITY_MS, previousKeys: [] }, signerOf(HK12.seed)));
    /** Each copied (plain) table's rows, as a count and a digest: what a standby must leave as its main server's copy made it. */
    const PLAIN = Object.entries(TABLES as Record<string, any>).filter(([, e]) => e.kind === 'replicated' && e.plain === true).map(([t]) => t);
    const plainPrint = (): Map<string, string> => new Map(PLAIN.map((t): [string, string] => {
        let rows: unknown[];
        try { rows = db.prepare(`SELECT * FROM "${t}"`).all(); } catch { return [t, 'no such table']; }
        return [t, `${rows.length}:${crypto.createHash('sha256').update(rows.map((r) => JSON.stringify(r)).sort().join('\n')).digest('hex').slice(0, 16)}`];
    }));
    const plainChanged = (a: Map<string, string>, b: Map<string, string>) => PLAIN.filter((t) => a.get(t) !== b.get(t));
    // The states the copied table can hold, read from its own CHECK: each must be one a standing below leaves in it (12y).
    const linksSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'group_guest_links'").pluck().get() as string;
    const STORED12 = [...(/\bstate\s+TEXT NOT NULL CHECK \(state IN \(([^)]*)\)\)/.exec(linksSql)?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    type Standing12 = 'invited' | 'their yes queued' | 'in' | 'declined' | 'left' | 'removed';
    const STANDINGS12: Standing12[] = ['invited', 'their yes queued', 'in', 'declined', 'left', 'removed'];
    type Role12 = 'main' | 'standby' | 'promoted standby';
    const ROLES12: Role12[] = ['main', 'standby', 'promoted standby'];
    type Action12 = 'yes' | 'no' | 'leave' | 'line' | 'epoch' | 'roster' | 'removal' | "host's line" | 'invitation';
    const ACTIONS12: Action12[] = ['yes', 'no', 'leave', 'line', 'epoch', 'roster', 'removal', "host's line", 'invitation'];
    /** The host's notices among the actions (the rest are the member's items, through POST /api/mail/send). */
    const NOTICE12: Partial<Record<Action12, [string, unknown]>> = {
        roster: ['roster', DATA.roster], removal: ['removed', { why: 'removed' }], "host's line": ['line', DATA.line], invitation: ['invite', DATA.invite],
    };
    /** Where they stand as their device reads it: on the server that queued their yes, and on one holding only the copy. */
    const MAIN_READS: Record<Standing12, string> = { invited: 'invited', 'their yes queued': 'joining', in: 'in', declined: 'declined', left: 'left', removed: 'removed' };
    const COPY_READS: Record<Standing12, string> = { ...MAIN_READS, 'their yes queued': 'invited' };
    const out = (s: string): Record<Action12, string> => ({ yes: `403 ${s}`, no: `403 ${s}`, leave: `403 ${s}`, line: `403 ${s}`, epoch: `403 ${s}`, roster: `202 ${s}`, removal: `202 ${s}`, "host's line": `202 ${s}`, invitation: '202 invited +' });
    /**
     * [where they stand, as their device reads it][action] on a server that is main (as it always was, or promoted): the
     * answer, where they stand then ('-': no link), and '+' when a notice was held for them. The host answers every item.
     */
    const E12: Record<string, Record<Action12, string>> = {
        invited: { yes: '200 in', no: '200 declined', leave: '200 left', line: '403 invited', epoch: '403 invited', roster: '202 invited', removal: '202 - +', "host's line": '202 invited', invitation: '202 invited' },
        // The leave goes behind the yes still queued: the host takes both, in order.
        joining: { yes: '403 joining', no: '403 joining', leave: '200 left', line: '403 joining', epoch: '403 joining', roster: '202 joining +', removal: '202 removed +', "host's line": '202 joining +', invitation: '202 joining' },
        in: { yes: '403 in', no: '403 in', leave: '200 left', line: '200 in', epoch: '200 in', roster: '202 in +', removal: '202 removed +', "host's line": '202 in +', invitation: '202 in' },
        declined: out('declined'), left: out('left'), removed: out('removed'),
    };
    const item12 = (who: Id, a: Action12, g: string) => {
        const [kind, payload] = payloadOf(a === 'yes' || a === 'no' || a === 'leave' || a === 'epoch' ? a : 'line');
        return item(who, kind, g, payload, H12);
    };
    const standing12 = (who: Id, g: string): string => {
        const view = (home.heldGroupMailFor(who.pk, 'f'.repeat(32)).groups as any[]).find((x) => x.host === H12 && x.group === g);
        return view?.state ?? linkOf(who, H12, g)?.state ?? '-';
    };
    const queuedFor = (who: Id) => db.prepare("SELECT COUNT(*) FROM group_guest_sent WHERE sender_key = ? AND state = 'queued'").pluck().get(who.pk) as number;
    /** The member's standing made as it is made: an invitation from the host, and their yes while the host is down. */
    async function seed12(who: Id, g: string, st: Standing12): Promise<string> {
        if (st === 'invited' || st === 'their yes queued') home.receiveGroupNotice(H12, { v: 1, kind: 'invite', group: g, host: H12, guests: [who.pk], data: DATA.invite });
        else setLink(who, H12, g, st);
        if (st !== 'their yes queued') return '';
        failing.add(H12);
        const r = await send(who, [await item12(who, 'yes', g)]);
        failing.delete(H12);
        return r.body?.items?.[0]?.state ?? `${r.status}`;
    }
    /** A promoted standby holds the copy alone: none of this server's own rows for them. */
    const keepOnlyTheCopy = (who: Id) => {
        db.prepare('DELETE FROM group_guest_sent WHERE sender_key = ?').run(who.pk);
        db.prepare('DELETE FROM group_guest_mail_got WHERE member = ?').run(who.pk);
        db.prepare('DELETE FROM group_guest_mail WHERE member = ?').run(who.pk);
    };
    let row12 = 0;
    const reached = new Set<string>();
    for (const st of STANDINGS12) {
        for (const role of ROLES12) {
            for (const act of ACTIONS12) {
                const who = addLocal(`Pa${++row12}`);
                const g = `g12-${row12}`;
                const seeded = await seed12(who, g, st);
                reached.add(linkOf(who, H12, g)?.state ?? '-');
                if (role === 'promoted standby') keepOnlyTheCopy(who);
                const before = standing12(who, g);
                const heldBefore = heldCount(who, H12, g), sentBefore12 = sentCount(), printBefore = plainPrint();
                const notice12 = NOTICE12[act];
                if (role === 'standby') setNodeRole('backup');
                let status = 0;
                try {
                    status = notice12 ? (await notice(H12, { v: 1, kind: notice12[0], group: g, host: H12, guests: [who.pk], data: notice12[1] })).status
                        : (await send(who, [await item12(who, act, g)])).status;
                } finally {
                    if (role === 'standby') setNodeRole('primary');
                }
                const after = standing12(who, g);
                const held = heldCount(who, H12, g) > heldBefore;
                let want: string, ok: boolean;
                if (role === 'standby') {
                    // A standby writes nothing at all: no copied row, nothing held, nothing queued; the member is told it is one.
                    const changed = plainChanged(printBefore, plainPrint());
                    want = `${notice12 ? 202 : 503} ${before}, nothing written`;
                    ok = status === (notice12 ? 202 : 503) && after === before && !held && sentCount() === sentBefore12 && changed.length === 0;
                    if (changed.length) want += ` (changed: ${changed.join(', ')})`;
                } else {
                    const reads = role === 'main' ? MAIN_READS[st] : COPY_READS[st];
                    want = E12[reads][act];
                    ok = before === reads && `${status} ${after}${held ? ' +' : ''}` === want;
                }
                // Nothing stuck: back on a main server with the host answering, whatever was queued settles, and no link is
                // left joining with nothing queued to move it.
                await home.retryGroupSent(Date.now() + 3 * MIN);
                const settled = standing12(who, g), queued = queuedFor(who);
                ok &&= settled !== 'joining' && queued === 0;
                assert(ok, `12. ${st} x ${role} x ${act}: ${want}; then nothing stuck (got ${seeded ? `seeded ${seeded}, ` : ''}${before} -> ${status} ${after}${held ? ' +' : ''}; settled ${settled}, ${queued} queued)`);
            }
        }
    }
    assert(row12 === STANDINGS12.length * ROLES12.length * ACTIONS12.length, `12z. the table has a row for every standing, server and action (${row12} rows)`);
    assert(STORED12.length > 0 && STORED12.every((s) => reached.has(s)),
        `12y. every state the copied table can hold (its CHECK: ${STORED12.join(', ')}) is one a standing above leaves in it (reached: ${[...reached].join(', ')})`);
    // From every standing, a server holding only the copy has a way back in: the host's invitation, the member's yes, a line.
    for (const st of STANDINGS12) {
        const who = addLocal(`Pb${++row12}`);
        const g = `g12-${row12}`;
        await seed12(who, g, st);
        keepOnlyTheCopy(who);
        const steps: Action12[] = COPY_READS[st] === 'in' ? [] : COPY_READS[st] === 'invited' ? ['yes'] : ['invitation', 'yes'];
        const got: string[] = [];
        for (const s of steps) {
            const n12 = NOTICE12[s];
            const r = n12 ? await notice(H12, { v: 1, kind: n12[0], group: g, host: H12, guests: [who.pk], data: n12[1] }) : await send(who, [await item12(who, s, g)]);
            got.push(`${s} ${r.status} ${standing12(who, g)}`);
        }
        const line = await send(who, [await item12(who, 'line', g)]);
        assert(standing12(who, g) === 'in' && line.status === 200 && line.body?.items?.[0]?.state === 'sent',
            `12x. ${st}, on a server holding only the copy: ${steps.length ? steps.join(', then ') : 'nothing to do'}, and a line goes (got ${got.join('; ') || 'no step'}; line ${line.status} ${line.body?.items?.[0]?.state ?? line.body?.code})`);
    }

    // ── 13. Nothing a standby's timer runs writes a copied table ────────────────────────────
    console.log('\n13. Close the class (invariant D): every timer job in the guest files x (standby, main) -> on a standby no row of any copied table is written; on a main server the job does its work');
    const { applyShapeChanges } = await import('./config/community-shape-write.js');
    const serverSrc = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'https-server.ts'), 'utf8');
    const timerNames = [...serverSrc.matchAll(/import \{([^}]*)\} from '\.\/engine\/group-guest(?:s|-home)\.js'/g)]
        .flatMap((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean)).sort();
    let n13 = 0;
    /** Each job: what it is given to do (made as it is made), the job, and whether a main server did it. */
    const TIMERS: Record<string, { seed: () => Promise<{ who: Id; g: string; extra?: string }>; run: (t: number) => unknown; at: number; did: (s: { who: Id; g: string; extra?: string }) => boolean; after?: () => void }> = {
        // The owners switched guests off: each guest invited here is removed (group_guests, a copied table).
        closeGuestsIfSwitchedOff: {
            seed: async () => {
                const key = crypto.randomBytes(32).toString('hex'), g = `g13-close-${++n13}`;
                const iso = new Date().toISOString();
                db.prepare(`INSERT INTO group_guests (group_id, guest_key, home, name, state, invited_by, invited_at, state_at) VALUES (?, ?, 'q.example', 'Quinn', 'invited', ?, ?, ?)`)
                    .run(g, key, olive.pk, iso, iso);
                applyShapeChanges({ actor: olive.pk, actorRole: 'owner' }, { changes: { groupGuests: false } });
                return { who: gus, g, extra: key };
            },
            run: () => hostSide.closeGuestsIfSwitchedOff(),
            at: Date.now(),
            did: (s) => db.prepare('SELECT state FROM group_guests WHERE group_id = ? AND guest_key = ?').pluck().get(s.g, s.extra) === 'removed',
            after: () => applyShapeChanges({ actor: olive.pk, actorRole: 'owner' }, { changes: { groupGuests: true } }),
        },
        // A notice for a guest's home, due.
        flushGuestOutbox: {
            seed: async () => {
                const id = crypto.randomUUID(), g = `g13-flush-${++n13}`, t = Date.now();
                // A line's takedown: the one kind that goes whatever this server holds (a line once down stays down: the send rule, #3233 round 5).
                db.prepare('INSERT INTO group_guest_outbox (id, group_id, home, kind, body, attempts, next_try_at, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
                    .run(id, g, 'q.example', 'edit', JSON.stringify({ v: 1, kind: 'edit', group: g, host: 'a.example', guests: [gus.pk], data: { id: `l13-${n13}`, action: 'removed', by: 'author' } }), t, t);
                return { who: gus, g, extra: id };
            },
            run: (t) => hostSide.flushGuestOutbox(t),
            at: Date.now() + MIN,
            did: (s) => !db.prepare('SELECT 1 FROM group_guest_outbox WHERE id = ?').get(s.extra),
        },
        // A member's yes queued a day ago for a host that never answered, the roster that came meanwhile kept: it fails.
        sweepGroupGuestMail: {
            seed: async () => {
                const who = addLocal(`Sw${++n13}`), g = `g13-sweep-${n13}`;
                await seed12(who, g, 'their yes queued');
                home.receiveGroupNotice(H12, { v: 1, kind: 'roster', group: g, host: H12, guests: [who.pk], data: DATA.roster });
                return { who, g };
            },
            run: (t) => home.sweepGroupGuestMail(t),
            at: Date.now() + 25 * 60 * MIN,
            did: (s) => queuedFor(s.who) === 0 && standing12(s.who, s.g) === 'invited',
        },
        // A member's yes queued while the host was down, due now that it is up: the host takes it, and they are in.
        retryGroupSent: {
            seed: async () => {
                const who = addLocal(`Rt${++n13}`), g = `g13-retry-${n13}`;
                await seed12(who, g, 'their yes queued');
                return { who, g };
            },
            run: (t) => home.retryGroupSent(t),
            at: Date.now() + 3 * MIN,
            did: (s) => queuedFor(s.who) === 0 && standing12(s.who, s.g) === 'in',
        },
    };
    assert(JSON.stringify(timerNames) === JSON.stringify(Object.keys(TIMERS).sort()),
        `13z. the table has a row for every job the server's timer takes from the guest files (imports: ${timerNames.join(', ')})`);
    for (const [name, job] of Object.entries(TIMERS)) {
        for (const role of ['standby', 'main'] as const) {
            const s = await job.seed();
            const printBefore = plainPrint();
            if (role === 'standby') setNodeRole('backup');
            try {
                await job.run(job.at);
            } finally {
                if (role === 'standby') setNodeRole('primary');
            }
            const changed = plainChanged(printBefore, plainPrint());
            const did = job.did(s);
            job.after?.();
            if (role === 'standby') {
                assert(changed.length === 0, `13. ${name} x standby: no row of any copied table written (changed: ${changed.join(', ') || 'none'})`);
            } else {
                assert(did, `13. ${name} x main: the job does its work (so the standby's row above can fail; copied tables changed: ${changed.join(', ') || 'none'})`);
            }
        }
    }

    // ── 14. A complaint about a member's line as a guest ────────────────────────────────────
    console.log('\n14. Close the class: a complaint from a group\'s host about a member\'s line there -> filed here, or the one 422');
    /** A server brings a complaint to a.example, in a request it signed (engine/relay-complaint.ts). */
    async function complain(origin: string, c: Record<string, unknown>): Promise<Res> {
        const k = hostKey[origin];
        const body = JSON.stringify({ complaint: { v: 1, id: crypto.randomUUID(), reason: 'spam or scam', words: 'what the line said', at: Date.now(), ...c } });
        const headers = await buildNodeRequestHeaders({ method: 'POST', url: 'https://a.example/api/relay/complaint', body, origin, keyHex: k.pk, sign: signerOf(k.seed) });
        const res = await suiteFetch(`${BASE}/api/relay/complaint`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
        let parsed: any = null;
        try { parsed = await res.json(); } catch { /* none */ }
        return { status: res.status, body: parsed };
    }
    const filedFrom = (origin: string, itemId: string) => db.prepare('SELECT target_pubkey, reporter_pubkey, disclosure FROM abuse_reports WHERE reporter_pubkey = ? AND target_message_id = ?')
        .all(`community:${origin}`, itemId) as Array<{ target_pubkey: string; reporter_pubkey: string; disclosure: string }>;
    const G14 = 'g14';
    setLink(gus, 'b.example', G14, 'in');
    setLink(gia, 'b.example', G14, 'in');
    const lineItem = (who: Id) => {
        const id = crypto.randomUUID();
        return item(who, 'group-line', G14, JSON.stringify({ v: 1, ciphertext: 'c', nonce: 'group-xc20p-v1:n', metadata: { epoch: 1 }, clientId: id }), 'b.example', id);
    };
    // Gus's lines in each state the host's answer leaves them in.
    const taken = await lineItem(gus);
    const sTaken = await send(gus, [taken]);
    const refusedItem = await lineItem(gus);
    refuseIds.set(refusedItem.envelope.itemId, 'group-refused');
    const sRefused = await send(gus, [refusedItem]);
    const failedItem = await lineItem(gus);
    script.set('b.example', ['400']);
    const sFailed = await send(gus, [failedItem]);
    const giaItem = await lineItem(gia);
    const sGia = await send(gia, [giaItem]);
    // Last, and b.example stays down through the table: any send to it would take the whole queue.
    const queuedItem = await lineItem(gus);
    failing.add('b.example');
    const sQueued = await send(gus, [queuedItem]);
    const stateOfItem = (it: { envelope: { itemId: string } }) => db.prepare('SELECT state FROM group_guest_sent WHERE item_id = ?').pluck().get(it.envelope.itemId);
    const setup14 = sTaken.status === 200 && sRefused.status === 200 && sFailed.status === 200 && sQueued.status === 200 && sGia.status === 200
        && stateOfItem(taken) === 'sent' && stateOfItem(refusedItem) === 'refused' && stateOfItem(failedItem) === 'failed' && stateOfItem(queuedItem) === 'queued' && stateOfItem(giaItem) === 'sent';
    assert(setup14, `14a. Gus's lines to b.example: one taken, one refused, one failed, one still queued; Gia's taken (got ${[taken, refusedItem, failedItem, queuedItem, giaItem].map(stateOfItem).join(', ')})`);
    type Line14 = 'taken' | 'still queued' | 'refused' | 'failed' | "another member's id" | 'no such line';
    const LINES14: Array<[Line14, () => { member: string; itemId: string }]> = [
        ['taken', () => ({ member: gus.pk, itemId: taken.envelope.itemId })],
        ['still queued', () => ({ member: gus.pk, itemId: queuedItem.envelope.itemId })],
        ['refused', () => ({ member: gus.pk, itemId: refusedItem.envelope.itemId })],
        ['failed', () => ({ member: gus.pk, itemId: failedItem.envelope.itemId })],
        ["another member's id", () => ({ member: gus.pk, itemId: giaItem.envelope.itemId })],
        ['no such line', () => ({ member: gus.pk, itemId: crypto.randomUUID() })],
    ];
    const SIGNERS14 = ['b.example', 'd.example'] as const;
    /** Filed here: only the line the group's host took, complained of by that host. */
    const FILED14: Record<Line14, Record<(typeof SIGNERS14)[number], boolean>> = {
        taken: { 'b.example': true, 'd.example': false },
        'still queued': { 'b.example': false, 'd.example': false },
        refused: { 'b.example': false, 'd.example': false },
        failed: { 'b.example': false, 'd.example': false },
        "another member's id": { 'b.example': false, 'd.example': false },
        'no such line': { 'b.example': false, 'd.example': false },
    };
    let rows14 = 0;
    for (const [line, of] of LINES14) for (const signer of SIGNERS14) {
        rows14++;
        const c = of();
        const r = await complain(signer, c);
        const rows = filedFrom(signer, c.itemId);
        const want = FILED14[line][signer];
        const ok = want
            ? r.status === 202 && r.body?.received === true && rows.length === 1 && rows[0].target_pubkey === gus.pk
                && JSON.parse(rows[0].disclosure).kind === 'relay-complaint' && JSON.parse(rows[0].disclosure).from === signer
            : r.status === 422 && r.body?.code === 'not_taken' && rows.length === 0;
        assert(ok, `14. ${line} x signed by ${signer}: ${want ? 'filed once here, 202' : '422 not_taken, nothing filed'} (got ${r.status} ${r.body?.code ?? ''}, ${rows.length} filed)`);
    }
    assert(rows14 === LINES14.length * SIGNERS14.length && Object.keys(FILED14).length === LINES14.length, `14z. the table has a row for every line and every signer (${rows14} rows)`);
    const again14 = await complain('b.example', { member: gus.pk, itemId: taken.envelope.itemId });
    assert(again14.status === 202 && filedFrom('b.example', taken.envelope.itemId).length === 1, `14y. the same complaint again: 202, still one report (got ${again14.status})`);
    failing.delete('b.example');

    // ── 15. A takedown reaches every copy held here ─────────────────────────────────────────
    console.log('\n15. Close the class: every takedown x where the held copy is -> no words or photo served or kept, the tombstone served');
    const TK15 = ['author delete', 'edited, then author delete', 'convenor removal', 'account deleted', 'group closed'] as const;
    const CS15 = ['held, no device has it', 'one device has it, another not', 'every device has it'] as const;
    type Tk15 = (typeof TK15)[number];
    /** The tombstone each device is served after the takedown, whatever the copy state. */
    const TOMB15: Record<Tk15, string> = {
        'author delete': 'removed:author', 'edited, then author delete': 'removed:author', 'convenor removal': 'removed:convenor',
        'account deleted': 'removed:author', 'group closed': 'group-closed',
    };
    /** A member here in a group at b.example, two devices listed, and a photo line of Ana's held for them. */
    async function held15(label: string) {
        const who = addLocal(label);
        const g = `g15-${label}`;
        setLink(who, 'b.example', g, 'in');
        const phone = device(), tablet = device();
        await fetchGroup(who, phone);
        await fetchGroup(who, tablet);
        const id = crypto.randomUUID();
        const mark = (k: string) => `${k}-${label}-${crypto.randomBytes(6).toString('hex')}`;
        const marks = { words: mark('words'), photo: mark('photo'), edited: mark('edited'), edited2: mark('edited2') };
        const line = { id, author: ana.pk, ciphertext: marks.words, nonce: 'group-xc20p-v1:n', type: 'image', metadata: { epoch: 1 }, timestamp: new Date().toISOString(),
            attachment: { data: `${marks.photo}${'x'.repeat(2000)}`, nonce: 'n', mime: 'image/jpeg' } };
        const r = await notice('b.example', { v: 1, kind: 'line', group: g, host: 'b.example', guests: [who.pk], data: line });
        const tell = (kind: string, data: Record<string, unknown>) => notice('b.example', { v: 1, kind, group: g, host: 'b.example', guests: [who.pk], data });
        const editOf = (ciphertext: string) => ({ id, action: 'edited', author: ana.pk, ciphertext, nonce: 'group-xc20p-v1:e', metadata: { epoch: 1, sender: ana.pk }, editedAt: new Date().toISOString() });
        const itemsOn = async (dev: string) => ((await fetchGroup(who, dev)).body?.items ?? []).filter((i: any) => i.group === g);
        const confirm = async (dev: string) => call('POST', who, '/api/mail/group/confirm', { ids: (await itemsOn(dev)).map((i: any) => i.id), device: dev });
        const bodies = () => db.prepare('SELECT body FROM group_guest_mail WHERE member = ?').pluck().all(who.pk) as string[];
        return { who, g, id, phone, tablet, marks, ok: r.status === 202 && heldCount(who, 'b.example', g) === 1, tell, editOf, itemsOn, confirm, bodies };
    }
    let r15 = 0;
    for (const tk of TK15) for (const cs of CS15) {
        const n15 = ++r15;
        const h = await held15(`t15-${n15}`);
        if (cs !== 'held, no device has it') await h.confirm(h.phone);
        if (cs === 'every device has it') await h.confirm(h.tablet);
        const heldBefore = heldCount(h.who, 'b.example', h.g);
        // The takedown as the host sends it (engine/group-guests.ts: queueLineChange; takeDownLinesOf, by the author; closeGroupGuests).
        if (tk === 'edited, then author delete') await h.tell('edit', h.editOf(h.marks.edited));
        if (tk === 'group closed') await h.tell('removed', { why: 'group-closed' });
        else await h.tell('edit', { id: h.id, action: 'removed', by: tk === 'convenor removal' ? 'convenor' : 'author' });
        const carries = (s: string) => [h.marks.words, h.marks.photo, h.marks.edited].some((k) => s.includes(k));
        const kept = h.bodies().filter(carries).length;
        const onPhone = await h.itemsOn(h.phone), onTablet = await h.itemsOn(h.tablet);
        const served = [...onPhone, ...onTablet].filter((i: any) => carries(JSON.stringify(i.data))).length;
        const tombOf = (items: any[]) => {
            const t = items.filter((i) => (i.kind === 'edit' && i.data?.id === h.id) || i.kind === 'removed');
            return !t.length ? 'none' : t.length > 1 ? `${t.length} items` : t[0].kind === 'removed' ? (t[0].data.why === 'group-closed' ? 'group-closed' : `removed ${t[0].data.why}`)
                : t[0].data.action === 'removed' ? `removed:${t[0].data.by}` : `edit ${t[0].data.action}`;
        };
        const gotTomb = tombOf(onPhone) === tombOf(onTablet) ? tombOf(onPhone) : `phone ${tombOf(onPhone)}, tablet ${tombOf(onTablet)}`;
        const setupOk = h.ok && heldBefore === (cs === 'every device has it' ? 0 : 1);
        assert(setupOk && kept === 0 && served === 0 && gotTomb === TOMB15[tk],
            `15. ${tk} x ${cs}: no words or photo served (${served}) or kept (${kept}), each device served the tombstone ${TOMB15[tk]} (got ${gotTomb}${setupOk ? '' : ', setup failed'})`);
    }
    assert(r15 === TK15.length * CS15.length && Object.keys(TOMB15).length === TK15.length, `15z. the table has a row for every takedown and every copy state (${r15} rows)`);

    // Edits: each device is served only the newest words.
    const ES15 = ['edit while held', 'edit twice while held', 'edit after one device has it', 'edit after every device has it'] as const;
    const WORDS15: Record<(typeof ES15)[number], string> = {
        'edit while held': 'phone: line(newest) edit(newest); tablet: line(newest) edit(newest)',
        'edit twice while held': 'phone: line(newest) edit(newest); tablet: line(newest) edit(newest)',
        'edit after one device has it': 'phone: edit(newest); tablet: line(newest) edit(newest)',
        'edit after every device has it': 'phone: edit(newest); tablet: edit(newest)',
    };
    let e15 = 0;
    for (const es of ES15) {
        const h = await held15(`e15-${++e15}`);
        if (es === 'edit after one device has it' || es === 'edit after every device has it') await h.confirm(h.phone);
        if (es === 'edit after every device has it') await h.confirm(h.tablet);
        const edits = es === 'edit twice while held' ? [h.marks.edited, h.marks.edited2] : [h.marks.edited];
        for (const c of edits) await h.tell('edit', h.editOf(c));
        const newest = edits[edits.length - 1];
        const which = (c: unknown) => (c === newest ? 'newest' : c === h.marks.words ? 'first words' : c === h.marks.edited ? 'older edit' : 'other');
        const words = (items: any[]) => items.map((i) => `${i.kind}(${which(i.data?.ciphertext)})`).join(' ');
        const got = `phone: ${words(await h.itemsOn(h.phone))}; tablet: ${words(await h.itemsOn(h.tablet))}`;
        const keptOld = h.bodies().filter((b) => b.includes(h.marks.words) || (newest !== h.marks.edited && b.includes(h.marks.edited))).length;
        assert(h.ok && keptOld === 0 && got === WORDS15[es], `15e. ${es}: each device is served only the newest words: ${WORDS15[es]} (got ${got}; older words kept ${keptOld})`);
    }

    // Out of the group: nothing of it held is served after, so a takedown later has no copy here to miss.
    const OUT15 = ['their leave taken', 'removed by a convenor', "removed by the owners' switch", 'group closed'] as const;
    for (const out of OUT15) {
        const h = await held15(`o15-${OUT15.indexOf(out) + 1}`);
        if (out === 'their leave taken') await send(h.who, [await item(h.who, 'group-leave', h.g, JSON.stringify({ v: 1 }))]);
        else await h.tell('removed', { why: out === 'removed by a convenor' ? 'removed' : out === 'group closed' ? 'group-closed' : 'closed' });
        const carries = (s: string) => s.includes(h.marks.words) || s.includes(h.marks.photo);
        const served = (await h.itemsOn(h.tablet)).filter((i: any) => carries(JSON.stringify(i.data))).length;
        const state = linkOf(h.who, 'b.example', h.g)?.state;
        assert(h.ok && state === (out === 'their leave taken' ? 'left' : 'removed') && served === 0 && h.bodies().filter(carries).length === 0,
            `15w. ${out}: the link ${state}, and no line of the group held for them is served (${served}) or kept`);
    }

    // A host the owners blocked since: its takedown still drops what it brought, and nothing new is held from it.
    const hb = await held15('b15');
    addConnector('b.example:4001', 'blocked', 'Blocked', 'https://b.example', false);
    await hb.tell('edit', { id: hb.id, action: 'removed', by: 'convenor' });
    const blockedKept = hb.bodies().filter((b) => b.includes(hb.marks.words) || b.includes(hb.marks.photo)).length;
    const blockedHeld = heldCount(hb.who, 'b.example', hb.g);
    removeConnector('b.example:4001');
    assert(hb.ok && blockedKept === 0 && blockedHeld === 0,
        `15v. a host blocked since its line was held: its takedown drops the line, and holds nothing (kept ${blockedKept}, held ${blockedHeld})`);

    // ── 15c. The copy rule (#3233 round 3): a takedown x the copy state of this server ───────
    // group_guest_mail is this server's own (`local`): a standby keeps it through every copy, and the host's takedowns go to
    // the server that took over, or reach a standby that answers 202 and takes nothing. A held line is served only while this
    // server has been main since it was held: nothing of it is served or kept after a take-over and a take-back.
    console.log('\n15c. Close the class: every takedown x this server\'s copy state -> no words or photo served or kept');
    const COPY15 = ['stays main', 'a standby when the takedown came, then promoted', 'started as a standby (no role change here), its sweep ran, then promoted'] as const;
    const heldRows15 = (who: Id) => db.prepare('SELECT * FROM group_guest_mail WHERE member = ?').all(who.pk) as Array<Record<string, unknown>>;
    const putBack15 = (rows: Array<Record<string, unknown>>) => {
        for (const r of rows) {
            db.prepare(`INSERT OR IGNORE INTO group_guest_mail (${Object.keys(r).join(', ')}) VALUES (${Object.keys(r).map(() => '?').join(', ')})`).run(...Object.values(r));
        }
    };
    let c15 = 0;
    for (const tk of TK15) for (const cp of COPY15) {
        const n = ++c15;
        const h = await held15(`c15-${n}`);
        await h.confirm(h.phone);
        const carries = (s: string) => [h.marks.words, h.marks.photo, h.marks.edited].some((k) => s.includes(k));
        const takedown = async () => {
            if (tk === 'edited, then author delete') await h.tell('edit', h.editOf(h.marks.edited));
            if (tk === 'group closed') return h.tell('removed', { why: 'group-closed' });
            return h.tell('edit', { id: h.id, action: 'removed', by: tk === 'convenor removal' ? 'convenor' : 'author' });
        };
        let servedOnStandby = 0, keptAfterSweep = 0, answer = 0;
        if (cp === 'stays main') {
            answer = (await takedown()).status;
        } else if (cp === 'a standby when the takedown came, then promoted') {
            setNodeRole('backup');
            try { answer = (await takedown()).status; } finally { setNodeRole('primary'); }
        } else {
            // A server that started as a standby with these held (its own table, kept through the copy): no role change in
            // this process, so the rows are put back as the standby's start finds them.
            const rows = heldRows15(h.who);
            setNodeRole('backup');
            try {
                putBack15(rows);
                answer = 202;     // the takedown went to the server that took over
                servedOnStandby = (await h.itemsOn(h.tablet)).filter((i: any) => carries(JSON.stringify(i.data))).length;
                home.sweepGroupGuestMail(Date.now());
                keptAfterSweep = h.bodies().filter(carries).length;
            } finally { setNodeRole('primary'); }
        }
        const kept = h.bodies().filter(carries).length;
        const served = (await h.itemsOn(h.tablet)).filter((i: any) => carries(JSON.stringify(i.data))).length;
        assert(h.ok && answer === 202 && served === 0 && kept === 0 && servedOnStandby === 0 && keptAfterSweep === 0,
            `15c. ${tk} x ${cp}: no words or photo served to the device that hadn't fetched it (${served}${cp.startsWith('started') ? `; on the standby ${servedOnStandby}` : ''}) or kept (${kept}${cp.startsWith('started') ? `; after the standby's sweep ${keptAfterSweep}` : ''})${h.ok ? '' : ', setup failed'}`);
    }
    assert(c15 === TK15.length * COPY15.length, `15cz. the table has a row for every takedown and every copy state (${c15} rows)`);
    // No over-blocking: a line held after the promotion is served; a standby round trip keeps the invitations, rosters, epochs.
    const p15 = await held15('c15-promoted');
    setNodeRole('backup');
    setNodeRole('primary');
    const line15c = { id: crypto.randomUUID(), author: ana.pk, ciphertext: `after-promotion-${crypto.randomBytes(6).toString('hex')}`, nonce: 'group-xc20p-v1:n', type: 'text', metadata: { epoch: 1 }, timestamp: new Date().toISOString() };
    const tookAfter = await p15.tell('line', line15c);
    const servedAfter = (await p15.itemsOn(p15.tablet)).filter((i: any) => i.kind === 'line' && i.data?.ciphertext === line15c.ciphertext).length;
    const epochKept = await (async () => {
        const who = addLocal('c15-epoch'), g = 'g15-c15-epoch';
        setLink(who, 'b.example', g, 'in');
        await notice('b.example', { v: 1, kind: 'epoch', group: g, host: 'b.example', guests: [who.pk], data: DATA.epoch });
        setNodeRole('backup');
        home.sweepGroupGuestMail(Date.now());
        setNodeRole('primary');
        return heldCount(who, 'b.example', g);
    })();
    assert(p15.ok && tookAfter.status === 202 && servedAfter === 1 && epochKept === 1,
        `15c. no over-blocking: a line held after a take-back is served (${servedAfter}), and an epoch held before it is kept (${epochKept})`);

    // An edit refused (the host's allowance full): the older edit held stays, so a device that has the line keeps its words.
    const f15 = await held15('c15-full');
    await f15.confirm(f15.phone);
    await f15.confirm(f15.tablet);
    await f15.tell('edit', f15.editOf(f15.marks.edited));
    await f15.confirm(f15.phone);
    const later = Date.now() + 24 * 60 * MIN;
    const fill = db.prepare('INSERT INTO group_guest_mail (id, member, host, group_id, kind, body, bytes, answered, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)');
    db.transaction(() => { for (let i = 0; i < HOST_ITEMS; i++) fill.run(crypto.randomUUID(), f15.who.pk, 'b.example', 'g15-c15-filler', 'epoch', '{}', 2, later + i); })();
    const refusedEdit = await f15.tell('edit', f15.editOf(f15.marks.edited2));
    const onTablet15 = (await f15.itemsOn(f15.tablet)).map((i: any) => `${i.kind}(${i.data?.ciphertext === f15.marks.edited ? 'older edit' : i.data?.ciphertext === f15.marks.edited2 ? 'newest' : 'other'})`).join(' ');
    db.prepare("DELETE FROM group_guest_mail WHERE member = ? AND group_id = 'g15-c15-filler'").run(f15.who.pk);
    assert(f15.ok && refusedEdit.status === 202 && onTablet15 === 'edit(older edit)',
        `15c. an edit not held (the host's allowance full): the tablet, which has the line, is served the older edit's words, not left on the first (got ${onTablet15 || 'nothing'})`);

    // 15d (#3233 round 4). Nothing held past MAIL_HELD_DAYS is served, swept yet or not (a server off for a month, back before
    // its first sweep): the host offers a takedown that long and a day more (group-guests.ts guestRowKeptMs), so whatever is
    // still served here can still be taken down.
    const { MAIL_HELD_DAYS: HELD15 } = await import('./engine/relay-mail.js');
    const DAY15 = 24 * 60 * MIN;
    const AGE15: Array<[string, number, number]> = [
        [`${HELD15 - 1} days`, (HELD15 - 1) * DAY15, 1],
        [`${HELD15} days less a minute`, HELD15 * DAY15 - MIN, 1],
        [`${HELD15} days and a minute, not swept yet`, HELD15 * DAY15 + MIN, 0],
    ];
    let a15 = 0;
    for (const [label, age, expected] of AGE15) {
        const h = await held15(`d15-${++a15}`);
        db.prepare('UPDATE group_guest_mail SET received_at = ? WHERE member = ?').run(Date.now() - age, h.who.pk);
        const served = (await h.itemsOn(h.phone)).filter((i: any) => i.kind === 'line' && i.data?.id === h.id).length;
        const stillHeld = heldCount(h.who, 'b.example', h.g);
        assert(h.ok && served === expected && stillHeld === 1,
            `15d. a line held ${label}: served ${served} (expected ${expected}), still held here until the sweep (${stillHeld})`);
    }

    // ── 16. The order rule (G2): the newest word of the host's on where a guest stands wins ─────
    // The host's two servers (A, its main, and B, the standby that takes over) each tell this server about Gus from their own
    // outbox, each stamping a word on where he stands (a removal, an invitation, the roster) and a line's takedown with the
    // group's counter (engine/group-guests.ts nextGuestSeq, from that server's copy of the last one and its own clock). Each
    // row: Gus in, with the roster R0 kept and a line L held; the host makes event 1, then event 2 (a second later in real time);
    // the two arrive in the order made, or reversed (an outage, a take-back, a send on the wire); this server's final state
    // must be what the two in the order made leave, which is pinned. The pairs are those a host can make: a roster or a
    // takedown names only guests in (the takedown only those who heard the line), so neither follows a removal or an
    // invitation of Gus without his own yes, which goes through this server.
    console.log('\n16. Close the class, the order rule (G2): (event pair) x (which server sent each, a take-over between, its copy and clock) x (arrival order) -> the newest word wins');
    const next16 = hostSide?.nextGuestSeq as ((last: number | null, now: number) => number) | undefined;
    const EV16 = ['removal', 're-invitation', 'roster', 'takedown'] as const;
    type Ev16 = (typeof EV16)[number];
    const PAIRS16: Array<[Ev16, Ev16]> = [
        ['removal', 'removal'], ['removal', 're-invitation'], ['re-invitation', 'removal'], ['re-invitation', 're-invitation'],
        ['roster', 'removal'], ['roster', 're-invitation'], ['roster', 'roster'], ['roster', 'takedown'],
        ['takedown', 'removal'], ['takedown', 're-invitation'], ['takedown', 'roster'], ['takedown', 'takedown'],
    ];
    /** What the two leave in the order made: where Gus stands, the roster kept, and (after a takedown) the line L. */
    const AFTER16: Record<string, string> = {
        'removal, removal': 'out, no roster', 'removal, re-invitation': 'invited, no roster', 're-invitation, removal': 'out, no roster',
        're-invitation, re-invitation': 'invited, no roster', 'roster, removal': 'out, no roster', 'roster, re-invitation': 'invited, no roster',
        'roster, roster': 'in, roster R2', 'roster, takedown': 'in, roster R1, L gone', 'takedown, removal': 'out, no roster, L gone',
        'takedown, re-invitation': 'invited, no roster, L gone', 'takedown, roster': 'in, roster R2, L gone', 'takedown, takedown': 'in, roster R0, L gone',
    };
    const MIN16 = 60_000;
    /** Each scenario's two counters, as the host's servers issue them: event 1 at t+1 s, event 2 at t+2 s, from R0's counter. */
    const SC16: Array<[string, (s0: number, t: number) => [number, number]]> = [
        ['one server, no take-over', (s0, t) => { const a = next16!(s0, t + 1000); return [a, next16!(a, t + 2000)]; }],
        ['A, then B after a take-over, its copy current', (s0, t) => { const a = next16!(s0, t + 1000); return [a, next16!(a, t + 2000)]; }],
        ['A, then B after a take-over, its copy from before event 1', (s0, t) => [next16!(s0, t + 1000), next16!(s0, t + 2000)]],
        ['A, then B after a take-over, its copy current, its clock 10 minutes behind', (s0, t) => { const a = next16!(s0, t + 1000); return [a, next16!(a, t + 2000 - 10 * MIN16)]; }],
        ['A, a take-over and a take-back between (B issued its own), A sends both', (s0, t) => { const a = next16!(s0, t + 1000); const b = next16!(a, t + 1500); return [a, next16!(b, t + 2000)]; }],
    ];
    const standing16 = (g: string) => {
        const s = linkOf(gus, 'b.example', g)?.state as string | undefined;
        return s === 'in' ? 'in' : s === 'invited' ? 'invited' : 'out';
    };
    const roster16 = (g: string) => {
        const r = linkOf(gus, 'b.example', g)?.roster as string | null | undefined;
        return r ? `roster ${JSON.parse(r).name}` : 'no roster';
    };
    /** The line L's words still held (the line, or an edit with new words: a held takedown of it carries none). */
    const lineHeld16 = (g: string, id: string) => (db.prepare(`SELECT COUNT(*) FROM group_guest_mail WHERE member = ? AND group_id = ? AND json_extract(body, '$.id') = ?
                                                               AND (kind = 'line' OR (kind = 'edit' AND json_extract(body, '$.action') IS NOT 'removed'))`).pluck().get(gus.pk, g, id) as number) > 0;
    /** Gus's invitations and held notices from b.example, from the rows before, go: each row starts inside every allowance. */
    const clear16 = () => {
        // The gateway's per-address limit counts this suite's own requests (all from one address), as call() resets it.
        resetGatewayRateLimit();
        db.prepare("DELETE FROM group_guest_links WHERE member = ? AND host = 'b.example'").run(gus.pk);
        db.prepare("DELETE FROM group_guest_mail WHERE member = ? AND host = 'b.example'").run(gus.pk);
    };
    let r16 = 0;
    for (const [scenario, counters] of SC16) for (const [e1, e2] of PAIRS16) for (const order of ['in the order made', 'reversed'] as const) {
        const n16 = ++r16;
        clear16();
        const g = `g16-${n16}`;
        const L = `l16-${n16}-${crypto.randomBytes(4).toString('hex')}`;
        const t = Date.now();
        const s0 = next16 ? next16(null, t) : 1;
        const [s1, s2] = next16 ? counters(s0, t) : [2, 3];
        setLink(gus, 'b.example', g, 'in');
        const ev = (e: Ev16, s: number, marker: string) => ({
            v: 1, kind: e === 'removal' ? 'removed' : e === 're-invitation' ? 'invite' : e === 'roster' ? 'roster' : 'edit', group: g, host: 'b.example', guests: [gus.pk], seq: s,
            data: e === 'removal' ? { why: 'removed' } : e === 're-invitation' ? DATA.invite : e === 'roster' ? { ...(DATA.roster as object), name: marker }
                : { id: L, action: 'removed', by: 'convenor' },
        });
        const start = [
            await notice('b.example', ev('roster', s0, 'R0')),
            await notice('b.example', { v: 1, kind: 'line', group: g, host: 'b.example', guests: [gus.pk], data: { ...(DATA.line as object), id: L } }),
        ];
        const setupOk = start.every((r) => r.status === 202) && standing16(g) === 'in' && roster16(g) === 'roster R0' && lineHeld16(g, L) && s1 < s2;
        const pair = order === 'reversed' ? [ev(e2, s2, 'R2'), ev(e1, s1, 'R1')] : [ev(e1, s1, 'R1'), ev(e2, s2, 'R2')];
        const answers = [];
        for (const p of pair) answers.push((await notice('b.example', p)).status);
        const takedown = e1 === 'takedown' || e2 === 'takedown';
        const got = `${standing16(g)}, ${roster16(g)}${takedown ? `, L ${lineHeld16(g, L) ? 'held' : 'gone'}` : ''}`;
        const want = AFTER16[`${e1}, ${e2}`];
        assert(setupOk && answers.every((s) => s === 202) && got === want,
            `16. ${e1}, then ${e2} x ${scenario} x arriving ${order}: ${want} (got ${got}${setupOk ? '' : `, setup failed (counters ${s0} ${s1} ${s2}; start ${start.map((r) => `${r.status} ${JSON.stringify(r.body)}`).join(', ')})`})`);
    }
    assert(r16 === SC16.length * PAIRS16.length * 2 && Object.keys(AFTER16).length === PAIRS16.length,
        `16z. the table has a row for every pair (${PAIRS16.length}) x every scenario (${SC16.length}) x both arrival orders (${r16} rows)`);
    // A counter that is no positive whole number makes no notice: 400, nothing held.
    for (const [label, bad] of [['zero', 0], ['negative', -5], ['a fraction', 1.5], ['a string', '7']] as Array<[string, unknown]>) {
        const g = `g16-bad-${label.replace(/\s/g, '-')}`;
        setLink(gus, 'b.example', g, 'in');
        const r = await notice('b.example', { v: 1, kind: 'removed', group: g, host: 'b.example', guests: [gus.pk], seq: bad, data: { why: 'removed' } });
        assert(r.status === 400 && standing16(g) === 'in', `16b. a notice whose counter is ${label}: 400 (got ${r.status}), nothing changes (${standing16(g)})`);
    }
    // The newest taken is kept when a withdrawn invitation leaves no link: the older invitation, arriving after, is no new one.
    {
        clear16();
        const g = 'g16-withdrawn';
        const t = Date.now();
        const inv = { v: 1, kind: 'invite', group: g, host: 'b.example', guests: [gus.pk], seq: t, data: DATA.invite };
        const wd = { v: 1, kind: 'removed', group: g, host: 'b.example', guests: [gus.pk], seq: t + 1, data: { why: 'removed' } };
        await notice('b.example', inv);
        const invited = linkOf(gus, 'b.example', g)?.state;
        await notice('b.example', wd);
        const gone = linkOf(gus, 'b.example', g) === undefined;
        await notice('b.example', inv);
        assert(invited === 'invited' && gone && linkOf(gus, 'b.example', g) === undefined,
            `16c. an invitation withdrawn (no link kept), then the same invitation again: no invitation comes back (${invited} -> ${gone ? 'none' : 'kept'} -> ${linkOf(gus, 'b.example', g)?.state ?? 'none'})`);
    }

    // A newer invitation to someone in that can't be held (they have as many waiting from that host as it may have): out all
    // the same, nothing of the group held for them, since the newest word says they are no longer in.
    {
        clear16();
        const g = 'g16-full';
        const t = Date.now();
        for (let i = 0; i < (home.GROUP_INVITES_WAITING_PER_HOST as number); i++) {
            await notice('b.example', { v: 1, kind: 'invite', group: `g16-full-w${i}`, host: 'b.example', guests: [gus.pk], seq: t, data: DATA.invite });
        }
        setLink(gus, 'b.example', g, 'in');
        const L = 'l16-full';
        await notice('b.example', { v: 1, kind: 'line', group: g, host: 'b.example', guests: [gus.pk], data: { ...(DATA.line as object), id: L } });
        const heldBefore = lineHeld16(g, L);
        const r = await notice('b.example', { v: 1, kind: 'invite', group: g, host: 'b.example', guests: [gus.pk], seq: t + 5, data: DATA.invite });
        assert(r.status === 202 && heldBefore && standing16(g) === 'out' && !lineHeld16(g, L),
            `16d. a newer invitation to someone in, past the invitations they may have waiting: out all the same, nothing of the group held (${standing16(g)}, L ${lineHeld16(g, L) ? 'held' : 'gone'})`);
    }

    // ── 16o. Out of the group, however it comes (G2 round 2, #3253 review: :339 and :344) ───────────
    // A removal this server WORKS OUT (from a newer invitation to someone in, held or refused so only its counter speaks)
    // does exactly what the host's own removal does: every device is told it is out (a `removed` notice, before the new
    // invitation), held words go, and a held TAKEDOWN stays for the device that still shows the line. Their own leave drops
    // the words and keeps the takedown too (their device sent it, so no notice). Each row: a member with two devices listed,
    // one held notice of the group (a line, an edit with new words, a takedown) that the phone fetched and confirmed and the
    // tablet did not; then the removal arrives; what each device is served next is pinned.
    console.log('\n16o. Close the class: (how they go out: the host\'s removal, a newer invitation held, a newer invitation refused, their leave) x (held: line, edit with words, takedown) x (device: fetched it, not) -> what each device is served');
    const ARRIVE16O = ["the host's removal", 'a newer invitation, held', 'a newer invitation that cannot be held (only its counter)', 'their leave taken'] as const;
    const HELD16O = ['a line', 'an edit with new words', 'a takedown'] as const;
    const DEV16O = ['phone (fetched it)', 'tablet (did not)'] as const;
    type Arrive16o = (typeof ARRIVE16O)[number];
    type Held16o = (typeof HELD16O)[number];
    const LINK16O: Record<Arrive16o, string> = {
        "the host's removal": 'removed', 'a newer invitation, held': 'invited', 'a newer invitation that cannot be held (only its counter)': 'removed', 'their leave taken': 'left',
    };
    /** What each device is served next, by (how they go out) and (what was held): the phone's, then the tablet's. */
    const SERVED16O = (a: Arrive16o, h: Held16o): [string, string] => {
        const out = a === 'their leave taken' ? '' : a === 'a newer invitation, held' ? 'removed(removed) invite' : 'removed(removed)';
        const kept = h === 'a takedown' ? 'takedown' : '';
        return [out || 'nothing', [kept, out].filter(Boolean).join(' ') || 'nothing'];
    };
    const served16o = (items: any[]) => items.map((i) => (i.kind === 'edit' ? (i.data?.action === 'removed' ? 'takedown' : 'edit') : i.kind === 'removed' ? `removed(${i.data?.why})` : i.kind)).join(' ') || 'nothing';
    let r16o = 0;
    for (const a of ARRIVE16O) for (const hk of HELD16O) {
        const h = await held15(`o16-${++r16o}`);
        // The held notice under test, alone: for an edit or a takedown, the line itself first reaches both devices (and goes).
        if (hk !== 'a line') {
            await h.confirm(h.phone);
            await h.confirm(h.tablet);
            await h.tell('edit', hk === 'a takedown' ? { id: h.id, action: 'removed', by: 'convenor' } : h.editOf(h.marks.edited));
        }
        const heldBefore = heldCount(h.who, 'b.example', h.g);
        await h.confirm(h.phone);
        const s = Date.now();
        if (a === 'their leave taken') await send(h.who, [await item(h.who, 'group-leave', h.g, JSON.stringify({ v: 1 }))]);
        else if (a === "the host's removal") await h.tell('removed', { why: 'removed' });
        else {
            const data = a === 'a newer invitation, held' ? DATA.invite : { ...(DATA.invite as object), name: 'x'.repeat(home.GROUP_INVITE_MAX_CHARS as number) };
            await notice('b.example', { v: 1, kind: 'invite', group: h.g, host: 'b.example', guests: [h.who.pk], seq: s, data });
        }
        const carries = (b: string) => [h.marks.words, h.marks.photo, h.marks.edited].some((k) => b.includes(k));
        const wordsKept = h.bodies().filter(carries).length;
        const link = linkOf(h.who, 'b.example', h.g)?.state ?? 'none';
        const got: [string, string] = [served16o(await h.itemsOn(h.phone)), served16o(await h.itemsOn(h.tablet))];
        const want = SERVED16O(a, hk);
        const setupOk = h.ok && heldBefore === 1;
        DEV16O.forEach((d, i) => assert(setupOk && wordsKept === 0 && link === LINK16O[a] && got[i] === want[i],
            `16o. ${a} x ${hk} x ${d}: the link ${LINK16O[a]}, no words kept, served: ${want[i]} (got ${got[i]}; link ${link}; words kept ${wordsKept}${setupOk ? '' : `; setup failed, held ${heldBefore}`})`));
    }
    assert(r16o === ARRIVE16O.length * HELD16O.length, `16o. the table has a row for every way out x every held notice (${r16o} rows, x ${DEV16O.length} devices)`);

    // Each held notice is stored under the allowance it was checked against, worked out from where it leaves them (#3253
    // :344): the allowance it counts in (and the trim of settleGroupMailFor) is the one that let it in.
    console.log('\n16f. Close the class: every branch that holds a notice -> the answered flag stored with each, from where it leaves them');
    const FLAG16F: Array<[string, string, string]> = [
        ['a first invitation', 'none', 'invite:0'],
        ['a newer invitation to someone in, held', 'in', 'removed:1 invite:0'],
        ['a newer invitation to someone in, refused (only its counter)', 'in', 'removed:1'],
        ["the host's removal of someone in", 'in', 'removed:1'],
        ['an invitation withdrawn (a removal of someone invited)', 'invited', 'removed:0'],
        ['a roster to someone in', 'in', 'roster:1'],
        ['a line to someone in', 'in', 'line:1'],
        ['an edit to someone in', 'in', 'edit:1'],
        ['an epoch to someone in', 'in', 'epoch:1'],
    ];
    let r16f = 0;
    for (const [branch, from, want] of FLAG16F) {
        const who = addLocal(`F16-${++r16f}`);
        const g = `g16f-${r16f}`;
        if (from !== 'none') setLink(who, 'b.example', g, from);
        const s = Date.now();
        const tell = (kind: string, data: unknown, seq?: number) => notice('b.example', { v: 1, kind, group: g, host: 'b.example', guests: [who.pk], ...(seq ? { seq } : {}), data });
        if (branch.includes('invitation') && !branch.includes('withdrawn')) {
            await tell('invite', branch.includes('refused') ? { ...(DATA.invite as object), name: 'x'.repeat(home.GROUP_INVITE_MAX_CHARS as number) } : DATA.invite, s);
        } else if (branch.includes('removal')) await tell('removed', { why: 'removed' }, s);
        else {
            const k = branch.split(' ')[1];
            await tell(k, k === 'roster' ? { ...(DATA.roster as object), guests: [{ key: who.pk, home: 'a.example', name: 'F' }] } : DATA[k], k === 'roster' ? s : undefined);
        }
        const got = (db.prepare('SELECT kind, answered FROM group_guest_mail WHERE member = ? AND group_id = ? ORDER BY received_at, rowid').all(who.pk, g) as Array<{ kind: string; answered: number }>)
            .map((r) => `${r.kind}:${r.answered}`).join(' ') || 'nothing';
        assert(got === want, `16f. ${branch}: held as ${want} (got ${got})`);
    }
    // The consequence the flag had: the re-invitation now counts towards the invitations that host may have waiting.
    {
        const who = addLocal('F16-count');
        const t = Date.now();
        setLink(who, 'b.example', 'g16f-count-in', 'in');
        await notice('b.example', { v: 1, kind: 'invite', group: 'g16f-count-in', host: 'b.example', guests: [who.pk], seq: t, data: DATA.invite });
        for (let i = 1; i < (home.GROUP_INVITES_WAITING_PER_HOST as number); i++) {
            await notice('b.example', { v: 1, kind: 'invite', group: `g16f-count-${i}`, host: 'b.example', guests: [who.pk], seq: t, data: DATA.invite });
        }
        const counted = (db.prepare("SELECT COUNT(*) FROM group_guest_mail WHERE member = ? AND host = 'b.example' AND answered = 0").pluck().get(who.pk) as number);
        assert(counted === (home.GROUP_INVITES_WAITING_PER_HOST as number),
            `16f. a re-invitation counts towards the ${home.GROUP_INVITES_WAITING_PER_HOST} invitations a host may have waiting (counted ${counted})`);
    }

    // 16s. Two tabs of one device (#3246 round 2 note: a stale page deleted an invitation): each page says when its list of
    // groups was read, strictly later than any page before, so the page read before an invitation came is known as older.
    {
        const who = addLocal('S16-tabs');
        const tab = device();
        const before = await fetchGroup(who, tab);
        await notice('b.example', { v: 1, kind: 'invite', group: 'g16s', host: 'b.example', guests: [who.pk], seq: Date.now(), data: DATA.invite });
        const after = await fetchGroup(who, tab);
        const lists = (r: Res) => (r.body?.groups ?? []).some((l: any) => l.group === 'g16s' && l.state === 'invited');
        const same = [await fetchGroup(who, tab), await fetchGroup(who, tab)].map((r) => r.body?.linksAt as number);
        assert(Number.isSafeInteger(before.body?.linksAt) && !lists(before) && lists(after) && after.body.linksAt > before.body.linksAt && same[1] > same[0],
            `16s. the page read before the invitation came says it is older (${before.body?.linksAt} < ${after.body?.linksAt}; listed ${lists(before)} -> ${lists(after)}; back to back ${same[0]} < ${same[1]})`);
    }

    // ── 16r. A home restored from an older snapshot (G2) ──────────────────────────────────────
    // The database a restore or a roll-back brings back holds lines from the backup's day; the hosts' takedowns since went to
    // the database it replaced. At the boot after it (index.ts: deliverRestoreNotices' `swapped`), every held line and edit
    // goes, as at a role change; everything else held stays.
    console.log('\n16r. Close the class: what is held (line, edit, takedown, epoch, roster, removal, invitation) x the notice the swap left (a restore, a roll-back, an unreadable one) -> no line or edit is held after the boot, everything else is');
    const rp: any = await import('./services/restore-points.js');
    const HELD16R = ['line', 'edit', 'line-taken-down', 'epoch', 'roster', 'removed', 'invite'] as const;
    for (const left of ['a restore', 'a roll-back', 'an unreadable notice'] as const) {
        const tag = left.replace(/\W+/g, '-');
        const gIn = `g16r-in-${tag}`, gOut = `g16r-out-${tag}`, gInv = `g16r-inv-${tag}`;
        clear16();
        setLink(gus, 'b.example', gIn, 'in');
        setLink(gus, 'b.example', gOut, 'in');
        db.prepare('DELETE FROM group_guest_mail WHERE member = ?').run(gus.pk);
        for (const k of HELD16R) {
            const g = k === 'removed' ? gOut : k === 'invite' ? gInv : gIn;
            const data = k === 'line-taken-down' ? { id: 'm-other', action: 'removed', by: 'author' } : DATA[k];
            await notice('b.example', { v: 1, kind: kindOfRow(k), group: g, host: 'b.example', guests: [gus.pk], data });
        }
        const kinds = () => (db.prepare(`SELECT kind, json_extract(body, '$.action') AS action FROM group_guest_mail WHERE member = ?`).all(gus.pk) as Array<{ kind: string; action: string | null }>)
            .map((r) => (r.kind === 'edit' && r.action === 'removed' ? 'line-taken-down' : r.kind)).sort().join(' ');
        const before = kinds();
        fs.writeFileSync(path.join(dataDir, `restore-notice-${Date.now()}-${process.pid}.json`),
            left === 'an unreadable notice' ? 'not json' : JSON.stringify({ kind: left === 'a restore' ? 'restore' : 'roll-back', at: new Date().toISOString(), madeAt: '2026-11-01T00:00:00.000Z', point: 'p-16r' }));
        rp.deliverRestoreNotices({ announce: () => {}, log: () => {}, swapped: home.heldLinesAfterSwap }, dataDir);
        const after = kinds();
        const want = 'epoch invite line-taken-down removed roster';
        assert(before === 'edit epoch invite line line-taken-down removed roster' && after === want,
            `16r. ${left}: no line or edit held after the boot, the rest still held (${after}; before: ${before})`);
    }
    const indexSrc = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'index.ts'), 'utf8');
    assert(/startRestoreNoticeWatch\(\{[\s\S]*?swapped:\s*heldLinesAfterSwap[\s\S]*?\}\);/.test(indexSrc),
        '16r. the boot hands the restore notices the drop of held lines (index.ts startRestoreNoticeWatch: swapped: heldLinesAfterSwap)');

    // ── 17. Where a guest stands: the newest word by counter, at the home and on each device (G2 follow-ups) ─────────
    // THE INVARIANT: at the home and on each device, where a guest stands is decided by the newest word by counter, never by
    // arrival order or by a stale page. Words: the host's invitation, the same invitation told again by the server that
    // took over (retellGroup), the roster, a removal, an invitation again, and the host's ANSWERS to the guest's own yes, no
    // and leave (each with the counter it was stamped with: the order rule, THE GUEST'S OWN WORD); and a page with links,
    // fetched by two tabs of one device. Each history's counters are issued as the host's servers issue them, in the
    // order made (after a take-over by B, its copy current and its clock 10 minutes behind). Each row is one arrival order
    // the transports allow (the first invitation first: the guest answers it, their yes or no queued at once while the host
    // is out of reach; each server's own outbox oldest first; the guest's own items oldest first), then the device's two
    // tabs: one fetched halfway, one at the end; the end page applied first, the halfway one after it (stale). The final
    // state at the home and on the device is the same for every order: the one each history pins.
    console.log('\n17. Close the class, the newest word wins: (invitation, the same told again after a take-over, yes, no, leave, roster, removal, invitation again) x (every arrival order the transports allow) x (a stale tab) -> the same final state at the home and on the device');
    type W17 = 'invite' | 'retold' | 'yes' | 'no' | 'leave' | 'roster' | 'removal' | 'invite again';
    interface H17 { name: string; words: W17[]; before: Array<[W17, W17]>; home: string; device: string }
    const H17S: H17[] = [
        { name: 'a yes after a take-over told the invitation again', words: ['invite', 'retold', 'yes', 'roster'], before: [['retold', 'roster']], home: 'in, roster R', device: 'in, roster R' },
        { name: 'removed and invited again after the yes', words: ['invite', 'yes', 'roster', 'removal', 'invite again'], before: [], home: 'invited', device: 'invited' },
        { name: 'a leave after the yes, the invitation told again before it', words: ['invite', 'retold', 'yes', 'roster', 'leave'], before: [['retold', 'roster'], ['yes', 'leave']], home: 'left', device: 'none' },
        { name: 'a no after a take-over told the invitation again', words: ['invite', 'retold', 'no'], before: [], home: 'declined', device: 'none' },
    ];
    /** Every order of `rest` in which nothing arrives before what `before` says must come first. */
    const orders17 = (rest: W17[], before: Array<[W17, W17]>): W17[][] => {
        if (rest.length <= 1) return [rest];
        const out: W17[][] = [];
        for (const w of rest) {
            if (before.some(([a, b]) => b === w && rest.includes(a))) continue;
            for (const tail of orders17(rest.filter((x) => x !== w), before)) out.push([w, ...tail]);
        }
        return out;
    };
    const chat17 = (chats: Record<string, any>, g: string) => {
        const c = chats[guestChatId('b.example', g)];
        return c ? `${c.state}${c.roster ? `, roster ${c.roster.name}` : ''}` : 'none';
    };
    let r17 = 0;
    const want17 = H17S.reduce((n, h) => n + orders17(h.words.slice(1), h.before).length, 0);
    for (const h of H17S) {
        for (const order of orders17(h.words.slice(1), h.before)) {
            const n17 = ++r17;
            clear16();
            db.prepare('DELETE FROM group_guest_sent WHERE sender_key = ?').run(gus.pk);
            const g = `g17-${n17}`;
            const t = Date.now();
            const seqs = new Map<W17, number>();
            let last: number | null = null;
            h.words.forEach((w, i) => {
                const behind = h.words.includes('retold') && i > 0 ? 10 * MIN : 0;
                last = next16 ? next16(last, t + (i + 1) * 1000 - behind) : i + 1;
                seqs.set(w, last);
            });
            const hostWord = (w: W17) => ({
                v: 1, kind: w === 'removal' ? 'removed' : w === 'roster' ? 'roster' : 'invite', group: g, host: 'b.example', guests: [gus.pk], seq: seqs.get(w),
                data: w === 'removal' ? { why: 'removed' } : w === 'roster' ? { ...(DATA.roster as object), name: 'R' } : DATA.invite,
            });
            const own = async (w: 'yes' | 'no' | 'leave') => {
                const it = await item(gus, w === 'leave' ? 'group-leave' : 'group-invite', g, w === 'leave' ? '{"v":1}' : JSON.stringify({ v: 1, answer: w }));
                answerSeq.set(it.envelope.itemId, seqs.get(w)!);
                return it;
            };
            const steps: string[] = [];
            const dev = device();
            steps.push(`invite ${(await notice('b.example', hostWord('invite'))).status}`);
            // Their yes or no, queued at once while the host is out of reach: its answer lands where the order puts it.
            const answer = h.words.includes('yes') ? 'yes' : h.words.includes('no') ? 'no' : null;
            if (answer) {
                failing.add('b.example');
                const r = await send(gus, [await own(answer)]);
                failing.delete('b.example');
                steps.push(`${answer} ${r.status} ${r.body?.items?.[0]?.state}`);
            }
            let halfway: Res | null = null;
            for (const [i, w] of order.entries()) {
                resetGatewayRateLimit();
                if (w === 'yes' || w === 'no') steps.push(`${w} answered ${await home.retryGroupSent(Date.now() + 10 * MIN)}`);
                else if (w === 'leave') { const r = await send(gus, [await own('leave')]); steps.push(`leave ${r.status} ${r.body?.items?.[0]?.state}`); }
                else steps.push(`${w} ${(await notice('b.example', hostWord(w))).status}`);
                if (i + 1 === Math.ceil(order.length / 2)) halfway = await fetchGroup(gus, dev);
            }
            const end = await fetchGroup(gus, dev);
            const link = linkOf(gus, 'b.example', g);
            const queued = db.prepare("SELECT COUNT(*) FROM group_guest_sent WHERE sender_key = ? AND group_id = ? AND state = 'queued'").pluck().get(gus.pk, g) as number;
            const homeGot = `${link?.state ?? 'none'}${link?.roster ? `, roster ${JSON.parse(link.roster).name}` : ''}${queued ? ', an item still queued' : ''}`;
            // The device: the end page applied, then the halfway one (another tab's, read before it) after it.
            const ctx17 = (seen: number | null) => ({ me: gus.pk, myEdPrivHex: gus.seedHex, blocked: () => false, now: Date.now(), linksSeen: seen });
            const alone = applyGuestMail({}, end.body ?? {}, ctx17(null));
            const both = applyGuestMail(alone.chats, halfway?.body ?? {}, ctx17(end.body?.linksAt ?? null));
            const devAlone = chat17(alone.chats, g), devGot = chat17(both.chats, g);
            assert(homeGot === h.home && devAlone === h.device && devGot === h.device && both.confirm.length === 0,
                `17. ${h.name} x arriving ${order.join(', ')}: home ${h.home}, device ${h.device}, the stale tab moving nothing (got home ${homeGot}; device ${devAlone}, after the stale tab ${devGot}, it confirmed ${both.confirm.length}; ${steps.join('; ')})`);
        }
    }
    assert(r17 === want17 && r17 >= 30, `17z. the table has a row for every history x every arrival order the transports allow (${r17} rows)`);

    // ── 18. The same invariant, GENERATED: every history the host can make x every arrival order at the home ─────────
    // #3266 round 1 (the deciding review, measured): a yes taken after its invitation was withdrawn and made again recorded
    // its counter at the home although its answer moved nothing there, so the invitation made again (older) and the roster
    // (newer, but not taken: no yes queued, no link answered) were both dropped, and the home stayed `removed` while the
    // host had the guest in. THE INVARIANT: a word's counter is recorded at the home only when the word is applied (it
    // changes or confirms the state it names), and where a guest stands is the state the newest applied word names. So:
    // every history of up to 4 of the host's acts its own rules allow (engine/group-guests.ts: invite from nothing, invite
    // again after a leave or a removal, withdraw an invitation, remove a guest in, a roster while they are in; the guest's
    // yes, no and leave as the host takes them: a yes to an invitation puts them in and the roster follows, a no or a leave
    // takes them out, one that agrees with where they stand confirms it under a new counter, a yes from a guest out moves
    // nothing and carries none), each word stamped with the next counter, x every arrival order of its words at the home:
    // the notices in any order (two servers, a take-over between); each of the guest's own items sent while the home lets
    // them (else the row is not one the guest can make, and is counted apart), before every word the host made after
    // taking it, oldest first; its answer after it, the answers in order, and items queued together answered together.
    // Then a device: the end page, and a page read halfway applied after it (a stale tab). The final state at the home and
    // on the device must be the one the host's newest word names, for every row.
    console.log('\n18. Close the class, generated: (every history of up to 4 host acts its rules allow) x (every arrival order at the home) x (a stale tab) -> the state the newest word names, at the home and on the device');
    type Act18 = 'invite' | 'withdraw' | 'invite again' | 'yes' | 'no' | 'leave' | 'remove' | 'roster';
    type Host18 = 'none' | 'invited' | 'in' | 'left' | 'removed';
    type Kind18 = 'invite' | 'removed' | 'roster' | 'yes' | 'no' | 'leave';
    const ACTS18: Act18[] = ['invite', 'withdraw', 'invite again', 'yes', 'no', 'leave', 'remove', 'roster'];
    /** The host's own rules: where an act leaves the guest, and the words it makes (null: the host can't make it there). */
    const act18 = (s: Host18, a: Act18): { s: Host18; words: Array<{ kind: Kind18; counted: boolean }> } | null => {
        const out = s === 'left' || s === 'removed';
        const w = (kind: Kind18, counted = true) => ({ kind, counted });
        switch (a) {
            case 'invite': return s === 'none' ? { s: 'invited', words: [w('invite')] } : null;
            case 'invite again': return out ? { s: 'invited', words: [w('invite')] } : null;
            case 'withdraw': return s === 'invited' ? { s: 'removed', words: [w('removed')] } : null;
            case 'remove': return s === 'in' ? { s: 'removed', words: [w('removed')] } : null;
            case 'roster': return s === 'in' ? { s: 'in', words: [w('roster')] } : null;
            case 'yes': return s === 'none' ? null : out ? { s, words: [w('yes', false)] } : { s: 'in', words: [w('yes'), w('roster')] };
            case 'no': case 'leave': return s === 'none' ? null : { s: out ? s : 'left', words: [w(a)] };
        }
    };
    interface Hist18 { acts: Act18[]; words: Array<{ kind: Kind18; counted: boolean }> }
    const hists18: Hist18[] = [];
    const grow18 = (s: Host18, h: Hist18) => {
        if (h.acts.length) hists18.push(h);
        if (h.acts.length === 4) return;
        for (const a of ACTS18) {
            const r = act18(s, a);
            if (r) grow18(r.s, { acts: [...h.acts, a], words: [...h.words, ...r.words] });
        }
    };
    grow18('none', { acts: [], words: [] });
    type Ev18 = { k: 'arrive' | 'send' | 'answer'; i: number };
    const OWN18: ReadonlySet<Kind18> = new Set(['yes', 'no', 'leave']);
    /** Every arrival order of `h`'s words at the home the transports allow (the rules above). */
    const orders18 = (h: Hist18): Ev18[][] => {
        const own = h.words.flatMap((w, i) => (OWN18.has(w.kind) ? [i] : []));
        const events: Ev18[] = h.words.flatMap((w, i): Ev18[] => (OWN18.has(w.kind) ? [{ k: 'send', i }, { k: 'answer', i }] : [{ k: 'arrive', i }]));
        const out: Ev18[][] = [];
        const walk = (left: Ev18[], placed: Ev18[]) => {
            if (!left.length) { out.push(placed); return; }
            const has = (k: Ev18['k'], i: number) => placed.some((p) => p.k === k && p.i === i);
            const last = placed[placed.length - 1];
            // An item sent before the answer to an older one is queued with it: the two are answered together, one after the other.
            const together = own.find((j) => !has('answer', j) && has('send', j) && own.some((o) => o < j && has('answer', o) && last?.k === 'answer' && last.i === o
                && placed.findIndex((p) => p.k === 'send' && p.i === j) < placed.findIndex((p) => p.k === 'answer' && p.i === o)));
            for (const e of left) {
                if (together !== undefined && !(e.k === 'answer' && e.i === together)) continue;
                // Before any invitation has arrived the home has no link to send under (it refuses every item): not generated.
                if (e.k === 'send' && !placed.some((p) => p.k === 'arrive' && h.words[p.i].kind === 'invite')) continue;
                if (e.k === 'answer' && !has('send', e.i)) continue;
                if ((e.k === 'send' || e.k === 'answer') && own.some((j) => j < e.i && !has(e.k, j))) continue;
                if (e.k === 'arrive' && own.some((j) => j < e.i && !has('send', j))) continue;
                walk(left.filter((x) => x !== e), [...placed, e]);
            }
        };
        walk(events, []);
        return out;
    };
    /** What the host's newest word names: at the home, and on a device. */
    const want18 = (h: Hist18): { home: string[]; device: string[] } => {
        const counted = h.words.filter((w) => w.counted);
        const newest = counted[counted.length - 1].kind;
        const rosters = h.words.filter((w) => w.kind === 'roster').length;
        if (newest === 'invite') return { home: ['invited'], device: ['invited'] };
        if (newest === 'roster' || newest === 'yes') return { home: [`in, roster R${rosters}`], device: [`in, roster R${rosters}`] };
        if (newest === 'no') return { home: ['declined'], device: ['none'] };
        if (newest === 'leave') return { home: ['left'], device: ['none'] };
        // A removal: out, whichever way the home had them (an invitation withdrawn leaves no link; one answered, `removed`).
        return { home: ['none', 'removed', 'declined', 'left'], device: ['none', 'removed'] };
    };
    const name18 = (h: Hist18, i: number) => {
        const w = h.words[i];
        return w.kind === 'roster' ? `roster R${h.words.slice(0, i + 1).filter((x) => x.kind === 'roster').length}` : w.counted ? w.kind : `${w.kind} (no counter)`;
    };
    const failures18: string[] = [];
    let rows18 = 0, orders18n = 0, notMade18 = 0, histsRun18 = 0;
    const histsWithRows18 = new Set<number>();
    const ran18 = new Set<string>();
    for (const [hi, h] of hists18.entries()) {
        const seqs = (() => { let n = 0; return h.words.map((w) => (w.counted ? ++n : null)); })();
        const want = want18(h);
        histsRun18++;
        for (const order of orders18(h)) {
            orders18n++;
            const g = `g18-${hi}-${orders18n}`;
            clear16();
            db.prepare('DELETE FROM group_guest_sent WHERE sender_key = ?').run(gus.pk);
            const dev = device();
            const steps: string[] = [];
            let made = true;
            let halfway: any = null;
            for (const [k, e] of order.entries()) {
                const w = h.words[e.i];
                if (e.k === 'arrive') {
                    const data = w.kind === 'removed' ? { why: 'removed' } : w.kind === 'roster' ? { ...(DATA.roster as object), name: name18(h, e.i).slice('roster '.length) } : DATA.invite;
                    const a = home.receiveGroupNotice('b.example', { v: 1, kind: w.kind, group: g, host: 'b.example', guests: [gus.pk], seq: seqs[e.i], data });
                    steps.push(`${name18(h, e.i)} ${a.status}`);
                } else if (e.k === 'send') {
                    const it = await item(gus, w.kind === 'leave' ? 'group-leave' : 'group-invite', g, w.kind === 'leave' ? '{"v":1}' : JSON.stringify({ v: 1, answer: w.kind }));
                    answerSeq.set(it.envelope.itemId, seqs[e.i]);
                    // Queued while the host is out of reach (a 503: it waits), so its answer lands where the order puts it.
                    script.set('b.example', ['503']);
                    try {
                        await home.sendGroupItems(gus.pk, [it]);
                        steps.push(`${w.kind} sent`);
                    } catch {
                        made = false;
                    } finally {
                        script.delete('b.example');
                    }
                    if (!made) break;
                } else {
                    const queued = db.prepare("SELECT COUNT(*) FROM group_guest_sent WHERE sender_key = ? AND group_id = ? AND state = 'queued'").pluck().get(gus.pk, g) as number;
                    if (queued) steps.push(`${name18(h, e.i)} answered ${await home.retryGroupSent(Date.now() + 10 * MIN)}`);
                }
                if (k + 1 === Math.ceil(order.length / 2)) { noteMailDevice(gus.pk, dev); halfway = home.heldGroupMailFor(gus.pk, dev); }
            }
            if (!made) { notMade18++; continue; }
            rows18++;
            histsWithRows18.add(hi);
            noteMailDevice(gus.pk, dev);
            const end = home.heldGroupMailFor(gus.pk, dev);
            const link = linkOf(gus, 'b.example', g);
            const queued = db.prepare("SELECT COUNT(*) FROM group_guest_sent WHERE sender_key = ? AND group_id = ? AND state = 'queued'").pluck().get(gus.pk, g) as number;
            const homeGot = `${link?.state ?? 'none'}${link?.roster ? `, roster ${JSON.parse(link.roster).name}` : ''}${queued ? ', an item still queued' : ''}`;
            const ctx18 = (seen: number | null) => ({ me: gus.pk, myEdPrivHex: gus.seedHex, blocked: () => false, now: Date.now(), linksSeen: seen });
            const alone = applyGuestMail({}, end, ctx18(null));
            const both = applyGuestMail(alone.chats, halfway ?? {}, ctx18(end.linksAt));
            const devAlone = chat17(alone.chats, g), devGot = chat17(both.chats, g);
            ran18.add(`${h.acts.join(', ')}: ${order.map((e) => `${e.k} ${name18(h, e.i)}`).join(', ')}`);
            if (!(want.home.includes(homeGot) && want.device.includes(devAlone) && devGot === devAlone && both.confirm.length === 0)) {
                failures18.push(`${h.acts.join(', ')} x arriving ${order.map((e) => `${e.k === 'send' ? 'send ' : e.k === 'answer' ? 'answer to ' : ''}${name18(h, e.i)}`).join(', ')}: `
                    + `home ${want.home.join(' or ')}, device ${want.device.join(' or ')} (got home ${homeGot}; device ${devAlone}, after the stale tab ${devGot}, it confirmed ${both.confirm.length}; ${steps.join('; ')})`);
            }
        }
    }
    for (const f of failures18.slice(0, 12)) assert(false, `18. ${f}`);
    // #3266's measured row: invited, withdrawn, invited again, the yes taken (its roster after it), arriving removal, the
    // answer to the yes, the invitation again, the roster.
    const reviewer18 = 'invite, withdraw, invite again, yes: arrive invite, send yes, arrive removed, answer yes, arrive invite, arrive roster R1';
    const unmade18 = hists18.filter((_, i) => !histsWithRows18.has(i)).map((h) => h.acts.join(', '));
    console.log(`   (18: histories with no row the guest can make, an item of theirs refused in every order: ${unmade18.join(' | ')})`);
    assert(failures18.length === 0 && ran18.has(reviewer18) && rows18 >= 400 && histsWithRows18.size >= 41,
        `18. every row: the state the host's newest word names, at the home and on the device (${hists18.length} histories, ${histsWithRows18.size} the guest can make; `
        + `${orders18n} arrival orders, ${rows18} rows run, ${notMade18} not ones the guest can make: the home refused an item; ${failures18.length} wrong; #3266's row among them: ${ran18.has(reviewer18)})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});

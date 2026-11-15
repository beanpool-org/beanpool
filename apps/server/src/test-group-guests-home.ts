/**
 * Group guests on the GUEST'S OWN community's server (slice G1b: engine/group-guest-home.ts; the host's side is
 * test-group-guests.ts). Through the real middleware: the node under test is a.example (BEANPOOL_ADDRESSES, its own node
 * key), whose members Gus and Gia are guests in groups hosted elsewhere. The hosts are played by this suite: b.example (the
 * host they answered), d.example (a host nobody here answered) and c.example (a server the owners blocked), each with its
 * own server key and key document (handed to the node's door by the test fetch hook, double-locked by
 * BEANPOOL_SSRF_TEST_HOOK=1); what the node sends a host reaches the suite through the transport hook. No other server is
 * contacted.
 *
 *   1  close the class: every notice a host brings (invite, roster, line, line with a mention, epoch, removal, edit) x
 *      (the host the guest answered, a host nobody answered, a blocked host, a removed guest, a key that is no member
 *      here, a standby) -> held for the guest or dropped, the answer always the same 202 (400 for a kind that is no notice)
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
    NODE_KEY_VALIDITY_MS, NODE_REQUEST_HEADER, buildNodeRequestHeaders, dmPublicKeyOf, groupEpochCoversExactly, guestEpochStep, makeGroupEpochRecord,
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
    const { addConnector } = await import('./connector-manager.js');
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
                ? { itemId: i.envelope.itemId, refused: refuseIds.get(i.envelope.itemId) ?? 'group-refused' } : { itemId: i.envelope.itemId, received: true })) } };
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
    async function item(from: Id, kind: RelayItemKind, group: string, payload: string, host = 'b.example') {
        const envelope = await signRelayEnvelope({
            kind, itemId: newItemId(), senderKey: from.pk, senderHome: 'a.example', recipient: `group:${group}`, recipientHome: host,
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
        edit: { id: 'm-1', ciphertext: 'c2' },
    };
    const kindOfRow = (k: string) => (k === 'line-mention' ? 'line' : k);
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
    const KINDS = ['invite', 'roster', 'line', 'line-mention', 'epoch', 'removed', 'edit'] as const;
    type Standing = 'answered host' | 'unknown host' | 'blocked host' | 'removed guest' | 'no member here' | 'standby';
    const STANDINGS: Standing[] = ['answered host', 'unknown host', 'blocked host', 'removed guest', 'no member here', 'standby'];
    /** Whether the notice is held for the guest: [kind][standing]. 'edit' is no notice (item 3 splits off): 400 everywhere. */
    const HELD: Record<string, Record<Standing, boolean>> = {
        invite:         { 'answered host': false, 'unknown host': true,  'blocked host': false, 'removed guest': true,  'no member here': false, standby: false },
        roster:         { 'answered host': true,  'unknown host': false, 'blocked host': false, 'removed guest': false, 'no member here': false, standby: false },
        line:           { 'answered host': true,  'unknown host': false, 'blocked host': false, 'removed guest': false, 'no member here': false, standby: false },
        'line-mention': { 'answered host': true,  'unknown host': false, 'blocked host': false, 'removed guest': false, 'no member here': false, standby: false },
        epoch:          { 'answered host': true,  'unknown host': false, 'blocked host': false, 'removed guest': false, 'no member here': false, standby: false },
        removed:        { 'answered host': true,  'unknown host': false, 'blocked host': false, 'removed guest': false, 'no member here': false, standby: false },
        edit:           { 'answered host': false, 'unknown host': false, 'blocked host': false, 'removed guest': false, 'no member here': false, standby: false },
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
            const wantStatus = k === 'edit' ? 400 : 202;
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
                        db.prepare('INSERT INTO group_guest_outbox (id, group_id, home, kind, body, attempts, next_try_at, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
                            .run(crypto.randomUUID(), 'g7', far, 'line', JSON.stringify({ v: 1, kind: 'line', group: 'g7', host: 'a.example', guests: [gus.pk], data: { i } }), t, t);
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
                    db.prepare('INSERT INTO group_guest_outbox (id, group_id, home, kind, body, attempts, next_try_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                        .run(crypto.randomUUID(), 'g11', h, 'line', JSON.stringify({ v: 1, kind: 'line', group: 'g11', host: 'a.example', guests: [gus.pk], data: { i } }), attempts, nextTry, created);
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
                db.prepare('INSERT INTO group_guest_outbox (id, group_id, home, kind, body, attempts, next_try_at, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
                    .run(id, g, 'q.example', 'line', JSON.stringify({ v: 1, kind: 'line', group: g, host: 'a.example', guests: [gus.pk], data: {} }), t, t);
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

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});

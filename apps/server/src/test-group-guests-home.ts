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
    const { TABLES } = await import('./engine/replication-manifest.js');
    const { RELAY_MAIL_TABLES } = await import('./engine/relay-mail-tables.js');
    // Loaded at run time, so on a server without them (origin/main, the fail-first run) the suite reports a count, not a crash.
    const home: any = await import('./engine/group-guest-home.js').catch(() => null);
    const hostSide: any = await import('./engine/group-guests.js').catch(() => null);

    await initTls();
    initStateEngine();
    const BASE = `https://localhost:${await startHttpsServer(0)}`;
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
    const aDoc = readNodeKeyDocument(await (await fetch(`${BASE}/api/node/key`)).json());
    if (!aDoc) throw new Error('a.example has no key document');

    // What the node sends other servers: a member's items to b.example's /api/relay/mail; the backoff table's notices.
    interface Out { host: string; path: string; signed: boolean; body: any }
    const outs: Out[] = [];
    /** Every try to each server, a failing one included. */
    const triesTo = new Map<string, number>();
    const failing = new Set<string>();
    const refuseIds = new Map<string, string>();       // item id -> the refusal b.example answers for it
    __useRelayTransportForTests(async (url, init) => {
        const u = new URL(url);
        triesTo.set(u.host, (triesTo.get(u.host) ?? 0) + 1);
        if (failing.has(u.host)) throw new Error('connect ETIMEDOUT');
        const header = parseNodeRequestHeader(init.headers[NODE_REQUEST_HEADER] ?? '');
        const signed = !!header && header.key === aDoc.key && header.destination === u.host && header.origin === 'a.example'
            && nodeRequestSignatureVerifies(header, { method: 'POST', path: u.pathname, body: init.body });
        const body = JSON.parse(init.body);
        outs.push({ host: u.host, path: u.pathname, signed, body });
        if (u.pathname === '/api/relay/mail') {
            return { status: 202, body: { items: body.items.map((i: any) => (refuseIds.has(i.envelope.itemId)
                ? { itemId: i.envelope.itemId, refused: refuseIds.get(i.envelope.itemId) } : { itemId: i.envelope.itemId, received: true })) } };
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
        const res = await fetch(`${BASE}${p}`, { method, headers, body: method === 'GET' ? undefined : raw });
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
        const res = await fetch(`${BASE}/api/relay/group`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
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
    const unsigned = await fetch(`${BASE}/api/relay/group`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(noticeOf('line', 'b.example', 'g8', [gus.pk])) });
    const asMember = await call('POST', gus, '/api/relay/group', noticeOf('line', 'b.example', 'g8', [gus.pk]));
    assert(unsigned.status >= 400 && unsigned.status < 500 && asMember.status >= 400 && asMember.status < 500 && heldCount(gus, 'b.example', 'g8') === 0,
        `8d. the door: unsigned, or a member's signature, at /api/relay/group is refused (got ${unsigned.status}, ${asMember.status})`);
    const guestView = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'test-guest-view.ts'), 'utf8');
    assert(NODE_SIGNED_PATHS.has('/api/relay/group') && ['POST /api/relay/group', 'GET /api/mail/group', 'POST /api/mail/group/confirm'].every((r) => guestView.includes(`'${r}'`)),
        '8e. the host\'s path takes only a server\'s signature, and the three routes are in the guest-view list');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});

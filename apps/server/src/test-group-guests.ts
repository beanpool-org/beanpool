/**
 * Guests in a group's chat from other communities, on the server that hosts the group (slice G1: scratch/fable-design/
 * DESIGN-forums-messaging-joint-fable.md §2.3; DESIGN-cross-chat-voice-fable.md §4.2, §11 row G1; engine/group-guests.ts).
 * Through the real middleware: the node under test is b.example (BEANPOOL_ADDRESSES, its own node key), hosting the group.
 * The guests' communities are a.example and c.example, played by this suite: their server keys and key documents (handed to
 * the node's door by the test fetch hook, double-locked by BEANPOOL_SSRF_TEST_HOOK=1), their members' keys, and their own
 * /api/relay/group, which the node's requests reach through the transport hook. No other server is contacted.
 *
 *   1  invite: a convenor invites by address card; a member who is no convenor, a forged card, a member here: refused
 *   2  accept: the guest's home brings their signed yes; in, the roster goes to their home; a yes from another home, or
 *      before an invitation, changes nothing and is answered as received
 *   3  epochs: the roster holds the guests in; an epoch is fanned out ONE request per community, with only its guests' wraps
 *   4  lines: a member's line goes once to each community with guests in, naming its guests; a guest's line goes in as theirs
 *      and out to the others' communities, never back to them; a guest's line with a bad envelope is refused, nothing stored;
 *      a stranger's line and one under a stale epoch: nothing stored
 *   5  close the class: every group route x (member, guest, removed guest, visitor) -> the expected answer; nothing a guest
 *      or visitor sends changes a row; what goes out is chat lines, epochs, the roster, invitations and removals only
 *   6  remove: the removed guest's home is told; the epoch goes stale; an epoch still wrapping them is refused; after the
 *      next epoch they are named in nothing that goes out, and a line of theirs is dropped
 *   7  leave: a guest's signed leave takes them out
 *   8  caps: 30 guests invited or in; 20 MB of photos and voice a day per guest; the free-disk floor every photo keeps
 *   9  the owners' switch: off, no invitation, every guest removed and their home told, nothing from a guest goes in
 *  10  a home that can't be reached: the request waits and is tried again, then goes once taken
 *  11  a standby copies group_guests (a plain table) and never the outbox; the routes are in the guest-view list
 *  12  close the class: every kind of roster change (a member joins with no epoch or their own, leaves, is removed by a
 *      convenor or a vote, deletes their account; a guest is invited, says yes, leaves, is removed) -> the roster once to
 *      each community with guests in, naming its guests, with exactly the chat's keys (an invitation: none, only itself)
 *  13  back from epoch-stale: a guest's refused epoch or line -> the roster follows to their home alone, with the current
 *      epoch (stale, or its record and their home's wraps); the epoch they make from it goes in, and so does the line they
 *      send again under the key they open from it; two refusals in one request -> one roster
 *  14  close the class: every kind a guest's home brings x a guest whose card says a member's name -> every notice it makes
 *      says "Ana · a.example · guest", never "Ana" alone
 *  15  each home on its own: while one home doesn't answer, another gets its line at once; a row queued during a send goes
 *      when that send ends; a home that refuses costs one try for all its rows, which wait, then go
 *  16  close the class: every timer job https-server.ts runs from group-guests x (standby, main server) -> a standby returns
 *      at once, writes no copied row, tells nobody; the main server removes and tells
 *
 * Run: SERVER_SUITES_ONLY=test-group-guests node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.BEANPOOL_SSRF_TEST_HOOK = '1';
process.env.BEANPOOL_ADDRESSES = 'b.example';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
    NODE_KEY_VALIDITY_MS, NODE_REQUEST_HEADER, buildNodeRequestHeaders, dmPublicKeyOf, makeGroupEpochRecord, nodeRequestSignatureVerifies,
    openMyGroupKey, parseNodeRequestHeader, readNodeKeyDocument, relayPayloadHash, sealGroupLine, signAddressCard, signNodeKeyDocument,
    signRelayEnvelope, type GroupEpochReason, type GroupEpochRecord, type RelayItem, type RelayItemKind,
} from '@beanpool/core';
import { setSignedForHost, signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

let BASE = '';

interface Id { pk: string; seedHex: string; seed: Uint8Array; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const seed = crypto.randomBytes(32);
    const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
    const seedHex = seed.toString('hex');
    return { pk: dmPublicKeyOf(seedHex), seedHex, seed, priv: crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }), name };
}
const signerOf = (seed: Uint8Array) => (b: Uint8Array) => ed25519.sign(b, seed);

interface Res { status: number; body: any }

async function main(): Promise<void> {
    const dataDir = process.env.BEANPOOL_DATA_DIR;
    if (!dataDir) throw new Error('BEANPOOL_DATA_DIR must be set to a fresh directory');
    const { generateKeyPair, privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
    fs.writeFileSync(path.join(dataDir, 'libp2p_key'), privateKeyToProtobuf(await generateKeyPair('Ed25519')));

    const { initTls } = await import('./services/tls.js');
    const { initStateEngine, seedGenesisMember, createGroup, exportSyncState, removeGroupMemberByVote, purgeMemberSelf } = await import('./state-engine.js');
    const { setNodeRole } = await import('./config/node-role.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { resetChatRateLimit } = await import('./chat-rate-limit.js');
    const { registerVisitor } = await import('./engine/members.js');
    const { __useNodeKeyFetchForTests } = await import('./engine/node-signature.js');
    const { __useRelayTransportForTests } = await import('./engine/relay-outbox.js');
    const { applyShapeChanges } = await import('./config/community-shape-write.js');
    const { TABLES } = await import('./engine/replication-manifest.js');
    const { setSimulatedFreeDiskBytesForTests } = await import('./engine/photo-upload-budget.js');
    // Loaded at run time, so on a server without it (origin/main, the fail-first run) the suite reports a count, not a crash.
    const guests: any = await import('./engine/group-guests.js').catch(() => null);

    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    // Members sign for the community's own name, as their apps do (BEANPOOL_ADDRESSES).
    setSignedForHost('b.example');

    // ── People ──────────────────────────────────────────────────────────────────────────────
    const olive = newId('Olive');
    seedGenesisMember(olive.pk, 'Olive');
    const addLocal = (name: string): Id => {
        const id = newId(name);
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'TEST', 'active')`).run(id.pk, name, olive.pk);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
        return id;
    };
    const ana = addLocal('Ana');      // the group's convenor
    const ben = addLocal('Ben');      // a member of the group
    const vic = newId('Vic');         // a visitor here
    registerVisitor(vic.pk, 'Vic', 'https://elsewhere.example');
    const gus = newId('Gus'), gia = newId('Gia'), stray = newId('Stray');   // at a.example
    const cara = newId('Cara');                                             // at c.example
    const A = newId('A'), C = newId('C');                                   // the two servers' keys

    const now = Date.now();
    const docs = new Map<string, unknown>([
        ['https://a.example/api/node/key', await signNodeKeyDocument({ key: A.pk, validUntil: now + NODE_KEY_VALIDITY_MS, previousKeys: [] }, signerOf(A.seed))],
        ['https://c.example/api/node/key', await signNodeKeyDocument({ key: C.pk, validUntil: now + NODE_KEY_VALIDITY_MS, previousKeys: [] }, signerOf(C.seed))],
    ]);
    __useNodeKeyFetchForTests(async (url) => {
        if (!docs.has(url)) throw new Error('no such server');
        return docs.get(url);
    });
    const bDoc = readNodeKeyDocument(await (await fetch(`${BASE}/api/node/key`)).json());
    if (!bDoc) throw new Error('b.example has no key document');

    // The guests' homes' /api/relay/group: every request the node sends lands here, checked as signed by b.example.
    interface Out { home: string; path: string; signed: boolean; body: any; at: number }
    const outs: Out[] = [];
    let unreachable = false;
    /** A home that doesn't answer until its gate opens (a server behind a firewall that drops packets, until FORWARD_TIMEOUT_MS). */
    const gates = new Map<string, Promise<void>>();
    /** Each home's tries, and the homes that refuse every request (a connection that times out). */
    const tries = new Map<string, number>();
    const refusing = new Set<string>();
    __useRelayTransportForTests(async (url, init) => {
        if (unreachable) throw new Error('connect ECONNREFUSED');
        const u = new URL(url);
        const gate = gates.get(u.host);
        if (gate) await gate;
        tries.set(u.host, (tries.get(u.host) ?? 0) + 1);
        if (refusing.has(u.host)) throw new Error('connect ETIMEDOUT');
        const header = parseNodeRequestHeader(init.headers[NODE_REQUEST_HEADER] ?? '');
        const signed = !!header && header.key === bDoc.key && header.destination === u.host && header.origin === 'b.example'
            && nodeRequestSignatureVerifies(header, { method: 'POST', path: u.pathname, body: init.body });
        outs.push({ home: u.host, path: u.pathname, signed, body: JSON.parse(init.body), at: Date.now() });
        return { status: 202, body: { received: true } };
    });
    const settle = async () => {
        await new Promise((r) => setTimeout(r, 30));
        if (guests) await guests.flushGuestOutbox();
    };
    const outsOf = (kind: string, after = 0) => outs.filter((o) => o.body?.kind === kind && o.at >= after);

    // ── Helpers ─────────────────────────────────────────────────────────────────────────────
    async function call(method: 'GET' | 'POST' | 'DELETE' | 'PATCH', signer: Id, p: string, body?: unknown): Promise<Res> {
        resetGatewayRateLimit();
        resetChatRateLimit();
        const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const headers: Record<string, string> = {
            'X-Public-Key': signer.pk,
            'X-Signature': signRequest(signer.priv, { method, path: p.split('?')[0], timestamp: ts, nonce, body: raw }),
            [SIGNED_FOR_HEADER]: signedForHost(),
            'X-Timestamp': String(ts),
            'X-Nonce': nonce,
        };
        if (method !== 'GET') headers['Content-Type'] = 'application/json';
        const res = await fetch(`${BASE}${p}`, { method, headers, body: method === 'GET' ? undefined : raw });
        const text = await res.text();
        let parsed: any = text;
        try { parsed = JSON.parse(text); } catch { /* empty */ }
        return { status: res.status, body: parsed };
    }
    let n = 0;
    const newItemId = () => `gst-${String(++n).padStart(4, '0')}-${crypto.randomBytes(6).toString('hex')}`;
    async function item(from: Id, fromHome: string, to: string, kind: RelayItemKind, payload: string, opts: { signer?: Id; at?: number } = {}): Promise<RelayItem> {
        const envelope = await signRelayEnvelope({
            kind, itemId: newItemId(), senderKey: from.pk, senderHome: fromHome, recipient: to, recipientHome: 'b.example',
            at: opts.at ?? Date.now(), payloadHash: relayPayloadHash(payload),
        }, signerOf((opts.signer ?? from).seed));
        return { envelope, payload };
    }
    /** A guest's home brings items to b.example, in a request it signed. */
    async function bring(items: unknown[], home: 'a.example' | 'c.example' = 'a.example'): Promise<Res> {
        const k = home === 'a.example' ? A : C;
        const body = JSON.stringify({ items });
        const headers = await buildNodeRequestHeaders({ method: 'POST', url: 'https://b.example/api/relay/mail', body, origin: home, keyHex: k.pk, sign: signerOf(k.seed) });
        const res = await fetch(`${BASE}/api/relay/mail`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
        let parsed: any = null;
        try { parsed = await res.json(); } catch { /* none */ }
        await settle();
        return { status: res.status, body: parsed };
    }
    const cardOf = (who: Id, home: string) => signAddressCard({ key: who.pk, home, name: who.name }, signerOf(who.seed));
    const stateOf = (g: string, who: Id) => (db.prepare('SELECT state FROM group_guests WHERE group_id = ? AND guest_key = ?').get(g, who.pk) as { state: string } | undefined)?.state ?? null;
    const epochBy = (maker: Id, g: string, epoch: number, reason: GroupEpochReason, recipients: Id[]) => makeGroupEpochRecord({
        myEdPrivHex: maker.seedHex, groupId: g, epoch, reason, subject: null, createdAt: new Date().toISOString(), recipients: recipients.map((r) => r.pk),
    });
    const msgCount = (g: string) => (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(g) as { n: number }).n;

    // ── The group ───────────────────────────────────────────────────────────────────────────
    const group = createGroup({ name: 'Seed Library', joinPolicy: 'open', createdBy: ana.pk });
    const G = group.id;
    db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status, from_epoch) VALUES (?, ?, 'member', 'active', 1)`).run(G, ben.pk);
    const groupTo = `group:${G}`;

    // ── 1. Invite ───────────────────────────────────────────────────────────────────────────
    console.log('\n1. A convenor invites someone from another community by their card');
    const notConvenor = await call('POST', ben, `/api/groups/${G}/guests`, { card: await cardOf(gus, 'a.example') });
    assert(notConvenor.status === 403 && notConvenor.body?.code === 'not_convenor', `1a. a member who is no convenor is refused (got ${notConvenor.status} ${notConvenor.body?.code})`);
    const forged = { ...(await cardOf(gus, 'a.example')), home: 'c.example' };
    const badCard = await call('POST', ana, `/api/groups/${G}/guests`, { card: forged });
    assert(badCard.status === 400 && badCard.body?.code === 'bad_card', `1b. a card pointing the key at another home is refused (got ${badCard.status} ${badCard.body?.code})`);
    const memberCard = await call('POST', ana, `/api/groups/${G}/guests`, { card: await cardOf(ben, 'a.example') });
    assert(memberCard.status === 400 && memberCard.body?.code === 'is_member', `1c. a member here is invited as a member, not a guest (got ${memberCard.status} ${memberCard.body?.code})`);
    const inv = await call('POST', ana, `/api/groups/${G}/guests`, { card: await cardOf(gus, 'a.example') });
    await settle();
    const invOut = outsOf('invite').filter((o) => o.body.guests.includes(gus.pk));
    assert(inv.status === 201 && inv.body?.guest?.state === 'invited' && stateOf(G, gus) === 'invited', `1d. Ana invites Gus: invited (got ${inv.status} ${JSON.stringify(inv.body)})`);
    assert(invOut.length === 1 && invOut[0].home === 'a.example' && invOut[0].path === '/api/relay/group' && invOut[0].signed
        && invOut[0].body.group === G && invOut[0].body.host === 'b.example' && JSON.stringify(invOut[0].body.guests) === JSON.stringify([gus.pk])
        && invOut[0].body.data?.name === 'Seed Library' && invOut[0].body.data?.invitedBy?.key === ana.pk,
        `1e. Gus's home is told in one request signed by b.example: the group, its name, who invited (got ${JSON.stringify(invOut.map((o) => o.body))})`);
    const again = await call('POST', ana, `/api/groups/${G}/guests`, { card: await cardOf(gus, 'a.example') });
    assert(again.status === 201 && outsOf('invite').filter((o) => o.body.guests.includes(gus.pk)).length === 1, '1f. inviting him again answers as he is, and tells nobody twice');
    await call('POST', ana, `/api/groups/${G}/guests`, { card: await cardOf(gia, 'a.example') });
    await call('POST', ana, `/api/groups/${G}/guests`, { card: await cardOf(cara, 'c.example') });

    // ── 2. Accept ───────────────────────────────────────────────────────────────────────────
    console.log('\n2. The guest says yes, through their own community\'s server');
    const yes = JSON.stringify({ v: 1, answer: 'yes' });
    const wrongHome = await bring([await item(cara, 'a.example', groupTo, 'group-invite', yes)]);
    assert(wrongHome.status === 202 && wrongHome.body?.items?.[0]?.received === true && stateOf(G, cara) === 'invited',
        `2a. Cara's yes naming a.example (she was invited at c.example): answered as received, nothing changes (got ${JSON.stringify(wrongHome.body)})`);
    const strayYes = await bring([await item(stray, 'a.example', groupTo, 'group-invite', yes)]);
    assert(strayYes.body?.items?.[0]?.received === true && stateOf(G, stray) === null, '2b. a yes from someone never invited: received, no row');
    const before2 = outs.length;
    const gusYes = await bring([await item(gus, 'a.example', groupTo, 'group-invite', yes)]);
    assert(gusYes.status === 202 && gusYes.body?.items?.[0]?.received === true && stateOf(G, gus) === 'in', `2c. Gus's yes: he is in (got ${stateOf(G, gus)})`);
    const roster2 = outs.slice(before2).filter((o) => o.body.kind === 'roster');
    assert(roster2.length === 1 && roster2[0].home === 'a.example' && roster2[0].body.data.guests.some((g: any) => g.key === gus.pk)
        && roster2[0].body.data.members.some((m: any) => m.key === ana.pk && m.name === 'Ana'),
        `2d. the roster goes to his home, once: the names in the chat (got ${JSON.stringify(roster2.map((o) => o.body))})`);
    await bring([await item(gia, 'a.example', groupTo, 'group-invite', yes)]);
    await bring([await item(cara, 'c.example', groupTo, 'group-invite', yes)], 'c.example');
    assert(stateOf(G, gia) === 'in' && stateOf(G, cara) === 'in', '2e. Gia and Cara are in');

    // ── 3. Epochs ───────────────────────────────────────────────────────────────────────────
    console.log('\n3. The key roster holds the guests, and an epoch goes once to each community');
    const keys3 = await call('GET', ana, `/api/groups/${G}/keys`);
    const want = [ana.pk, ben.pk, gus.pk, gia.pk, cara.pk].sort();
    assert(keys3.status === 200 && JSON.stringify(keys3.body?.roster) === JSON.stringify(want), `3a. the roster is the members and the guests in (got ${JSON.stringify(keys3.body?.roster)})`);
    const membersOnly = epochBy(ana, G, 1, 'start', [ana, ben]);
    const refused3 = await call('POST', ana, `/api/groups/${G}/keys/epoch`, { epoch: membersOnly.record });
    assert(refused3.status === 409, `3b. an epoch wrapped to the members alone is refused (got ${refused3.status} ${refused3.body?.code})`);
    const before3 = Date.now();
    const e1 = epochBy(ana, G, 1, 'start', [ana, ben, gus, gia, cara]);
    const stored3 = await call('POST', ana, `/api/groups/${G}/keys/epoch`, { epoch: e1.record });
    await settle();
    const ep3 = outsOf('epoch', before3);
    const aEp = ep3.find((o) => o.home === 'a.example'), cEp = ep3.find((o) => o.home === 'c.example');
    assert(stored3.status === 201 && ep3.length === 2 && !!aEp && !!cEp, `3c. epoch 1 goes in, and out in exactly two requests, one per community (got ${stored3.status}, ${ep3.map((o) => o.home)})`);
    assert(JSON.stringify(aEp?.body.guests) === JSON.stringify([gus.pk, gia.pk].sort()) && aEp?.body.data.wraps.length === 2
        && aEp?.body.data.wraps.every((w: any) => [gus.pk, gia.pk].includes(w.recipient)) && JSON.stringify(cEp?.body.guests) === JSON.stringify([cara.pk])
        && cEp?.body.data.wraps.length === 1 && cEp?.body.data.wraps[0].recipient === cara.pk,
        '3d. each request names that community\'s guests and carries only their wraps');
    let gusKey: Uint8Array | null = null;
    try {
        const rec: GroupEpochRecord = { groupId: G, ...aEp!.body.data.record };
        gusKey = openMyGroupKey(rec, { epoch: 1, ...aEp!.body.data.wraps.find((w: any) => w.recipient === gus.pk), sig: null } as any, gus.seedHex, { groupId: G });
    } catch (e) { console.error(e); }
    assert(!!gusKey && Buffer.from(gusKey).equals(Buffer.from(e1.groupKey)), '3e. Gus opens the epoch key from what his home was sent');

    // ── 4. Lines ────────────────────────────────────────────────────────────────────────────
    console.log('\n4. Lines, a member\'s and a guest\'s');
    const before4 = Date.now();
    const anaId = crypto.randomUUID();
    const anaLine = sealGroupLine('hello guests', { myEdPrivHex: ana.seedHex, groupKey: e1.groupKey, groupId: G, epoch: 1, messageId: anaId });
    const posted = await call('POST', ana, `/api/groups/${G}/chat/message`, { ...anaLine, metadata: { epoch: 1 }, clientId: anaId });
    await settle();
    const lines4 = outsOf('line', before4).filter((o) => o.body.data.id === anaId);
    assert(posted.status === 201 && lines4.length === 2 && lines4.every((o) => o.signed && o.body.data.ciphertext === anaLine.ciphertext),
        `4a. Ana's line goes out once to each community, signed, sealed as it was (got ${posted.status}, ${lines4.map((o) => o.home)})`);
    const gusId = crypto.randomUUID();
    const gusSealed = sealGroupLine('hello from a', { myEdPrivHex: gus.seedHex, groupKey: e1.groupKey, groupId: G, epoch: 1, messageId: gusId });
    const gusPayload = JSON.stringify({ ...gusSealed, metadata: { epoch: 1 }, clientId: gusId });
    const before4b = Date.now();
    const gusLine = await bring([await item(gus, 'a.example', groupTo, 'group-line', gusPayload)]);
    const stored4 = db.prepare('SELECT author_pubkey, ciphertext FROM messages WHERE id = ?').get(gusId) as any;
    const out4 = outsOf('line', before4b).filter((o) => o.body.data.id === gusId);
    assert(gusLine.body?.items?.[0]?.received === true && stored4?.author_pubkey === gus.pk && stored4.ciphertext === gusSealed.ciphertext,
        `4b. Gus's line goes into the chat as his (got ${JSON.stringify(gusLine.body)})`);
    assert(out4.length === 2 && JSON.stringify(out4.find((o) => o.home === 'a.example')?.body.guests) === JSON.stringify([gia.pk])
        && JSON.stringify(out4.find((o) => o.home === 'c.example')?.body.guests) === JSON.stringify([cara.pk]),
        `4c. and out once to each community, naming Gia and Cara, never Gus (got ${JSON.stringify(out4.map((o) => [o.home, o.body.guests]))})`);
    const membersRead = await call('GET', ben, `/api/groups/${G}/chat`);
    assert(membersRead.status === 200 && JSON.stringify(membersRead.body).includes(gusId), '4d. Ben reads Gus\'s line in the chat');
    const count4 = msgCount(G);
    const changedId = crypto.randomUUID();
    const changed = await item(gus, 'a.example', groupTo, 'group-line', JSON.stringify({ ...sealGroupLine('x', { myEdPrivHex: gus.seedHex, groupKey: e1.groupKey, groupId: G, epoch: 1, messageId: changedId }), metadata: { epoch: 1 }, clientId: changedId }));
    const tampered = await bring([{ ...changed, payload: changed.payload.replace('"epoch":1', '"epoch":1 ') }]);
    const forgedSig = await bring([await item(gus, 'a.example', groupTo, 'group-line', changed.payload, { signer: stray })]);
    const otherHome = await bring([await item(gus, 'c.example', groupTo, 'group-line', changed.payload)]);
    assert(tampered.body?.items?.[0]?.refused === 'payload-changed' && forgedSig.body?.items?.[0]?.refused === 'bad-signature'
        && otherHome.body?.items?.[0]?.refused === 'wrong-home' && msgCount(G) === count4,
        `4e. a guest's line with a bad envelope is refused, nothing stored: changed payload, wrong signer, another home (got ${tampered.body?.items?.[0]?.refused}, ${forgedSig.body?.items?.[0]?.refused}, ${otherHome.body?.items?.[0]?.refused})`);
    const strayLine = await bring([await item(stray, 'a.example', groupTo, 'group-line', changed.payload)]);
    assert(strayLine.body?.items?.[0]?.received === true && msgCount(G) === count4, '4f. a line from someone at a.example who is no guest: received, nothing stored');
    const wrongEpochId = crypto.randomUUID();
    const wrongEpoch = await bring([await item(gus, 'a.example', groupTo, 'group-line', JSON.stringify({ ...sealGroupLine('y', { myEdPrivHex: gus.seedHex, groupKey: e1.groupKey, groupId: G, epoch: 1, messageId: wrongEpochId }), metadata: { epoch: 7 }, clientId: wrongEpochId }))]);
    assert(wrongEpoch.body?.items?.[0]?.refused === 'epoch-stale' && msgCount(G) === count4, `4g. Gus's line under an epoch that is not current: epoch-stale, nothing stored (got ${JSON.stringify(wrongEpoch.body)})`);

    // ── 5. Close the class ──────────────────────────────────────────────────────────────────
    console.log('\n5. Every group route x (member, guest, removed guest, visitor)');
    // Hal is a guest who was removed (by hand here; section 6 removes through the route).
    const hal = newId('Hal');
    db.prepare(`INSERT INTO group_guests (group_id, guest_key, home, name, state, invited_by, invited_at, state_at) VALUES (?, ?, 'a.example', 'Hal', 'removed', ?, ?, ?)`)
        .run(G, hal.pk, ana.pk, new Date().toISOString(), new Date().toISOString());
    const lineFor = (who: Id) => { const id = crypto.randomUUID(); return { ...sealGroupLine('z', { myEdPrivHex: who.seedHex, groupKey: e1.groupKey, groupId: G, epoch: 1, messageId: id }), metadata: { epoch: 1 }, clientId: id }; };
    // The answer each outsider gets: refused before anything of the group is read. Most routes ask first whether the caller
    // is an active member (401/403/404, an invite-only group answering 404 as if it did not exist); joining asks first
    // whether the key is a member here at all (400, "Member not found"), and a report checks its form first (400).
    const REFUSED = [401, 403, 404];
    const routes: Array<[string, 'GET' | 'POST' | 'DELETE' | 'PATCH', string, (who: Id) => unknown, number[]?]> = [
        ['the group', 'GET', `/api/groups/${G}`, () => undefined],
        ['its members', 'GET', `/api/groups/${G}/members`, () => undefined],
        ['its invitations', 'GET', `/api/groups/${G}/invitations`, () => undefined],
        ['its chat', 'GET', `/api/groups/${G}/chat`, () => undefined],
        ['its keys', 'GET', `/api/groups/${G}/keys`, () => undefined],
        ['missing wraps', 'GET', `/api/groups/${G}/keys/missing`, () => undefined],
        ['former wraps', 'GET', `/api/groups/${G}/keys/former`, () => undefined],
        ['an epoch\'s wraps', 'GET', `/api/groups/${G}/keys/1/wraps`, () => undefined],
        ['its guests', 'GET', `/api/groups/${G}/guests`, () => undefined],
        ['its succession', 'GET', `/api/groups/${G}/succession`, () => undefined],
        ['a line', 'POST', `/api/groups/${G}/chat/message`, (who) => lineFor(who)],
        ['an epoch', 'POST', `/api/groups/${G}/keys/epoch`, () => ({ epoch: epochBy(ana, G, 2, 'rotate', [ana, ben, gus, gia, cara]).record })],
        ['a wrap', 'POST', `/api/groups/${G}/keys/wrap`, () => ({})],
        ['a report', 'POST', `/api/groups/${G}/chat/report`, () => ({ messageId: anaId, reason: 'spam' }), [400, ...REFUSED]],
        ['a removal of a line', 'POST', `/api/groups/${G}/chat/remove`, () => ({ messageId: anaId })],
        ['an invitation of a guest', 'POST', `/api/groups/${G}/guests`, () => ({ card: null })],
        ['a removal of a guest', 'DELETE', `/api/groups/${G}/guests/${gia.pk}`, () => undefined],
        ['joining', 'POST', `/api/groups/${G}/join`, () => ({}), [400, ...REFUSED]],
        ['a member added', 'POST', `/api/groups/${G}/members`, () => ({ memberPubkey: stray.pk })],
        ['a role changed', 'PATCH', `/api/groups/${G}/members/${ben.pk}`, () => ({ role: 'convenor' })],
        ['a member removed', 'DELETE', `/api/groups/${G}/members/${ben.pk}`, () => undefined],
        ['the lead handed over', 'POST', `/api/groups/${G}/lead`, () => ({ pubkey: ben.pk })],
        ['the group edited', 'PATCH', `/api/groups/${G}`, () => ({ name: 'Taken' })],
        ['a succession proposal', 'POST', `/api/groups/${G}/succession/propose`, () => ({ candidate: ben.pk })],
        ['a post removed', 'DELETE', `/api/groups/${G}/posts/nope`, () => undefined],
    ];
    const snapshot = () => JSON.stringify([
        db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(G),
        db.prepare('SELECT * FROM group_members WHERE group_id = ? ORDER BY member_pubkey').all(G),
        db.prepare('SELECT group_id, guest_key, state FROM group_guests WHERE group_id = ? ORDER BY guest_key').all(G),
        db.prepare('SELECT COUNT(*) AS n FROM group_key_epochs WHERE group_id = ?').get(G),
        db.prepare('SELECT COUNT(*) AS n FROM group_key_wraps WHERE group_id = ?').get(G),
        db.prepare('SELECT name FROM groups WHERE id = ?').get(G),
    ]);
    const outsiders: Array<[string, Id]> = [['guest Gus', gus], ['removed guest Hal', hal], ['visitor Vic', vic]];
    for (const [what, method, p, bodyOf, expected = REFUSED] of routes) {
        // A member (Ben) reaches each GET; nothing below asks what a member's write does, which the group suites own.
        if (method === 'GET') {
            const r = await call('GET', ben, p);
            assert(r.status === 200, `5. member Ben, ${what}: 200 (got ${r.status})`);
        }
        for (const [who, id] of outsiders) {
            const before = snapshot();
            const r = await call(method, id, p, bodyOf(id));
            const body = JSON.stringify(r.body ?? '');
            assert(expected.includes(r.status) && snapshot() === before && !body.includes(anaLine.ciphertext) && !body.includes('Seed Library'),
                `5. ${who}, ${what} (${method}): refused ${r.status}, nothing changed, nothing of the group in the answer`);
        }
    }
    const kinds = new Set(outs.map((o) => o.body?.kind));
    const lineIds = outs.filter((o) => o.body?.kind === 'line').map((o) => o.body.data.id);
    const inChat = lineIds.every((id) => !!db.prepare('SELECT 1 FROM messages WHERE id = ? AND conversation_id = ?').get(id, G));
    assert([...kinds].every((k) => ['invite', 'roster', 'line', 'epoch', 'removed'].includes(k)) && inChat && outs.every((o) => o.signed),
        `5z. what went out is invitations, rosters, lines of this chat, epochs and removals, each signed by b.example (kinds ${[...kinds]})`);

    // ── 6. Remove ───────────────────────────────────────────────────────────────────────────
    console.log('\n6. A convenor removes a guest');
    const byBen = await call('DELETE', ben, `/api/groups/${G}/guests/${gia.pk}`);
    assert(byBen.status === 403 && stateOf(G, gia) === 'in', `6a. a member who is no convenor can't (got ${byBen.status})`);
    const removedAt = Date.now();
    const removed = await call('DELETE', ana, `/api/groups/${G}/guests/${gia.pk}`);
    await settle();
    const told6 = outsOf('removed', removedAt);
    assert(removed.status === 200 && stateOf(G, gia) === 'removed' && told6.length === 1 && told6[0].home === 'a.example'
        && JSON.stringify(told6[0].body.guests) === JSON.stringify([gia.pk]) && told6[0].body.data.why === 'removed',
        `6b. Gia is removed and her home told, naming her alone (got ${removed.status}, ${JSON.stringify(told6.map((o) => o.body))})`);
    const k6 = await call('GET', ana, `/api/groups/${G}/keys`);
    assert(k6.body?.stale === true && !k6.body?.roster.includes(gia.pk), '6c. the epoch is stale and the roster is without her');
    const stillHer = await call('POST', ana, `/api/groups/${G}/keys/epoch`, { epoch: epochBy(ana, G, 2, 'rotate', [ana, ben, gus, gia, cara]).record });
    assert(stillHer.status === 409, `6d. an epoch still wrapped to her is refused (got ${stillHer.status})`);
    const e2 = epochBy(ana, G, 2, 'rotate', [ana, ben, gus, cara]);
    const rot = await call('POST', ana, `/api/groups/${G}/keys/epoch`, { epoch: e2.record });
    const l2id = crypto.randomUUID();
    await call('POST', ana, `/api/groups/${G}/chat/message`, { ...sealGroupLine('after', { myEdPrivHex: ana.seedHex, groupKey: e2.groupKey, groupId: G, epoch: 2, messageId: l2id }), metadata: { epoch: 2 }, clientId: l2id });
    await settle();
    const after6 = outs.filter((o) => o.at >= removedAt && o.body.kind !== 'removed');
    assert(rot.status === 201 && after6.length > 0 && after6.every((o) => !o.body.guests.includes(gia.pk) && !JSON.stringify(o.body.data?.wraps ?? []).includes(gia.pk)),
        `6e. after the next epoch, nothing that goes out names her or carries a wrap for her (${after6.length} requests)`);
    const count6 = msgCount(G);
    const giaId = crypto.randomUUID();
    const giaLine = await bring([await item(gia, 'a.example', groupTo, 'group-line', JSON.stringify({ ...sealGroupLine('still here?', { myEdPrivHex: gia.seedHex, groupKey: e1.groupKey, groupId: G, epoch: 2, messageId: giaId }), metadata: { epoch: 2 }, clientId: giaId }))]);
    assert(giaLine.body?.items?.[0]?.received === true && msgCount(G) === count6, '6f. a line of hers is dropped, answered as received');

    // ── 7. Leave ────────────────────────────────────────────────────────────────────────────
    console.log('\n7. A guest leaves');
    await bring([await item(cara, 'c.example', groupTo, 'group-leave', JSON.stringify({ v: 1 }))], 'c.example');
    const k7 = await call('GET', ana, `/api/groups/${G}/keys`);
    assert(stateOf(G, cara) === 'left' && k7.body?.stale === true && !k7.body?.roster.includes(cara.pk), '7a. Cara leaves: out of the roster, the epoch stale');

    // ── 8. Caps ─────────────────────────────────────────────────────────────────────────────
    console.log('\n8. Caps');
    let lastOk = 0;
    for (let i = 0; i < guests?.GROUP_GUESTS_MAX - 1; i++) {
        const r = await call('POST', ana, `/api/groups/${G}/guests`, { card: await cardOf(newId(`Guest${i}`), 'c.example') });
        if (r.status === 201) lastOk++;
    }
    const over = await call('POST', ana, `/api/groups/${G}/guests`, { card: await cardOf(newId('OneTooMany'), 'c.example') });
    assert(lastOk === 29 && over.status === 409 && over.body?.code === 'guests_full', `8a. Gus and 29 invited make 30; the next is refused (got ${lastOk}, ${over.status} ${over.body?.code})`);
    // Gus has stored 20 MB less 1 KB today (seeded): a photo of his past the guests' day is refused, nothing stored.
    const fakeId = crypto.randomUUID();
    db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata, timestamp) VALUES (?, 'elsewhere', ?, 'x', 'y', 'image', '{}', ?)`)
        .run(fakeId, gus.pk, new Date().toISOString());
    db.prepare('INSERT INTO message_attachments (message_id, data, nonce, mime, bytes) VALUES (?, NULL, ?, ?, ?)').run(fakeId, 'n', 'image/jpeg', (guests?.GUEST_MEDIA_BYTES_DAY ?? 0) - 1024);
    const e3 = epochBy(ana, G, 3, 'rotate', [ana, ben, gus]);
    await call('POST', ana, `/api/groups/${G}/keys/epoch`, { epoch: e3.record });
    const photoId = crypto.randomUUID();
    const sealedPhoto = sealGroupLine(`data:image/jpeg;base64,${crypto.randomBytes(30_000).toString('base64')}`, { myEdPrivHex: gus.seedHex, groupKey: e3.groupKey, groupId: G, epoch: 3, messageId: photoId, part: 'attachment' });
    const words = sealGroupLine('', { myEdPrivHex: gus.seedHex, groupKey: e3.groupKey, groupId: G, epoch: 3, messageId: photoId });
    const count8 = msgCount(G);
    const photo = await bring([await item(gus, 'a.example', groupTo, 'group-line', JSON.stringify({ ...words, metadata: { epoch: 3 }, clientId: photoId, type: 'image', attachment: { data: sealedPhoto.ciphertext, nonce: sealedPhoto.nonce, mime: 'image/jpeg' } }))]);
    assert(photo.body?.items?.[0]?.refused === 'group-refused' && msgCount(G) === count8, `8b. past 20 MB of photos and voice today, Gus's photo is refused (got ${JSON.stringify(photo.body)})`);
    // Within his day, but the disk past the floor every photo keeps: refused too, nothing stored.
    db.prepare('DELETE FROM message_attachments WHERE message_id = ?').run(fakeId);
    setSimulatedFreeDiskBytesForTests(1024);
    const floorId = crypto.randomUUID();
    const floorPhoto = sealGroupLine(`data:image/jpeg;base64,${crypto.randomBytes(30_000).toString('base64')}`, { myEdPrivHex: gus.seedHex, groupKey: e3.groupKey, groupId: G, epoch: 3, messageId: floorId, part: 'attachment' });
    const floorWords = sealGroupLine('', { myEdPrivHex: gus.seedHex, groupKey: e3.groupKey, groupId: G, epoch: 3, messageId: floorId });
    const floor = await bring([await item(gus, 'a.example', groupTo, 'group-line', JSON.stringify({ ...floorWords, metadata: { epoch: 3 }, clientId: floorId, type: 'image', attachment: { data: floorPhoto.ciphertext, nonce: floorPhoto.nonce, mime: 'image/jpeg' } }))]);
    setSimulatedFreeDiskBytesForTests(null);
    assert(floor.body?.items?.[0]?.refused === 'group-refused' && msgCount(G) === count8, `8c. the disk past its floor: Gus's photo is refused, nothing stored (got ${JSON.stringify(floor.body)})`);
    const okId = crypto.randomUUID();
    const okPhoto = sealGroupLine(`data:image/jpeg;base64,${crypto.randomBytes(30_000).toString('base64')}`, { myEdPrivHex: gus.seedHex, groupKey: e3.groupKey, groupId: G, epoch: 3, messageId: okId, part: 'attachment' });
    const okWords = sealGroupLine('', { myEdPrivHex: gus.seedHex, groupKey: e3.groupKey, groupId: G, epoch: 3, messageId: okId });
    const okSent = await bring([await item(gus, 'a.example', groupTo, 'group-line', JSON.stringify({ ...okWords, metadata: { epoch: 3 }, clientId: okId, type: 'image', attachment: { data: okPhoto.ciphertext, nonce: okPhoto.nonce, mime: 'image/jpeg' } }))]);
    assert(okSent.body?.items?.[0]?.received === true && msgCount(G) === count8 + 1 && !!db.prepare('SELECT 1 FROM message_attachments WHERE message_id = ?').get(okId),
        `8d. within his day and the floor, the same kind of photo goes in with its sealed bytes (got ${JSON.stringify(okSent.body)})`);

    // ── 9. The owners' switch ───────────────────────────────────────────────────────────────
    console.log('\n9. The owners switch guests off');
    const info = await (await fetch(`${BASE}/api/community/info`)).json();
    assert(info?.features?.groupGuests === true, `9a. on by default: features say groupGuests (got ${JSON.stringify(info?.features?.groupGuests)})`);
    const offAt = Date.now();
    let offErr: unknown = null;
    try { applyShapeChanges({ actor: olive.pk, actorRole: 'owner' }, { changes: { groupGuests: false } }); } catch (e) { offErr = e; }
    const closed = guests ? guests.closeGuestsIfSwitchedOff() : 0;
    await settle();
    const told9 = outsOf('removed', offAt);
    const anyLeft = (db.prepare("SELECT COUNT(*) AS n FROM group_guests WHERE state IN ('invited', 'in')").get() as { n: number }).n;
    assert(!offErr && closed === 30 && anyLeft === 0 && stateOf(G, gus) === 'removed', `9b. off: every guest invited or in is removed (got ${String(offErr)}, ${closed}, ${anyLeft} left)`);
    assert(told9.length === 2 && told9.every((o) => o.body.data.why === 'closed') && told9.find((o) => o.home === 'a.example')?.body.guests.includes(gus.pk),
        `9c. and their homes are told, one request per community (got ${told9.map((o) => `${o.home}:${o.body.guests.length}`)})`);
    const offInvite = await call('POST', ana, `/api/groups/${G}/guests`, { card: await cardOf(gus, 'a.example') });
    const offInfo = await (await fetch(`${BASE}/api/community/info`)).json();
    assert(offInvite.status === 403 && offInvite.body?.code === 'guests_off' && offInfo?.features?.groupGuests === undefined, `9d. no invitation while it is off (got ${offInvite.status} ${offInvite.body?.code})`);
    applyShapeChanges({ actor: olive.pk, actorRole: 'owner' }, { changes: { groupGuests: true } });

    // ── 10. A home that can't be reached ────────────────────────────────────────────────────
    console.log('\n10. A home that can\'t be reached');
    unreachable = true;
    const dan = newId('Dan');
    await call('POST', ana, `/api/groups/${G}/guests`, { card: await cardOf(dan, 'a.example') });
    await settle();
    const waiting = db.prepare('SELECT * FROM group_guest_outbox WHERE home = ?').all('a.example') as any[];
    assert(waiting.length === 1 && waiting[0].attempts >= 1 && waiting[0].next_try_at > Date.now(), `10a. the invitation waits to be tried again (got ${JSON.stringify(waiting.map((w) => [w.attempts, w.next_try_at - Date.now()]))})`);
    unreachable = false;
    const sent10 = outs.length;
    await guests?.flushGuestOutbox(Date.now() + 10 * 60_000);
    assert(outs.length === sent10 + 1 && outs[outs.length - 1].body.kind === 'invite' && (db.prepare('SELECT COUNT(*) AS n FROM group_guest_outbox').get() as { n: number }).n === 0,
        '10b. tried again once the home answers, then gone');

    // ── 11. A standby, and the route lists ──────────────────────────────────────────────────
    console.log('\n11. A standby copies the guests, never the outbox');
    const gg = (TABLES as any).group_guests, go = (TABLES as any).group_guest_outbox;
    assert(gg?.kind === 'replicated' && gg?.plain === true && go?.kind === 'local', `11a. group_guests is a plain copied table; the outbox is local (got ${gg?.kind}, ${go?.kind})`);
    const { startP2P } = await import('./p2p.js');
    const p2p = await startP2P(0, 0);
    const copy = JSON.stringify(await exportSyncState(p2p.peerId.toString()));
    assert(copy.includes(gus.pk) && copy.includes('group_guests') && !copy.includes('group_guest_outbox'), '11b. a standby\'s whole copy carries the guests\' rows and no outbox');
    const guestView = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'test-guest-view.ts'), 'utf8');
    assert(['GET /api/groups/:id/guests', 'POST /api/groups/:id/guests', 'DELETE /api/groups/:id/guests/:key'].every((r) => guestView.includes(`'${r}'`)),
        '11c. the new routes are in test-guest-view\'s EVERY_ROUTE');

    // ── Round 2 (the deciding review of 6b7cc38a): close each class ─────────────────────────
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (cond: () => boolean, ms = 3000) => {
        const end = Date.now() + ms;
        while (!cond() && Date.now() < end) await sleep(10);
        return cond();
    };
    const lineIn = (who: Id, g: string, key: Uint8Array, epoch: number, extra: Record<string, unknown> = {}) => {
        const id = crypto.randomUUID();
        return { ...sealGroupLine('hi', { myEdPrivHex: who.seedHex, groupKey: key, groupId: g, epoch, messageId: id }), metadata: { epoch, ...extra }, clientId: id };
    };
    const keysOfRoster = (d: any): string[] => [...(d?.members ?? []).map((m: any) => m.key), ...(d?.guests ?? []).map((g: any) => g.key)].sort();

    // ── 12. The roster, at every change of it ───────────────────────────────────────────────
    console.log('\n12. Every change of the names in the chat sends the roster, once to each community with guests in');
    const S = createGroup({ name: 'Tool Shed', joinPolicy: 'open', createdBy: ana.pk }).id;
    const shedTo = `group:${S}`;
    const shedKeys = async () => (await call('GET', ana, `/api/groups/${S}/keys`)).body;
    const homeGuests = (home: string) => db.prepare("SELECT guest_key FROM group_guests WHERE group_id = ? AND home = ? AND state = 'in' ORDER BY guest_key").pluck().all(S, home) as string[];
    const homesIn = () => [...new Set(db.prepare("SELECT home FROM group_guests WHERE group_id = ? AND state = 'in'").pluck().all(S) as string[])].sort();
    const gwen = newId('Gwen'), kit = newId('Kit');     // at a.example
    const cy = newId('Cy'), lu = newId('Lu');           // at c.example
    const ivy = addLocal('Ivy'), max = addLocal('Max'), ned = addLocal('Ned'), hugo = addLocal('Hugo'), jo = addLocal('Jo');
    for (const m of [ivy, max, ned]) await call('POST', m, `/api/groups/${S}/join`, {});
    for (const [g, home] of [[gwen, 'a.example'], [cy, 'c.example'], [lu, 'c.example']] as Array<[Id, 'a.example' | 'c.example']>) {
        await call('POST', ana, `/api/groups/${S}/guests`, { card: await cardOf(g, home) });
        await bring([await item(g, home, shedTo, 'group-invite', yes)], home);
    }
    const s1 = epochBy(ana, S, 1, 'start', [ana, ivy, max, ned, gwen, cy, lu]);
    const s1r = await call('POST', ana, `/api/groups/${S}/keys/epoch`, { epoch: s1.record });
    assert(s1r.status === 201 && JSON.stringify(homesIn()) === JSON.stringify(['a.example', 'c.example']),
        `12a. Tool Shed: four members, guests at two communities, one epoch over them all (got ${s1r.status} ${JSON.stringify(s1r.body)})`);
    // Each kind of roster change once. A member's: joining (with no epoch, and with her own), leaving, removed by a convenor,
    // removed by a vote, deleting their account. A guest's: invited (no change of the names in the chat: the invitation alone
    // goes, and the roster follows their yes, design §4.2 "Joining"), in, left, removed.
    const rosterRows: Array<{ change: string; act: () => Promise<unknown>; names: (d: any) => boolean; invites?: Id }> = [
        { change: 'a member joins (an app that sends no epoch)', act: () => call('POST', hugo, `/api/groups/${S}/join`, {}),
            names: (d) => d.members.some((m: any) => m.key === hugo.pk && m.name === 'Hugo') },
        { change: 'a member joins with her own epoch', act: async () => {
            const k = await shedKeys();
            const e = makeGroupEpochRecord({ myEdPrivHex: jo.seedHex, groupId: S, epoch: k.current + 1, reason: 'join', subject: jo.pk, createdAt: new Date().toISOString(), recipients: [...k.roster, jo.pk] });
            return call('POST', jo, `/api/groups/${S}/join`, { epoch: e.record });
        }, names: (d) => d.members.some((m: any) => m.key === jo.pk && m.name === 'Jo') && d.epoch?.stale === false },
        { change: 'a member leaves', act: () => call('DELETE', hugo, `/api/groups/${S}/members/${hugo.pk}`), names: (d) => !d.members.some((m: any) => m.key === hugo.pk) },
        { change: 'a convenor removes a member', act: () => call('DELETE', ana, `/api/groups/${S}/members/${ivy.pk}`), names: (d) => !d.members.some((m: any) => m.key === ivy.pk) },
        { change: 'a member is removed by a vote', act: async () => db.transaction(() => removeGroupMemberByVote(S, max.pk))(),
            names: (d) => !d.members.some((m: any) => m.key === max.pk) },
        { change: 'a member deletes their account', act: async () => purgeMemberSelf(ned.pk), names: (d) => !d.members.some((m: any) => m.key === ned.pk) },
        { change: 'a guest is invited', act: async () => call('POST', ana, `/api/groups/${S}/guests`, { card: await cardOf(kit, 'a.example') }), names: () => true, invites: kit },
        { change: 'a guest says yes', act: async () => bring([await item(kit, 'a.example', shedTo, 'group-invite', yes)]),
            names: (d) => d.guests.some((g: any) => g.key === kit.pk && g.home === 'a.example' && g.name === 'Kit') },
        { change: 'a guest leaves', act: async () => bring([await item(kit, 'a.example', shedTo, 'group-leave', JSON.stringify({ v: 1 }))]), names: (d) => !d.guests.some((g: any) => g.key === kit.pk) },
        { change: 'a convenor removes a guest', act: () => call('DELETE', ana, `/api/groups/${S}/guests/${lu.pk}`), names: (d) => !d.guests.some((g: any) => g.key === lu.pk) },
    ];
    for (const row of rosterRows) {
        const before = Date.now();
        const res: any = await row.act();
        await settle();
        const rosters = outsOf('roster', before).filter((o) => o.body.group === S);
        const want = row.invites ? [] : homesIn();
        const roster = (await shedKeys()).roster;
        const once = want.every((h) => {
            const to = rosters.filter((o) => o.home === h);
            return to.length === 1 && JSON.stringify(to[0].body.guests) === JSON.stringify(homeGuests(h));
        });
        const right = rosters.every((o) => o.signed && row.names(o.body.data) && JSON.stringify(keysOfRoster(o.body.data)) === JSON.stringify(roster));
        const invited = !row.invites || outsOf('invite', before).filter((o) => o.body.group === S && o.home === 'a.example' && JSON.stringify(o.body.guests) === JSON.stringify([row.invites!.pk])).length === 1;
        const status = res && typeof res === 'object' && 'status' in res ? res.status : 'ok';
        assert(rosters.length === want.length && once && right && invited,
            `12. ${row.change} (${status}): the roster goes once to each community with guests in (${want.join(', ') || 'none'}), naming its guests, with exactly the chat's keys (got ${rosters.map((o) => o.home).join(', ') || 'none'})`);
    }

    // ── 13. Back from epoch-stale ───────────────────────────────────────────────────────────
    console.log('\n13. A guest who hears epoch-stale is sent what they need to get back in');
    const t13 = Date.now();
    const wrong = epochBy(gwen, S, (await shedKeys()).current + 1, 'rotate', [ana, jo, gwen, cy, lu]);
    const r13 = await bring([await item(gwen, 'a.example', shedTo, 'group-epoch', JSON.stringify({ epoch: wrong.record }))]);
    const back13 = outsOf('roster', t13).filter((o) => o.body.group === S);
    const k13 = await shedKeys();
    assert(r13.body?.items?.[0]?.refused === 'epoch-stale' && back13.length === 1 && back13[0].home === 'a.example' && back13[0].signed
        && JSON.stringify(back13[0].body.guests) === JSON.stringify(homeGuests('a.example')) && back13[0].body.data.epoch?.stale === true
        && back13[0].body.data.epoch?.current === k13.current && JSON.stringify(keysOfRoster(back13[0].body.data)) === JSON.stringify(k13.roster),
        `13a. Gwen's epoch over a roster that is gone: epoch-stale, and the roster follows to her home alone, the epoch marked stale (got ${JSON.stringify(r13.body)}, ${back13.map((o) => o.home)})`);
    // From the roster she was sent (a server without the recovery sends none: the GET stands in, so the suite goes on and
    // reports each check rather than stopping here; 13b itself still asks that the roster came).
    const sent13 = back13[0]?.body.data;
    const right13 = makeGroupEpochRecord({ myEdPrivHex: gwen.seedHex, groupId: S, epoch: (sent13?.epoch?.current ?? k13.current) + 1, reason: 'rotate', subject: null,
        createdAt: new Date().toISOString(), recipients: sent13 ? keysOfRoster(sent13) : k13.roster });
    const r13b = await bring([await item(gwen, 'a.example', shedTo, 'group-epoch', JSON.stringify({ epoch: right13.record }))]);
    const k13b = await shedKeys();
    assert(!!sent13 && r13b.body?.items?.[0]?.received === true && k13b.current === right13.record.epoch && k13b.stale === false,
        `13b. the epoch she makes over exactly the keys she was sent goes in (got ${JSON.stringify(r13b.body)}, current ${k13b.current})`);
    // Ana rotates; Gwen's phone missed it and writes under the epoch before.
    const s4 = epochBy(ana, S, k13b.current + 1, 'rotate', [ana, jo, gwen, cy]);
    await call('POST', ana, `/api/groups/${S}/keys/epoch`, { epoch: s4.record });
    await settle();
    const t13c = Date.now();
    const r13c = await bring([await item(gwen, 'a.example', shedTo, 'group-line', JSON.stringify(lineIn(gwen, S, right13.groupKey, right13.record.epoch)))]);
    const back13c = outsOf('roster', t13c).filter((o) => o.body.group === S);
    const ep13 = back13c[0]?.body.data.epoch;
    let opened13: Uint8Array | null = null;
    try {
        opened13 = openMyGroupKey({ groupId: S, ...ep13.record } as GroupEpochRecord, { epoch: ep13.current, ...ep13.wraps.find((w: any) => w.recipient === gwen.pk), sig: null } as any, gwen.seedHex, { groupId: S });
    } catch { /* stays null */ }
    assert(r13c.body?.items?.[0]?.refused === 'epoch-stale' && back13c.length === 1 && back13c[0].home === 'a.example' && ep13?.current === s4.record.epoch && ep13?.stale === false
        && ep13.wraps.length > 0 && ep13.wraps.every((w: any) => homeGuests('a.example').includes(w.recipient)) && !!opened13 && Buffer.from(opened13).equals(Buffer.from(s4.groupKey)),
        `13c. her line under the epoch before: epoch-stale, and the roster follows with the current epoch and her home's wraps only; she opens its key (got ${JSON.stringify(r13c.body)}, ${JSON.stringify(ep13 && { current: ep13.current, stale: ep13.stale, wraps: ep13.wraps?.length })})`);
    const again13 = lineIn(gwen, S, opened13 ?? s4.groupKey, s4.record.epoch);
    const r13d = await bring([await item(gwen, 'a.example', shedTo, 'group-line', JSON.stringify(again13))]);
    assert(r13d.body?.items?.[0]?.received === true && !!db.prepare('SELECT 1 FROM messages WHERE id = ?').get(again13.clientId), '13d. sent again under it, her line goes in');
    // Two items in one request, each with its own time from one reading of the clock.
    const t13e = Date.now();
    const first13e = await item(gwen, 'a.example', shedTo, 'group-line', JSON.stringify(lineIn(gwen, S, right13.groupKey, right13.record.epoch)), { at: t13e - 1000 });
    const second13e = await item(gwen, 'a.example', shedTo, 'group-line', JSON.stringify(lineIn(gwen, S, right13.groupKey, right13.record.epoch)), { at: t13e });
    const r13e = await bring([first13e, second13e]);
    assert(r13e.body?.items?.every((i: any) => i.refused === 'epoch-stale') && outsOf('roster', t13e).filter((o) => o.body.group === S).length === 1,
        `13e. two refused in one request: one roster follows, not two (got ${outsOf('roster', t13e).filter((o) => o.body.group === S).length})`);

    // ── 14. Every notice a guest's action makes names them as a guest, with their community ─
    console.log('\n14. Every notice a guest\'s action can make shows their community, never their card\'s name alone');
    // A guest whose card says the convenor's name (the review's case): "Ana", at a.example.
    const fakeAna = newId('Ana');
    const oz = newId('Oz');
    await call('POST', ana, `/api/groups/${S}/guests`, { card: await cardOf(fakeAna, 'a.example') });
    await bring([await item(fakeAna, 'a.example', shedTo, 'group-invite', yes)]);
    await call('POST', ana, `/api/groups/${S}/guests`, { card: await cardOf(oz, 'c.example') });
    let curEpoch = 0;
    let curKey: Uint8Array = s4.groupKey;
    const lastNotice = () => (db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM push_notices').get() as { n: number }).n;
    const noticeRows: Array<{ kind: string; label: string; who: Id; home: 'a.example' | 'c.example'; act: () => Promise<unknown>; want?: { to: Id; body: string } }> = [
        { kind: 'group-invite', label: 'yes to an invitation', who: oz, home: 'c.example', act: async () => bring([await item(oz, 'c.example', shedTo, 'group-invite', yes)], 'c.example') },
        { kind: 'group-leave', label: 'leaving', who: oz, home: 'c.example', act: async () => bring([await item(oz, 'c.example', shedTo, 'group-leave', JSON.stringify({ v: 1 }))], 'c.example') },
        { kind: 'group-epoch', label: 'epoch', who: fakeAna, home: 'a.example', act: async () => {
            const k = await shedKeys();
            const e = makeGroupEpochRecord({ myEdPrivHex: fakeAna.seedHex, groupId: S, epoch: k.current + 1, reason: 'rotate', subject: null, createdAt: new Date().toISOString(), recipients: k.roster });
            curEpoch = e.record.epoch;
            curKey = e.groupKey;
            return bring([await item(fakeAna, 'a.example', shedTo, 'group-epoch', JSON.stringify({ epoch: e.record }))]);
        } },
        { kind: 'group-line', label: 'line', who: fakeAna, home: 'a.example', want: { to: ana, body: 'Ana · a.example · guest sent a message' },
            act: async () => bring([await item(fakeAna, 'a.example', shedTo, 'group-line', JSON.stringify(lineIn(fakeAna, S, curKey, curEpoch)))]) },
        { kind: 'group-line', label: 'line mentioning a member', who: fakeAna, home: 'a.example', want: { to: jo, body: 'Ana · a.example · guest mentioned you' },
            act: async () => bring([await item(fakeAna, 'a.example', shedTo, 'group-line', JSON.stringify(lineIn(fakeAna, S, curKey, curEpoch, { mentions: [jo.pk] })))]) },
    ];
    for (const row of noticeRows) {
        const from = lastNotice();
        const res: any = await row.act();
        await settle();
        await sleep(30);
        const made = db.prepare('SELECT recipient, title, body FROM push_notices WHERE rowid > ?').all(from) as Array<{ recipient: string; title: string; body: string }>;
        const line = `${row.who.name} · ${row.home} · guest`;
        const bare = made.filter((n) => `${n.title}\n${n.body}`.includes(row.who.name) && !`${n.title}\n${n.body}`.includes(line));
        const wanted = !row.want || made.some((n) => n.recipient === row.want!.to.pk && n.body === row.want!.body);
        assert(res?.body?.items?.[0]?.received === true && bare.length === 0 && wanted,
            `14. a guest's ${row.label}: every notice it makes says "${line}", never "${row.who.name}" alone (${made.length} notice(s): ${made.map((n) => n.body).join(' | ') || 'none'})`);
    }
    const kindsCovered = [...(guests?.GUEST_ITEM_KINDS ?? [])].every((k: string) => noticeRows.some((r) => r.kind === k));
    assert(kindsCovered && noticeRows.some((r) => r.want), '14z. the table covers every kind a guest\'s home brings, and the lines make notices');

    // ── 15. Each home on its own ────────────────────────────────────────────────────────────
    console.log('\n15. One community that doesn\'t answer holds up no other; a row queued during a send goes when it ends');
    let openC: () => void = () => {};
    gates.set('c.example', new Promise<void>((r) => { openC = r; }));
    const pia = newId('Pia');
    const t15 = Date.now();
    await call('POST', ana, `/api/groups/${S}/guests`, { card: await cardOf(pia, 'c.example') });     // c.example's row, the oldest: its send hangs
    await sleep(30);
    const busy = lineIn(ana, S, curKey, curEpoch);
    const posted15 = await call('POST', ana, `/api/groups/${S}/chat/message`, busy);
    const aGot = await waitFor(() => outs.some((o) => o.home === 'a.example' && o.body.kind === 'line' && o.body.data.id === busy.clientId), 2000);
    assert(posted15.status === 201 && aGot && !outs.some((o) => o.home === 'c.example' && o.at >= t15),
        `15a. while c.example doesn't answer, Ana's line reaches a.example at once (got ${posted15.status}, a.example ${aGot})`);
    openC();
    gates.delete('c.example');
    const cGot = await waitFor(() => outs.some((o) => o.home === 'c.example' && o.body.kind === 'line' && o.body.data.id === busy.clientId), 2000);
    assert(cGot && outsOf('invite', t15).some((o) => o.home === 'c.example' && o.body.guests.includes(pia.pk)),
        '15b. once c.example answers, the invitation goes and then the line queued while it hung, with no other flush and no minute tick');
    // Three lines queued for c.example at once while it refuses: one try for the home, not one a row; a.example gets all three.
    const ids15 = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const id of ids15) {
        await call('POST', ana, `/api/groups/${S}/chat/message`, { ...sealGroupLine('x', { myEdPrivHex: ana.seedHex, groupKey: curKey, groupId: S, epoch: curEpoch, messageId: id }), metadata: { epoch: curEpoch }, clientId: id });
    }
    await settle();
    refusing.add('c.example');
    const triesC = tries.get('c.example') ?? 0;
    const t15c = Date.now();
    for (const id of ids15) guests?.fanOutGroupLine(S, id, ana.pk);
    const aAll = await waitFor(() => ids15.every((id) => outs.some((o) => o.home === 'a.example' && o.at >= t15c && o.body.data?.id === id)), 2000);
    await settle();
    const cWaiting = db.prepare('SELECT next_try_at FROM group_guest_outbox WHERE home = ?').pluck().all('c.example') as number[];
    assert(aAll && (tries.get('c.example') ?? 0) - triesC === 1 && cWaiting.length === 3 && cWaiting.every((t) => t > Date.now()),
        `15c. c.example refuses: one try for its three rows, all three wait; a.example has all three (got ${(tries.get('c.example') ?? 0) - triesC} tries, ${cWaiting.length} waiting)`);
    refusing.delete('c.example');
    await guests?.flushGuestOutbox(Date.now() + 10 * 60_000);
    assert(ids15.every((id) => outs.some((o) => o.home === 'c.example' && o.at >= t15c && o.body.data?.id === id))
        && (db.prepare('SELECT COUNT(*) AS n FROM group_guest_outbox WHERE home = ?').get('c.example') as { n: number }).n === 0,
        '15d. when it answers again, all three go, then the outbox is empty');

    // ── 16. Every timer job x (main server, standby) ────────────────────────────────────────
    console.log('\n16. Every timer job of the guests, on a main server and on a standby');
    const httpsSource = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'https-server.ts'), 'utf8');
    const timerJobs = (httpsSource.match(/import \{([^}]*)\} from '\.\/engine\/group-guests\.js'/)?.[1] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    // A line waits for a.example (it refused), guests are in, and then the owners' switch goes off as a standby's copy has it.
    refusing.add('a.example');
    await call('POST', ana, `/api/groups/${S}/chat/message`, lineIn(ana, S, curKey, curEpoch));
    await settle();
    refusing.delete('a.example');
    const offKey = 'nodeProfile.groupGuests';
    const snap16 = () => JSON.stringify([
        db.prepare('SELECT guest_key, state FROM group_guests WHERE group_id = ? ORDER BY guest_key').all(S),
        db.prepare('SELECT epoch, stale_since FROM group_key_epochs WHERE group_id = ? ORDER BY epoch').all(S),
        db.prepare('SELECT id, attempts, next_try_at FROM group_guest_outbox ORDER BY id').all(),
    ]);
    const jobs16: Record<string, () => Promise<number> | number> = {
        closeGuestsIfSwitchedOff: () => guests?.closeGuestsIfSwitchedOff() ?? -1,
        flushGuestOutbox: () => guests?.flushGuestOutbox(Date.now() + 60 * 60_000) ?? -1,
    };
    const waitingA16 = (db.prepare('SELECT COUNT(*) AS n FROM group_guest_outbox WHERE home = ?').get('a.example') as { n: number }).n;
    const inBefore16 = (db.prepare("SELECT COUNT(*) AS n FROM group_guests WHERE group_id = ? AND state IN ('invited', 'in')").get(S) as { n: number }).n;
    setNodeRole('backup');
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(offKey, 'false');
    for (const name of timerJobs) {
        const job = jobs16[name];
        const before = snap16(), sent = outs.length, triesA = tries.get('a.example') ?? 0;
        const r = job ? await job() : -1;
        await sleep(30);
        assert(!!job && r === 0 && snap16() === before && outs.length === sent && (tries.get('a.example') ?? 0) === triesA,
            `16. standby, ${name}: returns at once, writes no copied row, tells no other community (got ${r})`);
    }
    setNodeRole('primary');
    const closed16 = await jobs16.closeGuestsIfSwitchedOff();
    const t16 = Date.now();
    await jobs16.flushGuestOutbox();
    const told16 = outsOf('removed', t16).filter((o) => o.body.group === S);
    assert(waitingA16 >= 1 && inBefore16 > 0 && closed16 >= inBefore16 && told16.length === 2 && told16.every((o) => o.body.data.why === 'closed')
        && (db.prepare('SELECT COUNT(*) AS n FROM group_guest_outbox').get() as { n: number }).n === 0,
        `16. main server, closeGuestsIfSwitchedOff then flushGuestOutbox: the guests go, each home is told once, the waiting line is dropped (got ${closed16}, ${told16.map((o) => o.home)})`);
    assert(timerJobs.length === 2 && timerJobs.every((n) => n in jobs16), `16z. the table covers every job https-server.ts's timer runs from group-guests (${timerJobs.join(', ')})`);
    db.prepare('DELETE FROM node_config WHERE key = ?').run(offKey);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ A guest from another community reads and writes one group\'s chat, through their own server, and nothing else.');
}

main().then(() => process.exit(0)).catch((e) => { console.error('❌ Test failed:', e); process.exit(1); });

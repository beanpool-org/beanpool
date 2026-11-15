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
 *   8  caps: 30 guests invited or in; 20 MB of photos and voice a day per guest
 *   9  the owners' switch: off, no invitation, every guest removed and their home told, nothing from a guest goes in
 *  10  a home that can't be reached: the request waits and is tried again, then goes once taken
 *  11  a standby copies group_guests (a plain table) and never the outbox; the routes are in the guest-view list
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
    const { initStateEngine, seedGenesisMember, createGroup, exportSyncState } = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { resetChatRateLimit } = await import('./chat-rate-limit.js');
    const { registerVisitor } = await import('./engine/members.js');
    const { __useNodeKeyFetchForTests } = await import('./engine/node-signature.js');
    const { __useRelayTransportForTests } = await import('./engine/relay-outbox.js');
    const { applyShapeChanges } = await import('./config/community-shape-write.js');
    const { TABLES } = await import('./engine/replication-manifest.js');
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
    __useRelayTransportForTests(async (url, init) => {
        if (unreachable) throw new Error('connect ECONNREFUSED');
        const u = new URL(url);
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
    async function item(from: Id, fromHome: string, to: string, kind: RelayItemKind, payload: string, opts: { signer?: Id } = {}): Promise<RelayItem> {
        const envelope = await signRelayEnvelope({
            kind, itemId: newItemId(), senderKey: from.pk, senderHome: fromHome, recipient: to, recipientHome: 'b.example',
            at: Date.now(), payloadHash: relayPayloadHash(payload),
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

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ A guest from another community reads and writes one group\'s chat, through their own server, and nothing else.');
}

main().then(() => process.exit(0)).catch((e) => { console.error('❌ Test failed:', e); process.exit(1); });

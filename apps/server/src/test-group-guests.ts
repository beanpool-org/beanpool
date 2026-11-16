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
 *      convenor or a vote, deletes their account, says yes to an invitation, is approved, is voted out of the community
 *      and reinstated; a re-key starts, is cancelled, completes; a guest is invited, says yes, leaves, is removed) -> the
 *      epoch stale or moved on, and the roster once to each community with guests in, naming its guests, with exactly the
 *      chat's keys; what changes no roster says so (an invitation, a request, a pause; a standby queues nothing); 12z: the
 *      table holds every path; the owners' switch is 16
 *  13  back from epoch-stale: a guest's refused epoch or line -> the roster follows to their home alone, with the current
 *      epoch (stale, or its record and their home's wraps); the epoch they make from it goes in, and so does the line they
 *      send again under the key they open from it; two refusals in one request -> one roster; 13f the same items brought
 *      again (their home never heard the answer) -> each hears the refusal it was given, never "received", nothing taken twice;
 *      13g (G2 follow-ups) a yes, a no, a leave taken -> each answered with its counter, the yes's older than the roster that
 *      follows; brought again -> the same counter; a yes from a guest in, a no or a leave from one out -> a new counter
 *      (their roster again after the yes); a yes from a guest out -> none
 *  14  close the class: every kind a guest's home brings x a guest whose card says a member's name -> every notice it makes
 *      says "Ana · a.example · guest", never "Ana" alone
 *  14b what members read of a guest's line (WALK 3 phone): the chat, the Groups list, a report, a removed guest's line
 *  14c close the class (#3275): every author of a group line (a member, a member also on the guest list, a guest in, left,
 *      removed, invited again, a guest of another group, a key nobody knows) x every place this server serves its name (the
 *      chat's read, the Groups list, Home's Groups and chat cards, a report opened, the report queue, the owner's
 *      assistant, the moderators' view of an assistant's suggestion, a convenor's removal) -> a member's name, the guest
 *      line, or that place's own stand-in; and (round 3) a guest whose card's name is 1, 40, 41, 58, 59 or 60 characters,
 *      from a long home, or padded with each kind of character that shows nothing (a right-to-left override among them)
 *      x every one of those places -> the line ends " · <home> · guest", fits 60 unless the home can't, and holds nothing
 *      invisible; a card signed over a padded name is refused, and a phone's own card carries the clean name
 *  15  each home on its own: while one home doesn't answer, another gets its line at once; a row queued during a send goes
 *      when that send ends; a home that refuses costs one try for all its rows, which wait, then go
 *  16  close the class: every timer job https-server.ts runs from group-guests x (standby, main server) -> a standby returns
 *      at once, writes no copied row, tells nobody; the main server removes and tells (removals only, no roster)
 *  17  close the class: (a home that answers / fails / fails then answers) x (rows queued before / during / after the
 *      failure) x (one flush / many) -> the home gets its rows once each in the order queued, and none waits once it answers
 *  18  close the class: every item that crosses (a guest's, a member's change, a report) x where the guest stands
 *  19  close the class, takedowns (#3233 round 2): (author delete, edited then deleted, convenor removal, account deleted,
 *      group closed) x (queued while the home is in backoff, in a send behind a row on the wire, already sent, queued
 *      for a guest who left since) -> no copy of the line's words or photo goes or is kept here, and the tombstone goes
 *      to a guest still in; 19e: (edit while queued, twice, while in a send, after it went) -> only the newest words go;
 *      19c: the copy rule x (stays main, a standby at the takedown then promoted, promoted a day later)
 *  19d close the class, take-aways (#3233 round 4): (author delete, convenor removal, account deleted, guest removed by a
 *      convenor, group closed, a takedown then the group closed, a takedown then the owners' switch off, a takedown while
 *      the switch is off and on again before the minute's timer) x (home down an
 *      hour, 25 hours, MAIL_HELD_DAYS - 1, MAIL_HELD_DAYS and 12 hours, MAIL_HELD_DAYS + 1 and a minute) -> the home
 *      gets every take-away when it comes back while it may still hold what it takes away; the table: each take-away kept
 *      at least MAIL_HELD_DAYS, each row that adds a day; and every row that adds goes unsent once a day old
 *  19f close the class, the send rule (#3233 round 5): every row kind (a line, an edit's new words, a takedown, an epoch, a
 *      roster, an invitation, a removal) x every change after it was queued, written as the server that took over writes it
 *      (none, line removed, line edited, guest removed, guest re-invited and in, guest re-invited not yet in, guest left,
 *      group closed, take-over, take-back, home blocked) x its age (fresh, a day, MAIL_HELD_DAYS, MAIL_HELD_DAYS and a day) -> it goes (naming only
 *      the guests it may still name, a line with its words now) or goes unsent; rows naming two guests go narrowed; the
 *      guard reads the kinds from the code (the send rule's list, the outbox's CHECK, every queueToHome) against the table
 *  20  the order rule (G2): 20a the next counter; 20b an invitation, the roster, a takedown and a removal carry it, rising,
 *      a line and an epoch none; 20c telling homes again: (the server that took over issued counters, a promoted standby,
 *      nothing changed) x (an invitation waiting, removals and takedowns 2 and 32 days old, the roster) -> told again within
 *      the time a home may hold what they drop, once; 20d a take-over and take-back end to end: the removal as queued, then
 *      the invitation under a counter past both; 20e an account with 5,000 lines: one request per 500, inside a time budget
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
    NODE_KEY_VALIDITY_MS, NODE_REQUEST_HEADER, addressCardDigest, buildNodeRequestHeaders, dmPublicKeyOf, groupMessageKey, makeGroupEpochRecord, nodeRequestSignatureVerifies,
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
    const { initStateEngine, seedGenesisMember, createGroup, exportSyncState, removeGroupMemberByVote, purgeMemberSelf, setUserStatusRow, adminPruneUser, closeGroupByVote, COMMUNITY_DECISION_ACTOR } = await import('./state-engine.js');
    const { issueRekeyCode, cancelRekeyCode, completeRekey } = await import('./engine/member-wizards.js');
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
    /** A guest's item, signed. A line goes under its own id (its payload's clientId), as the host stores it (takeGuestItem). */
    async function item(from: Id, fromHome: string, to: string, kind: RelayItemKind, payload: string, opts: { signer?: Id; at?: number; itemId?: string } = {}): Promise<RelayItem> {
        let lineId: unknown;
        try { lineId = (JSON.parse(payload) as { clientId?: unknown }).clientId; } catch { lineId = undefined; }
        const envelope = await signRelayEnvelope({
            kind, itemId: opts.itemId ?? (typeof lineId === 'string' ? lineId : newItemId()), senderKey: from.pk, senderHome: fromHome, recipient: to, recipientHome: 'b.example',
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
    const quin = addLocal('Quin'), quin2 = newId('Quin'), ula = addLocal('Ula');
    let rekeyCode = '';
    const rosterRows: Array<{ change: string; act: () => Promise<unknown>; names: (d: any) => boolean; invites?: Id; none?: string; standby?: true }> = [
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
        // A request to join, while the group asks for one, and a convenor's approval of it (the policy is put back after).
        { change: 'a member asks to join (no key joins until a convenor approves)', none: 'a request is no key in the chat',
            act: async () => {
                db.prepare("UPDATE groups SET join_policy = 'request_to_join', updated_at = ? WHERE id = ?").run(new Date().toISOString(), S);
                return call('POST', ula, `/api/groups/${S}/join`, {});
            }, names: () => true },
        { change: 'a convenor approves the request', act: async () => {
            const r = await call('POST', ana, `/api/groups/${S}/members`, { targetPubkey: ula.pk, action: 'approve' });
            db.prepare("UPDATE groups SET join_policy = 'open', updated_at = ? WHERE id = ?").run(new Date().toISOString(), S);
            return r;
        }, names: (d) => d.members.some((m: any) => m.key === ula.pk && m.name === 'Ula') },
        { change: 'the approved member leaves', act: () => call('DELETE', ula, `/api/groups/${S}/members/${ula.pk}`), names: (d) => !d.members.some((m: any) => m.key === ula.pk) },
        // A member's key through a re-key, a pause, a removal from the community and a reinstate vote (Quin; Quin2 is the key
        // the re-key moves him to). Quin convenes a group of his own with a guest he invited, for the re-key's move of it.
        { change: 'a convenor invites a member (no key joins until they say yes)', none: 'an invited row is no key in the chat',
            act: () => call('POST', ana, `/api/groups/${S}/members`, { targetPubkey: quin.pk }), names: () => true },
        { change: 'the member says yes to the invitation', act: () => call('POST', quin, `/api/groups/${S}/join`, {}),
            names: (d) => d.members.some((m: any) => m.key === quin.pk && m.name === 'Quin') },
        { change: 'a re-key starts (the old key is held)', act: async () => issueRekeyCode(quin.pk, olive.pk),
            names: (d) => !d.members.some((m: any) => m.key === quin.pk) },
        { change: 'the re-key is cancelled (the old key is back)', act: async () => cancelRekeyCode(quin.pk, olive.pk),
            names: (d) => d.members.some((m: any) => m.key === quin.pk) },
        { change: 'a re-key starts again', act: async () => { rekeyCode = issueRekeyCode(quin.pk, olive.pk).code; },
            names: (d) => !d.members.some((m: any) => m.key === quin.pk) },
        { change: 'the re-key completes (the new key joins)', act: async () => completeRekey(quin.pk, quin2.pk, rekeyCode, olive.pk),
            names: (d) => d.members.some((m: any) => m.key === quin2.pk && m.name === 'Quin') && !d.members.some((m: any) => m.key === quin.pk) },
        { change: 'an admin pauses the member', none: "a pause keeps every membership and the key (isNodeMember holds while it lasts)",
            act: async () => setUserStatusRow(quin2.pk, 'disabled'), names: () => true },
        { change: 'the pause is lifted', none: 'the key never left', act: async () => setUserStatusRow(quin2.pk, 'active'), names: () => true },
        { change: 'the community votes the member out (removed from the community)', act: async () => adminPruneUser(quin2.pk, COMMUNITY_DECISION_ACTOR),
            names: (d) => !d.members.some((m: any) => m.key === quin2.pk) },
        { change: 'a vote reinstates them (their group rows stayed)', act: async () => setUserStatusRow(quin2.pk, 'active'),
            names: (d) => d.members.some((m: any) => m.key === quin2.pk) },
        { change: 'a standby makes a change (its copy came from the main server, which sent the roster)', standby: true,
            none: 'a standby never queues: its copy came from the main server, which sends it, and its rows would go out stale after a promotion',
            act: async () => {
                setNodeRole('backup');
                try { db.transaction(() => removeGroupMemberByVote(S, quin2.pk))(); } finally { setNodeRole('primary'); }
            }, names: () => true },
    ];
    const quinGroup = createGroup({ name: 'Repair Cafe', joinPolicy: 'open', createdBy: quin.pk }).id;
    const tam = newId('Tam');
    const tamInvited = await call('POST', quin, `/api/groups/${quinGroup}/guests`, { card: await cardOf(tam, 'c.example') });
    for (const row of rosterRows) {
        const before = Date.now();
        const k0 = await shedKeys();
        const res: any = await row.act();
        await settle();
        const rosters = outsOf('roster', before).filter((o) => o.body.group === S);
        const want = row.invites || row.none ? [] : homesIn();
        const k1 = await shedKeys();
        const roster = k1.roster;
        const once = want.every((h) => {
            const to = rosters.filter((o) => o.home === h);
            return to.length === 1 && JSON.stringify(to[0].body.guests) === JSON.stringify(homeGuests(h));
        });
        const right = rosters.every((o) => o.signed && row.names(o.body.data) && JSON.stringify(keysOfRoster(o.body.data)) === JSON.stringify(roster));
        const invited = !row.invites || outsOf('invite', before).filter((o) => o.body.group === S && o.home === 'a.example' && JSON.stringify(o.body.guests) === JSON.stringify([row.invites!.pk])).length === 1;
        // A change of the roster leaves the chat's epoch stale, or stores a new one over it; a row that changes nothing
        // leaves the roster as it was.
        const epochHeld = (row.invites || row.none) && !row.standby
            ? JSON.stringify(k1.roster) === JSON.stringify(k0.roster)
            : JSON.stringify(k1.roster) !== JSON.stringify(k0.roster) && (k1.stale === true || k1.current > k0.current);
        const status = res && typeof res === 'object' && 'status' in res ? res.status : 'ok';
        assert(rosters.length === want.length && once && right && invited && epochHeld,
            `12. ${row.change} (${status}): ${row.none ? `no roster (${row.none})` : row.invites ? 'only the invitation' : `the epoch goes stale or moves on, and the roster goes once to each community with guests in (${want.join(', ')}), naming its guests, with exactly the chat's keys`} (got ${rosters.map((o) => o.home).join(', ') || 'none'}; stale ${k0.stale}→${k1.stale}, epoch ${k0.current}→${k1.current})`);
    }
    // The re-key moved what Quin convenes too: the guest he invited is invited by his new key.
    const tamBy = (db.prepare('SELECT invited_by FROM group_guests WHERE group_id = ? AND guest_key = ?').get(quinGroup, tam.pk) as { invited_by: string } | undefined)?.invited_by;
    assert(tamInvited.status === 201 && tamBy === quin2.pk, `12y. after Quin's re-key, the guest he invited is invited by his new key (got ${tamInvited.status}, ${tamBy === quin.pk ? 'the old key' : tamBy === quin2.pk ? 'the new key' : String(tamBy)})`);
    // Every way the chat's key roster can change has its row: here, or the switch's own section (16).
    const rosterPaths: Record<string, string> = {
        'member joins': 'a member joins (an app that sends no epoch)', 'member joins with an epoch': 'a member joins with her own epoch',
        'member invited, then yes': 'the member says yes to the invitation', 'member leaves': 'a member leaves',
        'member asks to join': 'a member asks to join (no key joins until a convenor approves)', 'request approved': 'a convenor approves the request',
        'member removed by a convenor': 'a convenor removes a member', 'member removed by a vote': 'a member is removed by a vote',
        'account deleted': 'a member deletes their account', 'account paused': 'an admin pauses the member', 'pause lifted': 'the pause is lifted',
        'removed from the community (prune)': 'the community votes the member out (removed from the community)', 'reinstated': 'a vote reinstates them (their group rows stayed)',
        're-key starts': 'a re-key starts (the old key is held)', 're-key cancelled': 'the re-key is cancelled (the old key is back)',
        're-key completes': 'the re-key completes (the new key joins)', 'guest invited': 'a guest is invited', 'guest in': 'a guest says yes',
        'guest leaves': 'a guest leaves', 'guest removed': 'a convenor removes a guest',
        'a standby copy': 'a standby makes a change (its copy came from the main server, which sent the roster)',
    };
    const rowNames = new Set(rosterRows.map((r) => r.change));
    const missing = Object.entries(rosterPaths).filter(([, row]) => !rowNames.has(row)).map(([p]) => p);
    assert(missing.length === 0, `12z. every way the chat's key roster changes has its row; the owners' switch off is section 16 (missing: ${missing.join(', ') || 'none'})`);

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
    const item13d = await item(gwen, 'a.example', shedTo, 'group-line', JSON.stringify(again13));
    const r13d = await bring([item13d]);
    assert(r13d.body?.items?.[0]?.received === true && !!db.prepare('SELECT 1 FROM messages WHERE id = ?').get(again13.clientId), '13d. sent again under it, her line goes in');
    // Two items in one request, each with its own time from one reading of the clock.
    const t13e = Date.now();
    const first13e = await item(gwen, 'a.example', shedTo, 'group-line', JSON.stringify(lineIn(gwen, S, right13.groupKey, right13.record.epoch)), { at: t13e - 1000 });
    const second13e = await item(gwen, 'a.example', shedTo, 'group-line', JSON.stringify(lineIn(gwen, S, right13.groupKey, right13.record.epoch)), { at: t13e });
    const r13e = await bring([first13e, second13e]);
    assert(r13e.body?.items?.every((i: any) => i.refused === 'epoch-stale') && outsOf('roster', t13e).filter((o) => o.body.group === S).length === 1,
        `13e. two refused in one request: one roster follows, not two (got ${outsOf('roster', t13e).filter((o) => o.body.group === S).length})`);
    // Her home never heard those answers and brings the same items again (G2 round 2, #3246 round 2 note: a home settles a
    // received item `sent`, so a refused epoch would read as taken): each hears the refusal it was given, the line taken
    // before still hears received, nothing is taken twice, and no second roster follows.
    const t13f = Date.now();
    const msgs13f = (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(S) as { n: number }).n;
    const r13f = await bring([first13e, second13e, item13d]);
    const msgsAfter13f = (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(S) as { n: number }).n;
    const got13f = (r13f.body?.items ?? []).map((i: any) => i.refused ?? (i.received ? 'received' : '?')).join(', ');
    assert(r13f.status === 202 && got13f === 'epoch-stale, epoch-stale, received' && msgsAfter13f === msgs13f && outsOf('roster', t13f).filter((o) => o.body.group === S).length === 0,
        `13f. the same items brought again: each hears what it heard the first time (epoch-stale, epoch-stale, received; got ${got13f}), nothing taken twice (${msgs13f} -> ${msgsAfter13f}), no roster follows`);
    // 13g. THE GUEST'S OWN WORD (G2 follow-ups, the order rule): a yes, a no and a leave that move where the guest stands are
    // answered with the group's counter each was stamped with, newer than every counter before it and older than the
    // roster that follows (so their home orders an invitation told again before the yes as older, and keeps the roster);
    // the same item brought again hears the same counter (relay_mail_answered), never a bare "received"; one that agrees
    // with where they stand already confirms it under a new counter, and a yes from a guest out carries none (round 2).
    {
        const P = createGroup({ name: 'Plot 7', joinPolicy: 'open', createdBy: ana.pk }).id;
        const plotTo = `group:${P}`;
        const [yesG, noG, leaveG] = [newId('Yuri'), newId('Nell'), newId('Lev')];
        for (const g of [yesG, noG, leaveG]) await call('POST', ana, `/api/groups/${P}/guests`, { card: await cardOf(g, 'a.example') });
        await settle();
        const clock = () => db.prepare('SELECT seq FROM group_guest_clock WHERE group_id = ?').pluck().get(P) as number | undefined;
        const seqOf = (r: Res) => r.body?.items?.[0]?.seq as unknown;
        const before = clock() ?? 0;
        const t13g = Date.now();
        const yesItem = await item(yesG, 'a.example', plotTo, 'group-invite', yes);
        const rYes = await bring([yesItem]);
        const rosterSeq = outsOf('roster', t13g).filter((o) => o.body.group === P).map((o) => o.body.seq as number);
        const rNo = await bring([await item(noG, 'a.example', plotTo, 'group-invite', JSON.stringify({ v: 1, answer: 'no' }))]);
        await bring([await item(leaveG, 'a.example', plotTo, 'group-invite', yes)]);
        const rLeave = await bring([await item(leaveG, 'a.example', plotTo, 'group-leave', JSON.stringify({ v: 1 }))]);
        const rAgain = await bring([yesItem]);
        const t13gConfirm = Date.now();
        const rSecondYes = await bring([await item(yesG, 'a.example', plotTo, 'group-invite', yes)]);
        const rosterAgain = outsOf('roster', t13gConfirm).filter((o) => o.body.group === P).map((o) => o.body.seq as number);
        const rNoAgain = await bring([await item(noG, 'a.example', plotTo, 'group-invite', JSON.stringify({ v: 1, answer: 'no' }))]);
        const rLeaveAgain = await bring([await item(leaveG, 'a.example', plotTo, 'group-leave', JSON.stringify({ v: 1 }))]);
        const rYesOut = await bring([await item(noG, 'a.example', plotTo, 'group-invite', yes)]);
        const sYes = seqOf(rYes), sNo = seqOf(rNo), sLeave = seqOf(rLeave);
        const ints = [sYes, sNo, sLeave].every((s) => typeof s === 'number' && Number.isSafeInteger(s));
        assert(ints && rYes.body.items[0].received === true && (sYes as number) > before && rosterSeq.length === 1 && rosterSeq[0] > (sYes as number)
            && (sNo as number) > (sYes as number) && (sLeave as number) > (sNo as number) && stateOf(P, yesG) === 'in' && stateOf(P, noG) === 'left' && stateOf(P, leaveG) === 'left',
            `13g. a yes, a no and a leave taken: each answered received with its counter, newer than the one before (${before} < ${sYes} < ${sNo} < ${sLeave}), the yes's older than the roster that follows (${JSON.stringify(rosterSeq)}); standing in, left, left (got ${stateOf(P, yesG)}, ${stateOf(P, noG)}, ${stateOf(P, leaveG)})`);
        assert(rAgain.status === 202 && rAgain.body?.items?.[0]?.received === true && seqOf(rAgain) === sYes,
            `13g. the yes brought again (its answer lost): the same counter (${sYes}; got ${JSON.stringify(rAgain.body?.items?.[0])})`);
        // Round 2 (#3266): a word that agrees with where they stand confirms it under the next counter, so their home (one
        // whose own take-over lost the first answer) ends where they stand; the yes from a guest in sends their roster
        // again, newer than it. A yes from a guest out says nothing of where they stand: no counter.
        const sSecond = seqOf(rSecondYes), sNoAgain = seqOf(rNoAgain), sLeaveAgain = seqOf(rLeaveAgain);
        assert(rSecondYes.status === 202 && rSecondYes.body?.items?.[0]?.received === true && typeof sSecond === 'number' && sSecond > (sLeave as number)
            && rosterAgain.length === 1 && rosterAgain[0] > sSecond && stateOf(P, yesG) === 'in',
            `13g. a second yes from a guest in already confirms it: received with a new counter (${sLeave} < ${JSON.stringify(sSecond)}), their roster again after it (${JSON.stringify(rosterAgain)}), still in (got ${stateOf(P, yesG)})`);
        assert(typeof sNoAgain === 'number' && sNoAgain > (sSecond as number) && typeof sLeaveAgain === 'number' && sLeaveAgain > sNoAgain
            && stateOf(P, noG) === 'left' && stateOf(P, leaveG) === 'left'
            && rYesOut.status === 202 && rYesOut.body?.items?.[0]?.received === true && seqOf(rYesOut) === undefined && stateOf(P, noG) === 'left',
            `13g. a no and a leave from guests who left confirm it with a new counter each (${JSON.stringify(sNoAgain)}, ${JSON.stringify(sLeaveAgain)}); a yes from one who left moves nothing and carries none (got ${JSON.stringify(rYesOut.body?.items?.[0])}); still left, left`);
    }

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

    // ── 14b. What members read of a guest's line ────────────────────────────────────────────
    // WALK 3 phone (17 Nov 2026): a guest's line was served under the first 8 characters of their key, so the members'
    // Groups list read "2b3be71a: 🔒 Message", and once the guest left or was removed the chat named their lines
    // "2b3be71a · no longer in this group" (a phone names a signer outside its roster by the name the node serves).
    console.log('\n14b. Every place a guest\'s line is served to members names it by the guest line, while they are in and after they go');
    const { groupLineAuthorName } = await import('./engine/group-thread.js');
    const { openReportedGroupLine } = await import('./engine/group-chat-report.js');
    // The member Ana writes first, then the guest whose card says "Ana": the guest's line is the chat's last.
    const anaPosted14b = await call('POST', ana, `/api/groups/${S}/chat/message`, lineIn(ana, S, curKey, curEpoch));
    const fakeLine = lineIn(fakeAna, S, curKey, curEpoch);
    await bring([await item(fakeAna, 'a.example', shedTo, 'group-line', JSON.stringify(fakeLine))]);
    await settle();
    const fakeName = 'Ana · a.example · guest';
    const chat14b = await call('GET', jo, `/api/groups/${S}/chat`);
    const fakeLines = ((chat14b.body?.messages ?? []) as any[]).filter((m) => m.authorPubkey === fakeAna.pk);
    assert(chat14b.status === 200 && fakeLines.length >= 3 && fakeLines.every((m) => m.authorCallsign === fakeName),
        `14b-1. the chat as a member reads it: every line of the guest whose card says "Ana" is "${fakeName}" (got ${chat14b.status}, ${JSON.stringify(fakeLines.map((m) => m.authorCallsign))})`);
    const memberLines = ((chat14b.body?.messages ?? []) as any[]).filter((m) => m.authorPubkey === ana.pk);
    assert(anaPosted14b.status === 201 && memberLines.length > 0 && memberLines.every((m) => m.authorCallsign === 'Ana'),
        `14b-2. and the member Ana's own lines stay "Ana" (got ${anaPosted14b.status}, ${JSON.stringify(memberLines.map((m) => m.authorCallsign))})`);
    const yours14b = await call('GET', jo, '/api/your-groups');
    const shedRow = ((yours14b.body?.items ?? []) as any[]).find((i) => i.conversationId === S || i.id === S);
    assert(shedRow?.lastMessage?.id === fakeLine.clientId && shedRow.lastMessage.authorCallsign === fakeName,
        `14b-3. the members' Groups list: the chat's last line is "${fakeName}"'s, never a short key (got ${JSON.stringify({ id: shedRow?.lastMessage?.id === fakeLine.clientId, who: shedRow?.lastMessage?.authorCallsign })})`);
    const mk14b = Buffer.from(groupMessageKey(curKey, fakeLine.clientId)).toString('base64');
    const filed14b = await call('POST', jo, `/api/groups/${S}/chat/report`, { messageId: fakeLine.clientId, reason: 'Spam or scam', disclosure: { epoch: curEpoch, mk: mk14b } });
    await settle();
    const report14b = db.prepare('SELECT id FROM abuse_reports WHERE reporter_pubkey = ? AND target_message_id = ?').get(jo.pk, fakeLine.clientId) as { id: string } | undefined;
    const seen14b = report14b ? await openReportedGroupLine(report14b.id) : null;
    assert(filed14b.status === 200 && seen14b?.authorCallsign === fakeName,
        `14b-4. the line as the moderators open a report of it: "${fakeName}" (got ${filed14b.status}, ${JSON.stringify(seen14b?.authorCallsign)})`);
    // After they go: Gus (a.example) wrote in the first group in 4b, and the owners' switch removed him in 9b.
    const gusRead = await call('GET', ana, `/api/groups/${G}/chat`);
    const gusServed = ((gusRead.body?.messages ?? []) as any[]).find((m) => m.id === gusId);
    assert(stateOf(G, gus) === 'removed' && gusServed?.authorCallsign === 'Gus · a.example · guest',
        `14b-5. a removed guest's line keeps their guest line, so a phone shows "Gus · a.example · guest · no longer in this group", never a short key (got ${stateOf(G, gus)}, ${JSON.stringify(gusServed?.authorCallsign)})`);
    // Every way the name is asked for, one rule: a member by their name; a guest of this group in any state by the guest
    // line; a stranger, the system, or a guest of another group: none (the reader shows a short key).
    const nameRows: Array<[string, string, string, string | null, string | null]> = [
        ['a member', S, ana.pk, 'Ana', 'Ana'],
        ['a guest in', S, fakeAna.pk, null, fakeName],
        ['a guest who left', S, oz.pk, null, 'Oz · c.example · guest'],
        ['a removed guest', G, gus.pk, null, 'Gus · a.example · guest'],
        ['a member key that is also a guest elsewhere: the member name wins', S, fakeAna.pk, 'Ana (member)', 'Ana (member)'],
        ['a guest of another group', S, gus.pk, null, null],
        ['a stranger', S, stray.pk, null, null],
        ['the system', S, 'SYSTEM', null, null],
    ];
    const nameMisses = nameRows.filter(([, g, k, member, want]) => groupLineAuthorName(g, k, member) !== want).map(([label]) => label);
    assert(stateOf(S, oz) === 'left' && nameMisses.length === 0, `14b-6. groupLineAuthorName, one rule for every caller (misses: ${nameMisses.join(', ') || 'none'})`);

    // ── 14c. Close the class: every author of a group line x every place this server serves its name ──
    // #3275 round 2: a member by their name; a guest of the group in any state by core's guest line; anyone else by no
    // name, and each place's own stand-in (a short key, "@" and a short key, or none). One table: each author's line is the
    // chat's newest when it is read (the Groups list and Home's Groups card carry only that one), and a convenor's removal
    // of it goes last, as it ends the line. The push and the bell for a guest's new line are 14's rows 'line' and 'line
    // mentioning a member'; a line from a guest who is not in is refused before it is stored (4, 6, 7).
    console.log('\n14c. Close the class: every author of a group line x every place this server serves its name');
    const { ensureGroupThread, syncGroupThreadMembership } = await import('./engine/group-thread.js');
    const { ownerTokenHeaders } = await import('./admin-auth-test-harness.js');
    const { AGENT_TOOLS } = await import('./agent/tools.js');
    const K = createGroup({ name: 'Bike Kitchen', joinPolicy: 'open', createdBy: ana.pk }).id;
    const mo = addLocal('Mo');
    for (const who of [jo, ben, mo]) {
        db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status, from_epoch) VALUES (?, ?, 'member', 'active', 1)`).run(K, who.pk);
    }
    ensureGroupThread(K);
    for (const who of [ana, jo, ben, mo]) syncGroupThreadMembership(K, who.pk);
    const at14c = new Date().toISOString();
    const listGuest14c = (who: Id, home: string, state: 'invited' | 'in' | 'left' | 'removed', name = who.name) => db.prepare(
        `INSERT INTO group_guests (group_id, guest_key, home, name, state, invited_by, invited_at, state_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(K, who.pk, home, name, state, ana.pk, at14c, at14c);
    const inAna = newId('Ana'), una = newId('Una'), ro = newId('Ro'), ed = newId('Ed'), nobody = newId('Nobody');
    listGuest14c(inAna, 'a.example', 'in');
    listGuest14c(una, 'c.example', 'left');
    listGuest14c(ro, 'a.example', 'removed');
    listGuest14c(ed, 'c.example', 'invited');   // in once, left, and invited again: the lines from when they were in stay
    listGuest14c(mo, 'a.example', 'left', 'Ana');   // a member here on this group's guest list whose card said "Ana"
    const authors14c: Array<{ who: string; key: string; name: string | null }> = [
        { who: 'a member', key: ben.pk, name: 'Ben' },
        { who: 'a member who is also on the group\'s guest list (their name here wins)', key: mo.pk, name: 'Mo' },
        { who: 'a guest in, whose card says a member\'s name', key: inAna.pk, name: 'Ana · a.example · guest' },
        { who: 'a guest who left', key: una.pk, name: 'Una · c.example · guest' },
        { who: 'a removed guest', key: ro.pk, name: 'Ro · a.example · guest' },
        { who: 'a guest invited again', key: ed.pk, name: 'Ed · c.example · guest' },
        { who: 'a guest of another group', key: gus.pk, name: null },
        { who: 'a key nobody here knows', key: nobody.pk, name: null },
    ];
    // #3275 round 3: a guest's card name x its length x each kind of character that shows nothing. Core makes the line under
    // NAME_LINE_CHARS (60) by cutting the card's name alone, so " · <home> · guest" stays whole wherever the line goes (Home's
    // Groups and chat cards cut a 60-character card name's line at 60, and the moderators' view too, so the guest read as a
    // bare name), and nothing invisible is served ("Ana" padded with zero-width spaces showed "Ana…" beside the member Ana).
    // A name written straight into group_guests stands for one stored however it came; the invite route refuses a card
    // signed over a name that isn't in its clean form, and a phone's own card (core signAddressCard) carries the clean one:
    // both are checked on each padded row. These guests have left, so no change of a line goes to their homes.
    const NAME60 = 'Wren Tallowmere of the Long Valley Seedbank Library and Mill Coop';
    const LONG_HOME = 'the-long-name-of-a-community-garden-and-its-shed.green.hills.example:8443';
    const lineFor14c = (clean: string, home: string): string => {
        const tail = ` · ${home} · guest`, room = Math.max(2, 60 - [...tail].length), chars = [...clean];
        return `${chars.length <= room ? clean : `${chars.slice(0, room - 1).join('').trimEnd()}…`}${tail}`;
    };
    const padded14c: Array<[string, string]> = [
        ['zero-width spaces (U+200B)', '​'], ['zero-width non-joiners (U+200C)', '‌'], ['zero-width joiners (U+200D)', '‍'],
        ['left-to-right marks (U+200E)', '‎'], ['right-to-left marks (U+200F)', '‏'], ['Arabic letter marks (U+061C)', '؜'],
        ['direction embeddings and overrides (U+202A to U+202E)', '‪‫‬‭‮'],
        ['direction isolates (U+2066 to U+2069)', '⁦⁧⁨⁩'],
        ['word joiners and invisible operators (U+2060 to U+2064)', '⁠⁡⁢⁣⁤'], ['byte-order marks (U+FEFF)', '﻿'],
        ['soft hyphens (U+00AD)', '­'], ['Mongolian vowel separators (U+180E)', '᠎'], ['tag characters (U+E0041, U+E007F)', '\u{E0041}\u{E007F}'],
        ['interlinear annotation marks (U+FFF9 to U+FFFB)', '￹￺￻'], ['combining grapheme joiners (U+034F)', '͏'],
        ['Hangul fillers (U+115F, U+1160, U+3164, U+FFA0)', 'ᅟᅠㅤﾠ'],
    ];
    const names14c: Array<{ what: string; card: string; clean: string; home?: string }> = [
        ...[1, 40, 41, 58, 59, 60].map((n) => ({ what: `${n} characters long`, card: NAME60.slice(0, n), clean: NAME60.slice(0, n) })),
        { what: '60 characters long, from a long home (the line runs past 60: the name is cut to "W…", never the home or "guest")',
            card: NAME60.slice(0, 60), clean: NAME60.slice(0, 60), home: LONG_HOME },
        ...padded14c.map(([what, c]) => ({ what: `"Ana" padded past 59 characters with ${what}`, card: `Ana${c.repeat(Math.ceil(56 / [...c].length))}`, clean: 'Ana' })),
        { what: '"Ana" inside a right-to-left override', card: '‮Ana‬', clean: 'Ana' },
        { what: 'a right-to-left override that shows "anA" as "Ana"', card: '‮anA', clean: 'anA' },
        { what: 'invisible characters before, between and after its letters', card: '​A‍n⁦a‮﻿', clean: 'Ana' },
        { what: '60 characters with invisible characters among them', card: `${NAME60.slice(0, 30)}​‮${NAME60.slice(30, 60)}⁩`, clean: NAME60.slice(0, 60) },
        { what: 'runs of spaces and no-break spaces', card: 'Ana   　Ríos', clean: 'Ana Ríos' },
    ];
    const cards14c = new Map<string, { who: Id; home: string; card: string; clean: string }>();
    for (const [i, n] of names14c.entries()) {
        const who = newId(`Guest${i}`), home = n.home ?? 'a.example';
        listGuest14c(who, home, 'left', n.card);
        cards14c.set(who.pk, { who, home, card: n.card, clean: n.clean });
        authors14c.push({ who: `a guest whose card's name is ${n.what}`, key: who.pk, name: lineFor14c(n.clean, home) });
    }
    // Nothing is served that shows nothing: Unicode's format characters, the combining grapheme joiner, the Hangul fillers.
    const INVISIBLE14c = /[\p{Cf}͏ᅟᅠㅤﾠ]/u;
    // The moderators' view of an assistant's suggestion about the report (agent/suggestions-route.ts): Olive is the owner,
    // and her assistants file one suggestion a line, each declined once read: a new assistant at each one's day's limit.
    const { ownerSessionHeaders } = await import('./admin-auth-test-harness.js');
    const { issueAutomationToken } = await import('./automation-tokens.js');
    const { fileSuggestion, declineSuggestion, SUGGESTIONS_PER_DAY } = await import('./agent/suggestions.js');
    const olive14c = ownerSessionHeaders(olive.pk);
    const grants14c = [1, 2, 3].map((n) => issueAutomationToken({ name: `Moderation helper ${n}`, scope: 'agent', expiresAt: Date.now() + 86_400_000, createdBy: olive.pk }));
    let suggested14c = 0;
    db.prepare(`INSERT INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, 'home.layout', ?)
                ON CONFLICT(public_key, pref_key) DO UPDATE SET pref_value = excluded.pref_value`)
        .run(jo.pk, JSON.stringify({ v: 2, cards: [{ id: 'chat-k14c', type: 'chat', settings: { conversationId: K, kind: 'group', name: 'Bike Kitchen' } }], dismissed: {}, updatedAt: at14c }));
    const admin14c = ownerTokenHeaders('admin');
    const adminGet = async (p: string) => (await (await fetch(`${BASE}${p}`, { headers: admin14c })).json().catch(() => null)) as any;
    const reportGet = AGENT_TOOLS.find((t) => t.name === 'report_get');
    const short = (k: string) => k.slice(0, 8);
    interface Line14c { id: string; at: string; report: string }
    const paths14c: Array<{ where: string; unnamed: (key: string) => string | null; read: (l: Line14c) => Promise<unknown> }> = [
        { where: 'the chat as a member reads it', unnamed: short,
            read: async (l) => ((await call('GET', jo, `/api/groups/${K}/chat`)).body?.messages ?? []).find((m: any) => m.id === l.id)?.authorCallsign },
        { where: 'the Groups list (its last line)', unnamed: short, read: async (l) => {
            const row = ((await call('GET', jo, '/api/your-groups')).body?.items ?? []).find((i: any) => i.conversationId === K);
            return row?.lastMessage?.id === l.id ? row.lastMessage.authorCallsign : `another line (${row?.lastMessage?.id})`;
        } },
        { where: 'Home\'s Groups card (its last line)', unnamed: short, read: async (l) => {
            const g = ((await call('GET', jo, '/api/home?cards=groups')).body?.cards?.groups?.items ?? []).find((i: any) => i.id === K);
            return g?.last?.at === l.at ? g.last.who : `another line (${g?.last?.at})`;
        } },
        { where: 'Home\'s chat card pinned to the group', unnamed: short,
            read: async (l) => ((await call('GET', jo, '/api/home?cards=chat-k14c')).body?.cards?.['chat-k14c']?.lines ?? []).find((m: any) => m.id === l.id)?.who },
        { where: 'a report of it, as the moderators open it', unnamed: () => null,
            read: async (l) => (await adminGet(`/api/local/admin/reports/${l.report}/message`))?.message?.authorCallsign },
        { where: 'the moderators\' report queue', unnamed: (k) => `@${short(k)}`,
            read: async (l) => ((await adminGet('/api/local/admin/reports?status=all&limit=500'))?.reports ?? []).find((r: any) => r.id === l.report)?.targetCallsign },
        { where: 'the owner\'s assistant reading the report', unnamed: (k) => `@${short(k)}`, read: async (l) => {
            const got: any = await reportGet?.run({} as any, { report_id: l.report }, 'b14c');
            return got?.result?.report?.authorCallsign?.text?.split('\n')[1];
        } },
        { where: 'the moderators\' view of an assistant\'s suggestion about the report', unnamed: (k) => `@${short(k)}`, read: async (l) => {
            const grant = grants14c[Math.floor(suggested14c++ / SUGGESTIONS_PER_DAY)];
            if (!grant?.ok) return `no assistant to suggest (${grant ? grant.error : 'past the grants made'})`;
            const filed = fileSuggestion(grant.record.id, 'dismiss_report', l.report, 'Looks fine to me');
            if (!filed.ok) return `not filed: ${filed.error}`;
            const seen = (await (await fetch(`${BASE}/api/local/admin/agent/suggestions`, { headers: olive14c })).json().catch(() => null)) as any;
            declineSuggestion(filed.suggestion.id);
            return (seen?.suggestions ?? []).find((s: any) => s.id === filed.suggestion.id)?.report?.author;
        } },
        // Last: the line is a tombstone after it, as every member hears it (broadcastGroupChatUpdate) and as an edit's is.
        { where: 'a convenor\'s removal (the changed line every member hears)', unnamed: short,
            read: async (l) => (await call('POST', ana, `/api/groups/${K}/chat/remove`, { messageId: l.id })).body?.message?.authorCallsign },
    ];
    const reports14c: string[] = [];
    const base14c = Date.now();
    for (const [i, a] of authors14c.entries()) {
        const line: Line14c = { id: crypto.randomUUID(), at: new Date(base14c + (i + 1) * 1000).toISOString(), report: crypto.randomUUID() };
        db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata, timestamp) VALUES (?, ?, ?, ?, ?, 'text', NULL, ?)`)
            .run(line.id, K, a.key, Buffer.from('a line').toString('base64'), `${'0'.repeat(24)}`, line.at);
        db.prepare(`INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, target_message_id, disclosure, reason, created_at) VALUES (?, ?, ?, ?, ?, 'Spam or scam', ?)`)
            .run(line.report, jo.pk, a.key, line.id, JSON.stringify({ epoch: 1, mk: Buffer.alloc(32).toString('base64') }), line.at);
        reports14c.push(line.report);
        const misses: string[] = [];
        const card = cards14c.get(a.key);
        for (const p of paths14c) {
            const want = a.name ?? p.unnamed(a.key);
            const got = await p.read(line);
            if (got !== want) misses.push(`${p.where}: ${JSON.stringify(got)}`);
            // A guest's line, wherever it goes: " · <home> · guest" whole at its end, and nothing in it that shows nothing.
            else if (card && (typeof got !== 'string' || !got.endsWith(` · ${card.home} · guest`) || INVISIBLE14c.test(got))) misses.push(`${p.where}: ${JSON.stringify(got)} (cut or invisible)`);
        }
        if (card && card.card !== card.clean) {
            // The way in: a card signed over the padded name is no card; a phone's own card (core signAddressCard) carries the clean name.
            const name = card.card, digest = addressCardDigest({ key: card.who.pk, home: card.home, name });
            const handMade = { v: 1, key: card.who.pk, home: card.home, name, sig: Buffer.from(ed25519.sign(digest, card.who.seed)).toString('base64') };
            const invited = await call('POST', ana, `/api/groups/${K}/guests`, { card: handMade });
            if (invited.status !== 400 || invited.body?.code !== 'bad_card') misses.push(`the invite route, a card signed over this name: ${invited.status} ${invited.body?.code}`);
            const phones = await signAddressCard({ key: card.who.pk, home: card.home, name }, signerOf(card.who.seed)).then((c) => c.name, (e) => `refused: ${e?.message}`);
            if (phones !== card.clean) misses.push(`a phone's own card over this name: ${JSON.stringify(phones)}`);
        }
        assert(misses.length === 0, `14c. ${a.who}: every place serves ${JSON.stringify(a.name ?? 'no name, only its own stand-in')} (${misses.length} of ${paths14c.length} miss${misses.length ? `: ${misses.join('; ')}` : ''})`);
    }
    // Nothing of this table reaches the sections after it: the guest rows, the reports and Jo's Home go.
    db.prepare('DELETE FROM group_guests WHERE group_id = ?').run(K);
    db.prepare('DELETE FROM abuse_reports WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(reports14c));
    db.prepare(`DELETE FROM member_preferences WHERE public_key = ? AND pref_key = 'home.layout'`).run(jo.pk);
    await settle();

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
    const rosters16 = outsOf('roster', t16).filter((o) => o.body.group === S);
    assert(waitingA16 >= 1 && inBefore16 > 0 && closed16 >= inBefore16 && told16.length === 2 && told16.every((o) => o.body.data.why === 'closed')
        && rosters16.length === 0 && (db.prepare('SELECT COUNT(*) AS n FROM group_guest_outbox').get() as { n: number }).n === 0,
        `16. main server, closeGuestsIfSwitchedOff then flushGuestOutbox: the guests go, each home is told once (a removal; no roster, no guest is left in), the waiting line is dropped (got ${closed16}, ${told16.map((o) => o.home)}, ${rosters16.length} roster(s))`);
    assert(timerJobs.length === 2 && timerJobs.every((n) => n in jobs16), `16z. the table covers every job https-server.ts's timer runs from group-guests (${timerJobs.join(', ')})`);
    db.prepare('DELETE FROM node_config WHERE key = ?').run(offKey);

    // ── 17. Close the class: each home's rows go strictly oldest first, and none waits once it answers ──
    console.log('\n17. For each community, what goes there goes in the order it was queued, and nothing waits once it answers');
    const B = createGroup({ name: 'Bike Coop', joinPolicy: 'open', createdBy: ana.pk }).id;
    const rue = newId('Rue');   // at a.example, in
    await call('POST', ana, `/api/groups/${B}/guests`, { card: await cardOf(rue, 'a.example') });
    await bring([await item(rue, 'a.example', `group:${B}`, 'group-invite', yes)]);
    const b1 = epochBy(ana, B, 1, 'start', [ana, rue]);
    await call('POST', ana, `/api/groups/${B}/keys/epoch`, { epoch: b1.record });
    await settle();
    const AH = 'a.example';
    const queuedA = () => (db.prepare('SELECT COUNT(*) AS n FROM group_guest_outbox WHERE home = ?').get(AH) as { n: number }).n;
    const waitsA = () => db.prepare('SELECT DISTINCT next_try_at FROM group_guest_outbox WHERE home = ?').pluck().all(AH) as number[];
    const labelOf = (o: Out) => o.body.kind === 'line' ? `line:${o.body.data.id}` : `${o.body.kind}:${o.body.guests.join('+')}`;
    const backoffOver = Math.max(...(guests?.GUEST_FANOUT_BACKOFF_MS ?? [0])) + 60_000;
    assert(stateOf(B, rue) === 'in' && queuedA() === 0, `17a. Bike Coop: Rue from a.example is in, and nothing waits for a.example (got ${stateOf(B, rue)}, ${queuedA()})`);
    // (a.example answers / fails and stays failing / fails and then answers) x (the case's rows queued before the failure,
    // while its send is in flight, or after it) x (one flush, or many: on every row and on top of each other). Each case:
    // the head row's send hangs (an invitation), the case's rows are queued at their moment, the head's send is answered
    // (or refused: the failure), then the trigger, the backoff ending (one) or a new row with flushes on top (many).
    let pn = 0;
    for (const home of ['ok', 'failing', 'failing-then-ok'] as const) for (const when of ['before', 'during', 'after'] as const) for (const flushes of ['one', 'many'] as const) {
        const label = `a.example ${home}, rows queued ${when} the failure, ${flushes} flush${flushes === 'many' ? 'es' : ''}`;
        const start = outs.length;
        const expected: string[] = [];
        const p = newId(`P${++pn}`);
        const pending: Array<Promise<unknown>> = [];
        const flush = () => { if (flushes === 'many') pending.push(guests?.flushGuestOutbox(), guests?.flushGuestOutbox()); };
        const line = async () => {
            const l = lineIn(ana, B, b1.groupKey, 1);
            const r = await call('POST', ana, `/api/groups/${B}/chat/message`, l);
            if (r.status === 201) expected.push(`line:${l.clientId}`);
            flush();
        };
        const caseRows = async () => {
            await line();
            const r = await call('DELETE', ana, `/api/groups/${B}/guests/${p.pk}`);
            if (r.status === 200) expected.push(`removed:${p.pk}`);
            flush();
            await line();
        };
        let open: () => void = () => {};
        gates.set(AH, new Promise<void>((r) => { open = r; }));
        const inv = await call('POST', ana, `/api/groups/${B}/guests`, { card: await cardOf(p, AH) });   // the head row: its send hangs
        // The send rule (#3233 round 5): an invitation goes only while its guest is still invited here. The head's send is on
        // the wire as the case's rows are queued; refused (the failure), it is tried again only after P's removal, unless the
        // home answered again before P was removed (failing-then-ok, rows after). So otherwise it goes unsent, and only the
        // case's rows go, in order: `sent` must be exactly `expected`, so an invitation that went would fail the check.
        const inviteGoes = home === 'ok' || (home === 'failing-then-ok' && when === 'after');
        if (inv.status === 201 && inviteGoes) expected.push(`invite:${p.pk}`);
        flush();
        await sleep(20);
        if (when === 'before') await caseRows();
        if (home !== 'ok') refusing.add(AH);                  // the failure begins
        if (when === 'during') await caseRows();
        open();
        gates.delete(AH);
        await sleep(20);
        await guests?.flushGuestOutbox();                     // joins the head's send if it is still running
        await Promise.all(pending.splice(0));
        if (home === 'failing-then-ok') refusing.delete(AH);  // it answers again; its rows are still in their backoff
        const triesAfter = tries.get(AH) ?? 0;
        if (when === 'after') await caseRows();
        await Promise.all(pending.splice(0));
        await sleep(20);
        // A row queued after its home answers again takes the whole queue with it: nothing is left waiting.
        const leftAfterRows = queuedA();
        const costAfter = (tries.get(AH) ?? 0) - triesAfter;
        if (flushes === 'one') await guests?.flushGuestOutbox(Date.now() + backoffOver);
        else {
            await line();
            await Promise.all([guests?.flushGuestOutbox(), guests?.flushGuestOutbox(), guests?.flushGuestOutbox(), ...pending.splice(0)]);
        }
        await sleep(20);
        const leftAfterTrigger = queuedA();
        const sentBefore = outs.slice(start).filter((o) => o.home === AH && o.body.group === B).map(labelOf);
        const waits = waitsA();
        if (home === 'failing') {
            refusing.delete(AH);
            await guests?.flushGuestOutbox(Date.now() + backoffOver);
        }
        const sent = outs.slice(start).filter((o) => o.home === AH && o.body.group === B).map(labelOf);
        const inOrder = inv.status === 201 && expected.length === (flushes === 'many' ? 5 : 4) - (inviteGoes ? 0 : 1) && JSON.stringify(sent) === JSON.stringify(expected);
        const waitedNone = home === 'failing'
            ? sentBefore.length === 0 && leftAfterTrigger === expected.length && waits.length === 1 && waits[0] > Date.now() && queuedA() === 0
            : leftAfterTrigger === 0 && (when !== 'after' || leftAfterRows === 0);
        // A new row costs a home that is failing at most one try (its three rows: three at most, however many flushes).
        const cheap = home !== 'failing' || when !== 'after' || costAfter <= 3;
        assert(inOrder && waitedNone && cheap,
            `17. ${label}: a.example gets each row once, in the order queued${inviteGoes ? '' : ' (the invitation, its guest removed before it went, goes unsent)'}; ${home === 'failing' ? 'while it fails nothing goes and every row waits one wait' : 'none waits once it answers'} (sent ${JSON.stringify(sent.map((s) => s.split(':')[0]))} of ${expected.length}; in order ${inOrder}; left ${leftAfterRows}/${leftAfterTrigger}; ${costAfter} tries for the rows after)`);
        // The next case starts from an empty queue, whatever this one left.
        refusing.delete(AH);
        await guests?.flushGuestOutbox(Date.now() + backoffOver);
    }

    // ── 18. Close the class: what crosses x where the guest stands (G1b part 2) ─────────────
    console.log('\n18. Close the class: every item that crosses (a guest\'s, a member\'s change, a report) x where the guest stands');
    const { addConnector, removeConnector } = await import('./connector-manager.js');
    type St18 = 'accepted' | 'blocked host' | 'removed guest' | 'closed group' | 'standby';
    const STANDINGS18: St18[] = ['accepted', 'blocked host', 'removed guest', 'closed group', 'standby'];
    const KINDS18 = ['guest line', 'guest leave', 'no once in', 'yes once in', 'member line', 'member edit', 'author delete', 'convenor removal', 'invite', 'report'] as const;
    type K18 = (typeof KINDS18)[number];
    /**
     * What each item comes to: [kind][standing]. On a standby (checked on every standby row too): no guest's item is taken,
     * no guest row is written, nothing is queued for or sent to another community. A member's own write there (a line, an
     * edit, a report) is the routes' existing business, unchanged here, so the digest leaves messages and reports out.
     */
    const WANT18: Record<K18, Record<St18, string>> = {
        //                   accepted                         blocked host               removed guest             closed group              standby
        'guest line':       { accepted: 'stored',              'blocked host': 'dropped', 'removed guest': 'dropped', 'closed group': 'dropped', standby: 'dropped' },
        'guest leave':      { accepted: 'left',                'blocked host': 'in',      'removed guest': 'removed', 'closed group': 'removed', standby: 'in' },
        'no once in':       { accepted: 'left',                'blocked host': 'in',      'removed guest': 'removed', 'closed group': 'removed', standby: 'in' },
        'yes once in':      { accepted: 'in',                  'blocked host': 'in',      'removed guest': 'removed', 'closed group': 'removed', standby: 'in' },
        'member line':      { accepted: 'line',                'blocked host': 'none',    'removed guest': 'none',    'closed group': 'none',    standby: 'none' },
        'member edit':      { accepted: 'edit:edited',         'blocked host': 'none',    'removed guest': 'none',    'closed group': 'none',    standby: 'none' },
        'author delete':    { accepted: 'edit:removed:author', 'blocked host': 'none',    'removed guest': 'none',    'closed group': 'none',    standby: 'none' },
        'convenor removal': { accepted: 'edit:removed:convenor', 'blocked host': 'none',  'removed guest': 'none',    'closed group': 'none',    standby: 'none' },
        invite:             { accepted: 'invited, told',       'blocked host': 'refused server_blocked', 'removed guest': 'invited, told', 'closed group': 'refused group_closed', standby: 'refused standby' },
        report:             { accepted: 'filed here, told',    'blocked host': 'filed here, not told', 'removed guest': 'filed here, told', 'closed group': 'filed here, told', standby: 'filed here, queued' },
    };
    const standbyDigest = (g: string) => JSON.stringify([
        db.prepare('SELECT guest_key, state, state_at FROM group_guests WHERE group_id = ? ORDER BY guest_key').all(g),
        db.prepare("SELECT id FROM messages WHERE conversation_id = ? AND author_pubkey IN (SELECT guest_key FROM group_guests WHERE group_id = ?) ORDER BY id").all(g, g),
        db.prepare('SELECT COUNT(*) AS n FROM group_guest_outbox').get(),
    ]);
    let r18 = 0;
    let closedTold = '';
    let closedKey = '';
    for (const kind of KINDS18) for (const st of STANDINGS18) {
        const n18 = ++r18;
        const H = st === 'blocked host' ? 'c.example' : 'a.example';
        // The row's own group: Ana convenes, M is a member, X from H says yes and is in; epoch 1 over the three; M and X
        // each have a line under it.
        const g = createGroup({ name: `Row ${n18}`, joinPolicy: 'open', createdBy: ana.pk }).id;
        const m = addLocal(`M18-${n18}`);
        db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status, from_epoch) VALUES (?, ?, 'member', 'active', 1)`).run(g, m.pk);
        const x = newId(`X18-${n18}`);
        await call('POST', ana, `/api/groups/${g}/guests`, { card: await cardOf(x, H) });
        await bring([await item(x, H, `group:${g}`, 'group-invite', yes)], H as 'a.example' | 'c.example');
        const e = epochBy(ana, g, 1, 'start', [ana, m, x]);
        const stored = await call('POST', ana, `/api/groups/${g}/keys/epoch`, { epoch: e.record });
        const mLine = lineIn(m, g, e.groupKey, 1);
        await call('POST', m, `/api/groups/${g}/chat/message`, mLine);
        const xId = crypto.randomUUID();
        const xText = `the guest's words, row ${n18}`;
        await bring([await item(x, H, `group:${g}`, 'group-line', JSON.stringify({ ...sealGroupLine(xText, { myEdPrivHex: x.seedHex, groupKey: e.groupKey, groupId: g, epoch: 1, messageId: xId }), metadata: { epoch: 1 }, clientId: xId }))], H as 'a.example' | 'c.example');
        await settle();
        const setupOk = stateOf(g, x) === 'in' && stored.status === 201 && !!db.prepare('SELECT 1 FROM messages WHERE id = ? AND author_pubkey = ?').get(xId, x.pk);
        // Where X stands.
        if (st === 'blocked host') addConnector(`${H}:4001`, 'blocked', 'Blocked', `https://${H}`, false);
        if (st === 'removed guest') await call('DELETE', ana, `/api/groups/${g}/guests/${x.pk}`);
        if (st === 'closed group') {
            const t = Date.now();
            closeGroupByVote(g, `test-close-${n18}`);
            await settle();
            if (!closedTold) {
                closedTold = JSON.stringify(outsOf('removed', t).filter((o) => o.body.group === g).map((o) => [o.home, o.body.guests, o.body.data.why]));
                closedKey = x.pk;
            }
        }
        await settle();
        if (st === 'standby') setNodeRole('backup');
        const before = standbyDigest(g);
        const t0 = Date.now();
        const sentBefore = outs.length;
        // The item.
        let got = '';
        const to = `group:${g}`;
        const home18 = H as 'a.example' | 'c.example';
        if (kind === 'guest line') {
            const id = crypto.randomUUID();
            await bring([await item(x, H, to, 'group-line', JSON.stringify({ ...sealGroupLine('again', { myEdPrivHex: x.seedHex, groupKey: e.groupKey, groupId: g, epoch: 1, messageId: id }), metadata: { epoch: 1 }, clientId: id }))], home18);
            got = db.prepare('SELECT 1 FROM messages WHERE id = ?').get(id) ? 'stored' : 'dropped';
        } else if (kind === 'guest leave' || kind === 'no once in' || kind === 'yes once in') {
            const it = kind === 'guest leave' ? await item(x, H, to, 'group-leave', JSON.stringify({ v: 1 }))
                : await item(x, H, to, 'group-invite', JSON.stringify({ v: 1, answer: kind === 'no once in' ? 'no' : 'yes' }));
            await bring([it], home18);
            got = stateOf(g, x) ?? 'none';
        } else if (kind === 'invite') {
            const y = newId(`Y18-${n18}`);
            const r = await call('POST', ana, `/api/groups/${g}/guests`, { card: await cardOf(y, H) });
            await settle();
            const told = outs.slice(sentBefore).some((o) => o.home === H && o.body.kind === 'invite' && o.body.guests.includes(y.pk));
            got = r.status === 201 && told ? 'invited, told' : r.status === 201 ? 'invited, not told' : `refused ${r.body?.code}`;
        } else if (kind === 'report') {
            const mk = Buffer.from(groupMessageKey(e.groupKey, xId)).toString('base64');
            const r = await call('POST', m, `/api/groups/${g}/chat/report`, { messageId: xId, reason: 'Spam or scam', disclosure: { epoch: 1, mk } });
            await settle();
            const row = db.prepare('SELECT target_pubkey, target_home, disclosure FROM abuse_reports WHERE reporter_pubkey = ? AND target_message_id = ?').get(m.pk, xId) as { target_pubkey: string; target_home: string | null; disclosure: string } | undefined;
            const complaint = outs.slice(sentBefore).find((o) => o.path === '/api/relay/complaint');
            const c = complaint?.body?.complaint;
            const toldState = row ? (JSON.parse(row.disclosure).told?.state ?? null) : null;
            const toldOk = !!complaint && complaint.home === H && complaint.signed && c?.member === x.pk && c?.itemId === xId && c?.words === xText && c?.reason === 'spam or scam'
                && !JSON.stringify(c).includes(m.pk) && toldState === 'sent';
            got = !row || r.status !== 200 ? 'not filed'
                : row.target_pubkey !== x.pk || row.target_home !== H ? `filed wrong (${row.target_home})`
                : toldOk ? 'filed here, told' : !complaint && toldState === 'failed' ? 'filed here, not told' : !complaint && toldState === 'queued' ? 'filed here, queued'
                : `filed here, told wrongly (${toldState}, ${JSON.stringify(c)})`;
        } else {
            if (kind === 'member line') await call('POST', m, `/api/groups/${g}/chat/message`, lineIn(m, g, e.groupKey, 1));
            if (kind === 'member edit') await call('POST', m, '/api/messages/edit', { messageId: mLine.clientId, ...sealGroupLine('edited', { myEdPrivHex: m.seedHex, groupKey: e.groupKey, groupId: g, epoch: 1, messageId: mLine.clientId }), metadata: { epoch: 1 } });
            if (kind === 'author delete') await call('POST', m, '/api/messages/delete', { messageId: mLine.clientId });
            if (kind === 'convenor removal') await call('POST', ana, `/api/groups/${g}/chat/remove`, { messageId: xId });
            await settle();
            const notes = outs.slice(sentBefore).filter((o) => o.body?.group === g && (o.body.kind === 'line' || o.body.kind === 'edit'));
            const wantId = kind === 'convenor removal' ? xId : mLine.clientId;
            const okShape = notes.every((o) => o.home === H && o.signed && JSON.stringify(o.body.guests) === JSON.stringify([x.pk])
                && (o.body.kind === 'line' || (o.body.data.id === wantId && (o.body.data.action === 'removed' ? !('ciphertext' in o.body.data) : typeof o.body.data.ciphertext === 'string'))));
            got = !notes.length ? 'none' : notes.length > 1 || !okShape ? `wrong ${JSON.stringify(notes.map((o) => [o.home, o.body.kind, o.body.data]))}`
                : notes[0].body.kind === 'line' ? 'line' : ['edit', notes[0].body.data.action, notes[0].body.data.by].filter(Boolean).join(':');
        }
        const standbyOk = st !== 'standby' || (standbyDigest(g) === before && outs.length === sentBefore);
        if (st === 'standby') setNodeRole('primary');
        if (st === 'blocked host') removeConnector(`${H}:4001`);
        const nothingToBlocked = st !== 'blocked host' || outs.slice(sentBefore).every((o) => o.home !== H);
        assert(setupOk && got === WANT18[kind][st] && standbyOk && nothingToBlocked && t0 > 0,
            `18. ${kind} x ${st}: ${WANT18[kind][st]} (got ${got}${setupOk ? '' : ', setup failed'}${standbyOk ? '' : ', the standby wrote or sent'}${nothingToBlocked ? '' : ', the blocked home was sent to'})`);
    }
    assert(r18 === KINDS18.length * STANDINGS18.length && Object.keys(WANT18).length === KINDS18.length, `18z. the table has a row for every item and every standing (${r18} rows)`);
    assert(!!closedKey && closedTold === JSON.stringify([['a.example', [closedKey], 'group-closed']]),
        `18y. a group its members close removes its guests: their home is told once, why group-closed (got ${closedTold})`);
    // The take-over 'no', by its own path: X's home lost the yes's answer and showed the invitation again; X said no there.
    const TO = createGroup({ name: 'Take-over', joinPolicy: 'open', createdBy: ana.pk }).id;
    const tx = newId('Tox'), ty = newId('Toy');
    for (const [who, h] of [[tx, 'a.example'], [ty, 'c.example']] as const) {
        await call('POST', ana, `/api/groups/${TO}/guests`, { card: await cardOf(who, h) });
        await bring([await item(who, h, `group:${TO}`, 'group-invite', yes)], h);
    }
    const eTO = epochBy(ana, TO, 1, 'start', [ana, tx, ty]);
    await call('POST', ana, `/api/groups/${TO}/keys/epoch`, { epoch: eTO.record });
    await settle();
    const tTO = Date.now();
    await bring([await item(tx, 'a.example', `group:${TO}`, 'group-invite', JSON.stringify({ v: 1, answer: 'no' }))]);
    const rosterTO = outsOf('roster', tTO).filter((o) => o.body.group === TO);
    const keysTO = await call('GET', ana, `/api/groups/${TO}/keys`);
    assert(stateOf(TO, tx) === 'left' && rosterTO.length === 1 && rosterTO[0].home === 'c.example' && !rosterTO[0].body.data.guests.some((gg: any) => gg.key === tx.pk)
        && !keysTO.body?.roster?.includes(tx.pk),
        `18x. after a take-over, a no from a guest who is in is their leave: left, out of the key roster, and the other home gets the roster without them (got ${stateOf(TO, tx)}, ${rosterTO.map((o) => o.home)})`);

    // An edit has its line's audience: a guest in now, who was not when the line was sealed, hears nothing of it.
    const AU = createGroup({ name: 'Audience', joinPolicy: 'open', createdBy: ana.pk }).id;
    const au1 = epochBy(ana, AU, 1, 'start', [ana]);
    await call('POST', ana, `/api/groups/${AU}/keys/epoch`, { epoch: au1.record });
    const oldLine = lineIn(ana, AU, au1.groupKey, 1);
    await call('POST', ana, `/api/groups/${AU}/chat/message`, oldLine);
    const late = newId('Late');
    await call('POST', ana, `/api/groups/${AU}/guests`, { card: await cardOf(late, 'a.example') });
    await bring([await item(late, 'a.example', `group:${AU}`, 'group-invite', yes)]);
    const au2 = epochBy(ana, AU, 2, 'rotate', [ana, late]);
    const au2Stored = await call('POST', ana, `/api/groups/${AU}/keys/epoch`, { epoch: au2.record });
    const newLine = lineIn(ana, AU, au2.groupKey, 2);
    await call('POST', ana, `/api/groups/${AU}/chat/message`, newLine);
    await settle();
    const tAU = Date.now();
    await call('POST', ana, '/api/messages/edit', { messageId: oldLine.clientId, ...sealGroupLine('old, edited', { myEdPrivHex: ana.seedHex, groupKey: au1.groupKey, groupId: AU, epoch: 1, messageId: oldLine.clientId }), metadata: { epoch: 1 } });
    await call('POST', ana, '/api/messages/delete', { messageId: oldLine.clientId });
    await call('POST', ana, '/api/messages/edit', { messageId: newLine.clientId, ...sealGroupLine('new, edited', { myEdPrivHex: ana.seedHex, groupKey: au2.groupKey, groupId: AU, epoch: 2, messageId: newLine.clientId }), metadata: { epoch: 2 } });
    await settle();
    const editsAU = outsOf('edit', tAU).filter((o) => o.body.group === AU).map((o) => o.body.data.id);
    assert(au2Stored.status === 201 && stateOf(AU, late) === 'in' && JSON.stringify(editsAU) === JSON.stringify([newLine.clientId]),
        `18w. a guest in since epoch 2 hears of the edit of a line under epoch 2 only: not the edit or delete of one from epoch 1, before them (got ${JSON.stringify(editsAU)})`);

    // ── 19. Close the class: a takedown x where a copy of the line is (#3233 round 2) ────────
    console.log('\n19. Close the class: every takedown x where a copy of the line is -> no words or photo go, none is kept here, the tombstone goes');
    const TK19 = ['author delete', 'edited, then author delete', 'convenor removal', 'account deleted', 'group closed'] as const;
    const CS19 = ['queued, home in backoff', 'in a send, behind a row on the wire', 'already sent', 'queued, its guest left since'] as const;
    type Tk19 = (typeof TK19)[number];
    type Cs19 = (typeof CS19)[number];
    const tombFor = (t: string): Record<Cs19, string> => ({
        'queued, home in backoff': t, 'in a send, behind a row on the wire': t, 'already sent': t, 'queued, its guest left since': 'none',
    });
    /** The tombstone the guest's home gets after the takedown: [takedown][copy state]. A guest who left hears nothing more. */
    const TOMB19: Record<Tk19, Record<Cs19, string>> = {
        'author delete': tombFor('removed:author'),
        'edited, then author delete': tombFor('removed:author'),
        'convenor removal': tombFor('removed:convenor'),
        'account deleted': tombFor('removed:author'),
        'group closed': tombFor('group-closed'),
    };
    const outbox19 = () => db.prepare('SELECT body FROM group_guest_outbox').pluck().all() as string[];
    /** One group for a row: Ana convenes, M is a member, X from a.example is in; epoch 1 over the three. */
    async function row19(label: string): Promise<{ g: string; m: Id; x: Id; key: Uint8Array; ok: boolean }> {
        const g = createGroup({ name: label, joinPolicy: 'open', createdBy: ana.pk }).id;
        const m = addLocal(`M-${label}`);
        db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status, from_epoch) VALUES (?, ?, 'member', 'active', 1)`).run(g, m.pk);
        const x = newId(`X-${label}`);
        await call('POST', ana, `/api/groups/${g}/guests`, { card: await cardOf(x, 'a.example') });
        await bring([await item(x, 'a.example', `group:${g}`, 'group-invite', yes)]);
        const e = epochBy(ana, g, 1, 'start', [ana, m, x]);
        const stored = await call('POST', ana, `/api/groups/${g}/keys/epoch`, { epoch: e.record });
        await settle();
        return { g, m, x, key: e.groupKey, ok: stored.status === 201 && stateOf(g, x) === 'in' };
    }
    /** a.example stops answering (its rows wait in backoff), or holds the first row of a send on the wire until opened. */
    let openWire19: () => void = () => {};
    let wire19: Promise<number> | null = null;
    async function holdOnTheWire(): Promise<void> {
        refusing.delete('a.example');
        gates.set('a.example', new Promise<void>((r) => { openWire19 = r; }));
        wire19 = guests.flushGuestOutbox(Date.now() + 10 * 60_000);
        await sleep(40);
    }
    async function answerAgain(): Promise<void> {
        refusing.delete('a.example');
        if (wire19) { openWire19(); gates.delete('a.example'); await wire19; wire19 = null; }
        await guests.flushGuestOutbox(Date.now() + 10 * 60_000);
        await settle();
    }
    let r19 = 0;
    for (const tk of TK19) for (const cs of CS19) {
        const n19 = ++r19;
        const { g, m, x, key, ok } = await row19(`Takedown ${n19}`);
        // M's photo line: its words, its sealed photo and the words of an edit, each a mark no other row carries.
        const id = crypto.randomUUID();
        const base = { myEdPrivHex: m.seedHex, groupKey: key, groupId: g, epoch: 1, messageId: id };
        const words = sealGroupLine(`row ${n19}'s caption`, base);
        const photo = sealGroupLine(`data:image/jpeg;base64,${crypto.randomBytes(2000).toString('base64')}`, { ...base, part: 'attachment' });
        const edited = sealGroupLine(`row ${n19}'s caption, edited`, base);
        const photoMark = photo.ciphertext.slice(0, 64);
        const carries = (s: string) => [words.ciphertext, photoMark, edited.ciphertext].some((k) => s.includes(k));
        const t0 = Date.now();
        if (cs !== 'already sent') refusing.add('a.example');
        if (cs === 'in a send, behind a row on the wire') await call('POST', ana, `/api/groups/${g}/chat/message`, lineIn(ana, g, key, 1));
        const posted = await call('POST', m, `/api/groups/${g}/chat/message`, {
            type: 'image', ...words, metadata: { epoch: 1 }, attachment: { data: photo.ciphertext, nonce: photo.nonce, mime: 'image/jpeg' }, clientId: id,
        });
        await settle();
        if (cs === 'queued, its guest left since') await bring([await item(x, 'a.example', `group:${g}`, 'group-leave', JSON.stringify({ v: 1 }))]);
        if (cs === 'in a send, behind a row on the wire') await holdOnTheWire();
        const queuedCopy = outbox19().find((b) => b.includes(words.ciphertext));
        const sentCopy = outs.find((o) => o.home === 'a.example' && o.body?.kind === 'line' && o.body.data?.id === id);
        const setupOk = ok && posted.status === 201 && (cs === 'already sent'
            ? !queuedCopy && !!sentCopy && JSON.stringify(sentCopy.body).includes(photoMark)
            : !!queuedCopy && queuedCopy.includes(photoMark) && !sentCopy);
        // The edit first (once a.example answers, it went: the takedown is the delete after it).
        if (tk === 'edited, then author delete') {
            await call('POST', m, '/api/messages/edit', { messageId: id, ...edited, metadata: { epoch: 1 } });
            if (cs === 'in a send, behind a row on the wire') await sleep(30);
            else await settle();
        }
        // What went after the takedown, by its place in `outs`, not its time (a send settle() waited for can share its millisecond).
        const nTake = outs.length;
        if (tk === 'author delete' || tk === 'edited, then author delete') await call('POST', m, '/api/messages/delete', { messageId: id });
        if (tk === 'convenor removal') await call('POST', ana, `/api/groups/${g}/chat/remove`, { messageId: id });
        if (tk === 'account deleted') purgeMemberSelf(m.pk);
        if (tk === 'group closed') closeGroupByVote(g, `test-close-19-${n19}`);
        const kept = outbox19().filter(carries).length;
        await answerAgain();
        const toA = (from: Out[]) => from.filter((o) => o.home === 'a.example' && o.body?.group === g);
        const afterTake = toA(outs.slice(nTake));
        const wordsOut = (cs === 'already sent' ? afterTake : toA(outs).filter((o) => o.at >= t0)).filter((o) => carries(JSON.stringify(o.body))).length;
        const tomb = afterTake.filter((o) => (o.body.kind === 'edit' && o.body.data?.id === id) || o.body.kind === 'removed');
        const t = tomb[0]?.body;
        const gotTomb = !tomb.length ? 'none' : tomb.length > 1 ? `${tomb.length} tombstones`
            : t.kind === 'removed' ? (t.data.why === 'group-closed' && JSON.stringify(t.guests) === JSON.stringify([x.pk]) ? 'group-closed' : `removed ${t.data.why}`)
            : t.data.action === 'removed' && !('ciphertext' in t.data) && JSON.stringify(t.guests) === JSON.stringify([x.pk]) ? `removed:${t.data.by}` : `edit ${t.data.action}`;
        assert(setupOk && wordsOut === 0 && kept === 0 && gotTomb === TOMB19[tk][cs],
            `19. ${tk} x ${cs}: no words or photo go (${wordsOut}), none kept here (${kept}), tombstone ${TOMB19[tk][cs]} (got ${gotTomb}${setupOk ? '' : ', setup failed'})`);
    }
    assert(r19 === TK19.length * CS19.length && Object.keys(TOMB19).length === TK19.length, `19z. the table has a row for every takedown and every copy state (${r19} rows)`);
    // An account deleted with a line already down whose metadata is no JSON: the deletion still goes through, and its other line's takedown goes.
    const y19 = await row19('Takedown stray');
    const strayId = crypto.randomUUID();
    db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata, timestamp) VALUES (?, ?, ?, 'x', 'plaintext-v1', 'removed', 'not json', ?)`)
        .run(strayId, y19.g, y19.m.pk, new Date().toISOString());
    const realLine = lineIn(y19.m, y19.g, y19.key, 1);
    await call('POST', y19.m, `/api/groups/${y19.g}/chat/message`, realLine);
    await settle();
    const tY = Date.now();
    let purged: { ok: boolean } | null = null;
    try { purged = purgeMemberSelf(y19.m.pk); } catch { purged = null; }
    await settle();
    const tombY = outs.filter((o) => o.home === 'a.example' && o.at >= tY && o.body?.kind === 'edit' && o.body.data?.id === realLine.clientId && o.body.data.action === 'removed');
    assert(y19.ok && purged?.ok === true && tombY.length === 1,
        `19y. an account deleted with a stray line whose metadata is no JSON: deleted (${purged?.ok ?? 'threw'}), and its real line's takedown goes once (${tombY.length})`);

    // Edits: the newest words win, wherever the line still waits here.
    const ES19 = ['edit while queued', 'edit twice while queued', 'edit while in a send, behind a row on the wire', 'edit after it went'] as const;
    /** What a.example gets of the line after it was posted (after the edit, once it went): each copy's words, by which edit. */
    const WORDS19: Record<(typeof ES19)[number], string> = {
        'edit while queued': 'line(newest) edit(newest)',
        'edit twice while queued': 'line(newest) edit(newest)',
        'edit while in a send, behind a row on the wire': 'line(newest) edit(newest)',
        'edit after it went': 'edit(newest)',
    };
    let e19 = 0;
    for (const es of ES19) {
        const n = ++e19;
        const { g, m, key, ok } = await row19(`Edit ${n}`);
        const id = crypto.randomUUID();
        const seal = (text: string) => sealGroupLine(text, { myEdPrivHex: m.seedHex, groupKey: key, groupId: g, epoch: 1, messageId: id });
        const w = [seal(`edit row ${n}, first words`), seal(`edit row ${n}, second words`), seal(`edit row ${n}, third words`)];
        const edits = es === 'edit twice while queued' ? [w[1], w[2]] : [w[1]];
        const newest = edits[edits.length - 1].ciphertext;
        const which = (c: unknown) => (c === newest ? 'newest' : w.findIndex((s) => s.ciphertext === c) >= 0 ? `words ${w.findIndex((s) => s.ciphertext === c)}` : 'other');
        if (es !== 'edit after it went') refusing.add('a.example');
        if (es === 'edit while in a send, behind a row on the wire') await call('POST', ana, `/api/groups/${g}/chat/message`, lineIn(ana, g, key, 1));
        const posted = await call('POST', m, `/api/groups/${g}/chat/message`, { ...w[0], metadata: { epoch: 1 }, clientId: id });
        await settle();
        if (es === 'edit while in a send, behind a row on the wire') await holdOnTheWire();
        // What went after the edit, by its place in `outs`, not its time: the line settle() waited for can land in the same
        // millisecond settle() returns, and an `at >= now` window would count it as after.
        const nEdit = outs.length;
        let edited = true;
        for (const s of edits) edited = (await call('POST', m, '/api/messages/edit', { messageId: id, ...s, metadata: { epoch: 1 } })).status === 200 && edited;
        const waiting = outbox19().filter((b) => b.includes(id)).map((b) => `${JSON.parse(b).kind}(${which(JSON.parse(b).data.ciphertext)})`).join(' ');
        await answerAgain();
        const got = outs.filter((o, i) => o.home === 'a.example' && o.body?.group === g && o.body.data?.id === id && i >= (es === 'edit after it went' ? nEdit : 0))
            .map((o) => `${o.body.kind}(${which(o.body.data.ciphertext)})`).join(' ');
        const waitingOk = es === 'edit after it went' ? waiting === 'edit(newest)' || waiting === '' : !waiting.includes('words');
        assert(ok && posted.status === 201 && edited && waitingOk && got === WORDS19[es],
            `19e. ${es}: only the newest words go: ${WORDS19[es]} (got ${got}; waiting here after the edit: ${waiting})`);
    }

    // ── 19c. The copy rule (#3233 round 3): a takedown x this server's copy state ────────────
    // group_guest_outbox is this server's own (`local`): a standby keeps it through every copy, while a takedown runs on the
    // server that took over and reaches this one only as its copy's rows (the tombstone, the guests' states). A queued copy
    // of a line goes only if, as its turn comes, the line still stands here and this server is main.
    console.log('\n19c. Close the class: every takedown x this server\'s copy state -> no words or photo go, none is kept here');
    const QUEUE_MS = (guests?.GUEST_FANOUT_QUEUE_MS ?? 24 * 60 * 60_000) as number;
    const COPY19 = ['stays main', 'a standby at the takedown, then promoted', 'a standby at the takedown, promoted a day later'] as const;
    const rowsOf19 = (g: string) => db.prepare('SELECT * FROM group_guest_outbox WHERE group_id = ?').all(g) as Array<Record<string, any>>;
    /** This server's own queue as it kept it through the copy (the other server's never comes in one), `age` ms older. */
    const keptThroughCopy = (g: string, rows: Array<Record<string, any>>, age: number) => {
        db.prepare('DELETE FROM group_guest_outbox WHERE group_id = ?').run(g);
        const put = db.prepare('INSERT INTO group_guest_outbox (id, group_id, home, kind, body, attempts, next_try_at, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)');
        for (const r of rows) put.run(r.id, r.group_id, r.home, r.kind, r.body, r.created_at - age, r.created_at - age);
    };
    /** As this server goes standby and is promoted again: what a standby's flush sent (nothing, ever), then the promoted flush. */
    async function standbyThenPromoted(): Promise<number> {
        setNodeRole('backup');
        let sent = 0;
        try {
            refusing.delete('a.example');
            const before = outs.length;
            sent = (await guests.flushGuestOutbox(Date.now() + 10 * 60_000)) + outs.length - before;
        } finally { setNodeRole('primary'); }
        return sent;
    }
    let c19 = 0;
    for (const tk of TK19) for (const cp of COPY19) {
        const n = ++c19;
        const { g, m, key, ok } = await row19(`Copy ${n}`);
        const id = crypto.randomUUID();
        const base = { myEdPrivHex: m.seedHex, groupKey: key, groupId: g, epoch: 1, messageId: id };
        const words = sealGroupLine(`copy row ${n}'s caption`, base);
        const photo = sealGroupLine(`data:image/jpeg;base64,${crypto.randomBytes(2000).toString('base64')}`, { ...base, part: 'attachment' });
        const edited = sealGroupLine(`copy row ${n}'s caption, edited`, base);
        const photoMark = photo.ciphertext.slice(0, 64);
        const carries = (s: string) => [words.ciphertext, photoMark, edited.ciphertext].some((k) => s.includes(k));
        const t0 = Date.now();
        refusing.add('a.example');
        const posted = await call('POST', m, `/api/groups/${g}/chat/message`, {
            type: 'image', ...words, metadata: { epoch: 1 }, attachment: { data: photo.ciphertext, nonce: photo.nonce, mime: 'image/jpeg' }, clientId: id,
        });
        await settle();
        const queued = rowsOf19(g);
        const setupOk = ok && posted.status === 201 && queued.some((r) => r.kind === 'line' && String(r.body).includes(photoMark));
        // The takedown: here, while this server stays main; otherwise on the server that took over, whose rows this server's
        // copy then carries verbatim, while its own queue keeps what it had (keptThroughCopy).
        if (tk === 'edited, then author delete') { await call('POST', m, '/api/messages/edit', { messageId: id, ...edited, metadata: { epoch: 1 } }); await settle(); }
        if (tk === 'author delete' || tk === 'edited, then author delete') await call('POST', m, '/api/messages/delete', { messageId: id });
        if (tk === 'convenor removal') await call('POST', ana, `/api/groups/${g}/chat/remove`, { messageId: id });
        if (tk === 'account deleted') purgeMemberSelf(m.pk);
        if (tk === 'group closed') closeGroupByVote(g, `test-close-19c-${n}`);
        await settle();
        let standbySent = 0;
        if (cp !== 'stays main') {
            keptThroughCopy(g, queued, cp.endsWith('a day later') ? QUEUE_MS + 60_000 : 0);
            standbySent = await standbyThenPromoted();
        }
        refusing.delete('a.example');
        await guests.flushGuestOutbox(Date.now() + 10 * 60_000);
        await settle();
        const wordsOut = outs.filter((o) => o.home === 'a.example' && o.body?.group === g && o.at >= t0 && carries(JSON.stringify(o.body))).length;
        const kept = rowsOf19(g).filter((r) => carries(String(r.body))).length;
        assert(setupOk && standbySent === 0 && wordsOut === 0 && kept === 0,
            `19c. ${tk} x ${cp}: no words or photo go (${wordsOut}${cp === 'stays main' ? '' : `; from the standby ${standbySent}`}), none kept here (${kept})${setupOk ? '' : ', setup failed'}`);
    }
    assert(c19 === TK19.length * COPY19.length, `19cz. the table has a row for every takedown and every copy state (${c19} rows)`);
    // No over-blocking: a line that still stands, queued before a take-over and a take-back, goes once, words and photo.
    {
        const { g, m, key, ok } = await row19('Copy standing');
        const id = crypto.randomUUID();
        const base = { myEdPrivHex: m.seedHex, groupKey: key, groupId: g, epoch: 1, messageId: id };
        const words = sealGroupLine('a line that still stands', base);
        const photo = sealGroupLine(`data:image/jpeg;base64,${crypto.randomBytes(2000).toString('base64')}`, { ...base, part: 'attachment' });
        const t0 = Date.now();
        refusing.add('a.example');
        await call('POST', m, `/api/groups/${g}/chat/message`, {
            type: 'image', ...words, metadata: { epoch: 1 }, attachment: { data: photo.ciphertext, nonce: photo.nonce, mime: 'image/jpeg' }, clientId: id,
        });
        await settle();
        const queued = rowsOf19(g);
        keptThroughCopy(g, queued, 0);
        const fromStandby = await standbyThenPromoted();
        await guests.flushGuestOutbox(Date.now() + 10 * 60_000);
        await settle();
        const went = outs.filter((o) => o.home === 'a.example' && o.body?.group === g && o.at >= t0 && o.body.kind === 'line' && o.body.data?.id === id
            && o.body.data.ciphertext === words.ciphertext && JSON.stringify(o.body).includes(photo.ciphertext.slice(0, 64))).length;
        assert(ok && queued.length === 1 && fromStandby === 0 && went === 1,
            `19c. no over-blocking: a line that still stands, queued before a take-over and a take-back, goes once with its words and photo (${went}; from the standby ${fromStandby})`);
    }
    // A row past GUEST_FANOUT_QUEUE_MS goes unsent, a line that still stands included; a takedown that old still goes.
    {
        const { g, m, key, ok } = await row19('Copy aged');
        const line1 = lineIn(m, g, key, 1), line2 = lineIn(m, g, key, 1);
        const t0 = Date.now();
        refusing.add('a.example');
        await call('POST', m, `/api/groups/${g}/chat/message`, line1);
        await call('POST', m, `/api/groups/${g}/chat/message`, line2);
        await settle();
        await call('POST', m, '/api/messages/delete', { messageId: line2.clientId });
        await settle();
        const queued = rowsOf19(g);
        db.prepare('UPDATE group_guest_outbox SET created_at = created_at - ?, next_try_at = ? WHERE group_id = ?').run(QUEUE_MS + 60_000, Date.now(), g);
        refusing.delete('a.example');
        await guests.flushGuestOutbox(Date.now() + 10 * 60_000);
        await settle();
        const toA = outs.filter((o) => o.home === 'a.example' && o.body?.group === g && o.at >= t0);
        const lines = toA.filter((o) => o.body.kind === 'line').length;
        const tombs = toA.filter((o) => o.body.kind === 'edit' && o.body.data?.id === line2.clientId && o.body.data.action === 'removed').length;
        assert(ok && queued.length === 2 && lines === 0 && tombs === 1 && rowsOf19(g).length === 0,
            `19c. a day in the queue: the line that still stands goes unsent (${lines}), the takedown still goes (${tombs}), nothing is left (${rowsOf19(g).length})`);
    }

    // ── 19d. A take-away outlasts what the home may hold (#3233 round 4) ────────────────────
    // The guest's home keeps a line it took, words and sealed photo, until each device has it or MAIL_HELD_DAYS pass, and
    // only a take-away (a line's takedown, the guest's removal) drops it sooner. So a take-away is offered for as long as
    // the home may still hold what it takes away, through a home down for an hour, a weekend or a month; a row that adds
    // still goes after a day.
    console.log('\n19d. Close the class: every take-away x how long its home was down -> the home gets it when it comes back, while it may hold what it takes away');
    const { MAIL_HELD_DAYS: HELD_DAYS19 } = await import('./engine/relay-mail.js');
    const DAY19 = 24 * 60 * 60_000;
    const HELD19 = HELD_DAYS19 * DAY19;
    const TA19 = ['author delete', 'convenor removal', 'account deleted', 'guest removed by a convenor', 'group closed',
        'author delete, then group closed', 'author delete, then the owners switch guests off',
        'author delete while the switch is off, on again before the timer'] as const;
    type Ta19 = (typeof TA19)[number];
    /** What the home gets of the take-aways once back: a line's takedown (by whom) or the guest's removal (why), in order. */
    const AWAY19: Record<Ta19, string> = {
        'author delete': 'takedown:author',
        'convenor removal': 'takedown:convenor',
        'account deleted': 'takedown:author',
        'guest removed by a convenor': 'removal:removed',
        'group closed': 'removal:group-closed',
        'author delete, then group closed': 'takedown:author removal:group-closed',
        'author delete, then the owners switch guests off': 'takedown:author removal:closed',
        'author delete while the switch is off, on again before the timer': 'takedown:author',
    };
    /**
     * How long the home was down after the take-away (its rows that old at the try that fails, then the home answers), and
     * whether the home must still get it: up to MAIL_HELD_DAYS it may hold the line, and a day more is the margin
     * (guestRowKeptMs: a line on the wire at the takedown, the home's own clock). Past both, the home holds and serves
     * nothing that old (test-group-guests-home 15d), and the row has gone here.
     */
    const DOWN19: Array<[string, number, boolean]> = [
        ['an hour', 60 * 60_000, true],
        ['25 hours', 25 * 60 * 60_000, true],
        [`${HELD_DAYS19 - 1} days`, HELD19 - DAY19, true],
        [`${HELD_DAYS19} days and 12 hours`, HELD19 + DAY19 / 2, true],
        [`${HELD_DAYS19 + 1} days and a minute`, HELD19 + DAY19 + 60_000, false],
    ];
    const switchTo19 = (on: boolean) => applyShapeChanges({ actor: olive.pk, actorRole: 'owner' }, { changes: { groupGuests: on } });
    let d19 = 0;
    for (const ta of TA19) for (const [down, age, reaches] of DOWN19) {
        const n = ++d19;
        const { g, m, x, key, ok } = await row19(`Away ${n}`);
        const id = crypto.randomUUID();
        const base = { myEdPrivHex: m.seedHex, groupKey: key, groupId: g, epoch: 1, messageId: id };
        const words = sealGroupLine(`away row ${n}'s caption`, base);
        const photo = sealGroupLine(`data:image/jpeg;base64,${crypto.randomBytes(2000).toString('base64')}`, { ...base, part: 'attachment' });
        const posted = await call('POST', m, `/api/groups/${g}/chat/message`, {
            type: 'image', ...words, metadata: { epoch: 1 }, attachment: { data: photo.ciphertext, nonce: photo.nonce, mime: 'image/jpeg' }, clientId: id,
        });
        await settle();
        // The home took the line (it holds it for the guest's devices), then goes down; the take-away's first try fails.
        const lineWent = outs.filter((o) => o.home === 'a.example' && o.body?.kind === 'line' && o.body.data?.id === id).length;
        refusing.add('a.example');
        const nTake = outs.length;
        let off = false, queued = 0, keptThroughTry = 0;
        try {
            if (ta.includes('while the switch is off')) { switchTo19(false); off = true; }
            if (ta.startsWith('author delete')) await call('POST', m, '/api/messages/delete', { messageId: id });
            if (ta.includes('on again before the timer')) { await settle(); switchTo19(true); off = false; }
            if (ta === 'convenor removal') await call('POST', ana, `/api/groups/${g}/chat/remove`, { messageId: id });
            if (ta === 'account deleted') purgeMemberSelf(m.pk);
            if (ta === 'guest removed by a convenor') await call('DELETE', ana, `/api/groups/${g}/guests/${x.pk}`);
            if (ta.endsWith('group closed')) closeGroupByVote(g, `test-close-19d-${n}`);
            if (ta.endsWith('switch guests off')) { switchTo19(false); off = true; guests.closeGuestsIfSwitchedOff(); }
            await settle();
            queued = rowsOf19(g).length;
            // Down for `age`: the try then fails (the backoff's sweep runs at it), and then the home answers.
            db.prepare('UPDATE group_guest_outbox SET created_at = created_at - ?, next_try_at = ? WHERE group_id = ?').run(age, Date.now(), g);
            await guests.flushGuestOutbox(Date.now() + 10 * 60_000);
            keptThroughTry = rowsOf19(g).length;
            refusing.delete('a.example');
            await guests.flushGuestOutbox(Date.now() + 10 * 60_000);
            await settle();
        } finally {
            refusing.delete('a.example');
            if (off) switchTo19(true);
        }
        const onlyX = (o: Out) => JSON.stringify(o.body.guests) === JSON.stringify([x.pk]);
        const got = outs.filter((o, i) => i >= nTake && o.home === 'a.example' && o.body?.group === g
            && (o.body.kind === 'removed' || (o.body.kind === 'edit' && o.body.data?.action === 'removed')))
            .map((o) => o.body.kind === 'removed' ? `removal:${o.body.data?.why}${onlyX(o) ? '' : '(other guests)'}`
                : `takedown:${o.body.data.by}${o.body.data.id === id && onlyX(o) && !('ciphertext' in o.body.data) ? '' : '(another line)'}`)
            .join(' ') || 'none';
        const want = reaches ? AWAY19[ta] : 'none';
        const left = rowsOf19(g).length;
        assert(ok && posted.status === 201 && lineWent === 1 && queued >= 1 && got === want && left === 0,
            `19d. ${ta} x home down ${down}: ${reaches ? `it gets ${want} when it comes back` : 'past what it may hold: none, and the row has gone'} (got ${got}; kept through the failed try ${keptThroughTry} of ${queued}; left here ${left})${ok && lineWent === 1 ? '' : ', setup failed'}`);
    }
    assert(d19 === TA19.length * DOWN19.length && Object.keys(AWAY19).length === TA19.length, `19dz. the table has a row for every take-away and every outage (${d19} rows)`);

    // The table: a row takes away exactly when it is a line's takedown or a removal; each take-away is kept at least as long as
    // a home may hold what it takes away (MAIL_HELD_DAYS), and each row that adds a day, no longer. An invitation (G2) adds,
    // and is kept as long as a take-away: its guest stays invited until they answer, and a removal queued before it is kept
    // that long, so a home down for more than a day got the removal and lost the invitation (guests-g2-must-include.md).
    const KINDS19: Array<[string, Record<string, unknown>]> = [
        ['invite', { name: 'g' }], ['roster', { name: 'g' }], ['line', { id: 'l' }], ['edit', { id: 'l', action: 'edited' }], ['epoch', { record: {} }],
        ['edit', { id: 'l', action: 'removed', by: 'author' }], ['removed', { why: 'removed' }], ['removed', { why: 'closed' }], ['removed', { why: 'group-closed' }],
        ['edit', { ids: ['l', 'm'], action: 'removed', by: 'author' }],
    ];
    for (const [kind, data] of KINDS19) {
        const away = kind === 'removed' || (kind === 'edit' && data.action === 'removed');
        const long = away || kind === 'invite';
        const label = `${kind}${data.ids ? ' of many lines' : ''}${data.action ? ` ${data.action}` : data.why ? ` (${data.why})` : ''}`;
        const kept = typeof guests?.guestRowKeptMs === 'function' ? guests.guestRowKeptMs(kind, data) as number : NaN;
        const says = typeof guests?.takesAway === 'function' ? guests.takesAway(kind, data) as boolean : null;
        assert(says === away && (long ? kept >= HELD19 : kept === QUEUE_MS),
            `19d. table: ${label} ${away ? `takes away: kept ${kept / DAY19} days, at least the ${HELD_DAYS19} a home may hold what it takes away`
                : long ? `adds, an invitation: kept ${kept / DAY19} days, at least the ${HELD_DAYS19} a removal before it is kept`
                : `adds: kept ${kept / DAY19} day(s), no longer than ${QUEUE_MS / DAY19}`} (takesAway says ${says})`);
    }

    // No over-retention: each row that adds, queued while its home is down, goes unsent once a day old, and none is left;
    // an invitation (G2) is kept, and goes once its home answers.
    {
        const { g, m, key, ok } = await row19('Adds aged');
        const sent = lineIn(m, g, key, 1);
        await call('POST', m, `/api/groups/${g}/chat/message`, sent);
        await settle();
        refusing.add('a.example');
        const nAdd = outs.length;
        let kinds = '';
        try {
            await call('POST', m, '/api/messages/edit', { messageId: sent.clientId, ...sealGroupLine('new words', { myEdPrivHex: m.seedHex, groupKey: key, groupId: g, epoch: 1, messageId: sent.clientId }), metadata: { epoch: 1 } });
            await call('POST', m, `/api/groups/${g}/chat/message`, lineIn(m, g, key, 1));
            guests.queueGroupRoster(g);
            guests.fanOutGroupEpoch(g, 1);
            await call('POST', ana, `/api/groups/${g}/guests`, { card: await cardOf(newId('Y-adds'), 'a.example') });
            await settle();
            kinds = rowsOf19(g).map((r) => r.kind).sort().join(' ');
            db.prepare('UPDATE group_guest_outbox SET created_at = created_at - ?, next_try_at = ? WHERE group_id = ?').run(25 * 60 * 60_000, Date.now(), g);
            await guests.flushGuestOutbox(Date.now() + 10 * 60_000);
            refusing.delete('a.example');
            await guests.flushGuestOutbox(Date.now() + 10 * 60_000);
            await settle();
        } finally { refusing.delete('a.example'); }
        for (const kind of ['edit', 'epoch', 'line', 'roster']) {
            const went = outs.filter((o, i) => i >= nAdd && o.home === 'a.example' && o.body?.group === g && o.body.kind === kind).length;
            const left = rowsOf19(g).filter((r) => r.kind === kind).length;
            assert(ok && kinds === 'edit epoch invite line roster' && went === 0 && left === 0,
                `19d. no over-retention: ${({ edit: 'an edit with new words', epoch: 'an epoch', line: 'a line', roster: 'a roster' } as Record<string, string>)[kind]} queued while its home is down goes unsent once 25 hours old (${went}), none left (${left})${kinds === 'edit epoch invite line roster' ? '' : `, setup queued ${kinds}`}`);
        }
        const invites = outs.filter((o, i) => i >= nAdd && o.home === 'a.example' && o.body?.group === g && o.body.kind === 'invite').length;
        const invitesLeft = rowsOf19(g).filter((r) => r.kind === 'invite').length;
        assert(ok && kinds === 'edit epoch invite line roster' && invites === 1 && invitesLeft === 0,
            `19d. an invitation queued while its home is down, 25 hours old, is kept and goes once its home answers (went ${invites}, left ${invitesLeft})`);
    }

    // ── 19f. The send rule (#3233 round 5): every row x every change after it was queued x its age ──
    // A row waits here for its home (down, or this server a standby) while what it says changes: on this server, or on the
    // server that took over, whose writes this server's copy carries. So as each row's turn comes it is checked again against
    // this server's state AT THE SEND (group-guests.ts SEND_RULES), and goes only while what it says is still true. Each
    // change below is written straight into the tables, as the server that took over writes it and this server's copy
    // carries it, while this server is a standby; then it takes back. This server's own hooks at a change (its withdrawals
    // and new rows) never run, so only the check at the send stands between the row and the wire.
    console.log('\n19f. Close the class: every row this server queues x every change after it was queued x its age -> it goes, or goes unsent, as this server stands at the send');
    const { addConnector: block19f, removeConnector: unblock19f } = await import('./connector-manager.js');
    const ROWS19F = ['line', 'edit (new words)', 'edit (takedown)', 'epoch', 'roster', 'invite', 'removal'] as const;
    type Row19f = (typeof ROWS19F)[number];
    const KIND19F: Record<Row19f, string> = {
        line: 'line', 'edit (new words)': 'edit', 'edit (takedown)': 'edit', epoch: 'epoch', roster: 'roster', invite: 'invite', removal: 'removed',
    };
    const CH19F = ['none', 'line removed', 'line edited', 'guest removed', 'guest re-invited and in', 'guest re-invited, not yet in', 'guest left', 'group closed', 'take-over', 'take-back', 'home blocked'] as const;
    type Ch19f = (typeof CH19F)[number];
    const AGES19F: Array<[string, number]> = [
        ['fresh', 0], ['past a day', QUEUE_MS + 60_000], [`past ${HELD_DAYS19} days`, HELD19 + DAY19 / 2], [`past ${HELD_DAYS19} days and a day`, HELD19 + DAY19 + 60_000],
    ];
    const GO = 'goes', NEWEST = 'goes, newest words', DROP = 'dropped', WAIT = 'waits';
    const cols19f = (...v: string[]): Record<Ch19f, string> => Object.fromEntries(CH19F.map((c, i) => [c, v[i]])) as Record<Ch19f, string>;
    /**
     * A fresh row, by the change after it was queued. The line changes act on the row's own line (a line, an edit, a
     * takedown) or, for the others, on a line of the group already sent. A takedown always goes (a line once down stays down);
     * a removal goes naming only the guests not in here now; nothing waits on a standby but waits; nothing goes to a home the
     * owners blocked, take-aways included (design §4.2). Invited again but not yet in, a removal still goes: on one server
     * their new invitation is queued behind it, and their home shows an invitation only once it has them out (it holds
     * nothing for an invitation to a guest it has in).
     */
    const FRESH19F: Record<Row19f, Record<Ch19f, string>> = {
        //                          none line removed line edited guest removed re-invited, in re-invited, not in guest left group closed take-over take-back home blocked
        line:               cols19f(GO,  DROP,        NEWEST,     DROP,         GO,            DROP,               DROP,      DROP,        WAIT,     GO,       DROP),
        'edit (new words)': cols19f(GO,  DROP,        NEWEST,     DROP,         GO,            DROP,               DROP,      DROP,        WAIT,     GO,       DROP),
        'edit (takedown)':  cols19f(GO,  GO,          GO,         GO,           GO,            GO,                 GO,        GO,          WAIT,     GO,       DROP),
        epoch:              cols19f(GO,  GO,          GO,         DROP,         GO,            DROP,               DROP,      DROP,        WAIT,     GO,       DROP),
        roster:             cols19f(GO,  GO,          GO,         DROP,         GO,            DROP,               DROP,      DROP,        WAIT,     GO,       DROP),
        invite:             cols19f(GO,  GO,          GO,         DROP,         DROP,          GO,                 DROP,      DROP,        WAIT,     GO,       DROP),
        removal:            cols19f(GO,  GO,          GO,         GO,           DROP,          GO,                 GO,        GO,          WAIT,     GO,       DROP),
    };
    /**
     * A row that takes away, or an invitation (G2), is kept MAIL_HELD_DAYS and a day, one that adds a day; past it, it goes
     * unsent (a standby keeps it).
     */
    const want19f = (r: Row19f, ch: Ch19f, age: number): string => {
        const fresh = FRESH19F[r][ch];
        if (fresh === WAIT || fresh === DROP) return fresh;
        const kept = r === 'edit (takedown)' || r === 'removal' || r === 'invite' ? HELD19 + QUEUE_MS : QUEUE_MS;
        return age >= kept ? DROP : fresh;
    };
    /** One group for a row: X from a.example in (invited only, for an invitation), the row queued while a.example refuses. */
    async function setup19f(r: Row19f) {
        const label = `Send ${r}`;
        let g: string, m: Id, x: Id, key: Uint8Array, ok: boolean;
        if (r === 'invite') {
            g = createGroup({ name: label, joinPolicy: 'open', createdBy: ana.pk }).id;
            m = addLocal(`M-${label}`);
            db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status, from_epoch) VALUES (?, ?, 'member', 'active', 1)`).run(g, m.pk);
            const e = epochBy(ana, g, 1, 'start', [ana, m]);
            ok = (await call('POST', ana, `/api/groups/${g}/keys/epoch`, { epoch: e.record })).status === 201;
            key = e.groupKey;
            x = newId(`X-${label}`);
        } else ({ g, m, x, key, ok } = await row19(label));
        const L = lineIn(m, g, key, 1);
        const seal = (text: string) => sealGroupLine(text, { myEdPrivHex: m.seedHex, groupKey: key, groupId: g, epoch: 1, messageId: L.clientId });
        if (r !== 'line') {
            refusing.delete('a.example');
            ok = (await call('POST', m, `/api/groups/${g}/chat/message`, L)).status === 201 && ok;
            await settle();
        }
        refusing.add('a.example');
        try {
            if (r === 'line') ok = (await call('POST', m, `/api/groups/${g}/chat/message`, L)).status === 201 && ok;
            if (r === 'edit (new words)') ok = (await call('POST', m, '/api/messages/edit', { messageId: L.clientId, ...seal('words edited here'), metadata: { epoch: 1 } })).status === 200 && ok;
            if (r === 'edit (takedown)') ok = (await call('POST', m, '/api/messages/delete', { messageId: L.clientId })).status === 200 && ok;
            if (r === 'epoch') ok = (await call('POST', ana, `/api/groups/${g}/keys/epoch`, { epoch: epochBy(ana, g, 2, 'rotate', [ana, m, x]).record })).status === 201 && ok;
            if (r === 'roster') guests.queueGroupRoster(g);
            if (r === 'invite') ok = (await call('POST', ana, `/api/groups/${g}/guests`, { card: await cardOf(x, 'a.example') })).status < 300 && ok;
            if (r === 'removal') ok = (await call('DELETE', ana, `/api/groups/${g}/guests/${x.pk}`)).status === 200 && ok;
            await settle();
        } finally { refusing.delete('a.example'); }
        const action = r === 'edit (takedown)' ? 'removed' : r === 'edit (new words)' ? 'edited' : undefined;
        const row = (db.prepare("SELECT * FROM group_guest_outbox WHERE group_id = ? AND home = 'a.example' AND kind = ? ORDER BY created_at DESC, rowid DESC").all(g, KIND19F[r]) as Array<Record<string, any>>)
            .find((q) => action === undefined || JSON.parse(q.body).data?.action === action);
        db.prepare('DELETE FROM group_guest_outbox WHERE group_id = ?').run(g);
        const guestRows = db.prepare('SELECT * FROM group_guests WHERE group_id = ?').all(g) as Array<Record<string, unknown>>;
        const lineRow = db.prepare('SELECT type, ciphertext, nonce, metadata, edited_at FROM messages WHERE id = ?').get(L.clientId) as Record<string, unknown> | undefined;
        const named = row ? JSON.parse(row.body).guests : null;
        return { g, m, x, L, row, guestRows, lineRow, edited: seal('words written on the server that took over'), ok: ok && !!row && !!lineRow && JSON.stringify(named) === JSON.stringify([x.pk]) };
    }
    type Setup19f = Awaited<ReturnType<typeof setup19f>>;
    /** The group's tables as they were when the row was queued, and the row back in this server's own queue, `age` old. */
    function restore19f(s: Setup19f, age: number): void {
        db.prepare('DELETE FROM group_guest_outbox WHERE group_id = ?').run(s.g);
        db.prepare('DELETE FROM group_closures WHERE group_id = ?').run(s.g);
        db.prepare('DELETE FROM group_guests WHERE group_id = ?').run(s.g);
        for (const gr of s.guestRows) {
            const c = Object.keys(gr);
            db.prepare(`INSERT INTO group_guests (${c.join(', ')}) VALUES (${c.map(() => '?').join(', ')})`).run(...c.map((k) => gr[k]));
        }
        const l = s.lineRow!;
        db.prepare('UPDATE messages SET type = ?, ciphertext = ?, nonce = ?, metadata = ?, edited_at = ? WHERE id = ?').run(l.type, l.ciphertext, l.nonce, l.metadata, l.edited_at, s.L.clientId);
        const at = Date.now() - age;
        db.prepare('INSERT INTO group_guest_outbox (id, group_id, home, kind, body, attempts, next_try_at, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
            .run(s.row!.id, s.g, s.row!.home, s.row!.kind, s.row!.body, at, at);
    }
    /** The change, as the server that took over writes it and this server's copy carries it (no hook of this server runs). */
    function change19f(s: Setup19f, ch: Ch19f): void {
        const setX = (state: string) => db.prepare('UPDATE group_guests SET state = ?, state_at = ? WHERE group_id = ? AND guest_key = ?').run(state, new Date().toISOString(), s.g, s.x.pk);
        if (ch === 'line removed') db.prepare(`UPDATE messages SET type = 'removed', ciphertext = '', nonce = 'plaintext-v1', metadata = ? WHERE id = ?`).run(JSON.stringify({ epoch: 1, removedBy: s.m.pk }), s.L.clientId);
        // A line once down stays down: nothing edits a takedown's line.
        if (ch === 'line edited') db.prepare("UPDATE messages SET ciphertext = ?, nonce = ?, edited_at = ? WHERE id = ? AND type != 'removed'").run(s.edited.ciphertext, s.edited.nonce, new Date().toISOString(), s.L.clientId);
        if (ch === 'guest removed') setX('removed');
        if (ch === 'guest re-invited and in') setX('in');
        if (ch === 'guest re-invited, not yet in') setX('invited');
        if (ch === 'guest left') setX('left');
        if (ch === 'group closed') {
            db.prepare('INSERT INTO group_closures (group_id, decision_id, closed_at) VALUES (?, ?, ?)').run(s.g, 'test-close-19f', new Date().toISOString());
            db.prepare("UPDATE group_guests SET state = 'removed', state_at = ? WHERE group_id = ? AND state IN ('invited', 'in')").run(new Date().toISOString(), s.g);
        }
        if (ch === 'home blocked') block19f('a.example:4001', 'blocked', 'Blocked', 'https://a.example', false);
    }
    let f19 = 0;
    for (const r of ROWS19F) {
        const s = await setup19f(r);
        for (const ch of CH19F) for (const [ageLabel, age] of AGES19F) {
            f19++;
            if (!s.ok) { assert(false, `19f. ${r} x ${ch} x ${ageLabel}: setup failed`); continue; }
            restore19f(s, age);
            const nOut = outs.length;
            let fromStandby = 0, got = '', left = -1;
            try {
                if (ch !== 'none' && ch !== 'take-over' && ch !== 'take-back') change19f(s, ch);
                if (ch !== 'none') {
                    setNodeRole('backup');
                    fromStandby = await guests.flushGuestOutbox(Date.now() + 10 * 60_000) + outs.length - nOut;
                    if (ch !== 'take-over') setNodeRole('primary');
                }
                if (ch !== 'take-over') await guests.flushGuestOutbox(Date.now() + 10 * 60_000);
                left = db.prepare('SELECT COUNT(*) FROM group_guest_outbox WHERE group_id = ?').pluck().get(s.g) as number;
                db.prepare('DELETE FROM group_guest_outbox WHERE group_id = ?').run(s.g);
            } finally {
                setNodeRole('primary');
                if (ch === 'home blocked') unblock19f('a.example:4001');
            }
            const sent = outs.slice(nOut).filter((o) => o.home === 'a.example' && o.body?.group === s.g);
            const mine = sent.filter((o) => o.body.kind === s.row!.kind);
            if (sent.length > mine.length) got = `${sent.length - mine.length} other row(s) sent`;
            else if (!mine.length) got = left === 0 ? DROP : left === 1 ? WAIT : `${left} left`;
            else if (mine.length > 1) got = `${mine.length} sent`;
            else {
                const b = mine[0].body;
                const words = b.data?.ciphertext === s.edited.ciphertext ? 'newest' : b.data?.ciphertext === JSON.parse(s.row!.body).data?.ciphertext ? 'as queued' : 'other';
                got = JSON.stringify(b.guests) !== JSON.stringify([s.x.pk]) ? `goes naming ${JSON.stringify(b.guests)?.length ?? 0} chars of others`
                    : (r === 'line' || r === 'edit (new words)') ? (ch === 'line edited' ? (words === 'newest' ? NEWEST : `goes, ${words} words`) : words === 'as queued' ? GO : `goes, ${words} words`)
                    : GO;
                if (left !== 0) got += ` (${left} left)`;
            }
            const want = want19f(r, ch, age);
            assert(got === want && fromStandby === 0,
                `19f. ${r} x ${ch} x ${ageLabel}: ${want} (got ${got}${fromStandby ? `; the standby sent ${fromStandby}` : ''})`);
        }
    }

    // Narrowed, never widened: a row naming two guests at one home goes naming only those it may still name (an epoch with
    // only their wraps); a removal names only those not in here now.
    {
        const NARROW19F: Array<[string, string]> = [['line', 'Y removed'], ['edit (new words)', 'Y left'], ['epoch', 'Y removed'], ['removal', 'Y re-invited and in']];
        for (const [r, ch] of NARROW19F) {
            const g = createGroup({ name: `Narrow ${r}`, joinPolicy: 'open', createdBy: ana.pk }).id;
            const m = addLocal(`M-narrow-${r}`);
            db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status, from_epoch) VALUES (?, ?, 'member', 'active', 1)`).run(g, m.pk);
            const x = newId(`X-narrow-${r}`), y = newId(`Y-narrow-${r}`);
            for (const who of [x, y]) {
                await call('POST', ana, `/api/groups/${g}/guests`, { card: await cardOf(who, 'a.example') });
                await bring([await item(who, 'a.example', `group:${g}`, 'group-invite', yes)]);
            }
            const e = epochBy(ana, g, 1, 'start', [ana, m, x, y]);
            let ok = (await call('POST', ana, `/api/groups/${g}/keys/epoch`, { epoch: e.record })).status === 201 && stateOf(g, x) === 'in' && stateOf(g, y) === 'in';
            const L = lineIn(m, g, e.groupKey, 1);
            if (r !== 'line') { ok = (await call('POST', m, `/api/groups/${g}/chat/message`, L)).status === 201 && ok; await settle(); }
            refusing.add('a.example');
            try {
                if (r === 'line') await call('POST', m, `/api/groups/${g}/chat/message`, L);
                if (r === 'edit (new words)') await call('POST', m, '/api/messages/edit', { messageId: L.clientId, ...sealGroupLine('narrowed words', { myEdPrivHex: m.seedHex, groupKey: e.groupKey, groupId: g, epoch: 1, messageId: L.clientId }), metadata: { epoch: 1 } });
                if (r === 'epoch') await call('POST', ana, `/api/groups/${g}/keys/epoch`, { epoch: epochBy(ana, g, 2, 'rotate', [ana, m, x, y]).record });
                if (r === 'removal') guests.closeGroupGuests(g);
                await settle();
            } finally { refusing.delete('a.example'); }
            const kind = KIND19F[r as Row19f];
            const row = (db.prepare("SELECT * FROM group_guest_outbox WHERE group_id = ? AND home = 'a.example' AND kind = ? ORDER BY created_at DESC").all(g, kind) as Array<Record<string, any>>)[0];
            const both = JSON.stringify([x.pk, y.pk].sort());
            ok = ok && !!row && JSON.stringify(JSON.parse(row.body).guests) === both;
            db.prepare('DELETE FROM group_guest_outbox WHERE group_id = ?').run(g);
            if (row) db.prepare('INSERT INTO group_guest_outbox (id, group_id, home, kind, body, attempts, next_try_at, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)').run(row.id, g, row.home, row.kind, row.body, Date.now(), Date.now());
            db.prepare('UPDATE group_guests SET state = ? WHERE group_id = ? AND guest_key = ?').run(ch === 'Y removed' ? 'removed' : ch === 'Y left' ? 'left' : 'in', g, y.pk);
            const nOut = outs.length;
            await guests.flushGuestOutbox(Date.now() + 10 * 60_000);
            const went = outs.slice(nOut).filter((o) => o.home === 'a.example' && o.body?.group === g && o.body.kind === kind);
            const b = went[0]?.body;
            const wrapsTo = r === 'epoch' ? [...new Set(((b?.data?.wraps ?? []) as Array<{ recipient: string }>).map((w) => w.recipient))].sort() : null;
            const namesX = went.length === 1 && JSON.stringify(b.guests) === JSON.stringify([x.pk]) && (wrapsTo === null || JSON.stringify(wrapsTo) === JSON.stringify([x.pk]));
            assert(ok && namesX,
                `19f. narrowed: ${r} naming X and Y x ${ch}: it goes naming X alone${r === 'epoch' ? ', with only X\'s wraps' : ''} (sent ${went.length}, naming ${b ? (JSON.stringify(b.guests) === JSON.stringify([x.pk]) ? 'X' : JSON.stringify(b.guests) === both ? 'X and Y' : 'others') : 'nobody'}${wrapsTo ? `, wraps to ${wrapsTo.length}` : ''})${ok ? '' : ', setup failed'}`);
        }
    }

    // The guard: the row kinds come from the code (the list the send rule is keyed by, the outbox table's CHECK, and every
    // kind queueToHome is called with), each has its rule in words, and each is in the table above, so a new kind can't
    // skip it.
    {
        const listed = ((guests?.GUEST_NOTICE_KINDS ?? []) as string[]).slice().sort();
        const outboxSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'group_guest_outbox'").pluck().get() as string;
        const checked = [...(/kind\s+TEXT NOT NULL CHECK \(kind IN \(([^)]*)\)\)/.exec(outboxSql)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
        const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'engine', 'group-guests.ts'), 'utf8')
            .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join('\n');
        const queuedKinds = [...new Set([...src.matchAll(/queueToHome\(\s*[\w.]+,\s*[\w.]+,\s*[^,()]+,\s*'([a-z-]+)'/g)].map((x) => x[1]))].sort();
        const rules = (guests?.GUEST_ROW_RULES ?? {}) as Record<string, unknown>;
        const noRule = listed.filter((k) => typeof rules[k] !== 'string' || !(rules[k] as string).trim());
        const inTable = new Set(Object.values(KIND19F));
        const notInTable = listed.filter((k) => !inTable.has(k));
        assert(listed.length > 0 && JSON.stringify(listed) === JSON.stringify(checked),
            `19fz. the send rule's kinds are the outbox table's kinds (code ${listed.join(' ') || 'none'}; table ${checked.join(' ')})`);
        assert(listed.length > 0 && JSON.stringify(listed) === JSON.stringify(queuedKinds),
            `19fz. every kind queued for a guest's home is one the send rule is keyed by, and each is queued (queued ${queuedKinds.join(' ')})`);
        assert(listed.length > 0 && noRule.length === 0 && Object.keys(rules).sort().join(' ') === listed.join(' '),
            `19fz. every kind has its send rule in words (none for ${noRule.join(' ') || 'no kind'})`);
        assert(listed.length > 0 && notInTable.length === 0 && f19 === ROWS19F.length * CH19F.length * AGES19F.length,
            `19fz. the table has rows for every kind (missing ${notInTable.join(' ') || 'none'}) x every change x every age (${f19} rows)`);
    }

    // ── 20. The order rule (G2): a counter on every word of where a guest stands; homes told again; an account's many lines ──
    console.log('\n20. The order rule (G2): the counter, telling homes again after a take-over, a take-back end to end, and an account with years of lines');
    refusing.delete('a.example');
    const T20 = 1_800_000_000_000;
    const NEXT20: Array<[string, number | null, number]> = [
        ['no counter yet: the clock', null, T20], ['the last behind the clock (from a copy before): the clock', T20 - 5000, T20],
        ['the last ahead of the clock (the other server\'s clock ahead, or two in one millisecond): one past it', T20 + 5000, T20 + 5001],
        ['the last at the clock: one past it', T20, T20 + 1],
    ];
    for (const [label, last, want] of NEXT20) {
        const got = typeof guests?.nextGuestSeq === 'function' ? guests.nextGuestSeq(last, T20) : null;
        assert(got === want, `20a. the next counter, ${label} (got ${got})`);
    }
    const clockOf20 = (g: string) => db.prepare('SELECT seq FROM group_guest_clock WHERE group_id = ?').pluck().get(g) as number | undefined;
    const toldOf20 = (g: string) => db.prepare('SELECT seq FROM group_guest_told WHERE group_id = ?').pluck().get(g) as number | undefined;
    const sentTo20 = (g: string, from: number) => outs.slice(from).filter((o) => o.home === 'a.example' && o.body?.group === g).map((o) => o.body);
    const same20 = (a: unknown, b: unknown[]) => JSON.stringify(a) === JSON.stringify([...b].sort());

    // 20b. What carries the counter: every word of where a guest stands (an invitation, the roster, a removal) and a line's
    // takedown, rising in the order sent; a line, an edit's new words and an epoch carry none.
    {
        const nB = outs.length;
        const c = await row19('Order counters');
        const posted = lineIn(c.m, c.g, c.key, 1);
        await call('POST', c.m, `/api/groups/${c.g}/chat/message`, posted);
        await settle();
        await call('POST', c.m, '/api/messages/delete', { messageId: posted.clientId });
        await settle();
        try { guests.removeGroupGuest(c.g, ana.pk, c.x.pk); } catch { /* counted below */ }
        await settle();
        const sent = sentTo20(c.g, nB);
        const stands = (b: any) => b.kind === 'invite' || b.kind === 'roster' || b.kind === 'removed' || (b.kind === 'edit' && b.data?.action === 'removed');
        const ordered = sent.filter(stands);
        const seqs = ordered.map((b) => b.seq);
        const rising = seqs.every((s, i) => Number.isSafeInteger(s) && s > 0 && (i === 0 || s > seqs[i - 1]));
        const kinds = [...new Set(ordered.map((b) => (b.kind === 'edit' ? 'takedown' : b.kind)))].sort().join(' ');
        const bare = sent.filter((b) => !stands(b));
        assert(c.ok && kinds === 'invite removed roster takedown' && rising,
            `20b. an invitation, the roster, a line's takedown and a removal each carry the group's counter, rising in the order sent (${ordered.map((b) => `${b.kind}:${b.seq ?? 'none'}`).join(' ')})`);
        assert(c.ok && bare.length >= 2 && bare.every((b) => b.seq === undefined) && bare.some((b) => b.kind === 'line') && bare.some((b) => b.kind === 'epoch'),
            `20b. a line and an epoch carry none (${bare.map((b) => `${b.kind}:${b.seq ?? 'none'}`).join(' ')})`);
        assert(seqs.length > 0 && clockOf20(c.g) === seqs[seqs.length - 1] && toldOf20(c.g) === clockOf20(c.g),
            `20b. the group's counter (a copied table) is the last one sent, and this server's own record says it issued it (${clockOf20(c.g)}, ${toldOf20(c.g)})`);
    }

    // 20c. Telling homes again: (the server that took over issued counters, which its copy carries / a promoted standby, which
    // has no record of its own / nothing changed, as at a restart of the main server) x (what stands on this server: an
    // invitation still waiting, a removal 2 days ago and one 32 days ago, a line taken down 2 days ago and one 32 days ago,
    // a guest in) -> told again under new counters, or not: within the time a home may hold what a take-away drops, never past it.
    const SC20 = ['the server that took over issued counters (its copy carries them)', 'a promoted standby, with no record of its own', 'nothing changed (a restart of the main server)'] as const;
    const ITEMS20 = ['the invitation still waiting', 'the removal 2 days ago', 'the removal 32 days ago', 'the line taken down 2 days ago', 'the line taken down 32 days ago', 'the roster'] as const;
    const RETOLD20: Record<(typeof ITEMS20)[number], boolean> = {
        'the invitation still waiting': true, 'the removal 2 days ago': true, 'the removal 32 days ago': false,
        'the line taken down 2 days ago': true, 'the line taken down 32 days ago': false, 'the roster': true,
    };
    const iso20 = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
    let c20 = 0;
    for (const sc of SC20) {
        const n = ++c20;
        const s = await row19(`Retell ${n}`);
        const inv = newId(`I-retell-${n}`), r2 = newId(`R2-retell-${n}`), r32 = newId(`R32-retell-${n}`);
        const invited = await call('POST', ana, `/api/groups/${s.g}/guests`, { card: await cardOf(inv, 'a.example') });
        const putGuest = db.prepare(`INSERT INTO group_guests (group_id, guest_key, home, name, state, invited_by, invited_at, state_at) VALUES (?, ?, 'a.example', ?, 'removed', ?, ?, ?)`);
        putGuest.run(s.g, r2.pk, 'Rita', ana.pk, iso20(3 * DAY19), iso20(2 * DAY19));
        putGuest.run(s.g, r32.pk, 'Rory', ana.pk, iso20(40 * DAY19), iso20(32 * DAY19));
        const putDown = db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata, timestamp) VALUES (?, ?, ?, 'eA==', 'plaintext-v1', 'removed', ?, ?)`);
        const l2 = crypto.randomUUID(), l32 = crypto.randomUUID();
        putDown.run(l2, s.g, s.m.pk, JSON.stringify({ epoch: 1, removed: true, removedBy: s.m.pk, removedAt: iso20(2 * DAY19) }), iso20(3 * DAY19));
        putDown.run(l32, s.g, s.m.pk, JSON.stringify({ epoch: 1, removed: true, removedBy: s.m.pk, removedAt: iso20(32 * DAY19) }), iso20(33 * DAY19));
        await settle();
        if (sc === SC20[0]) db.prepare('UPDATE group_guest_clock SET seq = seq + 1000 WHERE group_id = ?').run(s.g);
        if (sc === SC20[1]) db.prepare('DELETE FROM group_guest_told WHERE group_id = ?').run(s.g);
        const copy = clockOf20(s.g) ?? 0;
        const nR = outs.length;
        await guests.flushGuestOutbox();
        await settle();
        const sent = sentTo20(s.g, nR);
        const names = (b: any, id: string) => b.data?.id === id || (Array.isArray(b.data?.ids) && b.data.ids.includes(id));
        const fresh = (b: any) => Number.isSafeInteger(b.seq) && b.seq > copy;
        const got: Record<(typeof ITEMS20)[number], boolean> = {
            'the invitation still waiting': sent.some((b) => b.kind === 'invite' && same20(b.guests, [inv.pk]) && fresh(b)),
            'the removal 2 days ago': sent.some((b) => b.kind === 'removed' && b.guests.includes(r2.pk) && fresh(b)),
            'the removal 32 days ago': sent.some((b) => b.kind === 'removed' && b.guests.includes(r32.pk)),
            'the line taken down 2 days ago': sent.some((b) => b.kind === 'edit' && b.data?.action === 'removed' && names(b, l2) && same20(b.guests, [s.x.pk]) && fresh(b)),
            'the line taken down 32 days ago': sent.some((b) => b.kind === 'edit' && names(b, l32)),
            'the roster': sent.some((b) => b.kind === 'roster' && same20(b.guests, [s.x.pk]) && fresh(b)),
        };
        const retell = sc !== SC20[2];
        for (const it of ITEMS20) {
            const want = retell && RETOLD20[it];
            assert(s.ok && invited.status < 300 && got[it] === want, `20c. ${sc} x ${it}: ${want ? 'told again, under a new counter' : 'not told again'} (got ${got[it] ? 'told' : 'not told'})`);
        }
        const nAgain = outs.length;
        await guests.flushGuestOutbox();
        await settle();
        assert(toldOf20(s.g) === clockOf20(s.g) && sentTo20(s.g, nAgain).length === 0,
            `20c. ${sc}: this server's record caught up with the counter (${toldOf20(s.g)} / ${clockOf20(s.g)}), and the next flush tells nothing again (${sentTo20(s.g, nAgain).length})`);
    }

    // 20d. A take-over and a take-back, end to end (#3233 round 5's measured case, under the order rule): this server queues X's
    // removal while X's home is down; the server that took over invites X again (its copy reaches this server: X invited,
    // its counter past the removal's), and its own invitation row never comes here. Taken back, this server sends the removal
    // (X isn't in) and then the invitation, told again under a counter past both: X's home ends with the invitation,
    // whichever order the two reach it in (test-group-guests-home §16).
    {
        const t = await row19('Order take-back');
        refusing.add('a.example');
        try { guests.removeGroupGuest(t.g, ana.pk, t.x.pk); } catch { /* counted below */ }
        await settle();
        const removal = rowsOf19(t.g).find((r) => r.kind === 'removed');
        const s1 = removal ? JSON.parse(removal.body).seq as number : NaN;
        setNodeRole('backup');
        try {
            db.prepare("UPDATE group_guests SET state = 'invited', state_at = ? WHERE group_id = ? AND guest_key = ?").run(new Date().toISOString(), t.g, t.x.pk);
            db.prepare('UPDATE group_guest_clock SET seq = ? WHERE group_id = ?').run(s1 + 10, t.g);
        } finally { setNodeRole('primary'); }
        refusing.delete('a.example');
        const nT = outs.length;
        await guests.flushGuestOutbox(Date.now() + 10 * 60_000);
        await settle();
        const sent = sentTo20(t.g, nT);
        const line = sent.map((b) => `${b.kind}(${same20(b.guests, [t.x.pk]) ? 'X' : 'others'})`).join(' ');
        const inv = sent.find((b) => b.kind === 'invite');
        assert(t.ok && line === 'removed(X) invite(X)' && sent[0]?.seq === s1 && inv?.seq > s1 + 10,
            `20d. taken back: X's removal goes as queued, then X's invitation, told again under a counter past both (sent ${line}; counters ${sent.map((b) => b.seq).join(' ')}, the copy's ${s1 + 10})`);
    }

    // 20e. An account with years of lines (#3233 round 2 note): 5,000 lines in a group with a guest, the last 500 still queued
    // for the guest's home, which is down. Deleting the account takes every line down in one read of the queue and one
    // request per TAKEDOWN_IDS_MAX lines to that home, never one a line. The time budget is a ratio to a baseline measured in
    // the same run, in the same loop (scripts/flake-patterns.mjs fixed-ms-bound): a tenth of the lines with a tenth queued.
    // One rule for many lines grows with the lines (about 10 times); one request a line, each reading the queue, grows with
    // the lines times the queue (about 100 times: 22,182 ms on main against 127 ms here).
    const RATIO20 = 30;
    const purges20: Array<{ n: number; ms: number }> = [];
    for (const [N, QUEUED] of [[500, 50], [5000, 500]] as const) {
        const p = await row19(`Order purge ${N}`);
        refusing.add('a.example');
        const ids: string[] = [];
        const put = db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata, timestamp) VALUES (?, ?, ?, ?, 'group-xc20p-v1:n', 'text', ?, ?)`);
        const base = Date.now();
        db.transaction(() => {
            for (let i = 0; i < N; i++) {
                const id = crypto.randomUUID();
                ids.push(id);
                put.run(id, p.g, p.m.pk, crypto.randomBytes(48).toString('base64'), JSON.stringify({ epoch: 1 }), new Date(base - (N - i) * 60_000).toISOString());
            }
        })();
        db.transaction(() => { for (const id of ids.slice(-QUEUED)) guests.fanOutGroupLine(p.g, id, p.m.pk); })();
        await settle();
        const queuedLines = rowsOf19(p.g).filter((r) => r.kind === 'line').length;
        const t0 = performance.now();
        let purged: { ok: boolean } | null = null;
        try { purged = purgeMemberSelf(p.m.pk); } catch { purged = null; }
        purges20.push({ n: N, ms: performance.now() - t0 });
        const rows = rowsOf19(p.g);
        const takedowns = rows.filter((r) => r.kind === 'edit').map((r) => JSON.parse(r.body));
        const named = takedowns.flatMap((b) => (Array.isArray(b.data?.ids) ? b.data.ids : [b.data?.id]));
        const want = Math.ceil(N / (guests?.TAKEDOWN_IDS_MAX ?? 1));
        const each = takedowns.every((b) => same20(b.guests, [p.x.pk]) && Number.isSafeInteger(b.seq) && b.data.action === 'removed' && b.data.by === 'author' && !('ciphertext' in b.data));
        assert(p.ok && purged?.ok === true && queuedLines === QUEUED && rows.filter((r) => r.kind === 'line').length === 0,
            `20e. an account with ${N} lines deleted: none of the ${QUEUED} still queued goes (queued ${queuedLines}, left ${rows.filter((r) => r.kind === 'line').length})`);
        assert(takedowns.length === want && named.length === N && new Set(named).size === N && ids.every((id) => named.includes(id)) && each,
            `20e. its ${N} lines go to the guest's home in ${want} request(s) of at most ${guests?.TAKEDOWN_IDS_MAX} ids, each line named once, by its author, words none (got ${takedowns.length} requests naming ${named.length})`);
        refusing.delete('a.example');
        const nP = outs.length;
        await guests.flushGuestOutbox(Date.now() + 10 * 60_000);
        await settle();
        const went = sentTo20(p.g, nP).filter((b) => b.kind === 'edit').length;
        assert(went === want && rowsOf19(p.g).length === 0, `20e. ${N} lines: once the home answers, the ${want} request(s) go and nothing is left (went ${went}, left ${rowsOf19(p.g).length})`);
    }
    {
        const [small, big] = purges20;
        const ratio = big.ms / Math.max(small.ms, 1);
        assert(purges20.length === 2 && ratio <= RATIO20,
            `20e. the ${big.n}-line deletion takes at most ${RATIO20} times the ${small.n}-line one in this run: it grows with the lines, not with the lines times the queue (${Math.round(big.ms)} ms against ${Math.round(small.ms)} ms, ${ratio.toFixed(1)} times)`);
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ A guest from another community reads and writes one group\'s chat, through their own server, and nothing else.');
}

main().then(() => process.exit(0)).catch((e) => { console.error('❌ Test failed:', e); process.exit(1); });

/**
 * "From a member here" (slice S5 "Message anyone": scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3 "A fellow
 * member writing across", §6 row S5), through the real middleware on one node (b.example), the other community (a.example)
 * played by this suite as test-mail-ring plays it: its server key, its signed requests to /api/relay/mail.
 *
 *   1  one table: the sender {an active member here, a visitor's row here, a closed account here, a member suspended here,
 *      no row here} x the sending server's claim {none, `memberHere: true` beside the item, `memberHere: true` inside the
 *      envelope}: GET /api/mail says `memberHere: true` beside the held item iff the sender is an active member here, by
 *      this node's own member list; the sending server's claim never changes it, and the envelope handed over never
 *      carries it
 *   2  it is said as the item is handed over, never stored: a sender who joins after their line was held reads as a
 *      member here; one suspended after it does not; relay_mail keeps no such column
 *   3  a re-keyed member (engine/key-move.ts): a line their OLD key wrote, held before the move, is not "from a member
 *      here" afterwards; a line from the key they hold now is
 *   4  every kind held says it (line, blob, delete, edit, reaction), one sender asked once a page however many items
 *   5  every rule on this node that stops a member writing to another member (PR #3347 review), each {holds, over, none}:
 *      paused or suspended (members.status), muted (moderation_muted_until), held from new requests by reports
 *      (request_limits; only where requests are on), a request of theirs to the recipient waiting with its one line
 *      written (dm_requests), on probation, blocked by the recipient: `memberHere: false` while any holds, so the line
 *      meets the door as a stranger's; true once it is over, or where it does not apply. Where the rule refuses the
 *      member inside too, the same row shows the community's own route refusing them, so the mark and the inside rule
 *      are one rule. The request limit's row is earned as well as written: three circles reporting lines the member wrote
 *      them across limit them, and the mark goes (PR #3347 review, relay-mail.ts:606)
 *   6  one rule, earned across or inside (engine/request-limits.ts, engine/relay-complaint.ts): reports {across only,
 *      inside only, mixed} x {1, 2, 3 circles}, and the same reporter twice: the limit is made at 3 circles however the
 *      reports came, never from one reporter's repeats, and then the mark is false and the inside open refused in the
 *      limit's own words. A report across counts only when the line was a request here (its sender a member here, held for
 *      the reporter as a first line they have not answered, and a request inside now): a stranger's, an answered one, a
 *      friend's, one never held here, and any where requests are off count for nothing, and their rows carry no request
 *      column, as before
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) BEANPOOL_SSRF_TEST_HOOK=1 pnpm exec tsx src/test-mail-member-here.ts
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
    NODE_KEY_VALIDITY_MS, buildNodeRequestHeaders, relayConversationId, relayPayloadHash, sealOutsideLine, signNodeKeyDocument,
    signRelayEnvelope, type RelayItemKind,
} from '@beanpool/core';
import { signedHeaders } from './signed-request-test-helper.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

let BASE = '';
interface Keys { seed: Uint8Array; key: string }
const keys = (): Keys => { const seed = crypto.randomBytes(32); return { seed, key: Buffer.from(ed25519.getPublicKey(seed)).toString('hex') }; };
const signerOf = (seed: Uint8Array) => (b: Uint8Array) => ed25519.sign(b, seed);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

interface Answer { status: number; body: any }
async function send(method: string, p: string, headers: Record<string, string>, body?: string): Promise<Answer> {
    const res = await fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body });
    let parsed: any = null;
    try { parsed = await res.json(); } catch { /* no body */ }
    return { status: res.status, body: parsed };
}

async function main(): Promise<void> {
    const dataDir = process.env.BEANPOOL_DATA_DIR;
    if (!dataDir) throw new Error('BEANPOOL_DATA_DIR must be set to a fresh directory');
    const { generateKeyPair, privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
    fs.writeFileSync(path.join(dataDir, 'libp2p_key'), privateKeyToProtobuf(await generateKeyPair('Ed25519')));

    const { initTls } = await import('./services/tls.js');
    const { initStateEngine, seedGenesisMember } = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { __useNodeKeyFetchForTests } = await import('./engine/node-signature.js');
    const mail = await import('./engine/relay-mail.js');
    const outbox = await import('./engine/relay-outbox.js');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const olive = keys();
    seedGenesisMember(olive.key, 'Olive');
    const rowFor = (k: Keys, name: string, status: string, visitor = 0) => {
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_visitor)
                    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'TEST', ?, ?)`).run(k.key, name, olive.key, status, visitor);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(k.key);
    };
    const member = (name: string): Keys => { const k = keys(); rowFor(k, name, 'active'); return k; };
    const A = keys();
    const aDoc = await signNodeKeyDocument({ key: A.key, validUntil: Date.now() + NODE_KEY_VALIDITY_MS, previousKeys: [] }, signerOf(A.seed));
    __useNodeKeyFetchForTests(async (url) => {
        if (url !== 'https://a.example/api/node/key') throw new Error('no such server');
        return aDoc;
    });

    let n = 0;
    const newId = () => `here-${String(++n).padStart(4, '0')}-${crypto.randomBytes(6).toString('hex')}`;
    const T0 = Date.now();
    type Claim = 'none' | 'beside the item' | 'inside the envelope';
    async function item(from: Keys, to: string, kind: RelayItemKind = 'dm-line', claim: Claim = 'none'): Promise<Record<string, unknown>> {
        const payload = crypto.randomBytes(120).toString('base64');
        const envelope = await signRelayEnvelope({
            kind, itemId: newId(), senderKey: from.key, senderHome: 'a.example', recipient: to, recipientHome: 'b.example', at: T0 + n,
            payloadHash: relayPayloadHash(payload),
        }, signerOf(from.seed));
        // The sending server's claim: a mark it adds where it can, beside the item or inside the envelope (unsigned either way).
        if (claim === 'inside the envelope') return { envelope: { ...envelope, memberHere: true }, payload };
        if (claim === 'beside the item') return { envelope, payload, memberHere: true };
        return { envelope, payload };
    }
    async function bring(items: Array<Record<string, unknown>>): Promise<Answer> {
        const body = JSON.stringify({ items });
        const headers = await buildNodeRequestHeaders({ method: 'POST', url: 'https://b.example/api/relay/mail', body, origin: 'a.example', keyHex: A.key, sign: signerOf(A.seed) });
        return send('POST', '/api/relay/mail', headers, body);
    }
    async function fetchMail(who: Keys): Promise<Answer> {
        const p = `/api/mail?device=${crypto.randomBytes(16).toString('hex')}`;
        return send('GET', p, signedHeaders({ method: 'GET', path: '/api/mail', body: '', publicKeyHex: who.key, key: who.seed, host: 'b.example' }));
    }
    const heldOf = async (who: Keys, from: Keys) => ((await fetchMail(who)).body?.items ?? []).filter((i: any) => i?.envelope?.senderKey === from.key);

    // ── 1. One table: who sent it x what the sending server claims ──────────────────────────
    console.log('\n1. Sender x the sending server\'s claim');
    const SENDERS: Array<[string, (k: Keys) => void, boolean]> = [
        ['an active member here', (k) => rowFor(k, `Active ${k.key.slice(0, 4)}`, 'active'), true],
        ["a visitor's row here", (k) => rowFor(k, `Visitor ${k.key.slice(0, 4)}`, 'active', 1), false],
        ['a closed account here', (k) => rowFor(k, `Closed ${k.key.slice(0, 4)}`, 'pruned'), false],
        ['a member suspended here', (k) => rowFor(k, `Paused ${k.key.slice(0, 4)}`, 'disabled'), false],
        ['no row here (a stranger)', () => {}, false],
    ];
    const CLAIMS: Claim[] = ['none', 'beside the item', 'inside the envelope'];
    for (const [senderName, make, expected] of SENDERS) {
        for (const claim of CLAIMS) {
            const ben = member(`Ben ${++n}`);
            const sender = keys();
            make(sender);
            const brought = await bring([await item(sender, ben.key, 'dm-line', claim)]);
            assert(brought.status === 202, `1. ${senderName}, claim ${claim}: brought (got ${brought.status})`);
            const got = await heldOf(ben, sender);
            assert(got.length === 1, `1. ${senderName}, claim ${claim}: held for the member (got ${got.length})`);
            assert(got[0]?.memberHere === expected, `1. ${senderName}, claim ${claim}: memberHere ${expected} (got ${JSON.stringify(got[0]?.memberHere)})`);
            assert(!!got[0] && !('memberHere' in (got[0].envelope ?? {})), `1. ${senderName}, claim ${claim}: the envelope handed over carries no mark`);
        }
    }

    // ── 2. Said as handed over, never stored ────────────────────────────────────────────────
    console.log('\n2. Said at the fetch, from the list as it is then');
    const cols = (db.prepare('PRAGMA table_info(relay_mail)').all() as Array<{ name: string }>).map((c) => c.name);
    assert(!cols.some((c) => /member/i.test(c)), `2. relay_mail keeps no member column (columns: ${cols.join(', ')})`);
    {
        const ben = member('Ben joins');
        const later = keys();
        await bring([await item(later, ben.key)]);
        assert((await heldOf(ben, later))[0]?.memberHere === false, '2a. a stranger when their line was held: not from a member here');
        rowFor(later, 'Joined later', 'active');
        assert((await heldOf(ben, later))[0]?.memberHere === true, '2b. they join here: the same held line is now from a member here');
        db.prepare("UPDATE members SET status = 'disabled' WHERE public_key = ?").run(later.key);
        assert((await heldOf(ben, later))[0]?.memberHere === false, '2c. suspended since: no longer from a member here');
    }

    // ── 3. A re-keyed member ────────────────────────────────────────────────────────────────
    console.log('\n3. A re-keyed member: the key they hold now, never the old one');
    {
        const { moveMemberKeyRows } = await import('./engine/key-move.js');
        const ben = member('Ben re-key');
        const cy = member('Cy re-key');
        await bring([await item(cy, ben.key)]);
        assert((await heldOf(ben, cy))[0]?.memberHere === true, '3a. before the move: from a member here');
        const moved = keys();
        db.transaction(() => moveMemberKeyRows(cy.key, moved.key, new Date().toISOString(), { keepStamps: false }))();
        assert((await heldOf(ben, cy))[0]?.memberHere === false, '3b. after the move, the old key\'s held line: not from a member here');
        await bring([await item(moved, ben.key)]);
        assert((await heldOf(ben, moved))[0]?.memberHere === true, '3c. a line from the key they hold now: from a member here');
        assert(mail.fromMemberHere(moved.key, ben.key) === true && mail.fromMemberHere(cy.key, ben.key) === false, '3d. fromMemberHere: the new key yes, the old key no');
    }

    // ── 4. Every kind held says it; one sender asked once a page ────────────────────────────
    console.log('\n4. Every kind held');
    {
        const ben = member('Ben kinds');
        const dee = member('Dee kinds');
        const stranger = keys();
        const KINDS: RelayItemKind[] = ['dm-line', 'dm-blob', 'dm-delete', 'dm-edit', 'dm-reaction'];
        for (const kind of KINDS) {
            const b = await bring([await item(dee, ben.key, kind), await item(stranger, ben.key, kind)].slice(0, kind === 'dm-blob' ? 1 : 2));
            if (kind === 'dm-blob') await bring([await item(stranger, ben.key, kind)]);
            assert(b.status === 202, `4. ${kind}: brought (got ${b.status})`);
        }
        const page = (await fetchMail(ben)).body?.items ?? [];
        for (const kind of KINDS) {
            const fromDee = page.filter((i: any) => i.kind === kind && i.envelope.senderKey === dee.key);
            const fromStranger = page.filter((i: any) => i.kind === kind && i.envelope.senderKey === stranger.key);
            assert(fromDee.length === 1 && fromDee[0].memberHere === true, `4. ${kind} from a member here: memberHere true`);
            assert(fromStranger.length === 1 && fromStranger[0].memberHere === false, `4. ${kind} from a stranger: memberHere false`);
        }
        assert(page.every((i: any) => typeof i.memberHere === 'boolean'), '4. every held item says it, true or false');
    }

    // ── 5. Every rule here that stops a member writing to another member ────────────────────
    console.log('\n5. Each rule that stops a member writing here x {holds, over, none}');
    {
        const { setSwitchOverride } = await import('./config/node-profile.js');
        const { lockedDm } = await import('./dm-test-payload.js');
        const HOUR = 3_600_000, DAY = 24 * HOUR;
        const iso = (ms: number) => new Date(ms).toISOString();
        // The community's own routes, signed by the member: what they may do inside.
        const inside = (who: Keys, p: string, body: object): Promise<Answer> => {
            const b = JSON.stringify(body);
            return send('POST', p, signedHeaders({ method: 'POST', path: p, body: b, publicKeyHex: who.key, key: who.seed, host: 'b.example' }), b);
        };
        const open = (s: Keys, r: Keys) => inside(s, '/api/messages/conversation', { type: 'dm', participants: [s.key, r.key], createdBy: s.key });
        const line = (s: Keys, conversationId: string) => inside(s, '/api/messages/send', { conversationId, authorPubkey: s.key, ...lockedDm() });
        const conversationOf = (s: Keys, r: Keys): string => (db.prepare(`SELECT c.id FROM conversations c
            JOIN conversation_participants a ON a.conversation_id = c.id AND a.public_key = ?
            JOIN conversation_participants b ON b.conversation_id = c.id AND b.public_key = ? WHERE c.type = 'dm'`).get(s.key, r.key) as { id: string }).id;
        // A request from s to r inside, made by the routes as a member makes one: the open, then its one line.
        const request = async (s: Keys, r: Keys): Promise<string> => {
            const opened = await open(s, r);
            const id = opened.body?.conversation?.id as string;
            const first = await line(s, id);
            const made = db.prepare('SELECT state FROM dm_requests WHERE conversation_id = ?').get(id) as { state: string } | undefined;
            if (opened.status !== 200 || first.status !== 200 || made?.state !== 'pending') {
                throw new Error(`no request made (${opened.status} ${first.status} ${made?.state}: ${JSON.stringify(first.body)})`);
            }
            return id;
        };
        const status = (s: Keys, to: string) => db.prepare('UPDATE members SET status = ? WHERE public_key = ?').run(to, s.key);
        const mute = (s: Keys, until: number) => db.prepare('UPDATE members SET moderation_muted_until = ? WHERE public_key = ?').run(iso(until), s.key);
        const limit = (s: Keys, until: number, liftedAt: number | null = null) => db.prepare(`INSERT INTO request_limits (id, sender_pubkey, made_at, until, how, lifted_at)
            VALUES (?, ?, ?, ?, 'many_reports', ?)`).run(crypto.randomUUID(), s.key, iso(Date.now() - HOUR), iso(until), liftedAt === null ? null : iso(liftedAt));
        const block = (r: Keys, s: Keys) => db.prepare('INSERT INTO member_blocks (owner_pubkey, blocked_pubkey) VALUES (?, ?)').run(r.key, s.key);
        const unblock = (r: Keys, s: Keys) => db.prepare('DELETE FROM member_blocks WHERE owner_pubkey = ? AND blocked_pubkey = ?').run(r.key, s.key);
        const keptPosts = (s: Keys, count: number) => {
            const at = iso(Date.now() - 90 * HOUR);
            for (let i = 0; i < count; i++) {
                db.prepare(`INSERT INTO posts (id, type, category, title, description, price_c, author_pubkey, created_at, updated_at, active, status)
                            VALUES (?, 'offer', 'other', 'Kept', 'Kept', 0, ?, ?, ?, 1, 'active')`).run(crypto.randomUUID(), s.key, at, at);
            }
        };
        const refusedWith = (code: string) => (a: Answer) => a.status === 403 && a.body?.code === code;
        // A report's complaint to the sender's home (a.example) is answered here: nothing leaves this machine.
        const complaints: string[] = [];
        outbox.__useRelayTransportForTests(async (url) => { complaints.push(url); return { status: 202, body: { received: true } }; });
        /** A real line across (core sealOutsideLine, under a UUID v4 id, which a report's check asks), in its sender's envelope. */
        const sealed = async (from: Keys, to: Keys, text: string): Promise<Record<string, unknown>> => {
            const itemId = crypto.randomUUID();
            const payload = sealOutsideLine({ text, name: 'Someone', myEdPrivHex: hex(from.seed), myKey: from.key, peerKey: to.key, messageId: itemId });
            const envelope = await signRelayEnvelope({
                kind: 'dm-line', itemId, senderKey: from.key, senderHome: 'a.example', recipient: to.key, recipientHome: 'b.example', at: Date.now(),
                payloadHash: relayPayloadHash(payload),
            }, signerOf(from.seed));
            return { envelope, payload };
        };
        const reportAcross = (who: Keys, item: Record<string, unknown>, words: string) => inside(who, '/api/mail/report', { item, reason: 'Spam or scam', words });
        const reportInside = (who: Keys, s: Keys) => inside(who, '/api/reports', { targetPubkey: s.key, reason: 'Spam or scam' });
        /** Three members, each their own circle, report a line `s` wrote them across: the limit, by reports across alone. */
        const earnAcross = async (s: Keys) => {
            const reporters = [member(`E ${++n}`), member(`E ${++n}`), member(`E ${++n}`)];
            const lines: Array<Record<string, unknown>> = [];
            for (const r of reporters) {
                const l = await sealed(s, r, `Across to ${r.key.slice(0, 8)}`);
                if ((await bring([l])).status !== 202) throw new Error('a line across was not brought');
                lines.push(l);
            }
            for (const [i, r] of reporters.entries()) {
                const a = await reportAcross(r, lines[i], `Across to reporter ${i}`);
                if (a.status !== 200) throw new Error(`a report across was refused (${a.status} ${JSON.stringify(a.body)})`);
            }
        };

        type Switches = { dmRequests?: boolean; probation?: boolean; autoHideReports?: boolean };
        interface Row {
            rule: string; state: string; switches?: Switches; expected: boolean;
            /** The state, made once the line across is held: the mark is said at the fetch. */
            make: (s: Keys, r: Keys) => unknown;
            /** The community's own route, asked after the fetch, answers the same way: `refused` is the rule's own refusal. */
            inside?: { what: string; ask: (s: Keys, r: Keys) => Promise<Answer>; refused: (a: Answer) => boolean };
        }
        const REQUESTS_ON: Switches = { dmRequests: true };
        const secondLine = { what: 'a second line', ask: (s: Keys, r: Keys) => line(s, conversationOf(s, r)), refused: refusedWith('dm_request_pending') };
        const ROWS: Row[] = [
            { rule: 'pause', state: 'holds (disabled)', expected: false, make: (s) => status(s, 'disabled'),
                inside: { what: 'a new conversation', ask: open, refused: refusedWith('paused') } },
            { rule: 'pause', state: 'holds (suspended)', expected: false, make: (s) => status(s, 'suspended') },
            { rule: 'pause', state: 'over (active again)', expected: true, make: (s) => { status(s, 'disabled'); status(s, 'active'); } },
            { rule: 'mute', state: 'holds', expected: false, make: (s) => mute(s, Date.now() + DAY),
                inside: { what: 'a new conversation', ask: open, refused: refusedWith('moderation_muted') } },
            { rule: 'mute', state: 'over', expected: true, make: (s) => mute(s, Date.now() - HOUR),
                inside: { what: 'a new conversation', ask: open, refused: refusedWith('moderation_muted') } },
            { rule: 'mute', state: 'none', expected: true, make: () => {} },
            { rule: 'request limit', state: 'holds', switches: REQUESTS_ON, expected: false, make: (s) => limit(s, Date.now() + 7 * DAY),
                inside: { what: 'a new conversation', ask: open, refused: refusedWith('dm_requests_limited') } },
            { rule: 'request limit', state: 'over', switches: REQUESTS_ON, expected: true, make: (s) => limit(s, Date.now() - HOUR),
                inside: { what: 'a new conversation', ask: open, refused: refusedWith('dm_requests_limited') } },
            { rule: 'request limit', state: 'lifted by a moderator', switches: REQUESTS_ON, expected: true,
                make: (s) => limit(s, Date.now() + 7 * DAY, Date.now() - HOUR),
                inside: { what: 'a new conversation', ask: open, refused: refusedWith('dm_requests_limited') } },
            { rule: 'request limit', state: 'holds where requests are off (it stops nothing inside)', expected: true,
                make: (s) => limit(s, Date.now() + 7 * DAY),
                inside: { what: 'a new conversation', ask: open, refused: refusedWith('dm_requests_limited') } },
            { rule: 'request limit', state: 'none', switches: REQUESTS_ON, expected: true, make: () => {} },
            { rule: 'request limit', state: 'earned by reports of across lines (3 circles)', switches: { dmRequests: true, autoHideReports: true },
                expected: false, make: (s) => earnAcross(s),
                inside: { what: 'a new conversation', ask: open, refused: refusedWith('dm_requests_limited') } },
            { rule: 'waiting request', state: 'holds (its one line written)', switches: REQUESTS_ON, expected: false,
                make: (s, r) => request(s, r), inside: secondLine },
            { rule: 'waiting request', state: 'holds (ignored)', switches: REQUESTS_ON, expected: false,
                make: async (s, r) => db.prepare("UPDATE dm_requests SET state = 'ignored', decided_at = ? WHERE conversation_id = ?").run(iso(Date.now()), await request(s, r)),
                inside: secondLine },
            { rule: 'waiting request', state: 'over (30 days)', switches: REQUESTS_ON, expected: true,
                make: async (s, r) => db.prepare('UPDATE dm_requests SET requested_at = ? WHERE conversation_id = ?').run(iso(Date.now() - 31 * DAY), await request(s, r)),
                inside: secondLine },
            { rule: 'waiting request', state: 'accepted', switches: REQUESTS_ON, expected: true,
                make: async (s, r) => db.prepare("UPDATE dm_requests SET state = 'accepted', decided_at = ?, accepted_by = ? WHERE conversation_id = ?").run(iso(Date.now()), r.key, await request(s, r)),
                inside: secondLine },
            { rule: 'probation', state: 'holds (a new account, allowance unused)', switches: { probation: true }, expected: false, make: () => {} },
            { rule: 'probation', state: 'over (past 72 hours, 3 kept posts)', switches: { probation: true }, expected: true,
                make: (s) => { db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(iso(Date.now() - 100 * HOUR), s.key); keptPosts(s, 3); } },
            { rule: 'probation', state: 'none (switched off here)', expected: true, make: () => {} },
            { rule: 'block', state: 'holds (the recipient blocked them since)', expected: false, make: (s, r) => block(r, s) },
            { rule: 'block', state: 'over (unblocked)', expected: true, make: (s, r) => { block(r, s); unblock(r, s); } },
            { rule: 'block', state: 'none', expected: true, make: () => {} },
        ];
        for (const row of ROWS) {
            const name = `5. ${row.rule}, ${row.state}`;
            const r = member(`R ${++n}`);
            const s = member(`S ${n}`);
            const brought = await bring([await item(s, r.key)]);
            assert(brought.status === 202, `${name}: brought (got ${brought.status})`);
            setSwitchOverride('dmRequests', !!row.switches?.dmRequests);
            setSwitchOverride('probation', !!row.switches?.probation);
            setSwitchOverride('autoHideReports', !!row.switches?.autoHideReports);
            try {
                await row.make(s, r);
                const got = await heldOf(r, s);
                assert(got.length === 1 && got[0].memberHere === row.expected, `${name}: memberHere ${row.expected} (got ${JSON.stringify(got[0]?.memberHere)})`);
                assert(mail.fromMemberHere(s.key, r.key) === row.expected, `${name}: fromMemberHere says the same`);
                if (row.inside) {
                    // Refused in the rule's own words where it holds; where it is over or stops nothing, let through (200).
                    const a = await row.inside.ask(s, r);
                    assert(row.expected ? a.status === 200 : row.inside.refused(a),
                        `${name}: inside, ${row.inside.what} is ${row.expected ? 'let through' : 'refused'} too (got ${a.status} ${a.body?.code ?? ''})`);
                }
            } finally {
                setSwitchOverride('dmRequests', false);
                setSwitchOverride('probation', false);
                setSwitchOverride('autoHideReports', false);
            }
        }

        // ── 6. One rule, earned across or inside ────────────────────────────────────────────
        console.log('\n6. Reports across, inside or both x circles x the same reporter twice: one limit, and the mark it ends');
        type Mode = 'across' | 'inside';
        interface Six {
            name: string;
            /** Each report: by which reporter (each a member invited by the owner, so their own circle), of which kind. */
            reports: Array<[number, Mode]>;
            /** The limit is made, and how. */
            limit: 'many_reports' | 'same_wording' | null;
            /** The reports across carry the request columns (they count); false: none does, as before this slice. */
            counted?: boolean;
            /** The sender is no member here (a stranger across). */
            stranger?: boolean;
            /** Requests off here (dmRequests), the rest of the moderation on. */
            requestsOff?: boolean;
            /** The lines across are reported without ever being held here. */
            neverHeld?: boolean;
            /** What each reporter did once their line was held and before they reported it. */
            since?: (s: Keys, r: Keys) => void;
            /** The reporter's words for report `k`. */
            words?: (k: number) => string;
        }
        const SAME = 'Buy my miracle seeds now, today only, from the finest grower in the valley';
        const answered = (s: Keys, r: Keys) => db.prepare(`INSERT INTO relay_outbox (sender_key, item_id, kind, recipient, recipient_home, state, created_at, updated_at)
            VALUES (?, ?, 'dm-line', ?, 'a.example', 'delivered', ?, ?)`).run(r.key, crypto.randomUUID(), s.key, Date.now(), Date.now());
        const added = (s: Keys, r: Keys) => db.prepare('INSERT INTO friends (owner_pubkey, friend_pubkey) VALUES (?, ?)').run(r.key, s.key);
        const SIX: Six[] = [];
        // The table: {across only, inside only, mixed} x {1, 2, 3 circles}, then the same reporter twice beside one other.
        const MIXED: Record<number, Array<[number, Mode]>> = {
            1: [[0, 'inside'], [0, 'across']],
            2: [[0, 'inside'], [1, 'across']],
            3: [[0, 'inside'], [1, 'across'], [2, 'across']],
        };
        for (const circles of [1, 2, 3]) {
            const each = (mode: Mode) => Array.from({ length: circles }, (_, i) => [i, mode] as [number, Mode]);
            const limit = circles >= 3 ? 'many_reports' : null;
            SIX.push({ name: `across only, ${circles} circle(s)`, reports: each('across'), limit });
            SIX.push({ name: `inside only, ${circles} circle(s)`, reports: each('inside'), limit });
            SIX.push({ name: `mixed, ${circles} circle(s)`, reports: MIXED[circles], limit });
        }
        SIX.push({ name: 'across only, the same reporter twice and one other (3 reports, 2 circles)', reports: [[0, 'across'], [0, 'across'], [1, 'across']], limit: null });
        SIX.push({ name: 'inside only, the same reporter twice and one other (3 reports, 2 circles)', reports: [[0, 'inside'], [0, 'inside'], [1, 'inside']], limit: null });
        SIX.push({ name: 'mixed, the same reporter across and inside and one other (3 reports, 2 circles)', reports: [[0, 'inside'], [0, 'across'], [1, 'inside']], limit: null });
        // The same wording from 2 circles, a line long enough to compare: the rule's second way, across as inside.
        SIX.push({ name: 'across only, the same long wording from 2 circles', reports: [[0, 'across'], [1, 'across']], limit: 'same_wording', words: () => SAME });
        // Reports across that are no request's: 3 circles, and none counts.
        const THREE: Array<[number, Mode]> = [[0, 'across'], [1, 'across'], [2, 'across']];
        SIX.push({ name: "a stranger's lines (no member here), 3 circles", reports: THREE, limit: null, counted: false, stranger: true });
        SIX.push({ name: 'lines each reporter had answered across before reporting, 3 circles', reports: THREE, limit: null, counted: false, since: answered });
        SIX.push({ name: 'lines from someone each reporter had added here, 3 circles', reports: THREE, limit: null, counted: false, since: added });
        SIX.push({ name: 'lines never held here, 3 circles', reports: THREE, limit: null, counted: false, neverHeld: true });
        SIX.push({ name: 'requests off here, 3 circles', reports: THREE, limit: null, counted: false, requestsOff: true });

        for (const row of SIX) {
            const name = `6. ${row.name}`;
            setSwitchOverride('autoHideReports', true);
            setSwitchOverride('dmRequests', !row.requestsOff);
            try {
                const s = row.stranger ? keys() : member(`S6 ${++n}`);
                const reporters = Array.from({ length: Math.max(...row.reports.map(([i]) => i)) + 1 }, () => member(`R6 ${++n}`));
                // The lines across first, then the requests inside, then the reports: no limit is made before every request is.
                const lines = new Map<number, Record<string, unknown>>();
                for (const [k, [i, mode]] of row.reports.entries()) {
                    if (mode !== 'across') continue;
                    const l = await sealed(s, reporters[i], `Line ${k} to reporter ${i}`);
                    if (!row.neverHeld) assert((await bring([l])).status === 202, `${name}: line ${k} brought`);
                    lines.set(k, l);
                }
                const asked = new Set<number>();
                for (const [i, mode] of row.reports) {
                    if (mode === 'inside' && !asked.has(i)) { await request(s, reporters[i]); asked.add(i); }
                }
                for (const [i, mode] of row.reports) if (mode === 'across') row.since?.(s, reporters[i]);
                for (const [k, [i, mode]] of row.reports.entries()) {
                    const words = row.words?.(k) ?? `Line ${k} to reporter ${i}`;
                    const a = mode === 'across' ? await reportAcross(reporters[i], lines.get(k)!, words) : await reportInside(reporters[i], s);
                    assert(a.status === 200, `${name}: report ${k} (${mode}) taken (got ${a.status} ${a.body?.code ?? a.body?.error ?? ''})`);
                }
                const across = db.prepare(`SELECT reporter_pubkey AS r, request_conversation_id AS c, request_wording AS w FROM abuse_reports
                                            WHERE target_pubkey = ? AND json_extract(disclosure, '$.kind') = 'outside-line'`).all(s.key) as Array<{ r: string; c: string | null; w: string | null }>;
                const counted = row.counted ?? true;
                const acrossFiled = row.reports.filter(([, m]) => m === 'across').length;
                assert(across.length === acrossFiled, `${name}: ${acrossFiled} report(s) across on file (got ${across.length})`);
                if (acrossFiled) {
                    assert(across.every((x) => x.c === (counted ? relayConversationId(s.key, x.r) : null) && (counted || x.w === null)),
                        `${name}: each report across ${counted ? "carries the pair's conversation id (it counts)" : 'carries no request column (as before)'}`);
                }
                const made = db.prepare('SELECT how FROM request_limits WHERE sender_pubkey = ?').all(s.key) as Array<{ how: string }>;
                assert(made.length === (row.limit ? 1 : 0) && (made[0]?.how ?? null) === row.limit,
                    `${name}: limit ${row.limit ? `made (${row.limit})` : 'not made'} (got ${JSON.stringify(made)})`);
                if (row.stranger) continue;
                // The mark, to a member who never reported them: false while the limit holds; and inside, the open refused alike.
                const x = member(`X6 ${++n}`);
                assert((await bring([await item(s, x.key)])).status === 202, `${name}: a line to a fourth member brought`);
                const got = await heldOf(x, s);
                assert(got.length === 1 && got[0].memberHere === !row.limit, `${name}: memberHere ${!row.limit} (got ${JSON.stringify(got[0]?.memberHere)})`);
                assert(mail.fromMemberHere(s.key, x.key) === !row.limit, `${name}: fromMemberHere says the same`);
                const o = await open(s, x);
                assert(row.limit ? refusedWith('dm_requests_limited')(o) : o.status === 200,
                    `${name}: inside, a new conversation is ${row.limit ? "refused in the limit's words" : 'let through'} too (got ${o.status} ${o.body?.code ?? ''})`);
            } finally {
                setSwitchOverride('dmRequests', false);
                setSwitchOverride('autoHideReports', false);
            }
        }
        assert(complaints.length > 0 && complaints.every((u) => u === 'https://a.example/api/relay/complaint'),
            `6. every report across still tells the sender's home, and only it (${complaints.length} complaints)`);
        outbox.__useRelayTransportForTests(null);
    }

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exitCode = 1;
    process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

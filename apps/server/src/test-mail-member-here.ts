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
 *      are one rule
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
    NODE_KEY_VALIDITY_MS, buildNodeRequestHeaders, relayPayloadHash, signNodeKeyDocument, signRelayEnvelope, type RelayItemKind,
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

        type Switches = { dmRequests?: boolean; probation?: boolean };
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
            }
        }
    }

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exitCode = 1;
    process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

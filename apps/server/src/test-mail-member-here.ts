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
        assert(mail.fromMemberHere(moved.key) === true && mail.fromMemberHere(cy.key) === false, '3d. fromMemberHere: the new key yes, the old key no');
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

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exitCode = 1;
    process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

/**
 * Across mail rings, and says how much waits (slice S4: scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3 "Alerts
 * for across mail", "Mutes", §6 row S4, §8 Spam), through the real middleware on one node (b.example), the other community
 * (a.example) played by this suite as test-relay-mail plays it: its server key, its signed requests to /api/relay/mail.
 *
 *   1  the ring, one table (close the class): every kind of held item (line, blob, delete, edit, reaction) x the sender
 *      (written to by the member within 30 days, written to 31 days ago, never written to) x the member's quiet key (none,
 *      this sender's) x the member's alerts (on, off): a content-free "New message" push (kind chat.message, details naming
 *      nothing) goes iff a line was held AND the member wrote to its sender within 30 days AND that key isn't quiet AND
 *      alerts are on. A sender the member blocked: dropped, so never a ring. Several lines in one request: one ring.
 *   2  `mail` in GET /api/me/unread: the items held for the signer, per member, never another's; down once confirmed
 *   3  POST /api/mail/quiet: the signer's own; refused for a key that isn't one, their own key, a quiet that isn't true or
 *      false, and a key that is no member here; quiet, then not: the ring follows
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) BEANPOOL_SSRF_TEST_HOOK=1 pnpm exec tsx src/test-mail-ring.ts
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
    NODE_KEY_VALIDITY_MS, buildNodeRequestHeaders, relayPayloadHash, signNodeKeyDocument, signRelayEnvelope,
    type RelayItem, type RelayItemKind,
} from '@beanpool/core';
import { signedHeaders } from './signed-request-test-helper.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

let BASE = '';
const DAY = 24 * 60 * 60_000;
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
    const member = (name: string): Keys => {
        const k = keys();
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'TEST', 'active')`).run(k.key, name, olive.key);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(k.key);
        return k;
    };
    const A = keys();
    const now = Date.now();
    const aDoc = await signNodeKeyDocument({ key: A.key, validUntil: now + NODE_KEY_VALIDITY_MS, previousKeys: [] }, signerOf(A.seed));
    __useNodeKeyFetchForTests(async (url) => {
        if (url !== 'https://a.example/api/node/key') throw new Error('no such server');
        return aDoc;
    });

    let n = 0;
    const newId = () => `ring-${String(++n).padStart(4, '0')}-${crypto.randomBytes(6).toString('hex')}`;
    // The clock read once: each item its own time after it (`at` orders a member's mail), never the live clock per row.
    const T0 = Date.now();
    async function item(from: Keys, to: string, kind: RelayItemKind = 'dm-line'): Promise<RelayItem> {
        const payload = crypto.randomBytes(120).toString('base64');
        const itemId = newId();
        const envelope = await signRelayEnvelope({
            kind, itemId, senderKey: from.key, senderHome: 'a.example', recipient: to, recipientHome: 'b.example', at: T0 + n,
            payloadHash: relayPayloadHash(payload),
        }, signerOf(from.seed));
        return { envelope, payload };
    }
    async function bring(items: RelayItem[]): Promise<Answer> {
        const body = JSON.stringify({ items });
        const headers = await buildNodeRequestHeaders({ method: 'POST', url: 'https://b.example/api/relay/mail', body, origin: 'a.example', keyHex: A.key, sign: signerOf(A.seed) });
        return send('POST', '/api/relay/mail', headers, body);
    }
    async function asMember(who: Keys, method: 'GET' | 'POST', pathAndQuery: string, body?: unknown): Promise<Answer> {
        const text = body === undefined ? '' : JSON.stringify(body);
        return send(method, pathAndQuery, signedHeaders({ method, path: pathAndQuery.split('?')[0], body: text, publicKeyHex: who.key, key: who.seed, host: 'b.example' }), method === 'GET' ? undefined : text);
    }
    /** The member wrote `to` (an outbox row of theirs, as relay-outbox.ts keeps one), `daysAgo` days ago. */
    const wrote = (who: Keys, to: string, daysAgo: number) => {
        const at = Date.now() - daysAgo * DAY;
        db.prepare(`INSERT INTO relay_outbox (sender_key, item_id, kind, recipient, recipient_home, state, item, attempts, next_try_at, created_at, updated_at)
                    VALUES (?, ?, 'dm-line', ?, 'a.example', 'sent', NULL, 1, NULL, ?, ?)`).run(who.key, newId(), to, at, at);
    };
    const rings = (who: Keys) => db.prepare("SELECT kind, title, body, data FROM push_notices WHERE recipient = ? AND kind = 'chat.message'").all(who.key) as any[];
    const held = (who: Keys) => (db.prepare('SELECT COUNT(*) AS n FROM relay_mail WHERE recipient = ?').get(who.key) as { n: number }).n;

    // ── 1. The ring ────────────────────────────────────────────────────────────────────────
    console.log('\n1. The ring: kind x sender x quiet x alerts');
    const KINDS: RelayItemKind[] = ['dm-line', 'dm-blob', 'dm-delete', 'dm-edit', 'dm-reaction'];
    const SENDERS = { 'written to within 30 days': 1, 'written to 31 days ago': 31, 'never written to': null } as const;
    let rows = 0;
    for (const kind of KINDS) {
        for (const [senderName, daysAgo] of Object.entries(SENDERS)) {
            for (const quiet of [false, true]) {
                for (const alerts of [true, false]) {
                    const ben = member(`Ben ${++rows}`);
                    const ana = keys();
                    if (daysAgo !== null) wrote(ben, ana.key, daysAgo);
                    if (quiet) {
                        const q = await asMember(ben, 'POST', '/api/mail/quiet', { key: ana.key, quiet: true });
                        if (q.status !== 200) assert(false, `quiet set for row ${rows} (got ${q.status} ${JSON.stringify(q.body)})`);
                    }
                    if (!alerts) db.prepare(`INSERT OR REPLACE INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, 'notify_chat', 'false')`).run(ben.key);
                    const r = await bring([await item(ana, ben.key, kind)]);
                    const want = kind === 'dm-line' && daysAgo === 1 && !quiet && alerts;
                    const got = rings(ben);
                    // Held either way (a stranger's first line too, within their caps): the ring is the only difference.
                    assert(r.status === 202 && held(ben) === 1 && got.length === (want ? 1 : 0),
                        `1. ${kind}, ${senderName}, ${quiet ? 'quiet' : 'not quiet'}, alerts ${alerts ? 'on' : 'off'}: held, and ${want ? 'one ring' : 'no ring'} (held ${held(ben)}, rings ${got.length})`);
                    if (want && got[0]) {
                        assert(got[0].body === 'You have a new message.' && got[0].data === '{}' && !got[0].title.includes(ana.key.slice(0, 8)),
                            `1. its details name nothing: no sender, no chat, no line (got ${JSON.stringify(got[0])})`);
                    }
                }
            }
        }
    }
    assert(rows === 60, `1. the table ran every row (${rows} of 60)`);

    const cy = member('Cy');
    const dee = keys();
    wrote(cy, dee.key, 1);
    await bring([await item(dee, cy.key), await item(dee, cy.key), await item(dee, cy.key)]);
    assert(held(cy) === 3 && rings(cy).length === 1, `1. three lines in one request from someone written to: held, one ring (rings ${rings(cy).length})`);

    const eve = member('Eve');
    const fay = keys();
    wrote(eve, fay.key, 1);
    db.prepare('INSERT INTO member_blocks (owner_pubkey, blocked_pubkey) VALUES (?, ?)').run(eve.key, fay.key);
    await bring([await item(fay, eve.key)]);
    assert(held(eve) === 0 && rings(eve).length === 0, '1. a sender the member blocked, written to or not: dropped, never a ring');

    const ringsForDirect = mail.ringsFor({ kind: 'dm-line', recipient: cy.key, senderKey: dee.key });
    assert(ringsForDirect === true && mail.ringsFor({ kind: 'dm-line', recipient: cy.key, senderKey: keys().key }) === false,
        '1. ringsFor: a key written to rings; a stranger never does');

    // ── 2. `mail` in the counts answer ────────────────────────────────────────────────────
    console.log('\n2. `mail` in GET /api/me/unread');
    const gus = member('Gus'), hal = member('Hal');
    const ivy = keys();
    await bring([await item(ivy, gus.key), await item(ivy, gus.key), await item(ivy, gus.key, 'dm-reaction'), await item(ivy, hal.key)]);
    const gusCounts = await asMember(gus, 'GET', '/api/me/unread');
    const halCounts = await asMember(hal, 'GET', '/api/me/unread');
    assert(gusCounts.status === 200 && gusCounts.body?.mail === 3 && gusCounts.body.mail === held(gus),
        `2a. Gus's answer counts the 3 items held for him (got ${JSON.stringify(gusCounts.body)})`);
    assert(halCounts.body?.mail === 1 && held(hal) === 1, `2b. Hal's counts his 1, never Gus's (got ${halCounts.body?.mail})`);
    const olives = await asMember(olive, 'GET', '/api/me/unread');
    assert(olives.body?.mail === 0, `2c. a member with nothing held: 0 (got ${olives.body?.mail})`);
    const gusDevice = crypto.randomBytes(16).toString('hex');
    const fetched = await asMember(gus, 'GET', `/api/mail?device=${gusDevice}`);
    const ids = (fetched.body?.items ?? []).map((i: any) => i.envelope.itemId);
    await asMember(gus, 'POST', '/api/mail/confirm', { ids: ids.slice(0, 2), device: gusDevice });
    const after = await asMember(gus, 'GET', '/api/me/unread');
    assert(after.body?.mail === 1 && held(gus) === 1, `2d. two confirmed by his one device: 1 left, as held (got ${after.body?.mail})`);
    const stranger = keys();
    const strangers = await asMember(stranger, 'GET', '/api/me/unread');
    assert(strangers.status === 403 && strangers.body?.mail === undefined, `2e. a key that is no member here hears no count (got ${strangers.status})`);

    // ── 3. POST /api/mail/quiet ───────────────────────────────────────────────────────────
    console.log('\n3. The across mute');
    const jo = member('Jo');
    const kit = keys();
    wrote(jo, kit.key, 2);
    for (const [why, body] of [
        ['a key that is no key', { key: 'nope', quiet: true }],
        ['a key in capitals', { key: kit.key.toUpperCase(), quiet: true }],
        ['their own key', { key: jo.key, quiet: true }],
        ['a quiet that is no yes or no', { key: kit.key, quiet: 'yes' }],
        ['no body', {}],
    ] as const) {
        const r = await asMember(jo, 'POST', '/api/mail/quiet', body);
        assert(r.status === 400 && r.body?.code === 'bad_quiet', `3a. refused (400): ${why} (got ${r.status})`);
    }
    const notHere = await asMember(keys(), 'POST', '/api/mail/quiet', { key: kit.key, quiet: true });
    assert(notHere.status === 403, `3b. a key that is no member here: 403, nothing kept (got ${notHere.status})`);
    const on = await asMember(jo, 'POST', '/api/mail/quiet', { key: kit.key, quiet: true });
    assert(on.status === 200 && on.body?.quiet === true && mail.mailQuiet(jo.key, kit.key), `3c. quiet: kept (got ${on.status} ${JSON.stringify(on.body)})`);
    assert(!mail.mailQuiet(cy.key, kit.key) && !mail.mailQuiet(jo.key, dee.key), '3d. the signer\'s own, for that key alone');
    await bring([await item(kit, jo.key)]);
    assert(rings(jo).length === 0 && held(jo) === 1, '3e. their line is held, and rings nothing');
    const off = await asMember(jo, 'POST', '/api/mail/quiet', { key: kit.key, quiet: false });
    assert(off.status === 200 && off.body?.quiet === false && !mail.mailQuiet(jo.key, kit.key), '3f. not quiet any more');
    await bring([await item(kit, jo.key)]);
    assert(rings(jo).length === 1, `3g. their next line rings (rings ${rings(jo).length})`);

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exitCode = 1;
    process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

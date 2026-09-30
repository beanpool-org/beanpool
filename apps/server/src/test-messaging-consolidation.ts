/**
 * Regression tests for consolidated/legacy conversation-id resolution in sendMessage
 * (PR #436 follow-up fixes).
 *
 *   1. A send addressed to a LEGACY conversation id is remapped to the active DM, and the
 *      original id is preserved in metadata.originalConversationId — without it, the DM
 *      ciphertext (XChaCha20-Poly1305 with conversationId as AEAD associated data, see
 *      the native and pwa e2e-crypto modules) is undecryptable by the recipient and the client fallback,
 *      which keys on metadata.originalConversationId, never fires.
 *   2. Client-supplied metadata is preserved (merged), not clobbered, by that rewrite.
 *   3. A single row with malformed metadata must NOT abort the resolution query
 *      (json_valid() CASE guard), which would otherwise silently disable consolidation
 *      node-wide.
 *   5-9. The old id is found in message_old_conversation_ids (schema.sql), which the messages triggers keep from each
 *      line's metadata (#1333 review: scanning the metadata told a hidden group's chat id from an id nobody has by
 *      time). A malformed line that names the key fails no write; the list form resolves item by item, never a part of
 *      one; the boot migration and the repair still fold old ids into the pair's DM; a line deleted, or its metadata
 *      changed, stops naming its old id; and a node upgraded with lines already there has them indexed at boot.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-messaging-consolidation.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import {
    initStateEngine, createConversation, sendMessage, toggleMessageReaction, migrateConsolidateConversations,
    repairConsolidatedMessagesMetadata,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db, initSchema } from './db/db.js';
import { lockedDm } from './dm-test-payload.js';

let PORT = 0; // the port startHttpsServer(0) bound
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

function makeIdentity(callsign: string): string {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pubKeyHex, callsign);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
    return pubKeyHex;
}

function seedConsolidatedMarker(activeConvId: string, author: string, legacyId: string): void {
    db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(crypto.randomUUID(), activeConvId, author, 'seed-ct', 'seed-nc', 'text',
             JSON.stringify({ originalConversationId: legacyId }), new Date().toISOString());
}

async function main() {
    console.log('Running consolidation-resolution regression tests (PR #436)...\n');
    await initTls();
    initStateEngine();
    PORT = await startHttpsServer(0);

    const A = makeIdentity('Alice');
    const B = makeIdentity('Bob');
    const conv = createConversation('dm', [A, B], A);
    if (!conv) throw new Error('setup: failed to create DM');
    const Y = conv.id;

    // 1 + 2. Legacy send resolves to Y, preserving the original id and any client metadata.
    const LEGACY = 'legacy-' + crypto.randomUUID();
    seedConsolidatedMarker(Y, A, LEGACY);
    const words = lockedDm();
    const msg = sendMessage(LEGACY, A, words.ciphertext, words.nonce, 'text', undefined, JSON.stringify({ foo: 'bar' }));
    assert(!!msg, 'send addressed to a legacy id resolves and returns a message');
    assert(!!msg && msg.conversationId === Y, `message stored under the active conv Y (got ${msg?.conversationId})`);
    const stored = db.prepare('SELECT metadata FROM messages WHERE id=?').get(msg!.id) as any;
    const meta = stored?.metadata ? JSON.parse(stored.metadata) : {};
    assert(meta.originalConversationId === LEGACY, `originalConversationId preserved for E2EE fallback (got ${meta.originalConversationId})`);
    assert(meta.foo === 'bar', 'existing client metadata is preserved, not clobbered');

    // 3. A malformed-metadata row must not break resolution of an unknown id.
    db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(crypto.randomUUID(), Y, A, 'ct', 'nc', 'text', '{not valid json', new Date().toISOString());
    let threw = false;
    let res: ReturnType<typeof sendMessage> = null;
    const unknownWords = lockedDm();
    try { res = sendMessage('unknown-' + crypto.randomUUID(), A, unknownWords.ciphertext, unknownWords.nonce, 'text', undefined, undefined); }
    catch { threw = true; }
    assert(!threw, 'send to an unknown id does not throw despite a malformed-metadata row');
    assert(res === null, 'send to a genuinely unknown conversation returns null');

    // 4. toggleMessageReaction with non-object message metadata (string, number, array)
    const msgPrimitiveMeta = crypto.randomUUID();
    db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(msgPrimitiveMeta, Y, A, 'ct', 'nc', 'text', '12345', new Date().toISOString());
    let reactionThrew = false;
    let reactionRes: any = null;
    try {
        reactionRes = toggleMessageReaction(msgPrimitiveMeta, A, '👍');
    } catch (e: any) {
        reactionThrew = true;
        console.error('Reaction threw error:', e);
    }
    assert(!reactionThrew, 'toggleMessageReaction does not throw when message metadata is a primitive number');
    assert(!!reactionRes && reactionRes.success === true, 'toggleMessageReaction succeeds and initializes reactions array');

    const msgArrayMeta = crypto.randomUUID();
    db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(msgArrayMeta, Y, A, 'ct', 'nc', 'text', '[1, 2, 3]', new Date().toISOString());
    reactionThrew = false;
    reactionRes = null;
    try {
        reactionRes = toggleMessageReaction(msgArrayMeta, A, '🔥');
    } catch (e: any) {
        reactionThrew = true;
    }
    assert(!reactionThrew, 'toggleMessageReaction does not throw when message metadata is a JSON array');
    assert(!!reactionRes && reactionRes.success === true, 'toggleMessageReaction succeeds on array metadata');

    const sendTo = (id: string, author: string) => {
        const w = lockedDm();
        return sendMessage(id, author, w.ciphertext, w.nonce, 'text', undefined, undefined);
    };
    const insertLine = (convId: string, author: string, metadata: string | null) => {
        const id = crypto.randomUUID();
        db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata, timestamp) VALUES (?, ?, ?, 'ct', 'nc', 'text', ?, ?)`)
            .run(id, convId, author, metadata, new Date().toISOString());
        return id;
    };
    const indexed = (oldId: string) => (db.prepare('SELECT COUNT(*) AS c FROM message_old_conversation_ids WHERE old_conversation_id = ?').get(oldId) as any).c as number;

    // 5. A malformed line that names the key is stored, and so is a change to malformed metadata: the triggers read
    //    the metadata only once json_valid() says it is JSON.
    {
        let threwInsert = false, threwUpdate = false;
        let brokenId = '';
        try { brokenId = insertLine(Y, A, '{"originalConversationId": "half'); } catch { threwInsert = true; }
        assert(!threwInsert, 'a malformed line that names originalConversationId is stored');
        try { db.prepare('UPDATE messages SET metadata = ? WHERE id = ?').run('{"originalConversationIds": [', msg!.id); } catch { threwUpdate = true; }
        assert(!threwUpdate, 'a line whose metadata changes to malformed JSON is stored');
        assert(indexed(LEGACY) === 1, `and the line that became malformed no longer names its old id (${indexed(LEGACY)} left, the seed's)`);
        if (brokenId) db.prepare('DELETE FROM messages WHERE id = ?').run(brokenId);
    }

    // 6. The list form (repairConsolidatedMessagesMetadata writes it when a pair had more than one old thread): each
    //    item resolves; a part of one doesn't, where the scan's LIKE matched any part of the list's text.
    {
        const L1 = 'legacy-list-' + crypto.randomUUID();
        const L2 = 'legacy-list-' + crypto.randomUUID();
        insertLine(Y, B, JSON.stringify({ originalConversationIds: [L1, L2, 7, { x: 'legacy' }] }));
        const one = sendTo(L1, A), two = sendTo(L2, B);
        assert(one?.conversationId === Y && two?.conversationId === Y, `each item of originalConversationIds resolves to Y (${one?.conversationId}, ${two?.conversationId})`);
        assert(sendTo(L1.slice(0, 20), A) === null, 'a part of an item resolves to nothing');
        assert(sendTo('7', A) === null, "a list's item that isn't text is no old id");
        const odd = 'legacy-string-' + crypto.randomUUID();
        insertLine(Y, B, JSON.stringify({ originalConversationIds: odd }));
        assert(sendTo(odd, A) === null, 'originalConversationIds that is text, not a list, names no old id');
    }

    // 7. The boot migration folds a per-post thread into the pair's DM, and a send to its old id lands there.
    {
        const C = makeIdentity('Carol'), D = makeIdentity('Dave');
        const postConv = 'post-thread-' + crypto.randomUUID();
        db.prepare(`INSERT INTO conversations (id, type, post_id, created_by, created_at) VALUES (?, 'dm', ?, ?, ?)`)
            .run(postConv, 'post-' + crypto.randomUUID(), C, new Date().toISOString());
        for (const p of [C, D]) db.prepare('INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(postConv, p);
        insertLine(postConv, C, null);
        insertLine(postConv, D, JSON.stringify({ reactions: [] }));
        migrateConsolidateConversations();
        const pair = db.prepare(`SELECT c.id FROM conversations c
            JOIN conversation_participants a ON a.conversation_id = c.id AND a.public_key = ?
            JOIN conversation_participants b ON b.conversation_id = c.id AND b.public_key = ?
            WHERE c.type = 'dm' AND c.post_id IS NULL`).get(C, D) as any;
        assert(!!pair && indexed(postConv) === 2, `the migration moved both lines into the pair's DM, each naming the old thread (${indexed(postConv)})`);
        const sent = sendTo(postConv, D);
        assert(!!pair && sent?.conversationId === pair.id, `a send to the old thread's id lands in the pair's DM (${sent?.conversationId})`);
    }

    // 8. The repair names every old thread of a pair on each line, as a list; each resolves.
    {
        const E = makeIdentity('Erin'), F = makeIdentity('Frank');
        const dm = createConversation('dm', [E, F], E)!;
        insertLine(dm.id, E, null);
        const olds = ['repair-' + crypto.randomUUID(), 'repair-' + crypto.randomUUID()];
        for (const o of olds) for (const p of [E, F]) {
            db.prepare(`INSERT INTO tombstones (table_name, row_key, deleted_at) VALUES ('conversation_participants', ?, ?)`).run(`${o}|${p}`, new Date().toISOString());
        }
        repairConsolidatedMessagesMetadata();
        const landed = olds.map(o => sendTo(o, F)?.conversationId);
        assert(landed.every(c => c === dm.id), `after the repair, each old thread's id lands in the pair's DM (${landed.join(', ')})`);
    }

    // 9. A line deleted, or its metadata changed, stops naming its old id: with no line left naming it, it resolves to nothing.
    {
        const G = 'legacy-gone-' + crypto.randomUUID(), H = 'legacy-edited-' + crypto.randomUUID();
        const g = insertLine(Y, A, JSON.stringify({ originalConversationId: G }));
        const h = insertLine(Y, A, JSON.stringify({ originalConversationId: H }));
        assert(sendTo(G, B)?.conversationId === Y && sendTo(H, B)?.conversationId === Y, 'two old ids, each named by one line, resolve');
        // Each send above wrote a second line naming its old id (sendMessage keeps the id a line was encrypted under).
        const namers = (o: string) => (db.prepare('SELECT id FROM messages WHERE instr(metadata, ?) > 0').all(o) as any[]).map(r => r.id as string);
        assert(namers(G).length === 2 && namers(G).includes(g) && namers(H).length === 2 && namers(H).includes(h),
            `each is named by the line and the send's (${namers(G).length}, ${namers(H).length})`);
        for (const id of namers(G)) db.prepare('DELETE FROM messages WHERE id = ?').run(id);
        for (const id of namers(H)) db.prepare('UPDATE messages SET metadata = ? WHERE id = ?').run(JSON.stringify({ deleted: true }), id);
        assert(indexed(G) === 0 && sendTo(G, B) === null, 'the deleted lines no longer name their old id');
        assert(indexed(H) === 0 && sendTo(H, B) === null, 'lines whose metadata changes no longer name the old id they named');
    }

    // 10. A node upgraded with lines already there: the table, its triggers and the marker are absent at the boot that
    //     brings them, and that boot indexes the lines (db.ts indexOldConversationIds).
    {
        db.exec(`DROP TRIGGER messages_old_conversation_ids_ai; DROP TRIGGER messages_old_conversation_ids_au;
                 DROP TRIGGER messages_old_conversation_ids_ad; DROP TABLE message_old_conversation_ids;`);
        db.prepare("DELETE FROM node_config WHERE key = 'migration_message_old_conversation_ids_v1'").run();
        const U1 = 'legacy-upgrade-' + crypto.randomUUID(), U2 = 'legacy-upgrade-' + crypto.randomUUID(), U3 = 'legacy-upgrade-' + crypto.randomUUID();
        insertLine(Y, A, JSON.stringify({ originalConversationId: U1 }));
        insertLine(Y, B, JSON.stringify({ originalConversationIds: [U2, U3] }));
        insertLine(Y, B, '{"originalConversationId": oops');
        initSchema();
        const landed = [U1, U2, U3].map(u => sendTo(u, A)?.conversationId);
        assert(landed.every(c => c === Y), `the boot that brings the table indexes the lines already there (${landed.join(', ')})`);
        assert(!!db.prepare("SELECT 1 FROM node_config WHERE key = 'migration_message_old_conversation_ids_v1'").get(), 'and writes its marker');
        const before = (db.prepare('SELECT COUNT(*) AS c FROM message_old_conversation_ids').get() as any).c;
        initSchema();
        const after = (db.prepare('SELECT COUNT(*) AS c FROM message_old_conversation_ids').get() as any).c;
        assert(before === after, `a later boot changes nothing (${before} → ${after})`);
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Consolidation-resolution regression checks PASSED.');
    process.exit(0);
}

main().catch(e => { console.error('❌ Test failed:', e); process.exit(1); });

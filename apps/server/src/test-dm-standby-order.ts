/**
 * A DM thread read from a standby is judged in the order it was written, not the order the standby's copy wrote its rows
 * (crypto review M F2, deciding review 3, NON-BLOCKING 6, 2026-10-02).
 *
 * Both apps mark a format-3 DM line shown before the line it was written after ("Shown out of the order it was written
 * in": packages/beanpool-core/src/dm-crypto.ts checkDmThread). The web app used to judge a thread in the node's row order
 * (getConversationMessages is ORDER BY rowid). A standby's delta copy writes rows in last-changed order (the export's
 * delta is by updated_at), so a question that gets a 👍 after its answer lands after the answer on the standby, and the
 * web app on that standby marked an honest answer. Both apps now show and judge a thread by the node's timestamps, then
 * the order given (core dmThreadInShownOrder), which the copy keeps verbatim.
 *
 * Through the real engine in one process, nothing off this machine: a main server's real DM lines (sealed by core's
 * sealDmLine as both apps seal them, sent through the real send path), its real delta export, and a standby's real import.
 *
 *   1. On the main server: Cat asks, Dan answers (written after the question), then Dan reacts 👍 to the question.
 *   2. The delta carries the answer before the question; imported by a standby, its rows are in that order, every column
 *      the main server's.
 *   3. Judged in row order the answer would be marked; in the order both apps now show it, nothing is marked, and the
 *      question is shown first.
 *   4. A real reorder (the node giving the answer the earlier time) is still marked.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-dm-standby-order.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sealDmLine, checkDmThread, dmThreadInShownOrder, type DmThreadLine } from '@beanpool/core';
import { db } from './db/db.js';
import {
    initStateEngine, exportSyncState, importRemoteState, setNodeRole, createConversation, sendMessage, toggleMessageReaction,
    getConversationMessages,
} from './state-engine.js';
import { emptyCopiedTables } from './engine/copied-tables.js';
import { startP2P } from './p2p.js';
import { addConnector } from './connector-manager.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ FAIL: ${msg}`);
}

/** No fetch leaves this machine. */
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
    throw new Error(`this suite reaches nothing off this machine (${url.hostname})`);
}) as typeof fetch;

interface Person { seedHex: string; publicKey: string }
function member(callsign: string): Person {
    const seed = ed25519.utils.randomSecretKey();
    const publicKey = Buffer.from(ed25519.getPublicKey(seed)).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, updated_at)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(publicKey, callsign);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(publicKey);
    return { seedHex: Buffer.from(seed).toString('hex'), publicKey };
}

/** A line as either app sends it: a new id, sealed to it, written after the newest line it had. */
function says(from: Person, to: Person, conversationId: string, text: string, after: string | null): string {
    const id = crypto.randomUUID();
    const sealed = sealDmLine(text, { myEdPrivHex: from.seedHex, peerEdPubHex: to.publicKey, conversationId }, { senderPubHex: from.publicKey, messageId: id, after });
    const stored = sendMessage(conversationId, from.publicKey, sealed.ciphertext, sealed.nonce, 'text', undefined, undefined, id);
    if (stored?.id !== id) throw new Error(`setup: the line was not stored under its own id (${stored?.id})`);
    return id;
}

const asThread = (rows: any[]): DmThreadLine[] => rows.map((m) => ({
    id: m.id, authorPubkey: m.authorPubkey, ciphertext: m.ciphertext, nonce: m.nonce, type: m.type, metadata: m.metadata, timestamp: m.timestamp,
}));
const columns = (convId: string) => db.prepare(
    'SELECT id, conversation_id, author_pubkey, ciphertext, nonce, type, timestamp FROM messages WHERE conversation_id = ? ORDER BY id',
).all(convId);

async function main(): Promise<void> {
    initStateEngine();
    const p2p = await startP2P(0, 0);
    const nodeId = p2p.peerId.toString();
    addConnector(`/ip4/127.0.0.1/tcp/4099/p2p/${nodeId}`, 'mirror', 'self-test-peer');

    const cat = member('Cat');
    const dan = member('Dan');
    const conv = createConversation('dm', [cat.publicKey, dan.publicKey], cat.publicKey);
    if (!conv) throw new Error('setup: no conversation');

    // ── 1 ──
    console.log('\n── 1. On the main server: a question, its answer, then a 👍 on the question');
    const since = new Date(Date.now() - 1000).toISOString();
    const question = says(cat, dan, conv.id, 'Can you take the bike on Saturday?', null);
    await new Promise((r) => setTimeout(r, 5));
    const answer = says(dan, cat, conv.id, 'Yes, I can', question);
    await new Promise((r) => setTimeout(r, 5));
    toggleMessageReaction(question, dan.publicKey, '👍');
    const mainRows = getConversationMessages(conv.id);
    assert(mainRows.map((m) => m.id).join() === [question, answer].join(), 'the main server serves the question, then the answer');
    const onMain = columns(conv.id);

    // ── 2 ──
    console.log('\n── 2. The delta, and a standby\'s import of it');
    const delta: any = await exportSyncState(nodeId, since);
    const inDelta = (delta.messages ?? []).filter((m: any) => m.conversationId === conv.id).map((m: any) => m.id);
    assert(inDelta.join() === [answer, question].join(), `the delta carries them in last-changed order: the answer, then the question (got ${inDelta.length} lines)`);
    emptyCopiedTables(db);   // both lines reach the standby in the same pull
    setNodeRole('backup');
    await importRemoteState(delta);
    setNodeRole('primary');
    const standbyRows = getConversationMessages(conv.id);
    assert(standbyRows.map((m) => m.id).join() === [answer, question].join(), 'the standby\'s rows are in that order: the answer first');
    assert(JSON.stringify(columns(conv.id)) === JSON.stringify(onMain), 'every column of both lines, timestamps included, is the main server\'s');

    // ── 3 ──
    console.log('\n── 3. Judged on the standby');
    const catsKeys = { myEdPrivHex: cat.seedHex, peerEdPubHex: dan.publicKey };
    const byRow = checkDmThread(asThread(standbyRows), catsKeys, conv.id);
    assert(byRow.get(answer)?.mark === 'out-of-order', 'in row order, the honest answer would be marked (the defect)');
    const shown = dmThreadInShownOrder(asThread(standbyRows));
    assert(shown.map((l) => l.id).join() === [question, answer].join(), 'in the order both apps show a thread, the question comes first');
    const views = checkDmThread(shown, catsKeys, conv.id);
    assert(views.get(answer)?.text === 'Yes, I can' && views.get(answer)?.mark === null && views.get(question)?.mark === null,
        `and nothing is marked (answer ${JSON.stringify(views.get(answer))})`);

    // ── 4 ──
    console.log('\n── 4. A real reorder is still marked');
    const [qRow, aRow] = [question, answer].map((id) => db.prepare('SELECT timestamp FROM messages WHERE id = ?').get(id) as { timestamp: string });
    db.prepare('UPDATE messages SET timestamp = ? WHERE id = ?').run(aRow.timestamp, question);
    db.prepare('UPDATE messages SET timestamp = ? WHERE id = ?').run(qRow.timestamp, answer);
    const reordered = checkDmThread(dmThreadInShownOrder(asThread(getConversationMessages(conv.id))), catsKeys, conv.id);
    assert(reordered.get(answer)?.mark === 'out-of-order', 'the operator giving the answer the earlier time: the answer is marked');

    console.log(`\n${passed}/${run} passed`);
    try { await p2p.stop(); } catch { /* stopping only */ }
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

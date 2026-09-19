/**
 * Groups redesign slice 1 — a group's chat is backed up and replicated like the group itself, and the removed
 * old chat group cannot come back through sync.
 *
 *  1. A full snapshot carries the group's chat: the group_thread conversation, its participants (active members
 *     only — a removed member's row is gone), its messages and its system lines with their kind. A fresh node
 *     that imports it serves the same chat to the same people.
 *  2. Leaving travels as a participant tombstone in a delta; the replica drops the chat row, and the member
 *     cannot read the chat there either.
 *  3. The old chat group (type 'group'): a snapshot that still carries one — from a node not yet updated — does
 *     not bring it, its members or its messages back.
 *  4. The boot purge's 'conversations' tombstone deletes an old chat group, its messages and its participants
 *     on a replica that still holds one.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-groups-chat-sync.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { db } from './db/db.js';
import {
    initStateEngine, exportSyncState, importRemoteState, setNodeRole, clearReplicatedTables, signSyncPayload,
    createGroup, joinGroup, removeGroupMember, setMemberRole, postGroupThreadMessage, canReadGroupThread,
} from './state-engine.js';
import { removeOldChatGroups } from './engine/messaging.js';
import { startP2P } from './p2p.js';
import { addConnector } from './connector-manager.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ FAIL: ${msg}`);
}

function makeMember(callsign: string): string {
    const pub = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, avatar_url, status, updated_at)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'data:image/png;base64,iVBORw0KGgo=', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pub, callsign);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pub);
    return pub;
}

const parts = (convId: string) =>
    (db.prepare('SELECT public_key FROM conversation_participants WHERE conversation_id = ? ORDER BY public_key').all(convId) as any[]).map(r => r.public_key);
const msgs = (convId: string) =>
    db.prepare('SELECT id, author_pubkey, ciphertext, nonce, type, system_type FROM messages WHERE conversation_id = ? ORDER BY id').all(convId) as any[];
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

async function asReplica(payload: any): Promise<void> {
    setNodeRole('backup');
    await importRemoteState(payload);
    setNodeRole('primary');
}

async function main(): Promise<void> {
    initStateEngine();
    const p2pNode = await startP2P(4076, 4077);
    const nodeId = p2pNode.peerId.toString();
    addConnector(`/ip4/127.0.0.1/tcp/4077/p2p/${nodeId}`, 'mirror', 'self-test-peer');

    const alice = makeMember('Alice');
    const bob = makeMember('Bob');
    const carol = makeMember('Carol');
    const dave = makeMember('Dave');

    // ── 1. A full snapshot carries the chat ─────────────────────────────────────────────────
    console.log('\n--- 1. The chat survives export → import on a fresh node ---');
    const g = createGroup({ name: 'Seed Savers', joinPolicy: 'open', createdBy: alice });
    joinGroup(g.id, bob);
    joinGroup(g.id, carol);
    joinGroup(g.id, dave);
    setMemberRole(g.id, alice, carol, 'observer');
    postGroupThreadMessage(g.id, bob, 'Tomato seeds are in');
    removeGroupMember(g.id, alice, dave);

    const expectedParts = parts(g.id);
    const expectedMsgs = msgs(g.id);
    assert(expectedParts.length === 3 && !expectedParts.includes(dave), 'fixture: three people in the chat, the removed member not');
    assert(expectedMsgs.some(m => m.system_type === 'GROUP_MEMBER_REMOVED'), 'fixture: the chat holds system lines');

    const payload: any = await exportSyncState(nodeId);
    const exportedConv = (payload.conversations ?? []).find((c: any) => c.id === g.id);
    assert(exportedConv?.type === 'group_thread', 'the snapshot carries the group chat conversation');
    assert((payload.conversationParticipants ?? []).filter((p: any) => p.conversationId === g.id).length === 3, 'and its participants');
    assert((payload.messages ?? []).filter((m: any) => m.conversationId === g.id).length === expectedMsgs.length, 'and every message and system line');

    clearReplicatedTables();
    assert(!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(g.id) && msgs(g.id).length === 0, 'the replica starts without the chat');
    await asReplica(payload);
    assert((db.prepare('SELECT type, name FROM conversations WHERE id = ?').get(g.id) as any)?.type === 'group_thread', 'the chat is back');
    assert(JSON.stringify(parts(g.id)) === JSON.stringify(expectedParts), 'with exactly the same people in it');
    assert(JSON.stringify(msgs(g.id)) === JSON.stringify(expectedMsgs), 'and the same messages, system lines keeping their kind');
    assert(canReadGroupThread(g.id, bob) && canReadGroupThread(g.id, carol), 'members read it on the replica');
    assert(!canReadGroupThread(g.id, dave), 'the removed member still cannot');

    // ── 2. Leaving travels as a tombstone ───────────────────────────────────────────────────
    console.log('\n--- 2. Leaving reaches the replica ---');
    const since = new Date(Date.now() - 1).toISOString();
    await new Promise(r => setTimeout(r, 5));
    const bobRow = db.prepare('SELECT * FROM conversation_participants WHERE conversation_id = ? AND public_key = ?').get(g.id, bob) as any;
    const bobMember = db.prepare('SELECT * FROM group_members WHERE group_id = ? AND member_pubkey = ?').get(g.id, bob) as any;
    removeGroupMember(g.id, bob, bob);
    const delta: any = await exportSyncState(nodeId, since);
    assert((delta.tombstones ?? []).some((t: any) => t.tableName === 'conversation_participants' && t.rowKey === `${g.id}|${bob}`),
        'the delta carries a chat-participant tombstone for Bob');
    // Roll back to what the replica held before the delta.
    db.prepare('INSERT INTO conversation_participants (conversation_id, public_key, last_read_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(g.id, bob, bobRow.last_read_at, bobRow.updated_at);
    db.prepare('INSERT INTO group_members (group_id, member_pubkey, role, status, joined_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(g.id, bob, bobMember.role, bobMember.status, bobMember.joined_at, bobMember.updated_at);
    db.prepare("DELETE FROM tombstones WHERE table_name IN ('conversation_participants', 'group_members')").run();
    await asReplica(delta);
    assert(!parts(g.id).includes(bob), 'the replica drops Bob from the chat');
    assert(!canReadGroupThread(g.id, bob), 'and he cannot read it there');

    // ── 3. An old chat group in a snapshot stays out ────────────────────────────────────────
    console.log('\n--- 3. A snapshot carrying an old chat group does not bring it back ---');
    const oldId = crypto.randomUUID();
    const oldMsg = crypto.randomUUID();
    const insertOld = () => {
        db.prepare(`INSERT INTO conversations (id, type, name, created_by, created_at) VALUES (?, 'group', 'Legacy', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(oldId, alice);
        for (const pk of [alice, bob]) db.prepare('INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(oldId, pk);
        db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce) VALUES (?, ?, ?, ?, 'plaintext-v1')`).run(oldMsg, oldId, alice, b64('old'));
    };
    insertOld();
    const oldSnapshot: any = await exportSyncState(nodeId);
    assert((oldSnapshot.conversations ?? []).some((c: any) => c.id === oldId), 'fixture: a not-yet-updated primary would export it');
    clearReplicatedTables();
    await asReplica(oldSnapshot);
    assert(!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(oldId), 'the replica does not import the old chat group');
    assert(parts(oldId).length === 0 && msgs(oldId).length === 0, 'nor its participants or messages');
    assert(!!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(g.id), 'the group chat in the same snapshot is imported');

    // ── 4. The purge's tombstone reaches a replica ──────────────────────────────────────────
    console.log('\n--- 4. The boot purge deletes an old chat group on a replica too ---');
    insertOld();
    const since2 = new Date(Date.now() - 1).toISOString();
    await new Promise(r => setTimeout(r, 5));
    assert(removeOldChatGroups() === 1, 'the primary purges it');
    const purgeDelta: any = await exportSyncState(nodeId, since2);
    assert((purgeDelta.tombstones ?? []).some((t: any) => t.tableName === 'conversations' && t.rowKey === oldId), 'the delta carries a conversations tombstone');
    // The replica still holds it.
    db.prepare("DELETE FROM tombstones WHERE table_name IN ('conversations', 'conversation_participants') AND row_key LIKE ?").run(`${oldId}%`);
    insertOld();
    const { signature: _s, publicKey: _p, ...unsigned } = purgeDelta;
    await asReplica(await signSyncPayload({ ...unsigned }));
    assert(!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(oldId), 'the replica deletes the old chat group');
    assert(msgs(oldId).length === 0 && parts(oldId).length === 0, 'with its messages and participants');
    assert(!!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(g.id), 'and leaves the group chat alone');

    console.log(`\n${passed}/${run} passed`);
    await p2pNode.stop();
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });

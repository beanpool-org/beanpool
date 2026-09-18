/**
 * Commons groups (#823) — three bugs from the 2026-09-19 groups review (scratch/overnight/groups-review.md §2.4).
 *
 *  1. Groups replicate. `groups` and `group_members` travel in the sync export and import like every other
 *     replicated table: a node restored from its mirror keeps every group, its members, their roles and
 *     statuses. A member leaving is a delete and travels as a tombstone; a re-join beats that tombstone.
 *     Force-resync clears both tables, the state hash covers them and the replica-consistency audit counts them.
 *  2. A group-only post stays group-only on the replica. audience_scope and target_group_id (and the rest of
 *     what decides who sees a post: target_pubkey, assigned_to, reach, reach_peers) cross the wire on insert
 *     AND on update, instead of falling back to the column default 'public'.
 *  3. Removal sticks. A convenor removing someone leaves a 'removed' row, so they cannot Join an open group
 *     straight back, cannot erase the record by "leaving", and cannot read group-only posts. Only a convenor
 *     re-admits them (invite, or approve). Someone who LEFT on their own can rejoin an open group.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-groups-sync-and-removal.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { db } from './db/db.js';
import {
    initStateEngine, exportSyncState, importRemoteState, setNodeRole, clearReplicatedTables,
    createGroup, getGroup, listGroups, joinGroup, removeGroupMember, inviteGroupMember, approveGroupMember,
    setMemberRole, isGroupMember, getMemberGroupIds, createPost, getPosts, signSyncPayload,
} from './state-engine.js';
import { getStateHash, getReplicaConsistency } from '@beanpool/engine';
import { startP2P } from './p2p.js';
import { addConnector } from './connector-manager.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ FAIL: ${msg}`);
}
function assertThrows(fn: () => unknown, match: RegExp, msg: string): void {
    run++;
    try {
        fn();
        console.error(`✗ FAIL: ${msg} (nothing thrown)`);
    } catch (e: any) {
        if (match.test(e?.message ?? '')) { passed++; console.log(`✓ ${msg}`); }
        else console.error(`✗ FAIL: ${msg} (got "${e?.message}")`);
    }
}
/** A step that throws on the unfixed tree must fail its assertion, not abort the run. */
function attempt<T>(fn: () => T): T | undefined {
    try { return fn(); } catch (e: any) { console.error(`  (threw: ${e?.message})`); return undefined; }
}

function makeMember(callsign: string): string {
    const pub = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, avatar_url, status, updated_at)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'data:image/png;base64,iVBORw0KGgo=', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pub, callsign);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pub);
    return pub;
}

const memberRow = (groupId: string, pub: string) =>
    db.prepare('SELECT role, status, updated_at FROM group_members WHERE group_id = ? AND member_pubkey = ?').get(groupId, pub) as any;
const postRow = (id: string) => db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as any;
const sees = (viewer: string, postId: string) => getPosts({ viewerPubkey: viewer }).some(p => p.id === postId);
const count = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as any).c);

function groupPost(author: string, groupId: string, title: string) {
    return createPost('offer', 'tools', title, 'For the group only', 5, 'fixed', author,
        undefined, undefined, [], false, undefined, false, { audienceScope: 'group', targetGroupId: groupId })!;
}

async function main(): Promise<void> {
    initStateEngine();
    const p2pNode = await startP2P(4072, 4073);
    const nodeId = p2pNode.peerId.toString();
    addConnector(`/ip4/127.0.0.1/tcp/4073/p2p/${nodeId}`, 'mirror', 'self-test-peer');

    const alice = makeMember('Alice');   // convenor
    const bob = makeMember('Bob');       // gets removed
    const carol = makeMember('Carol');   // leaves on her own
    const dave = makeMember('Dave');     // stays a member
    const erin = makeMember('Erin');     // never joins
    const frank = makeMember('Frank');   // pending request

    // ── 3. Removal sticks ───────────────────────────────────────────────────────────────────────
    console.log('\n--- 3. A removed member stays removed; a member who left can come back ---');
    const garden = createGroup({ name: 'Garden Crew', joinPolicy: 'open', createdBy: alice });
    joinGroup(garden.id, bob);
    joinGroup(garden.id, carol);
    joinGroup(garden.id, dave);
    const secret = groupPost(alice, garden.id, 'Spare seedlings');
    assert(sees(bob, secret.id), 'while a member, Bob sees the group-only post');

    assert(removeGroupMember(garden.id, alice, bob) === true, 'the convenor removes Bob');
    assert(!isGroupMember(garden.id, bob), 'Bob is no longer a member');
    assert(memberRow(garden.id, bob)?.status === 'removed', 'a removed row is kept with status removed, not deleted');
    assert(!sees(bob, secret.id), 'a removed member cannot read group-only posts');
    assert(!getPosts({ viewerPubkey: bob, audienceScope: 'group' } as any).some(p => p.id === secret.id),
        'not through the group-scoped feed either');
    assert(!getMemberGroupIds(bob).includes(garden.id), 'the group is not among his groups');
    assert(!listGroups({ memberPubkey: bob }, bob).some(g => g.id === garden.id), 'nor in his "my groups" list');
    assert(getGroup(garden.id, alice)?.memberCount === 3, 'the member count no longer counts him');
    const bobView = getGroup(garden.id, bob);
    assert(!bobView?.viewerRole && bobView?.viewerStatus === ('removed' as any),
        'he sees the group as removed, with no role (so no app shows it as one of his)');

    assertThrows(() => joinGroup(garden.id, bob), /removed/i, 'Bob cannot Join the open group straight back');
    assert(!isGroupMember(garden.id, bob), 'and is still not a member after trying');
    assertThrows(() => createPost('offer', 'tools', 'Sneaky', 'x', 1, 'fixed', bob, undefined, undefined, [], false, undefined, false,
        { audienceScope: 'group', targetGroupId: garden.id }), /./, 'nor post to the group');
    attempt(() => removeGroupMember(garden.id, bob, bob));
    assert(memberRow(garden.id, bob)?.status === 'removed', '"leaving" does not erase the removal record');
    assertThrows(() => joinGroup(garden.id, bob), /removed/i, 'so Join is still refused after that');
    assertThrows(() => setMemberRole(garden.id, alice, bob, 'observer'), /not a member/i,
        'a convenor cannot give a removed person a role without re-admitting them');

    assert(removeGroupMember(garden.id, carol, carol) === true, 'Carol leaves on her own');
    assert(!memberRow(garden.id, carol), 'leaving deletes her row');
    const carolBack = attempt(() => joinGroup(garden.id, carol));
    assert(carolBack?.status === 'active', 'a member who left can rejoin an open group');
    const leftAt = (db.prepare(`SELECT deleted_at FROM tombstones WHERE table_name = 'group_members' AND row_key = ?`)
        .get(`${garden.id}|${carol}`) as any)?.deleted_at as string | undefined;
    assert(!!leftAt && memberRow(garden.id, carol)?.updated_at > leftAt,
        'leaving writes a tombstone, and a re-join straight after is stamped strictly later (same millisecond included)');

    const reinvited = attempt(() => inviteGroupMember(garden.id, alice, bob));
    assert(reinvited?.status === 'invited', 'a convenor can re-admit Bob by inviting him');
    const bobBack = attempt(() => joinGroup(garden.id, bob));
    assert(bobBack?.status === 'active' && bobBack?.role === 'member', 'accepting the invite makes him an active member again');
    assert(sees(bob, secret.id), 'and he can read the group-only post again');

    const workshop = createGroup({ name: 'Workshop', joinPolicy: 'request_to_join', createdBy: alice });
    joinGroup(workshop.id, dave);
    approveGroupMember(workshop.id, alice, dave);
    removeGroupMember(workshop.id, alice, dave);
    assertThrows(() => joinGroup(workshop.id, dave), /removed/i, 'a removed member cannot re-request a request-to-join group');
    const approved = attempt(() => approveGroupMember(workshop.id, alice, dave));
    assert(approved?.status === 'active', 'a convenor can re-admit by approving');

    const circle = createGroup({ name: 'Quiet Circle', joinPolicy: 'invite_only', createdBy: alice });
    inviteGroupMember(circle.id, alice, erin);
    joinGroup(circle.id, erin);
    removeGroupMember(circle.id, alice, erin);
    assert(!listGroups({}, erin).some(g => g.id === circle.id), 'a removed member no longer sees a hidden invite-only group listed');

    // ── 1 & 2. Replication ──────────────────────────────────────────────────────────────────────
    console.log('\n--- 1. Groups, members and roles survive export → import on a fresh node ---');
    const guild = createGroup({ name: 'Bakers Guild', joinPolicy: 'request_to_join', category: 'guild', description: 'Bread', createdBy: alice });
    joinGroup(guild.id, dave);
    approveGroupMember(guild.id, alice, dave);
    setMemberRole(guild.id, alice, dave, 'convenor');
    joinGroup(guild.id, carol);
    approveGroupMember(guild.id, alice, carol);
    setMemberRole(guild.id, alice, carol, 'observer');
    joinGroup(guild.id, frank);                       // pending
    joinGroup(guild.id, bob);
    approveGroupMember(guild.id, alice, bob);
    removeGroupMember(guild.id, alice, bob);          // removed
    const guildPost = groupPost(alice, guild.id, 'Sourdough starter');
    // The rest of what decides who sees a listing.
    db.prepare(`UPDATE posts SET reach = 'peers', reach_peers = ? WHERE id = ?`).run(JSON.stringify(['12D3KooWPeerA']), guildPost.id);
    const direct = createPost('offer', 'tools', 'Just for Erin', 'x', 1, 'fixed', alice, undefined, undefined, [], false, undefined, false,
        { audienceScope: 'direct', targetPubkey: erin, assignedTo: erin })!;

    const expected = (db.prepare('SELECT group_id, member_pubkey, role, status FROM group_members ORDER BY group_id, member_pubkey').all() as any[])
        .map(r => `${r.group_id}|${r.member_pubkey}|${r.role}|${r.status}`);
    const expectedGroups = db.prepare('SELECT id, name, slug, description, category, created_by, join_policy FROM groups ORDER BY id').all() as any[];
    const primaryHash = getStateHash(db);
    const payload: any = await exportSyncState(nodeId);
    assert((payload.groups ?? []).length === expectedGroups.length, 'the snapshot carries every group');
    assert((payload.groupMembers ?? []).length === expected.length, 'and every membership row, removed and pending included');
    const exportedPost = (payload.posts ?? []).find((p: any) => p.id === guildPost.id);
    assert(exportedPost?.audienceScope === 'group' && exportedPost?.targetGroupId === guild.id,
        'a group-only post is exported with its scope and group');

    // A fresh node: the replicated tables are empty. clearReplicatedTables is the force-resync path and has to
    // empty the group tables too; they are also wiped by hand so the import below is what puts them back.
    clearReplicatedTables();
    assert(count('groups') === 0 && count('group_members') === 0, 'force-resync clears groups and group_members');
    db.prepare('DELETE FROM group_members').run();
    db.prepare('DELETE FROM groups').run();
    assert(count('posts') === 0 && count('members') === 0, 'the replica starts empty');

    setNodeRole('backup');
    await importRemoteState(payload);
    setNodeRole('primary');

    const replicaGroups = db.prepare('SELECT id, name, slug, description, category, created_by, join_policy FROM groups ORDER BY id').all() as any[];
    assert(JSON.stringify(replicaGroups) === JSON.stringify(expectedGroups), 'every group is back with its name, slug, category and join policy');
    const replicaMembers = (db.prepare('SELECT group_id, member_pubkey, role, status FROM group_members ORDER BY group_id, member_pubkey').all() as any[])
        .map(r => `${r.group_id}|${r.member_pubkey}|${r.role}|${r.status}`);
    assert(JSON.stringify(replicaMembers) === JSON.stringify(expected), 'every membership is back with its role and status');
    assert(isGroupConvenorRow(guild.id, dave), 'a promoted convenor is still a convenor on the replica');
    assert(memberRow(guild.id, bob)?.status === 'removed', 'a removal is still a removal on the replica');
    assertThrows(() => joinGroup(guild.id, bob), /removed/i, 'so the removed member still cannot rejoin there');
    assert(getStateHash(db) === primaryHash, 'the replica state hash matches the primary');
    const consistency = getReplicaConsistency(db, payload, 0);
    const table = (n: string) => consistency.tables.find(t => t.name === n);
    assert(table('groups')?.match === true && table('group_members')?.match === true,
        'the replica-consistency audit counts groups and group_members, and they match');

    console.log('\n--- 2. A group-only post stays group-only on the replica ---');
    const rp = postRow(guildPost.id);
    assert(rp?.audience_scope === 'group' && rp?.target_group_id === guild.id, 'the imported post keeps audience_scope and target_group_id');
    assert(rp?.reach === 'peers' && rp?.reach_peers === JSON.stringify(['12D3KooWPeerA']), 'and its reach');
    const rd = postRow(direct.id);
    assert(rd?.audience_scope === 'direct' && rd?.target_pubkey === erin && rd?.assigned_to === erin, 'a direct post keeps its target');
    assert(!getPosts().some(p => p.id === guildPost.id), 'an anonymous reader on the replica does not see it');
    assert(!sees(erin, guildPost.id), 'a non-member on the replica does not see it');
    assert(!sees(bob, guildPost.id), 'a removed member on the replica does not see it');
    assert(sees(dave, guildPost.id) && sees(carol, guildPost.id), 'active members on the replica do');
    assert(!sees(dave, direct.id) && sees(erin, direct.id), 'the direct post is only for its target');

    // The UPDATE path: a replica already holding an older copy of the post as public.
    db.prepare(`UPDATE posts SET audience_scope = 'public', target_group_id = NULL, updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(guildPost.id);
    setNodeRole('backup');
    await importRemoteState(payload);
    setNodeRole('primary');
    const ru = postRow(guildPost.id);
    assert(ru?.audience_scope === 'group' && ru?.target_group_id === guild.id, 'a newer copy re-scopes a stale public row back to the group');

    console.log('\n--- 1b. Leaving travels as a tombstone; a re-join beats it; later changes win ---');
    const since = new Date(Date.now() - 1).toISOString();
    await new Promise(r => setTimeout(r, 5));
    const before = memberRow(guild.id, frank);
    removeGroupMember(guild.id, frank, frank);        // Frank withdraws his request
    const carolBefore = memberRow(guild.id, carol);
    setMemberRole(guild.id, alice, carol, 'member');
    const delta: any = await exportSyncState(nodeId, since);
    assert((delta.tombstones ?? []).some((t: any) => t.tableName === 'group_members' && t.rowKey === `${guild.id}|${frank}`),
        'a member leaving exports a group_members tombstone');
    assert((delta.groupMembers ?? []).some((m: any) => m.memberPubkey === carol && m.role === 'member'),
        'a role change is in the delta');
    // Roll this database back to what a replica held before the delta.
    db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status, joined_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(guild.id, frank, before.role, before.status, before.updated_at, before.updated_at);
    db.prepare(`DELETE FROM tombstones WHERE table_name = 'group_members'`).run();
    db.prepare(`UPDATE group_members SET role = ?, updated_at = ? WHERE group_id = ? AND member_pubkey = ?`)
        .run(carolBefore.role, carolBefore.updated_at, guild.id, carol);
    setNodeRole('backup');
    await importRemoteState(delta);
    setNodeRole('primary');
    assert(!memberRow(guild.id, frank), 'the replica drops the row of a member who left');
    assert(memberRow(guild.id, carol)?.role === 'member', 'and applies the newer role (last write wins)');

    // An older copy must not overwrite a newer one.
    const { signature: _s, publicKey: _p, ...unsigned } = delta;
    const stale = { ...unsigned, tombstones: [], groupMembers: (delta.groupMembers ?? []).map((m: any) => ({ ...m, role: 'observer', updatedAt: '2000-01-01T00:00:00.000Z' })) };
    const signed = await signSyncPayload(stale);
    setNodeRole('backup');
    await importRemoteState(signed);
    setNodeRole('primary');
    assert(memberRow(guild.id, carol)?.role === 'member', 'an older membership row does not overwrite a newer one');

    // Leave, then rejoin: the replica imports both and keeps the member.
    const since2 = new Date(Date.now() - 1).toISOString();
    await new Promise(r => setTimeout(r, 5));
    removeGroupMember(garden.id, carol, carol);
    await new Promise(r => setTimeout(r, 5));
    joinGroup(garden.id, carol);
    const churn: any = await exportSyncState(nodeId, since2);
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND member_pubkey = ?').run(garden.id, carol);
    setNodeRole('backup');
    await importRemoteState(churn);
    setNodeRole('primary');
    assert(memberRow(garden.id, carol)?.status === 'active', 'a replica importing a leave and a re-join together keeps the member');

    console.log(`\n${passed}/${run} passed`);
    await p2pNode.stop();
    process.exit(passed === run ? 0 : 1);
}

function isGroupConvenorRow(groupId: string, pub: string): boolean {
    const r = memberRow(groupId, pub);
    return r?.role === 'convenor' && r?.status === 'active';
}

main().catch(e => { console.error(e); process.exit(1); });

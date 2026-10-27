/**
 * Integration/unit tests for pending group invites engine module (apps/server/src/engine/group-invites.ts).
 *
 * Asserts pendingGroupInvites behavior:
 *  1. Returns empty list when member has no group invitations.
 *  2. Returns pending invitations mapped to wire shape and ordered by joined_at DESC, g.id.
 *  3. Ignores invitations for closed groups (group_closures).
 *  4. Ignores group memberships where status is not 'invited' (e.g., 'active', 'pending_approval').
 *  5. Returns empty list when caller's account status is disabled or suspended.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-group-invites-engine.ts
 */

import { initStateEngine } from './state-engine.js';
import { db } from './db/db.js';
import { pendingGroupInvites } from './engine/group-invites.js';

let run = 0;
let passed = 0;

function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ FAIL: ${msg}`);
        process.exitCode = 1;
    }
}

function main(): void {
    console.log('Running engine/group-invites.ts tests...\n');

    initStateEngine();

    const alice = 'pubkey_alice_group_invites_1111111111111111111111111111111111';
    const bob = 'pubkey_bob_group_invites_22222222222222222222222222222222222';
    const convenor = 'pubkey_convenor_333333333333333333333333333333333333333333333';

    const now = new Date().toISOString();
    const older = new Date(Date.now() - 3600_000).toISOString();
    const oldest = new Date(Date.now() - 7200_000).toISOString();

    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, earned_credit) VALUES (?, ?, ?, 'active', 100)`).run(alice, 'alice', now);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, earned_credit) VALUES (?, ?, ?, 'active', 100)`).run(bob, 'bob', now);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, earned_credit) VALUES (?, ?, ?, 'active', 100)`).run(convenor, 'convenor', now);

    // 1. No invitations
    const emptyInvites = pendingGroupInvites(alice);
    assert(Array.isArray(emptyInvites) && emptyInvites.length === 0, 'pendingGroupInvites returns empty array when member has no invitations');

    // 2. Active invitation mapped and ordered
    const g1 = 'group_id_11111111111111111111111111111111111111111111111111111111';
    const g2 = 'group_id_22222222222222222222222222222222222222222222222222222222';
    const g3 = 'group_id_33333333333333333333333333333333333333333333333333333333';

    db.prepare(`INSERT INTO groups (id, name, slug, category, created_by, lead_pubkey, join_policy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(g1, 'Alpha Club', 'alpha-club', 'social', convenor, convenor, 'invite_only', oldest, oldest);
    db.prepare(`INSERT INTO groups (id, name, slug, category, created_by, lead_pubkey, join_policy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(g2, 'Beta Guild', 'beta-guild', 'guild', convenor, convenor, 'open', older, older);
    db.prepare(`INSERT INTO groups (id, name, slug, category, created_by, lead_pubkey, join_policy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(g3, 'Gamma Hub', 'gamma-hub', 'general', convenor, convenor, 'request_to_join', now, now);

    // Alice invited to g1 (oldest) and g2 (newer)
    db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status, joined_at, role_since, updated_at) VALUES (?, ?, 'member', 'invited', ?, ?, ?)`).run(g1, alice, oldest, oldest, oldest);
    db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status, joined_at, role_since, updated_at) VALUES (?, ?, 'member', 'invited', ?, ?, ?)`).run(g2, alice, older, older, older);

    // Bob active in g3
    db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status, joined_at, role_since, updated_at) VALUES (?, ?, 'member', 'active', ?, ?, ?)`).run(g3, bob, now, now, now);

    const aliceInvites = pendingGroupInvites(alice);
    assert(aliceInvites.length === 2, 'pendingGroupInvites returns 2 invites for Alice');
    assert(aliceInvites[0].groupId === g2 && aliceInvites[0].name === 'Beta Guild' && aliceInvites[0].category === 'guild' && aliceInvites[0].joinPolicy === 'open', 'first invite is newer (Beta Guild)');
    assert(aliceInvites[1].groupId === g1 && aliceInvites[1].name === 'Alpha Club' && aliceInvites[1].category === 'social' && aliceInvites[1].joinPolicy === 'invite_only', 'second invite is older (Alpha Club)');

    const bobInvites = pendingGroupInvites(bob);
    assert(bobInvites.length === 0, 'pendingGroupInvites ignores active memberships (returns 0 for Bob)');

    // 3. Closed group filter
    db.prepare(`INSERT INTO group_closures (group_id, decision_id, closed_at, created_at, updated_at) VALUES (?, 'decision_closed_1', ?, ?, ?)`).run(g2, now, now, now);

    const aliceInvitesAfterClosure = pendingGroupInvites(alice);
    assert(aliceInvitesAfterClosure.length === 1 && aliceInvitesAfterClosure[0].groupId === g1, 'pendingGroupInvites excludes invitations for closed groups');

    // 4. Status non-invited filter
    db.prepare(`UPDATE group_members SET status = 'active' WHERE group_id = ? AND member_pubkey = ?`).run(g1, alice);
    assert(pendingGroupInvites(alice).length === 0, 'pendingGroupInvites ignores membership after status changes to active');

    // Re-invite Alice to g3 (status 'invited')
    db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status, joined_at, role_since, updated_at) VALUES (?, ?, 'member', 'invited', ?, ?, ?)`).run(g3, alice, now, now, now);
    assert(pendingGroupInvites(alice).length === 1 && pendingGroupInvites(alice)[0].groupId === g3, 'pendingGroupInvites returns newly invited group');

    // 5. Suspended / disabled account filter
    db.prepare(`UPDATE members SET status = 'disabled' WHERE public_key = ?`).run(alice);
    assert(pendingGroupInvites(alice).length === 0, 'pendingGroupInvites returns empty array when member account is disabled');

    db.prepare(`UPDATE members SET status = 'suspended' WHERE public_key = ?`).run(alice);
    assert(pendingGroupInvites(alice).length === 0, 'pendingGroupInvites returns empty array when member account is suspended');

    db.prepare(`UPDATE members SET status = 'active' WHERE public_key = ?`).run(alice);
    assert(pendingGroupInvites(alice).length === 1, 'pendingGroupInvites restores invites when account status returns to active');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        throw new Error(`${run - passed} check(s) failed`);
    }
    console.log('COUNT_LINE: ' + passed + '/' + run + ' checks passed.');
    process.exit(0);
}

main();

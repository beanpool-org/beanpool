import { describe, it, beforeEach } from 'vitest';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import {
    createGroup,
    getGroup,
    listGroups,
    getGroupMembers,
    joinGroup,
    isGroupConvenor,
    isGroupMember,
    setMemberRole,
    removeGroupMember,
    updateGroupPolicy,
    updateGroup,
    approveGroupMember,
    inviteGroupMember,
    deleteGroupPost
} from '../groups.js';
import { getPosts, getPostCount, getActivePostCount } from '../posts.js';

describe('Groups Engine & Convenor Moderation (§9)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = new Database(':memory:');
        db.exec(`
            CREATE TABLE members (
                public_key TEXT PRIMARY KEY,
                callsign TEXT NOT NULL,
                avatar_url TEXT,
                status TEXT DEFAULT 'active',
                earned_credit REAL DEFAULT 0,
                paused INTEGER DEFAULT 0,
                joined_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE groups (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                slug TEXT UNIQUE NOT NULL,
                description TEXT,
                avatar_url TEXT,
                category TEXT DEFAULT 'general' CHECK (category IN ('working_group', 'social', 'guild', 'project', 'general')),
                created_by TEXT NOT NULL REFERENCES members(public_key),
                join_policy TEXT NOT NULL DEFAULT 'open' CHECK (join_policy IN ('open', 'request_to_join', 'invite_only')),
                created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            );

            CREATE TABLE group_members (
                group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
                member_pubkey TEXT NOT NULL REFERENCES members(public_key) ON DELETE CASCADE,
                role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('convenor', 'member', 'observer')),
                status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending_approval', 'invited')),
                joined_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                invited_by TEXT REFERENCES members(public_key),
                updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                PRIMARY KEY (group_id, member_pubkey)
            );

            CREATE TABLE posts (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                category TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT NOT NULL,
                credits REAL NOT NULL,
                price_type TEXT DEFAULT 'fixed',
                author_pubkey TEXT NOT NULL REFERENCES members(public_key),
                created_at DATETIME NOT NULL,
                active INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'active',
                repeatable INTEGER DEFAULT 0,
                accepted_by TEXT REFERENCES members(public_key),
                accepted_at DATETIME,
                pending_transaction_id TEXT,
                completed_at DATETIME,
                lat REAL,
                lng REAL,
                updated_at DATETIME NOT NULL,
                cash_also_needed INTEGER DEFAULT 0,
                reach TEXT DEFAULT 'local',
                reach_peers TEXT,
                origin_node TEXT,
                created_by TEXT,
                poll_options TEXT,
                poll_closes_at DATETIME,
                audience_scope TEXT NOT NULL DEFAULT 'public' CHECK (audience_scope IN ('public', 'group', 'direct')),
                target_group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
                target_pubkey TEXT REFERENCES members(public_key),
                assigned_to TEXT REFERENCES members(public_key),
                target_archetypes TEXT
            );

            CREATE TABLE marketplace_transactions (
                id TEXT PRIMARY KEY,
                post_id TEXT NOT NULL REFERENCES posts(id),
                buyer_pubkey TEXT,
                seller_pubkey TEXT,
                status TEXT NOT NULL,
                created_at DATETIME,
                completed_at DATETIME
            );

            CREATE TABLE deferred_wage_claims (
                id TEXT PRIMARY KEY,
                post_id TEXT,
                status TEXT
            );

            CREATE TABLE transactions (
                id TEXT PRIMARY KEY,
                from_pubkey TEXT,
                to_pubkey TEXT,
                amount REAL
            );

            CREATE TABLE member_preferences (
                public_key TEXT,
                pref_key TEXT,
                pref_value TEXT
            );

            CREATE TABLE post_photos (
                post_id TEXT,
                photo_data TEXT,
                order_num INTEGER,
                updated_at DATETIME
            );

            INSERT INTO members (public_key, callsign) VALUES
                ('alice_pub', 'Alice'),
                ('bob_pub', 'Bob'),
                ('carol_pub', 'Carol'),
                ('dave_pub', 'Dave');
        `);
    });

    it('creates a group with creator as convenor (not steward or host)', () => {
        const group = createGroup(db, {
            name: 'Mullum Permaculture',
            description: 'Local gardening collective',
            category: 'working_group',
            joinPolicy: 'open',
            createdBy: 'alice_pub'
        });

        assert.strictEqual(group.name, 'Mullum Permaculture');
        assert.strictEqual(group.slug, 'mullum-permaculture');
        assert.strictEqual(group.joinPolicy, 'open');
        assert.strictEqual(group.memberCount, 1);
        assert.strictEqual(group.convenorPubkey, 'alice_pub');

        assert.ok(isGroupConvenor(db, group.id, 'alice_pub'));
        assert.ok(isGroupMember(db, group.id, 'alice_pub'));
        assert.ok(!isGroupConvenor(db, group.id, 'bob_pub'));

        const members = getGroupMembers(db, group.id);
        assert.strictEqual(members.length, 1);
        assert.strictEqual(members[0].role, 'convenor');
        assert.strictEqual(members[0].status, 'active');
    });

    it('handles open join policy', () => {
        const group = createGroup(db, {
            name: 'Open Guild',
            joinPolicy: 'open',
            createdBy: 'alice_pub'
        });

        const member = joinGroup(db, group.id, 'bob_pub');
        assert.strictEqual(member.role, 'member');
        assert.strictEqual(member.status, 'active');

        const fetched = getGroup(db, group.id);
        assert.strictEqual(fetched?.memberCount, 2);
    });

    it('handles request_to_join policy and convenor approval', () => {
        const group = createGroup(db, {
            name: 'Private Guild',
            joinPolicy: 'request_to_join',
            createdBy: 'alice_pub'
        });

        const req = joinGroup(db, group.id, 'bob_pub');
        assert.strictEqual(req.status, 'pending_approval');
        // Pending member is not an active member yet
        assert.ok(!isGroupMember(db, group.id, 'bob_pub'));

        // Convenor approves Bob
        const approved = approveGroupMember(db, group.id, 'alice_pub', 'bob_pub');
        assert.strictEqual(approved.status, 'active');
        assert.ok(isGroupMember(db, group.id, 'bob_pub'));
    });

    it('handles invite_only policy', () => {
        const group = createGroup(db, {
            name: 'Secret Circle',
            joinPolicy: 'invite_only',
            createdBy: 'alice_pub'
        });

        assert.throws(() => {
            joinGroup(db, group.id, 'bob_pub');
        }, /invite only/i);

        // Convenor invites Bob
        const invited = inviteGroupMember(db, group.id, 'alice_pub', 'bob_pub', 'member');
        assert.strictEqual(invited.status, 'invited');
        assert.ok(!isGroupMember(db, group.id, 'bob_pub'));

        // Bob accepts by joining
        const accepted = joinGroup(db, group.id, 'bob_pub');
        assert.strictEqual(accepted.status, 'active');
        assert.ok(isGroupMember(db, group.id, 'bob_pub'));
    });

    it('convenor moderation: role management and demotion safety', () => {
        const group = createGroup(db, {
            name: 'Team A',
            createdBy: 'alice_pub'
        });
        joinGroup(db, group.id, 'bob_pub');

        // Alice promotes Bob to convenor
        const updatedBob = setMemberRole(db, group.id, 'alice_pub', 'bob_pub', 'convenor');
        assert.strictEqual(updatedBob.role, 'convenor');

        // Bob changes Alice to observer
        const updatedAlice = setMemberRole(db, group.id, 'bob_pub', 'alice_pub', 'observer');
        assert.strictEqual(updatedAlice.role, 'observer');

        // Bob tries to demote himself while being the last convenor -> MUST fail
        assert.throws(() => {
            setMemberRole(db, group.id, 'bob_pub', 'bob_pub', 'member');
        }, /last active convenor/i);

        // Non-convenor cannot change roles
        assert.throws(() => {
            setMemberRole(db, group.id, 'alice_pub', 'bob_pub', 'member');
        }, /UNAUTHORIZED/i);
    });

    it('convenor moderation: member removal and policy update', () => {
        const group = createGroup(db, {
            name: 'Team B',
            joinPolicy: 'open',
            createdBy: 'alice_pub'
        });
        joinGroup(db, group.id, 'bob_pub');

        // Convenor changes policy
        updateGroupPolicy(db, group.id, 'alice_pub', 'invite_only');
        assert.strictEqual(getGroup(db, group.id)?.joinPolicy, 'invite_only');

        // Convenor removes Bob
        const removed = removeGroupMember(db, group.id, 'alice_pub', 'bob_pub');
        assert.ok(removed);
        assert.ok(!isGroupMember(db, group.id, 'bob_pub'));

        // Alice cannot remove herself if she is the last convenor and others exist (here no others, but let's test with member)
        inviteGroupMember(db, group.id, 'alice_pub', 'carol_pub');
        joinGroup(db, group.id, 'carol_pub');
        assert.throws(() => {
            removeGroupMember(db, group.id, 'alice_pub', 'alice_pub');
        }, /last active convenor/i);
    });

    it('convenor moderation: delete post in group', () => {
        const group = createGroup(db, { name: 'Gardening', createdBy: 'alice_pub' });
        joinGroup(db, group.id, 'bob_pub');

        // Insert post in group
        const now = new Date().toISOString();
        db.prepare(`
            INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, updated_at, audience_scope, target_group_id)
            VALUES ('post_g1', 'offer', 'tools', 'Shovel', 'Sturdy shovel', 5, 'bob_pub', ?, ?, 'group', ?)
        `).run(now, now, group.id);

        // Stranger cannot delete post
        assert.throws(() => {
            deleteGroupPost(db, group.id, 'carol_pub', 'post_g1');
        }, /UNAUTHORIZED/i);

        // Convenor deletes post
        const deleted = deleteGroupPost(db, group.id, 'alice_pub', 'post_g1');
        assert.ok(deleted);

        const postRow = db.prepare("SELECT active, status FROM posts WHERE id = 'post_g1'").get() as any;
        assert.strictEqual(postRow.active, 0);
        assert.strictEqual(postRow.status, 'cancelled');

        // Residual non-group post with target_group_id cannot be deleted by convenor
        db.prepare(`
            INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, updated_at, audience_scope, target_group_id)
            VALUES ('post_public_with_group', 'offer', 'tools', 'Public Ladder', 'Open ladder', 5, 'bob_pub', ?, ?, 'public', ?)
        `).run(now, now, group.id);

        assert.throws(() => {
            deleteGroupPost(db, group.id, 'alice_pub', 'post_public_with_group');
        }, /does not belong to this group/i);
    });

    it('audience scoping in getPosts and getPostCount excludes private posts from unauthorized viewers', () => {
        const group = createGroup(db, { name: 'Makers', createdBy: 'alice_pub' });
        joinGroup(db, group.id, 'bob_pub');

        const now = new Date().toISOString();
        // 1. Public post
        db.prepare(`
            INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, updated_at, audience_scope)
            VALUES ('p_pub', 'offer', 'food', 'Apples', 'Fresh apples', 2, 'carol_pub', ?, ?, 'public')
        `).run(now, now);

        // 2. Group post in Makers
        db.prepare(`
            INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, updated_at, audience_scope, target_group_id)
            VALUES ('p_grp', 'offer', 'tools', 'Laser cutter access', 'In maker shed', 10, 'alice_pub', ?, ?, 'group', ?)
        `).run(now, now, group.id);

        // 3. Direct post from Carol to Dave
        db.prepare(`
            INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, updated_at, audience_scope, target_pubkey)
            VALUES ('p_dir', 'need', 'help', 'Private task', 'Confidential', 20, 'carol_pub', ?, ?, 'direct', 'dave_pub')
        `).run(now, now);

        // A. Anonymous / Unauthenticated viewer:
        const anonPosts = getPosts(db);
        assert.strictEqual(anonPosts.length, 1);
        assert.strictEqual(anonPosts[0].id, 'p_pub');
        assert.strictEqual(getPostCount(db), 1);
        assert.strictEqual(getActivePostCount(db), 1);

        // Direct ID lookup anonymously on group/direct post must fail
        assert.strictEqual(getPosts(db, { id: 'p_grp' }).length, 0);
        assert.strictEqual(getPosts(db, { id: 'p_dir' }).length, 0);

        // B. Bob (member of Makers):
        const bobPosts = getPosts(db, { viewerPubkey: 'bob_pub' });
        const bobIds = bobPosts.map(p => p.id);
        assert.ok(bobIds.includes('p_pub'), 'Bob sees public posts');
        assert.ok(bobIds.includes('p_grp'), 'Bob sees Makers group post');
        assert.ok(!bobIds.includes('p_dir'), 'Bob CANNOT see Carol->Dave direct post');

        // C. Dave (recipient of direct post, not in Makers):
        const davePosts = getPosts(db, { viewerPubkey: 'dave_pub' });
        const daveIds = davePosts.map(p => p.id);
        assert.ok(daveIds.includes('p_pub'), 'Dave sees public posts');
        assert.ok(!daveIds.includes('p_grp'), 'Dave CANNOT see Makers group post');
        assert.ok(daveIds.includes('p_dir'), 'Dave sees direct post addressed to him');

        // D. Carol (author of direct post, not in Makers):
        const carolPosts = getPosts(db, { viewerPubkey: 'carol_pub' });
        const carolIds = carolPosts.map(p => p.id);
        assert.ok(carolIds.includes('p_pub'));
        assert.ok(!carolIds.includes('p_grp'));
        assert.ok(carolIds.includes('p_dir'), 'Carol sees direct post as author');
    });
});

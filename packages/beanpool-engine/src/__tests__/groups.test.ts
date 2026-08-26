import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
    createGroup,
    getGroup,
    listGroups,
    getGroupMembers,
    joinGroup,
    setMemberRole,
    removeGroupMember,
    isGroupSteward,
    isGroupMember,
    getMemberGroupIds
} from '../groups.js';
import { getPosts, rowToPost } from '../posts.js';

describe('beanpool-engine groups & audience scoping', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = new Database(':memory:');
        db.exec(`
            CREATE TABLE members (
                public_key TEXT PRIMARY KEY,
                callsign TEXT NOT NULL,
                joined_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                avatar_url TEXT,
                status TEXT DEFAULT 'active',
                earned_credit REAL DEFAULT 0
            );

            CREATE TABLE member_preferences (
                public_key TEXT NOT NULL,
                pref_key TEXT NOT NULL,
                pref_value TEXT NOT NULL DEFAULT 'true',
                PRIMARY KEY (public_key, pref_key)
            );

            CREATE TABLE transactions (
                id TEXT PRIMARY KEY,
                from_pubkey TEXT NOT NULL,
                to_pubkey TEXT NOT NULL,
                amount REAL NOT NULL,
                timestamp DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            );

            CREATE TABLE marketplace_transactions (
                id TEXT PRIMARY KEY,
                buyer_pubkey TEXT NOT NULL,
                seller_pubkey TEXT NOT NULL,
                status TEXT DEFAULT 'completed'
            );

            CREATE TABLE groups (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                slug TEXT UNIQUE NOT NULL,
                description TEXT,
                avatar_url TEXT,
                category TEXT DEFAULT 'general',
                created_by TEXT NOT NULL REFERENCES members(public_key),
                join_policy TEXT NOT NULL DEFAULT 'open',
                is_official INTEGER NOT NULL DEFAULT 0,
                treasury_pubkey TEXT,
                conversation_id TEXT,
                created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            );

            CREATE TABLE group_members (
                group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
                member_pubkey TEXT NOT NULL REFERENCES members(public_key) ON DELETE CASCADE,
                role TEXT NOT NULL DEFAULT 'member',
                status TEXT NOT NULL DEFAULT 'active',
                joined_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                invited_by TEXT,
                updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                PRIMARY KEY (group_id, member_pubkey)
            );

            CREATE TABLE posts (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                category TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT NOT NULL,
                credits REAL NOT NULL DEFAULT 0,
                author_pubkey TEXT NOT NULL,
                created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                active INTEGER DEFAULT 1,
                status TEXT DEFAULT 'active',
                price_type TEXT DEFAULT 'fixed',
                repeatable INTEGER DEFAULT 0,
                cash_also_needed INTEGER DEFAULT 0,
                accepted_by TEXT,
                pending_transaction_id TEXT,
                completed_at DATETIME,
                lat REAL,
                lng REAL,
                origin_node TEXT,
                reach TEXT NOT NULL DEFAULT 'local',
                reach_peers TEXT,
                audience_scope TEXT NOT NULL DEFAULT 'public',
                target_group_id TEXT,
                target_pubkey TEXT,
                assigned_to TEXT,
                target_archetypes TEXT
            );

            CREATE TABLE post_photos (
                post_id TEXT NOT NULL,
                photo_data TEXT NOT NULL,
                order_num INTEGER NOT NULL,
                updated_at DATETIME,
                PRIMARY KEY (post_id, order_num)
            );
        `);

        // Seed members
        db.prepare(`INSERT INTO members (public_key, callsign) VALUES ('alice_key', 'Alice')`).run();
        db.prepare(`INSERT INTO members (public_key, callsign) VALUES ('bob_key', 'Bob')`).run();
        db.prepare(`INSERT INTO members (public_key, callsign) VALUES ('carol_key', 'Carol')`).run();
    });

    it('creates a group and automatically assigns creator as steward', () => {
        const group = createGroup(db, {
            name: 'Community Garden',
            description: 'Organic community garden team',
            createdBy: 'alice_key',
            category: 'working_group',
            joinPolicy: 'open'
        });

        expect(group.id).toBeDefined();
        expect(group.name).toBe('Community Garden');
        expect(group.slug).toBe('community-garden');
        expect(group.memberCount).toBe(1);
        expect(group.currentUserRole).toBe('steward');

        expect(isGroupSteward(db, group.id, 'alice_key')).toBe(true);
        expect(isGroupMember(db, group.id, 'alice_key')).toBe(true);
        expect(isGroupMember(db, group.id, 'bob_key')).toBe(false);
    });

    it('handles join policies (open vs request_to_join vs invite_only)', () => {
        const openGroup = createGroup(db, { name: 'Open Club', createdBy: 'alice_key', joinPolicy: 'open' });
        const requestGroup = createGroup(db, { name: 'Request Guild', createdBy: 'alice_key', joinPolicy: 'request_to_join' });
        const inviteGroup = createGroup(db, { name: 'Private Circle', createdBy: 'alice_key', joinPolicy: 'invite_only' });

        // Join open group -> becomes active member immediately
        const m1 = joinGroup(db, openGroup.id, 'bob_key');
        expect(m1.status).toBe('active');
        expect(isGroupMember(db, openGroup.id, 'bob_key')).toBe(true);

        // Join request group -> status is pending_approval
        const m2 = joinGroup(db, requestGroup.id, 'bob_key');
        expect(m2.status).toBe('pending_approval');
        expect(isGroupMember(db, requestGroup.id, 'bob_key')).toBe(false);

        // Join invite_only without invite -> throws error
        expect(() => joinGroup(db, inviteGroup.id, 'bob_key')).toThrow(/invite-only/);

        // Join invite_only WITH invite -> active
        const m3 = joinGroup(db, inviteGroup.id, 'bob_key', 'alice_key');
        expect(m3.status).toBe('active');
        expect(isGroupMember(db, inviteGroup.id, 'bob_key')).toBe(true);
    });

    it('supports 3-tier roles and preserves at least one steward', () => {
        const group = createGroup(db, { name: 'Makerspace', createdBy: 'alice_key' });
        joinGroup(db, group.id, 'bob_key');

        // Promote Bob to Steward
        setMemberRole(db, group.id, 'bob_key', 'steward', 'active', 'alice_key');
        expect(isGroupSteward(db, group.id, 'bob_key')).toBe(true);

        // Add Carol as Observer
        joinGroup(db, group.id, 'carol_key');
        setMemberRole(db, group.id, 'carol_key', 'observer', 'active', 'alice_key');

        const members = getGroupMembers(db, group.id);
        expect(members.length).toBe(3);
        expect(members.find(m => m.memberPubkey === 'carol_key')?.role).toBe('observer');

        // Bob can be removed since Alice is also a steward
        expect(removeGroupMember(db, group.id, 'bob_key', 'alice_key')).toBe(true);

        // Alice cannot be removed because she is now the only steward
        expect(() => removeGroupMember(db, group.id, 'alice_key', 'alice_key')).toThrow(/only steward/);
    });

    it('enforces server-side audience filtering on getPosts', () => {
        const group = createGroup(db, { name: 'Secret Garden', createdBy: 'alice_key' });
        joinGroup(db, group.id, 'bob_key'); // Bob is in group, Carol is not

        // Post 1: Public post
        db.prepare(`
            INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, audience_scope)
            VALUES ('p1', 'offer', 'food', 'Fresh Tomatoes', 'Public tomatoes', 10, 'alice_key', 'public')
        `).run();

        // Post 2: Group-scoped post
        db.prepare(`
            INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, audience_scope, target_group_id)
            VALUES ('p2', 'need', 'gardening', 'Weed the beds', 'Need help weeding', 20, 'alice_key', 'group', ?)
        `).run(group.id);

        // Post 3: Direct 1-to-1 post to Carol
        db.prepare(`
            INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, audience_scope, target_pubkey, assigned_to)
            VALUES ('p3', 'need', 'tutoring', 'Math lesson', 'Math tutoring session', 30, 'alice_key', 'direct', 'carol_key', 'carol_key')
        `).run();

        // 1. Unauthenticated viewer: sees ONLY public (p1)
        const unauthPosts = getPosts(db);
        expect(unauthPosts.map(p => p.id)).toEqual(['p1']);

        // 2. Bob (group member): sees p1 (public) and p2 (group post), but NOT p3 (Carol's direct need)
        const bobPosts = getPosts(db, { viewerPubkey: 'bob_key' });
        expect(bobPosts.map(p => p.id).sort()).toEqual(['p1', 'p2']);

        // 3. Carol (non-group member, but direct target of p3): sees p1 (public) and p3 (direct need), but NOT p2 (group post)
        const carolPosts = getPosts(db, { viewerPubkey: 'carol_key' });
        expect(carolPosts.map(p => p.id).sort()).toEqual(['p1', 'p3']);

        // 4. Alice (author): sees all 3
        const alicePosts = getPosts(db, { viewerPubkey: 'alice_key' });
        expect(alicePosts.map(p => p.id).sort()).toEqual(['p1', 'p2', 'p3']);
    });

    it('filters posts by archetype', () => {
        db.prepare(`
            INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, audience_scope, target_archetypes)
            VALUES ('p_sage', 'need', 'tech', 'Solar Circuit Design', 'Need an analytical mind', 50, 'alice_key', 'public', '["sage","weaver"]')
        `).run();

        db.prepare(`
            INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, audience_scope, target_archetypes)
            VALUES ('p_catalyst', 'need', 'community', 'Rally Volunteers', 'Need high energy', 20, 'alice_key', 'public', '["catalyst"]')
        `).run();

        const sagePosts = getPosts(db, { targetArchetype: 'sage' });
        expect(sagePosts.map(p => p.id)).toEqual(['p_sage']);

        const catalystPosts = getPosts(db, { targetArchetype: 'catalyst' });
        expect(catalystPosts.map(p => p.id)).toEqual(['p_catalyst']);
    });
});

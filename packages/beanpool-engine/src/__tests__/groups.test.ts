import { describe, it, beforeEach } from 'vitest';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import {
    createGroup,
    getGroup,
    getGroupLead,
    isGroupLead,
    handOverGroupLead,
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
import { registerGeoFunctions } from '../geo.js';

describe('Groups Engine & Convenor Moderation (§9)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = new Database(':memory:');
        registerGeoFunctions(db);
        db.exec(`
            CREATE TABLE members (
                public_key TEXT PRIMARY KEY,
                callsign TEXT NOT NULL,
                avatar_url TEXT,
                status TEXT DEFAULT 'active',
                earned_credit REAL DEFAULT 0,
                paused INTEGER DEFAULT 0,
                joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                is_visitor INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE groups (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                slug TEXT UNIQUE NOT NULL,
                description TEXT,
                avatar_url TEXT,
                category TEXT DEFAULT 'general' CHECK (category IN ('working_group', 'social', 'guild', 'project', 'general')),
                created_by TEXT NOT NULL REFERENCES members(public_key),
                lead_pubkey TEXT REFERENCES members(public_key),
                join_policy TEXT NOT NULL DEFAULT 'open' CHECK (join_policy IN ('open', 'request_to_join', 'invite_only')),
                created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            );

            CREATE TABLE group_members (
                group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
                member_pubkey TEXT NOT NULL REFERENCES members(public_key) ON DELETE CASCADE,
                role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('convenor', 'member', 'observer')),
                status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending_approval', 'invited', 'removed')),
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
                target_archetypes TEXT,
                event_start_at DATETIME,
                event_end_at DATETIME,
                event_place_name TEXT,
                event_private_note TEXT,
                event_state TEXT,
                event_conversation_id TEXT,
                hidden_by_reports_at TEXT,
                removed_by_moderator_at TEXT
            );

            CREATE TABLE tombstones (
                table_name TEXT NOT NULL,
                row_key TEXT NOT NULL,
                deleted_at DATETIME NOT NULL,
                PRIMARY KEY (table_name, row_key)
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
        assert.match(group.slug, /^mullum-permaculture-[a-z2-7]{6}$/);
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

    it('does not advertise invite_only groups to people outside them', () => {
        const secret = createGroup(db, { name: 'Secret Circle', joinPolicy: 'invite_only', createdBy: 'alice_pub' });
        const open = createGroup(db, { name: 'Garden Crew', joinPolicy: 'open', createdBy: 'alice_pub' });
        const knock = createGroup(db, { name: 'Water Works', joinPolicy: 'request_to_join', createdBy: 'alice_pub' });

        const names = (viewer?: string) => listGroups(db, undefined, viewer).map(g => g.name).sort();

        // A stranger sees the open and request_to_join groups — the latter must stay discoverable or nobody
        // could ever ask to join it — but learns nothing about the invite_only one.
        assert.deepStrictEqual(names('carol_pub'), ['Garden Crew', 'Water Works']);
        // An anonymous caller is treated the same way.
        assert.deepStrictEqual(names(undefined), ['Garden Crew', 'Water Works']);

        // Someone merely holding an invitation can see it, before accepting.
        inviteGroupMember(db, secret.id, 'alice_pub', 'bob_pub', 'member');
        assert.ok(names('bob_pub').includes('Secret Circle'));

        // And its convenor sees it.
        assert.ok(names('alice_pub').includes('Secret Circle'));

        // Removing Bob's membership row removes his sight of it again.
        removeGroupMember(db, secret.id, 'alice_pub', 'bob_pub');
        assert.ok(!names('bob_pub').includes('Secret Circle'));
    });

    it('convenor moderation: role management and demotion safety', () => {
        const group = createGroup(db, {
            name: 'Team A',
            createdBy: 'alice_pub'
        });
        joinGroup(db, group.id, 'bob_pub');

        // Alice promotes Bob to convenor. Any convenor may do this.
        const updatedBob = setMemberRole(db, group.id, 'alice_pub', 'bob_pub', 'convenor');
        assert.strictEqual(updatedBob.role, 'convenor');

        // Bob CANNOT change Alice to observer: she is the group's lead convenor (2026-09-23). Until this change
        // he could, which is the bug Damo found — a convenor who could remove the group's creator.
        assert.throws(() => {
            setMemberRole(db, group.id, 'bob_pub', 'alice_pub', 'observer');
        }, /lead convenor cannot be demoted/i);
        assert.strictEqual(getGroupMembers(db, group.id).find(m => m.memberPubkey === 'alice_pub')?.role, 'convenor');

        // Bob may still step down from convenor himself — but not while he is needed as the last one. Alice is
        // still a convenor here, so it goes through.
        assert.strictEqual(setMemberRole(db, group.id, 'bob_pub', 'bob_pub', 'member').role, 'member');
        setMemberRole(db, group.id, 'alice_pub', 'bob_pub', 'convenor');

        // The lead cannot demote themselves either: they hand the lead over first.
        assert.throws(() => {
            setMemberRole(db, group.id, 'alice_pub', 'alice_pub', 'member');
        }, /[Hh]and the lead over/);

        // Non-convenor cannot change roles
        setMemberRole(db, group.id, 'alice_pub', 'bob_pub', 'member');
        assert.throws(() => {
            setMemberRole(db, group.id, 'bob_pub', 'alice_pub', 'member');
        }, /UNAUTHORIZED/i);
    });

    it('the lead convenor: only the lead touches a convenor, and nobody touches the lead', () => {
        const group = createGroup(db, { name: 'Lead Rules', createdBy: 'alice_pub' });
        joinGroup(db, group.id, 'bob_pub');
        joinGroup(db, group.id, 'carol_pub');
        db.prepare("INSERT INTO members (public_key, callsign) VALUES ('dan_pub', 'Dan')").run();
        joinGroup(db, group.id, 'dan_pub');

        // The creator is the first lead convenor, written down — not inferred.
        assert.strictEqual(getGroupLead(db, group.id), 'alice_pub');
        assert.strictEqual(
            (db.prepare('SELECT lead_pubkey FROM groups WHERE id = ?').get(group.id) as any).lead_pubkey,
            'alice_pub',
        );
        assert.ok(isGroupLead(db, group.id, 'alice_pub'));
        assert.ok(!isGroupLead(db, group.id, 'bob_pub'));
        assert.strictEqual(getGroup(db, group.id)?.leadPubkey, 'alice_pub');

        // Any convenor may promote someone to convenor.
        setMemberRole(db, group.id, 'alice_pub', 'bob_pub', 'convenor');
        setMemberRole(db, group.id, 'bob_pub', 'carol_pub', 'convenor');
        assert.strictEqual(getGroupLead(db, group.id), 'alice_pub');

        // A convenor cannot remove or demote another convenor.
        assert.throws(() => setMemberRole(db, group.id, 'bob_pub', 'carol_pub', 'member'),
            /Only this group's lead convenor/);
        assert.throws(() => removeGroupMember(db, group.id, 'bob_pub', 'carol_pub'),
            /Only this group's lead convenor/);

        // Nor the lead — not by demoting, not by removing.
        assert.throws(() => setMemberRole(db, group.id, 'bob_pub', 'alice_pub', 'member'),
            /lead convenor cannot be demoted/);
        assert.throws(() => removeGroupMember(db, group.id, 'carol_pub', 'alice_pub'),
            /lead convenor cannot be removed/);

        // Both refusals name the two routes that DO exist, in order: the hand-over first, then the 30-day-silence
        // vote — which has had screens in both apps since 2026-09-23, so it is named as a thing to go and do and
        // never as something coming later. A refusal that sends a member looking for a screen that is not there
        // is the same dead end as naming a Decision that does not exist.
        for (const refuse of [
            () => setMemberRole(db, group.id, 'bob_pub', 'alice_pub', 'member'),
            () => removeGroupMember(db, group.id, 'carol_pub', 'alice_pub'),
        ]) {
            assert.throws(refuse, /hand the lead over/);
            assert.throws(refuse, /the group can vote a new lead in from the group's screen/);
            assert.throws(refuse, (e: Error) => !/later update|coming/i.test(e.message));
        }

        // A convenor still manages members and observers, exactly as before.
        setMemberRole(db, group.id, 'bob_pub', 'dan_pub', 'observer');
        assert.strictEqual(getGroupMembers(db, group.id).find(m => m.memberPubkey === 'dan_pub')?.role, 'observer');
        assert.ok(removeGroupMember(db, group.id, 'bob_pub', 'dan_pub'));

        // The lead removes and demotes convenors.
        setMemberRole(db, group.id, 'alice_pub', 'carol_pub', 'member');
        assert.strictEqual(getGroupMembers(db, group.id).find(m => m.memberPubkey === 'carol_pub')?.role, 'member');
        assert.ok(removeGroupMember(db, group.id, 'alice_pub', 'bob_pub'));
        assert.strictEqual(getGroupLead(db, group.id), 'alice_pub');
    });

    it('the lead convenor: hand over, step down, leave', () => {
        const group = createGroup(db, { name: 'Hand Over', createdBy: 'alice_pub' });
        joinGroup(db, group.id, 'bob_pub');
        joinGroup(db, group.id, 'carol_pub');

        // Only the lead hands the lead over.
        assert.throws(() => handOverGroupLead(db, group.id, 'bob_pub', 'carol_pub'),
            /UNAUTHORIZED.*hand the lead over/);
        // An observer only watches: promote them first.
        setMemberRole(db, group.id, 'alice_pub', 'carol_pub', 'observer');
        assert.throws(() => handOverGroupLead(db, group.id, 'alice_pub', 'carol_pub'), /observer only watches/);
        setMemberRole(db, group.id, 'alice_pub', 'carol_pub', 'member');
        // Not to somebody outside the group.
        assert.throws(() => handOverGroupLead(db, group.id, 'alice_pub', 'nobody_pub'), /active member of this group/);

        // A lead cannot just leave while anyone else is active — hand over first.
        assert.throws(() => removeGroupMember(db, group.id, 'alice_pub', 'alice_pub'), /[Hh]and the lead over/);

        // Handing over to an active MEMBER makes them a convenor in the same step, and the group's lead.
        const newLead = handOverGroupLead(db, group.id, 'alice_pub', 'bob_pub');
        assert.strictEqual(newLead.role, 'convenor');
        assert.strictEqual(getGroupLead(db, group.id), 'bob_pub');
        // The outgoing lead stays a convenor: handing over is not leaving.
        assert.strictEqual(getGroupMembers(db, group.id).find(m => m.memberPubkey === 'alice_pub')?.role, 'convenor');

        // And now Bob, as lead, can remove Alice — and Alice cannot remove Bob.
        assert.throws(() => removeGroupMember(db, group.id, 'alice_pub', 'bob_pub'), /lead convenor cannot be removed/);
        // Alice leaves on her own, which she may: she is not the lead any more.
        assert.ok(removeGroupMember(db, group.id, 'alice_pub', 'alice_pub'));

        // The last one in the group has nobody to hand to, so the lead may simply go.
        assert.ok(removeGroupMember(db, group.id, 'carol_pub', 'carol_pub'));
        assert.ok(removeGroupMember(db, group.id, 'bob_pub', 'bob_pub'));
        assert.strictEqual(getGroupLead(db, group.id), null);
        assert.strictEqual(getGroup(db, group.id)?.leadPubkey, null);
    });

    it('the lead convenor: the backfill rule decides when lead_pubkey is not a live convenor', () => {
        // A group row as a node older than this change holds it: no lead_pubkey at all.
        const creatorPresent = createGroup(db, { name: 'Creator Present', createdBy: 'alice_pub' });
        joinGroup(db, creatorPresent.id, 'bob_pub');
        setMemberRole(db, creatorPresent.id, 'alice_pub', 'bob_pub', 'convenor');
        db.prepare('UPDATE groups SET lead_pubkey = NULL WHERE id = ?').run(creatorPresent.id);
        // The creator, while they are an active convenor.
        assert.strictEqual(getGroupLead(db, creatorPresent.id), 'alice_pub');

        // Creator gone: the longest-serving active convenor.
        const creatorGone = createGroup(db, { name: 'Creator Gone', createdBy: 'alice_pub' });
        joinGroup(db, creatorGone.id, 'bob_pub');
        joinGroup(db, creatorGone.id, 'carol_pub');
        setMemberRole(db, creatorGone.id, 'alice_pub', 'bob_pub', 'convenor');
        setMemberRole(db, creatorGone.id, 'alice_pub', 'carol_pub', 'convenor');
        handOverGroupLead(db, creatorGone.id, 'alice_pub', 'bob_pub');
        removeGroupMember(db, creatorGone.id, 'alice_pub', 'alice_pub');
        db.prepare('UPDATE groups SET lead_pubkey = NULL WHERE id = ?').run(creatorGone.id);
        db.prepare("UPDATE group_members SET joined_at = '2020-01-01T00:00:00.000Z' WHERE group_id = ? AND member_pubkey = 'carol_pub'")
            .run(creatorGone.id);
        assert.strictEqual(getGroupLead(db, creatorGone.id), 'carol_pub');

        // A stored lead who is no longer an active convenor is never read as one.
        const stale = createGroup(db, { name: 'Stale Pointer', createdBy: 'alice_pub' });
        joinGroup(db, stale.id, 'bob_pub');
        setMemberRole(db, stale.id, 'alice_pub', 'bob_pub', 'convenor');
        db.prepare('UPDATE groups SET lead_pubkey = ? WHERE id = ?').run('carol_pub', stale.id);
        assert.strictEqual(getGroupLead(db, stale.id), 'alice_pub');
    });

    it('the lead convenor: a promotion never moves the lead, even with lead_pubkey NULL', () => {
        // The mixed-version window: importRemoteState INSERTs a group row from a node older than the lead convenor,
        // so lead_pubkey is NULL while the group has active convenors. reconcileGroupLead has to pin the current
        // fallback lead BEFORE the role write, or the promotion is evaluated with the promoted person already a
        // convenor — and the convenor who did the promoting loses the lead by promoting someone.

        // (a) An earlier-joined MEMBER is promoted: the fallback would rather have them.
        const earlier = createGroup(db, { name: 'Earlier Member', createdBy: 'alice_pub' });
        joinGroup(db, earlier.id, 'carol_pub');
        joinGroup(db, earlier.id, 'bob_pub');
        setMemberRole(db, earlier.id, 'alice_pub', 'bob_pub', 'convenor');
        handOverGroupLead(db, earlier.id, 'alice_pub', 'bob_pub');
        // The creator is gone, and Carol joined before Bob.
        assert.ok(removeGroupMember(db, earlier.id, 'alice_pub', 'alice_pub'));
        db.prepare('UPDATE groups SET lead_pubkey = NULL WHERE id = ?').run(earlier.id);
        // Explicitly older than Bob: joins one millisecond apart would otherwise be settled by the pubkey
        // tie-break, and the fallback would pick Bob for a reason this test is not about.
        db.prepare("UPDATE group_members SET joined_at = '2020-01-01T00:00:00.000Z' WHERE group_id = ? AND member_pubkey = 'carol_pub'")
            .run(earlier.id);
        assert.strictEqual(getGroupLead(db, earlier.id), 'bob_pub');

        setMemberRole(db, earlier.id, 'bob_pub', 'carol_pub', 'convenor');
        assert.strictEqual(getGroupLead(db, earlier.id), 'bob_pub');
        assert.strictEqual(
            (db.prepare('SELECT lead_pubkey FROM groups WHERE id = ?').get(earlier.id) as any).lead_pubkey,
            'bob_pub',
        );

        // (b) The CREATOR is promoted back to convenor: the fallback's creator branch would rather have them.
        const creator = createGroup(db, { name: 'Creator Back', createdBy: 'dave_pub' });
        joinGroup(db, creator.id, 'bob_pub');
        setMemberRole(db, creator.id, 'dave_pub', 'bob_pub', 'convenor');
        handOverGroupLead(db, creator.id, 'dave_pub', 'bob_pub');
        // The creator stays in the group as an ordinary member, so the creator branch does not match — yet.
        setMemberRole(db, creator.id, 'dave_pub', 'dave_pub', 'member');
        db.prepare('UPDATE groups SET lead_pubkey = NULL WHERE id = ?').run(creator.id);
        assert.strictEqual(getGroupLead(db, creator.id), 'bob_pub');

        setMemberRole(db, creator.id, 'bob_pub', 'dave_pub', 'convenor');
        assert.strictEqual(getGroupLead(db, creator.id), 'bob_pub');
        assert.strictEqual(
            (db.prepare('SELECT lead_pubkey FROM groups WHERE id = ?').get(creator.id) as any).lead_pubkey,
            'bob_pub',
        );
        // And the promotion itself still happened.
        assert.strictEqual(getGroupMembers(db, creator.id).find(m => m.memberPubkey === 'dave_pub')?.role, 'convenor');
    });

    it('the lead convenor: accepting a convenor invitation never moves the lead, even with lead_pubkey NULL', () => {
        // The same NULL-lead window as the promotion above, one route over. inviteGroupMember writes role on a
        // row that is not active yet, so the write that makes them an active convenor — and re-decides the
        // fallback — is joinGroup accepting the invitation. That accept has to pin the lead first.
        const group = createGroup(db, { name: 'Invite Creator Back', createdBy: 'dave_pub' });
        joinGroup(db, group.id, 'bob_pub');
        setMemberRole(db, group.id, 'dave_pub', 'bob_pub', 'convenor');
        handOverGroupLead(db, group.id, 'dave_pub', 'bob_pub');
        // The creator leaves: the creator branch of the fallback stops matching while they are not active.
        assert.ok(removeGroupMember(db, group.id, 'dave_pub', 'dave_pub'));
        db.prepare('UPDATE groups SET lead_pubkey = NULL WHERE id = ?').run(group.id);
        assert.strictEqual(getGroupLead(db, group.id), 'bob_pub');

        // Bob re-admits the creator as a convenor. The invitation alone must not move anything...
        inviteGroupMember(db, group.id, 'bob_pub', 'dave_pub', 'convenor');
        assert.strictEqual(getGroupLead(db, group.id), 'bob_pub');
        // ...and neither must the creator accepting it, which is what makes the row an active convenor.
        joinGroup(db, group.id, 'dave_pub');
        assert.strictEqual(getGroupLead(db, group.id), 'bob_pub');
        assert.strictEqual(
            (db.prepare('SELECT lead_pubkey FROM groups WHERE id = ?').get(group.id) as any).lead_pubkey,
            'bob_pub',
        );
        // The invitation itself still landed: Dave is back, and a convenor.
        const dave = getGroupMembers(db, group.id).find(m => m.memberPubkey === 'dave_pub');
        assert.strictEqual(dave?.status, 'active');
        assert.strictEqual(dave?.role, 'convenor');
    });

    it('the lead convenor: direct-approving a pending request as convenor never moves the lead', () => {
        // inviteGroupMember on a pending_approval row goes active AND convenor in one UPDATE — the whole move,
        // with no separate promotion to pin the lead. An older pending request wins the fallback's joined_at
        // ordering, so the convenor who approves it would hand the lead to the person they just let in.
        const group = createGroup(db, { name: 'Direct Approve', joinPolicy: 'request_to_join', createdBy: 'dave_pub' });
        joinGroup(db, group.id, 'bob_pub');
        approveGroupMember(db, group.id, 'dave_pub', 'bob_pub');
        setMemberRole(db, group.id, 'dave_pub', 'bob_pub', 'convenor');
        handOverGroupLead(db, group.id, 'dave_pub', 'bob_pub');
        assert.ok(removeGroupMember(db, group.id, 'dave_pub', 'dave_pub'));

        // Carol asked to join long before any of them — still waiting.
        joinGroup(db, group.id, 'carol_pub');
        db.prepare("UPDATE group_members SET joined_at = '2020-01-01T00:00:00.000Z' WHERE group_id = ? AND member_pubkey = 'carol_pub'")
            .run(group.id);
        db.prepare('UPDATE groups SET lead_pubkey = NULL WHERE id = ?').run(group.id);
        assert.strictEqual(getGroupLead(db, group.id), 'bob_pub');

        inviteGroupMember(db, group.id, 'bob_pub', 'carol_pub', 'convenor');
        assert.strictEqual(getGroupLead(db, group.id), 'bob_pub');
        assert.strictEqual(
            (db.prepare('SELECT lead_pubkey FROM groups WHERE id = ?').get(group.id) as any).lead_pubkey,
            'bob_pub',
        );
        const carol = getGroupMembers(db, group.id).find(m => m.memberPubkey === 'carol_pub');
        assert.strictEqual(carol?.status, 'active');
        assert.strictEqual(carol?.role, 'convenor');
    });

    it('the lead convenor: a stored lead survives both routes untouched (control)', () => {
        // The same two steps with lead_pubkey actually written: the first COALESCE branch answers, and neither
        // route has anything to fix. This is what says the two tests above are about the NULL window and not
        // about invitations moving a lead that is on record.
        const group = createGroup(db, { name: 'Stored Lead Control', createdBy: 'dave_pub' });
        joinGroup(db, group.id, 'bob_pub');
        setMemberRole(db, group.id, 'dave_pub', 'bob_pub', 'convenor');
        handOverGroupLead(db, group.id, 'dave_pub', 'bob_pub');
        assert.ok(removeGroupMember(db, group.id, 'dave_pub', 'dave_pub'));
        assert.strictEqual(
            (db.prepare('SELECT lead_pubkey FROM groups WHERE id = ?').get(group.id) as any).lead_pubkey,
            'bob_pub',
        );

        inviteGroupMember(db, group.id, 'bob_pub', 'dave_pub', 'convenor');
        joinGroup(db, group.id, 'dave_pub');
        assert.strictEqual(getGroupLead(db, group.id), 'bob_pub');

        inviteGroupMember(db, group.id, 'bob_pub', 'carol_pub', 'convenor');
        joinGroup(db, group.id, 'carol_pub');
        assert.strictEqual(getGroupLead(db, group.id), 'bob_pub');
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

        // Alice cannot leave while others are still here: she is the lead convenor, so she hands the lead over
        // first. (Before the lead convenor this refusal came from the "last active convenor" guard, which is
        // still there for a convenor who is not the lead.)
        inviteGroupMember(db, group.id, 'alice_pub', 'carol_pub');
        joinGroup(db, group.id, 'carol_pub');
        assert.throws(() => {
            removeGroupMember(db, group.id, 'alice_pub', 'alice_pub');
        }, /[Hh]and the lead over/);
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

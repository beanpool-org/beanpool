/**
 * Unit/integration tests for post visibility rules (apps/server/src/engine/post-sight.ts).
 *
 * Covers:
 *   1. postOutOfSight with public, direct, and group audience scopes.
 *   2. marketplacePostOutOfSight wrapper behavior with camelCase objects.
 *   3. postInSightSql SQL expression generation and query execution in SQLite.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-post-sight.ts
 */

import { db } from './db/db.js';
import { initStateEngine } from './state-engine.js';
import {
    postOutOfSight,
    marketplacePostOutOfSight,
    postInSightSql,
    type PostAudienceRow,
} from './engine/post-sight.js';

let run = 0;
let passed = 0;

function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        process.exitCode = 1;
    }
}

function main() {
    console.log('Running post-sight tests...\n');

    initStateEngine();

    const author = 'author_111111111111111111111111111111111111111111111111111111111111';
    const target = 'target_222222222222222222222222222222222222222222222222222222222222';
    const assigned = 'assigned_3333333333333333333333333333333333333333333333333333333';
    const stranger = 'stranger_4444444444444444444444444444444444444444444444444444444';
    const groupMember = 'member_55555555555555555555555555555555555555555555555555555555';
    const groupInactive = 'inactive_666666666666666666666666666666666666666666666666666666';
    const groupId = 'group_1001';

    // Seed database for group tests
    db.prepare(`INSERT INTO groups (id, name, slug, created_by) VALUES (?, ?, ?, ?)`).run(groupId, 'Test Group', 'test-group', author);
    db.prepare(`INSERT INTO group_members (group_id, member_pubkey, status) VALUES (?, ?, 'active')`).run(groupId, groupMember);
    db.prepare(`INSERT INTO group_members (group_id, member_pubkey, status) VALUES (?, ?, 'removed')`).run(groupId, groupInactive);

    // 1. Public posts
    const publicPost: PostAudienceRow = { author_pubkey: author, audience_scope: 'public' };
    const nullScopePost: PostAudienceRow = { author_pubkey: author, audience_scope: null };

    assert(!postOutOfSight(publicPost, undefined), 'Public post is in sight for undefined caller');
    assert(!postOutOfSight(publicPost, stranger), 'Public post is in sight for stranger');
    assert(!postOutOfSight(nullScopePost, stranger), 'Post with null scope defaults to public (in sight)');

    // 2. Direct posts
    const directPost: PostAudienceRow = {
        author_pubkey: author,
        audience_scope: 'direct',
        target_pubkey: target,
        assigned_to: assigned,
    };

    assert(postOutOfSight(directPost, undefined), 'Direct post is out of sight for undefined caller');
    assert(!postOutOfSight(directPost, author), 'Direct post is in sight for author');
    assert(!postOutOfSight(directPost, target), 'Direct post is in sight for target');
    assert(!postOutOfSight(directPost, assigned), 'Direct post is in sight for assignee');
    assert(postOutOfSight(directPost, stranger), 'Direct post is out of sight for stranger');

    // 3. Group posts
    const groupPost: PostAudienceRow = {
        author_pubkey: author,
        audience_scope: 'group',
        target_group_id: groupId,
    };

    assert(postOutOfSight(groupPost, undefined), 'Group post is out of sight for undefined caller');
    assert(!postOutOfSight(groupPost, author), 'Group post is in sight for author');
    assert(!postOutOfSight(groupPost, groupMember), 'Group post is in sight for active group member');
    assert(postOutOfSight(groupPost, groupInactive), 'Group post is out of sight for inactive/removed group member');
    assert(postOutOfSight(groupPost, stranger), 'Group post is out of sight for non-group member');

    // 4. marketplacePostOutOfSight wrapper
    const camelMarketplacePost = {
        authorPublicKey: author,
        audienceScope: 'group',
        targetGroupId: groupId,
    };

    assert(!marketplacePostOutOfSight(camelMarketplacePost, groupMember), 'marketplacePostOutOfSight maps camelCase correctly for member');
    assert(marketplacePostOutOfSight(camelMarketplacePost, stranger), 'marketplacePostOutOfSight maps camelCase correctly for stranger');

    // 5. postInSightSql testing in SQLite
    const postId1 = 'post_1';
    const postId2 = 'post_2';
    const postId3 = 'post_3';

    db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, audience_scope, target_pubkey, assigned_to, target_group_id)
                VALUES (?, 'offer', 'general', 'Public Post', '', 0, ?, 'public', NULL, NULL, NULL)`).run(postId1, author);

    db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, audience_scope, target_pubkey, assigned_to, target_group_id)
                VALUES (?, 'offer', 'general', 'Direct Post', '', 0, ?, 'direct', ?, ?, NULL)`).run(postId2, author, target, assigned);

    db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, audience_scope, target_pubkey, assigned_to, target_group_id)
                VALUES (?, 'offer', 'general', 'Group Post', '', 0, ?, 'group', NULL, NULL, ?)`).run(postId3, author, groupId);

    const sqlCondition = postInSightSql('p', '?');

    const queryInSight = (callerKey: string) =>
        db.prepare(`SELECT id FROM posts p WHERE ${sqlCondition} ORDER BY id`).all(callerKey, callerKey, callerKey, callerKey) as { id: string }[];

    const strangerVisible = queryInSight(stranger);
    assert(strangerVisible.length === 1 && strangerVisible[0].id === postId1, 'Stranger sees only public post via postInSightSql');

    const targetVisible = queryInSight(target);
    assert(targetVisible.length === 2 && targetVisible[0].id === postId1 && targetVisible[1].id === postId2, 'Target sees public and direct post via postInSightSql');

    const groupMemberVisible = queryInSight(groupMember);
    assert(groupMemberVisible.length === 2 && groupMemberVisible[0].id === postId1 && groupMemberVisible[1].id === postId3, 'Group member sees public and group post via postInSightSql');

    const authorVisible = queryInSight(author);
    assert(authorVisible.length === 3, 'Author sees all 3 posts via postInSightSql');

    console.log(`\nPassed ${passed}/${run} assertions.`);
    process.exit(run === passed ? 0 : 1);
}

main();

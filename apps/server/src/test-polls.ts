/**
 * Community Polls Engine & Routes Test Suite.
 *
 * Verifies docs/the-commons.md §3.2, §3.8, §8 specifications:
 * 1. Poll creation, options validation (2-4), duration (3/7/14 days).
 * 2. Invisibility & Isolation:
 *    - Poll does NOT increment liveOfferCount or widen credit floor.
 *    - Poll neither requires nor satisfies the Need-requires-Offer covenant.
 *    - Category forced to 'community', lat/lng null, credits 0, photos empty.
 *    - Trade routes (request, accept, approve, complete) reject polls.
 *    - Search queries exclude polls unless explicitly requested.
 * 3. Rate limits: 1 active poll per member, 5 active polls per node.
 * 4. Franchise rules: Active members only; credit-frozen members cannot create or vote.
 * 5. Re-voting overwrites choice rather than duplicating.
 * 6. Immutability: Question and options cannot be edited once votes exist.
 * 7. Author departure/prune: Closes open polls (status='completed', active=0), retains votes.
 * 8. Early closure by author.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import { db, initSchema } from './db/db.js';
import {
    createPost,
    getPosts,
    updatePost,
    votePoll,
    closePoll,
    requestPost,
    acceptPost,
    approvePostRequest,
    completePostTransaction,
    adminPruneUser,
    usableFloor,
} from './state-engine.js';
import {
    liveOfferCount,
    hasListedOffer
} from '@beanpool/engine';

let run = 0;
let passed = 0;

function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ FAIL: ${msg}`);
        process.exit(1);
    }
}

async function main() {
    console.log('🧪 Starting Community Polls Test Suite...\n');

    initSchema();

    // Setup mock members
    const members = [
        { pubkey: 'pub-alice', callsign: 'Alice', avatar: 'https://example.com/alice.jpg', status: 'active', frozen: 0 },
        { pubkey: 'pub-bob', callsign: 'Bob', avatar: 'https://example.com/bob.jpg', status: 'active', frozen: 0 },
        { pubkey: 'pub-carol', callsign: 'Carol', avatar: 'https://example.com/carol.jpg', status: 'active', frozen: 0 },
        { pubkey: 'pub-dave', callsign: 'Dave', avatar: 'https://example.com/dave.jpg', status: 'active', frozen: 1 }, // Credit frozen
        { pubkey: 'pub-eve', callsign: 'Eve', avatar: 'https://example.com/eve.jpg', status: 'disabled', frozen: 0 }, // Inactive
        { pubkey: 'pub-frank', callsign: 'Frank', avatar: 'https://example.com/frank.jpg', status: 'active', frozen: 0 },
        { pubkey: 'pub-grace', callsign: 'Grace', avatar: 'https://example.com/grace.jpg', status: 'active', frozen: 0 },
        { pubkey: 'pub-heidi', callsign: 'Heidi', avatar: 'https://example.com/heidi.jpg', status: 'active', frozen: 0 },
    ];

    for (const m of members) {
        db.prepare(`
            INSERT OR REPLACE INTO members (public_key, callsign, avatar_url, status, credit_frozen, joined_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
        `).run(m.pubkey, m.callsign, m.avatar, m.status, m.frozen);
    }

    console.log('--- 1. Validation & Options Check ---');
    // Poll requires 2-4 options
    let errThrew = false;
    try {
        createPost('poll', 'community', 'Only 1 Option?', '', 0, 'fixed', 'pub-alice', undefined, undefined, undefined, false, undefined, false, {
            pollOptions: [{ id: 'opt_1', text: 'Yes' }]
        });
    } catch (e: any) {
        errThrew = true;
        assert(e.message.includes('between 2 and 4 options'), 'Rejects poll with fewer than 2 options');
    }
    assert(errThrew, 'Threw error on < 2 options');

    errThrew = false;
    try {
        createPost('poll', 'community', '5 Options?', '', 0, 'fixed', 'pub-alice', undefined, undefined, undefined, false, undefined, false, {
            pollOptions: [
                { id: '1', text: 'A' }, { id: '2', text: 'B' }, { id: '3', text: 'C' }, { id: '4', text: 'D' }, { id: '5', text: 'E' }
            ]
        });
    } catch (e: any) {
        errThrew = true;
        assert(e.message.includes('between 2 and 4 options'), 'Rejects poll with more than 4 options');
    }
    assert(errThrew, 'Threw error on > 4 options');

    errThrew = false;
    try {
        createPost('poll', 'community', 'Invalid Duration?', '', 0, 'fixed', 'pub-alice', undefined, undefined, undefined, false, undefined, false, {
            pollOptions: [{ id: '1', text: 'A' }, { id: '2', text: 'B' }],
            durationDays: 5
        });
    } catch (e: any) {
        errThrew = true;
        assert(e.message.includes('3, 7, or 14 days'), 'Rejects invalid duration');
    }
    assert(errThrew, 'Threw error on invalid duration');

    // Credit-frozen member cannot create poll
    errThrew = false;
    try {
        createPost('poll', 'community', 'Dave Poll?', '', 0, 'fixed', 'pub-dave', undefined, undefined, undefined, false, undefined, false, {
            pollOptions: [{ id: '1', text: 'A' }, { id: '2', text: 'B' }]
        });
    } catch (e: any) {
        errThrew = true;
        assert(e.message.includes('Credit-frozen'), 'Rejects poll creation by credit-frozen member');
    }
    assert(errThrew, 'Threw error for credit-frozen creator');

    console.log('\n--- 2. Successful Creation & Isolation Invariants ---');
    const poll1 = createPost('poll', 'tools', 'Community Timber Workshop on Sunday?', 'Should we open the workshop?', 50, 'hourly', 'pub-alice', 12.34, 56.78, ['data:image/jpeg;base64,...'], true, undefined, true, {
        pollOptions: [
            { id: 'opt_yes', text: 'Yes, definitely' },
            { id: 'opt_no', text: 'No, busy' }
        ],
        durationDays: 7
    });

    assert(poll1 !== null, 'Poll created successfully');
    assert(poll1!.type === 'poll', 'Post type is poll');
    assert(poll1!.category === 'community', 'Category forced to community (cannot pose as tools)');
    assert(poll1!.credits === 0, 'Credits forced to 0');
    assert(poll1!.lat === null || poll1!.lat === undefined, 'Lat is null to prevent map pin drop');
    assert(poll1!.lng === null || poll1!.lng === undefined, 'Lng is null to prevent map pin drop');
    assert(poll1!.photos === undefined || poll1!.photos.length === 0, 'Photos forced empty');
    assert(poll1!.status === 'active', 'Initial status is active');
    assert(Array.isArray(poll1!.pollOptions) && poll1!.pollOptions.length === 2, 'Poll options stored');

    // Offer counting & credit covenant isolation
    assert(liveOfferCount(db, 'pub-alice') === 0, 'liveOfferCount does NOT count polls');
    assert(hasListedOffer(db, 'pub-alice') === false, 'hasListedOffer is false (poll is not an offer)');
    assert(usableFloor('pub-alice') === 0, 'usableFloor is not widened by polls');

    // Need covenant check: Alice cannot post a Need without an Offer
    errThrew = false;
    try {
        createPost('need', 'tools', 'Need Chainsaw', 'Need for clearing', 10, 'fixed', 'pub-alice');
    } catch (e: any) {
        errThrew = true;
    }
    assert(errThrew, 'Posting Need requires an Offer; poll does not satisfy need covenant');

    console.log('\n--- 3. Rate Limits ---');
    // Alice cannot open a second poll while poll1 is active
    errThrew = false;
    try {
        createPost('poll', 'community', 'Alice Second Poll?', '', 0, 'fixed', 'pub-alice', undefined, undefined, undefined, false, undefined, false, {
            pollOptions: [{ id: '1', text: 'A' }, { id: '2', text: 'B' }]
        });
    } catch (e: any) {
        errThrew = true;
        assert(e.message.includes('Rate limit: You can only have 1 active poll'), 'Enforces 1 active poll per member');
    }
    assert(errThrew, 'Blocked second active poll for Alice');

    // Other members create polls up to node limit of 5
    const pollBob = createPost('poll', 'community', 'Bob Poll', '', 0, 'fixed', 'pub-bob', undefined, undefined, undefined, false, undefined, false, {
        pollOptions: [{ id: '1', text: 'A' }, { id: '2', text: 'B' }]
    });
    const pollCarol = createPost('poll', 'community', 'Carol Poll', '', 0, 'fixed', 'pub-carol', undefined, undefined, undefined, false, undefined, false, {
        pollOptions: [{ id: '1', text: 'A' }, { id: '2', text: 'B' }]
    });
    const pollFrank = createPost('poll', 'community', 'Frank Poll', '', 0, 'fixed', 'pub-frank', undefined, undefined, undefined, false, undefined, false, {
        pollOptions: [{ id: '1', text: 'A' }, { id: '2', text: 'B' }]
    });
    const pollGrace = createPost('poll', 'community', 'Grace Poll', '', 0, 'fixed', 'pub-grace', undefined, undefined, undefined, false, undefined, false, {
        pollOptions: [{ id: '1', text: 'A' }, { id: '2', text: 'B' }]
    });

    assert(!!pollBob && !!pollCarol && !!pollFrank && !!pollGrace, 'Created 5 total active polls');

    // 6th active poll should be rejected
    errThrew = false;
    try {
        createPost('poll', 'community', 'Heidi Poll', '', 0, 'fixed', 'pub-heidi', undefined, undefined, undefined, false, undefined, false, {
            pollOptions: [{ id: '1', text: 'A' }, { id: '2', text: 'B' }]
        });
    } catch (e: any) {
        errThrew = true;
        assert(e.message.includes('Node limit of 5 active polls reached'), 'Enforces node limit of 5 active polls');
    }
    assert(errThrew, 'Blocked 6th active poll on node');

    console.log('\n--- 4. Voting & Franchise ---');
    // Credit-frozen Dave cannot vote
    errThrew = false;
    try {
        votePoll(poll1!.id, 'pub-dave', 'opt_yes');
    } catch (e: any) {
        errThrew = true;
        assert(e.message.includes('Credit-frozen'), 'Credit-frozen member cannot vote');
    }
    assert(errThrew, 'Blocked vote from credit-frozen member');

    // Inactive Eve cannot vote
    errThrew = false;
    try {
        votePoll(poll1!.id, 'pub-eve', 'opt_yes');
    } catch (e: any) {
        errThrew = true;
        assert(e.message.includes('disabled') || e.message.includes('active'), 'Inactive member cannot vote');
    }
    assert(errThrew, 'Blocked vote from inactive member');

    // Invalid option ID
    errThrew = false;
    try {
        votePoll(poll1!.id, 'pub-carol', 'opt_nonexistent');
    } catch (e: any) {
        errThrew = true;
        assert(e.message.includes('Invalid poll option'), 'Rejects non-existent option');
    }
    assert(errThrew, 'Blocked vote for invalid option');

    // Carol votes for opt_yes
    const voteRes1 = votePoll(poll1!.id, 'pub-carol', 'opt_yes');
    assert(voteRes1.success, 'Carol voted successfully');
    assert(voteRes1.post.totalVotes === 1, 'Total votes is 1');
    const optYes = voteRes1.post.pollOptions?.find(o => o.id === 'opt_yes');
    assert(optYes?.votes === 1 && optYes?.percentage === 100, 'opt_yes has 1 vote (100%)');
    assert(voteRes1.post.userVotedOptionId === 'opt_yes', 'Carol sees her vote choice');

    // Carol changes mind and re-votes for opt_no
    const voteRes2 = votePoll(poll1!.id, 'pub-carol', 'opt_no');
    assert(voteRes2.success, 'Carol re-voted successfully');
    assert(voteRes2.post.totalVotes === 1, 'Total votes is STILL 1 (re-vote overwrote, did not duplicate)');
    const optNoAfter = voteRes2.post.pollOptions?.find(o => o.id === 'opt_no');
    const optYesAfter = voteRes2.post.pollOptions?.find(o => o.id === 'opt_yes');
    assert(optNoAfter?.votes === 1 && optNoAfter?.percentage === 100, 'opt_no now has 1 vote (100%)');
    assert(optYesAfter?.votes === 0 && optYesAfter?.percentage === 0, 'opt_yes now has 0 votes (0%)');
    assert(voteRes2.post.userVotedOptionId === 'opt_no', 'Carol sees updated vote choice');

    // Open ballot check: voter list is visible
    assert(Array.isArray(voteRes2.post.pollVotes) && voteRes2.post.pollVotes.length === 1, 'pollVotes contains public vote records');
    assert(voteRes2.post.pollVotes![0].voterPubkey === 'pub-carol', 'Voter pubkey is Carol');
    assert(voteRes2.post.pollVotes![0].optionId === 'opt_no', 'Voted option is opt_no');

    console.log('\n--- 5. Immutability (Cannot Edit Question or Options After Votes) ---');
    errThrew = false;
    try {
        updatePost(poll1!.id, 'pub-alice', { title: 'Changed Question After Vote?' });
    } catch (e: any) {
        errThrew = true;
        assert(e.message.includes('Cannot edit poll question once votes have been cast'), 'Blocks editing question after votes exist');
    }
    assert(errThrew, 'Blocked question edit on voted poll');

    errThrew = false;
    try {
        updatePost(poll1!.id, 'pub-alice', { pollOptions: [{ id: '1', text: 'New 1' }, { id: '2', text: 'New 2' }] } as any);
    } catch (e: any) {
        errThrew = true;
        assert(e.message.includes('Cannot edit poll options once votes have been cast'), 'Blocks editing options after votes exist');
    }
    assert(errThrew, 'Blocked options edit on voted poll');

    console.log('\n--- 6. Trade Routes Rejection ---');
    errThrew = false;
    try {
        requestPost(poll1!.id, 'pub-bob');
    } catch (e: any) {
        errThrew = true;
        assert(e.message.includes('Polls cannot be requested or transacted'), 'requestPost rejects poll');
    }
    assert(errThrew, 'requestPost threw on poll');

    errThrew = false;
    try {
        acceptPost(poll1!.id, 'pub-bob');
    } catch (e: any) {
        errThrew = true;
        assert(e.message.includes('Polls cannot be requested or transacted'), 'acceptPost rejects poll');
    }
    assert(errThrew, 'acceptPost threw on poll');

    const approveRes = approvePostRequest('fake-tx-id', 'pub-alice');
    assert(approveRes === null, 'approvePostRequest returns null on non-existent or poll transaction');

    const completeRes = completePostTransaction('fake-tx-id', 'pub-alice');
    assert(completeRes === null, 'completePostTransaction returns null on non-existent or poll transaction');

    console.log('\n--- 7. Early Close & Feed Visibility ---');
    const closedPoll = closePoll(poll1!.id, 'pub-alice');
    assert(closedPoll !== null && closedPoll.status === 'completed', 'Author closed poll early; status is completed');

    // Voting on completed poll fails
    errThrew = false;
    try {
        votePoll(poll1!.id, 'pub-frank', 'opt_no');
    } catch (e: any) {
        errThrew = true;
        assert(e.message.includes('closed'), 'Cannot vote on completed poll');
    }
    assert(errThrew, 'Blocked voting on completed poll');

    // Closed polls remain visible in feed with final tally
    const feedPosts = getPosts();
    const pollInFeed = feedPosts.find(p => p.id === poll1!.id);
    assert(pollInFeed !== undefined, 'Closed poll remains visible in feed');
    assert(pollInFeed?.status === 'completed', 'Feed shows poll as completed');
    assert(pollInFeed?.totalVotes === 1, 'Feed shows final vote count');

    // Alice can now create a new poll since her previous one is completed
    const aliceNewPoll = createPost('poll', 'community', 'Alice Second Poll (After Close)', '', 0, 'fixed', 'pub-alice', undefined, undefined, undefined, false, undefined, false, {
        pollOptions: [{ id: '1', text: 'Option A' }, { id: '2', text: 'Option B' }]
    });
    assert(aliceNewPoll !== null, 'Alice created new poll after previous one completed');

    console.log('\n--- 8. Author Departure / Prune ---');
    // Bob has an active poll (pollBob)
    const bobPollBefore = getPosts({ id: pollBob!.id })[0];
    assert(bobPollBefore?.status === 'active', 'Bob poll is active before prune');

    // Frank votes on Bob poll
    votePoll(pollBob!.id, 'pub-frank', '1');

    // Prune Bob
    adminPruneUser('pub-bob', 'owner:password');

    const bobPollAfter = getPosts({ id: pollBob!.id, includeInactive: true })[0];
    assert(bobPollAfter?.status === 'completed', 'Bob poll closed immediately upon author prune');
    assert(bobPollAfter?.active === false, 'Bob poll active is false');
    assert(bobPollAfter?.totalVotes === 1, 'Votes retained after author prune');

    console.log('\n--- 9. Goods Keyword Search Isolation ---');
    // Poll title has 'Timber'
    // Searching 'timber' without specifying type should NOT return polls
    const searchGoods = getPosts({ query: 'Timber' });
    const goodsContainsPoll = searchGoods.some(p => p.type === 'poll');
    assert(!goodsContainsPoll, 'Goods keyword search excludes polls');

    // Searching specifically for polls returns it
    const searchPolls = getPosts({ query: 'Timber', type: 'poll' });
    const pollFound = searchPolls.some(p => p.id === poll1!.id);
    assert(pollFound, 'Poll search specifically returns matching poll');
    console.log('\n--- 10. Route Security & Extended Validation ---');
    // Option text length limit
    errThrew = false;
    try {
        createPost('poll', 'community', 'Long Option Poll', '', 0, 'fixed', 'pub-carol', undefined, undefined, undefined, false, undefined, false, {
            pollOptions: [{ id: '1', text: 'A'.repeat(81) }, { id: '2', text: 'B' }]
        });
    } catch (e: any) {
        errThrew = true;
        assert(e.message.includes('between 1 and 80 characters'), 'Rejects option text > 80 characters');
    }
    assert(errThrew, 'Blocked option text > 80 chars');

    // Duplicate option ID
    errThrew = false;
    try {
        createPost('poll', 'community', 'Duplicate ID Poll', '', 0, 'fixed', 'pub-carol', undefined, undefined, undefined, false, undefined, false, {
            pollOptions: [{ id: 'same_id', text: 'A' }, { id: 'same_id', text: 'B' }]
        });
    } catch (e: any) {
        errThrew = true;
        assert(e.message.includes('Duplicate option ID'), 'Rejects duplicate option ID');
    }
    assert(errThrew, 'Blocked duplicate option ID');

    // Route impersonation checks
    const { createMarketplaceRoutes } = await import('./routes/marketplace.js');
    const router = createMarketplaceRoutes({
        broadcast: () => {},
        getPostsVersion: () => 1,
        bumpPostsVersion: () => {},
    } as any);

    const dispatch = async (method: string, path: string, ctx: any) => {
        const route = router.stack.find(r => r.methods.includes(method.toUpperCase()) && r.regexp.test(path));
        if (!route) throw new Error(`Route not found: ${method} ${path}`);
        const match = route.regexp.exec(path);
        ctx.params = {};
        if (match && route.paramNames) {
            route.paramNames.forEach((p: any, i: number) => { ctx.params[p.name] = match[i + 1]; });
        }
        await (route.stack[0] as any)(ctx, async () => {});
    };

    // Authenticated as pub-alice, cannot vote claiming to be pub-carol
    const ctxImpersonateVote: any = {
        requestBody: { optionId: '1', voterPublicKey: 'pub-carol' },
        state: { actor: 'pub-alice' }
    };
    await dispatch('POST', `/api/marketplace/posts/${aliceNewPoll!.id}/vote`, ctxImpersonateVote);
    assert(ctxImpersonateVote.status === 403, 'Route rejects vote impersonation (actor != voterPublicKey)');

    // Authenticated as pub-carol, cannot close Alice's poll
    const ctxImpersonateClose: any = {
        requestBody: { authorPublicKey: 'pub-alice' },
        state: { actor: 'pub-carol' }
    };
    await dispatch('POST', `/api/marketplace/posts/${aliceNewPoll!.id}/close`, ctxImpersonateClose);
    assert(ctxImpersonateClose.status === 403, 'Route rejects close impersonation (actor != authorPublicKey)');

    console.log('\n--- 11. updatePost Validation & Poll Isolation ---');
    // Cannot edit closed poll
    errThrew = false;
    try {
        updatePost(poll1!.id, 'pub-alice', { title: 'New Closed Title' });
    } catch (e: any) {
        errThrew = true;
        assert(e.message.includes('Cannot edit a closed poll'), 'Rejects updating a closed poll');
    }
    assert(errThrew, 'Blocked update on closed poll');

    // Stripping reach and reachPeers for polls
    updatePost(aliceNewPoll!.id, 'pub-alice', { reach: 'everywhere', reachPeers: ['peer1'] } as any);
    const postRowAfterReach = db.prepare('SELECT reach, reach_peers FROM posts WHERE id = ?').get(aliceNewPoll!.id) as any;
    assert(postRowAfterReach.reach === 'local', 'updatePost strips reach for polls (stays local)');
    assert(postRowAfterReach.reach_peers === null, 'updatePost strips reachPeers for polls (stays null)');

    // Option length validation in updatePost
    errThrew = false;
    try {
        updatePost(aliceNewPoll!.id, 'pub-alice', {
            pollOptions: [{ id: '1', text: 'Z'.repeat(81) }, { id: '2', text: 'Valid' }]
        } as any);
    } catch (e: any) {
        errThrew = true;
        assert(e.message.includes('between 1 and 80 characters'), 'updatePost rejects option > 80 chars');
    }
    assert(errThrew, 'Blocked update option > 80 chars');

    // Duplicate option ID validation in updatePost
    errThrew = false;
    try {
        updatePost(aliceNewPoll!.id, 'pub-alice', {
            pollOptions: [{ id: 'dup_id', text: 'A' }, { id: 'dup_id', text: 'B' }]
        } as any);
    } catch (e: any) {
        errThrew = true;
        assert(e.message.includes('Duplicate option ID'), 'updatePost rejects duplicate option ID');
    }
    assert(errThrew, 'Blocked update duplicate option ID');

    console.log('\n--- 12. Replication & Backup/Restore ---');
    // Full export
    const { exportSyncState: exportEngine, getPosts: getPostsEngine } = await import('@beanpool/engine');
    const syncSnapshot = exportEngine(db, 'primary-node');
    assert(Array.isArray(syncSnapshot.posts), 'exportSyncState includes posts');
    const exportedPoll = syncSnapshot.posts?.find(p => p.id === poll1!.id);
    assert(!!exportedPoll, 'exportSyncState exports poll1');
    assert(Array.isArray(exportedPoll?.pollOptions) && exportedPoll!.pollOptions.length === 2, 'exportSyncState exports pollOptions');
    assert(!!exportedPoll?.pollClosesAt, 'exportSyncState exports pollClosesAt');
    assert(Array.isArray(syncSnapshot.pollVotes), 'exportSyncState includes pollVotes');
    const exportedVote = syncSnapshot.pollVotes?.find(v => v.postId === poll1!.id && v.voterPubkey === 'pub-carol');
    assert(!!exportedVote, 'exportSyncState exports ballot for poll1');
    assert(exportedVote?.optionId === 'opt_no', 'exportSyncState ballot records correct optionId');

    // Delta sync export
    const pastSince = new Date(Date.now() - 3600000).toISOString();
    const deltaSnapshot = exportEngine(db, 'primary-node', pastSince);
    const deltaPoll = deltaSnapshot.posts?.find(p => p.id === poll1!.id);
    assert(!!deltaPoll, 'Delta sync export carries poll');
    const deltaVote = deltaSnapshot.pollVotes?.find(v => v.postId === poll1!.id);
    assert(!!deltaVote, 'Delta sync export carries ballot');

    // File backup & restore (writeDbSnapshot)
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const { writeDbSnapshot } = await import('./services/snapshot-scheduler.js');
    const tmpSnapFile = path.join(process.cwd(), `tmp-poll-backup-${Date.now()}.db`);
    try {
        writeDbSnapshot(tmpSnapFile);
        assert(fs.existsSync(tmpSnapFile), 'Backup snapshot created via writeDbSnapshot');

        const Database = (await import('better-sqlite3')).default;
        const restoredDb = new Database(tmpSnapFile, { readonly: true });
        const restoredPost = restoredDb.prepare('SELECT * FROM posts WHERE id = ?').get(poll1!.id) as any;
        assert(!!restoredPost, 'Restored database contains poll post');
        assert(restoredPost.poll_options.includes('Yes, definitely'), 'Restored database preserves poll options');
        assert(!!restoredPost.poll_closes_at, 'Restored database preserves poll_closes_at');

        const restoredVotes = restoredDb.prepare('SELECT * FROM poll_votes WHERE post_id = ?').all(poll1!.id) as any[];
        assert(restoredVotes.length === 1, 'Restored database preserves ballots count');
        assert(restoredVotes[0].voter_pubkey === 'pub-carol', 'Restored database ballot matches voter');
        assert(restoredVotes[0].option_id === 'opt_no', 'Restored database ballot matches voted option');
        restoredDb.close();
    } finally {
        if (fs.existsSync(tmpSnapFile)) fs.unlinkSync(tmpSnapFile);
    }

    // Secondary replica state import & restore
    const Database = (await import('better-sqlite3')).default;
    const replicaDb = new Database(':memory:');
    const schemaSql = fs.readFileSync(path.join(thisDir, 'db', 'schema.sql'), 'utf-8');
    replicaDb.exec(schemaSql);
    for (const m of members) {
        replicaDb.prepare(`
            INSERT OR REPLACE INTO members (public_key, callsign, avatar_url, status, credit_frozen, joined_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
        `).run(m.pubkey, m.callsign, m.avatar, m.status, m.frozen);
    }
    for (const rp of syncSnapshot.posts ?? []) {
        const pollOptionsJson = rp.pollOptions != null
            ? (typeof rp.pollOptions === 'string' ? rp.pollOptions : JSON.stringify(rp.pollOptions))
            : null;
        replicaDb.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, active, status, repeatable, lat, lng, origin_node, price_type, accepted_by, accepted_at, pending_transaction_id, completed_at, updated_at, poll_options, poll_closes_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            rp.id, rp.type, rp.category, rp.title, rp.description, rp.credits, rp.authorPublicKey, rp.createdAt,
            rp.active ? 1 : 0, rp.status, rp.repeatable ? 1 : 0, rp.lat ?? null, rp.lng ?? null, rp.originNode || 'node',
            rp.priceType || 'fixed', rp.acceptedBy || null, rp.acceptedAt || null, rp.pendingTransactionId || null,
            rp.completedAt || null, rp.updatedAt || rp.createdAt, pollOptionsJson, rp.pollClosesAt || null
        );
    }
    for (const pv of syncSnapshot.pollVotes ?? []) {
        replicaDb.prepare(`INSERT INTO poll_votes (post_id, voter_pubkey, option_id, signature, created_at)
                    VALUES (?, ?, ?, ?, ?)`).run(pv.postId, pv.voterPubkey, pv.optionId, pv.signature || '', pv.createdAt);
    }
    const replicaPolls = getPostsEngine(replicaDb as any, { id: poll1!.id, includeInactive: true });
    assert(replicaPolls.length === 1, 'Replication replica contains restored poll');
    assert(Array.isArray(replicaPolls[0].pollOptions) && replicaPolls[0].pollOptions.length === 2, 'Replica preserves poll options');
    assert(replicaPolls[0].totalVotes === 1, 'Replica preserves vote turnout');
    assert(replicaPolls[0].pollVotes?.length === 1, 'Replica preserves voter ballot records');
    assert(replicaPolls[0].pollVotes?.[0]?.voterPubkey === 'pub-carol', 'Replica preserves voter identity');
    replicaDb.close();

    console.log(`\n🎉 All ${passed}/${run} tests passed successfully!`);
}

main().catch(err => {
    console.error('Test suite failed with unexpected error:', err);
    process.exit(1);
});

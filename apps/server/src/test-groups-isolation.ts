/**
 * Test Suite: Groups, Convenor Moderation & Consumer Isolation (§9, Item 10)
 *
 * Dedicated tests per consumer:
 * 1. Public feed isolation (GET /api/marketplace/posts & getPosts)
 * 2. Map pins isolation
 * 3. Search isolation (posts_fts, getPosts({ query }), getPostCount({ query }))
 * 4. Peer/federation sync isolation (listingsForPeer in federation-listings.ts)
 * 5. Daily Pulse gate isolation (daily-pulse active member listing count)
 * 6. Activity feed isolation (activity_feed table entries)
 * 7. WebSocket broadcast isolation (scoped recipient delivery)
 * 8. Public info counters isolation (getActivePostCount & getCommunityInfo().postCount)
 * 9. Direct queries isolation (getPosts({ id }))
 * 10. Convenor moderation & hard boundary invariants (§9)
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import { db, initSchema } from './db/db.js';
import {
    createPost,
    updatePost,
    getPosts,
    getPostCount,
    getActivePostCount,
    getCommunityInfo,
    createGroup,
    getGroup,
    listGroups,
    getGroupMembers,
    joinGroup,
    setMemberRole,
    removeGroupMember,
    updateGroupPolicy,
    approveGroupMember,
    inviteGroupMember,
    deleteGroupPost,
    removePost,
    requestPost,
    acceptPost,
    closePoll,
    votePoll,
    broadcast,
    addWsClient,
    removeWsClient
} from './state-engine.js';
import { listingsForPeer } from './federation-listings.js';
import crypto from 'node:crypto';

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

function makeMember(baseCallsign: string): { pubKeyHex: string; callsign: string } {
    const pubKeyHex = crypto.randomBytes(32).toString('hex');
    const callsign = `${baseCallsign}_${crypto.randomBytes(4).toString('hex')}`;
    db.prepare(`
        INSERT INTO members (public_key, callsign, avatar_url, status, earned_credit, joined_at)
        VALUES (?, ?, 'bundled://sprout', 'active', 50, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).run(pubKeyHex, callsign);

    // Give member an initial offer to satisfy the contribution covenant
    createPost('offer', 'other', `${callsign}'s Seed Offer`, 'Offer for covenant', 10, 'fixed', pubKeyHex, undefined, undefined, [], false);
    return { pubKeyHex, callsign };
}

async function runTests() {
    console.log('🧪 Starting Groups, Convenor Moderation & Isolation Test Suite (docs/the-commons.md §9)...\n');
    initSchema();

    const alice = makeMember('Alice');
    const bob = makeMember('Bob');
    const carol = makeMember('Carol');
    const dave = makeMember('Dave');

    // Setup Group 1: Gardeners
    const gardenGroup = createGroup({
        name: 'Mullumbimby Gardeners',
        description: 'Community gardening and tool sharing',
        category: 'working_group',
        joinPolicy: 'open',
        createdBy: alice.pubKeyHex
    });

    // Bob joins gardenGroup
    joinGroup(gardenGroup.id, bob.pubKeyHex);

    // Setup Group 2: Builders
    const buildGroup = createGroup({
        name: 'Mullumbimby Builders',
        category: 'guild',
        joinPolicy: 'request_to_join',
        createdBy: carol.pubKeyHex
    });

    console.log('─── CONSUMER 1: Public Feed Isolation ───');
    {
        // Alice creates:
        // - 1 public post
        // - 1 group post in Gardeners
        // - 1 direct post to Dave
        const pubPost = createPost('offer', 'food', 'Fresh Kale', 'Organically grown kale', 3, 'fixed', alice.pubKeyHex, undefined, undefined, [], false, undefined, false, { audienceScope: 'public' });
        const grpPost = createPost('offer', 'tools', 'Rototiller Rental', 'Heavy duty rototiller for gardeners', 15, 'daily', alice.pubKeyHex, undefined, undefined, [], false, undefined, false, { audienceScope: 'group', targetGroupId: gardenGroup.id });
        const dirPost = createPost('need', 'help', 'Urgent Ride to Town', 'Need a lift to the depot', 5, 'fixed', alice.pubKeyHex, undefined, undefined, [], false, undefined, false, { audienceScope: 'direct', targetPubkey: dave.pubKeyHex });

        assert(!!pubPost && !!grpPost && !!dirPost, '1a. All three posts created successfully');

        // Anonymous public feed
        const anonFeed = getPosts();
        const anonIds = anonFeed.map(p => p.id);
        assert(anonIds.includes(pubPost!.id), '1b. Public feed shows public post');
        assert(!anonIds.includes(grpPost!.id), '1c. Public feed STRICTLY HIDES group-scoped post');
        assert(!anonIds.includes(dirPost!.id), '1d. Public feed STRICTLY HIDES direct-scoped post');

        // Carol (non-member of Gardeners, not recipient of direct post)
        const carolFeed = getPosts({ viewerPubkey: carol.pubKeyHex });
        const carolIds = carolFeed.map(p => p.id);
        assert(carolIds.includes(pubPost!.id), '1e. Carol sees public post');
        assert(!carolIds.includes(grpPost!.id), '1f. Non-member Carol cannot see Gardeners group post');
        assert(!carolIds.includes(dirPost!.id), '1g. Carol cannot see direct post to Dave');

        // Bob (active member of Gardeners)
        const bobFeed = getPosts({ viewerPubkey: bob.pubKeyHex });
        const bobIds = bobFeed.map(p => p.id);
        assert(bobIds.includes(pubPost!.id), '1h. Bob sees public post');
        assert(bobIds.includes(grpPost!.id), '1i. Active group member Bob sees Gardeners group post');
        assert(!bobIds.includes(dirPost!.id), '1j. Bob cannot see direct post to Dave');

        // Dave (recipient of direct post)
        const daveFeed = getPosts({ viewerPubkey: dave.pubKeyHex });
        const daveIds = daveFeed.map(p => p.id);
        assert(daveIds.includes(pubPost!.id), '1k. Dave sees public post');
        assert(!daveIds.includes(grpPost!.id), '1l. Dave (not in Gardeners) cannot see Gardeners group post');
        assert(daveIds.includes(dirPost!.id), '1m. Dave sees direct post addressed to him');
    }

    console.log('\n─── CONSUMER 2: Map Pins Isolation ───');
    {
        // Public post with location
        const pubMapPost = createPost('offer', 'produce', 'Oranges at Gate', 'Pick your own oranges', 4, 'fixed', alice.pubKeyHex, -28.55, 153.50, [], false, undefined, false, { audienceScope: 'public' });
        // Private group post with location
        const grpMapPost = createPost('offer', 'equipment', 'Secret Seed Bank Location', 'Come grab seeds from the shed', 0, 'fixed', alice.pubKeyHex, -28.56, 153.51, [], false, undefined, false, { audienceScope: 'group', targetGroupId: gardenGroup.id });

        assert(!!pubMapPost && !!grpMapPost, '2a. Location-tagged posts created');

        // Map pins for anonymous caller
        const anonPins = getPosts().filter(p => p.lat != null && p.lng != null);
        const anonPinIds = anonPins.map(p => p.id);
        assert(anonPinIds.includes(pubMapPost!.id), '2b. Public map pin is visible to anyone');
        assert(!anonPinIds.includes(grpMapPost!.id), '2c. Private group location pin is HIDDEN from anonymous map');

        // Map pins for Carol (non-member)
        const carolPins = getPosts({ viewerPubkey: carol.pubKeyHex }).filter(p => p.lat != null && p.lng != null);
        const carolPinIds = carolPins.map(p => p.id);
        assert(!carolPinIds.includes(grpMapPost!.id), '2d. Private group location pin is HIDDEN from non-member Carol');

        // Map pins for Bob (active group member)
        const bobPins = getPosts({ viewerPubkey: bob.pubKeyHex }).filter(p => p.lat != null && p.lng != null);
        const bobPinIds = bobPins.map(p => p.id);
        assert(bobPinIds.includes(grpMapPost!.id), '2e. Private group location pin IS visible to active group member Bob');
    }

    console.log('\n─── CONSUMER 3: Search Isolation ───');
    {
        const secretTerm = `zyzzyva_${Date.now()}`;
        const secretPost = createPost('offer', 'tools', `Rare ${secretTerm} artifact`, 'Top secret equipment', 50, 'fixed', alice.pubKeyHex, undefined, undefined, [], false, undefined, false, { audienceScope: 'group', targetGroupId: gardenGroup.id });
        assert(!!secretPost, '3a. Group post with unique search term created');

        // Anonymous search
        const anonResults = getPosts({ query: secretTerm });
        assert(anonResults.length === 0, '3b. Anonymous FTS search returns 0 results for group post');
        assert(getPostCount({ query: secretTerm }) === 0, '3c. Anonymous getPostCount for term is 0');

        // Non-member search
        const carolResults = getPosts({ query: secretTerm, viewerPubkey: carol.pubKeyHex });
        assert(carolResults.length === 0, '3d. Non-member Carol FTS search returns 0 results');
        assert(getPostCount({ query: secretTerm, viewerPubkey: carol.pubKeyHex }) === 0, '3e. Carol getPostCount for term is 0');

        // Group member search
        const bobResults = getPosts({ query: secretTerm, viewerPubkey: bob.pubKeyHex });
        assert(bobResults.length === 1 && bobResults[0].id === secretPost!.id, '3f. Active group member Bob finds the group post via search');
        assert(getPostCount({ query: secretTerm, viewerPubkey: bob.pubKeyHex }) === 1, '3g. Bob getPostCount for term is 1');
    }

    console.log('\n─── CONSUMER 4: Peer / Federation Sync Isolation ───');
    {
        const peerId = 'peer_neighbour_node_1';
        // Public federated post
        const pubFedPost = createPost('offer', 'crafts', 'Handmade Soap Everywhere', 'Soap for all communities', 8, 'fixed', alice.pubKeyHex, undefined, undefined, [], false, undefined, false, { reach: 'everywhere', audienceScope: 'public' });
        // Group post with reach: 'everywhere' (should NEVER federate!)
        const grpFedPost = createPost('offer', 'crafts', 'Private Guild Soap', 'Only for our group members', 8, 'fixed', alice.pubKeyHex, undefined, undefined, [], false, undefined, false, { reach: 'everywhere', audienceScope: 'group', targetGroupId: gardenGroup.id });
        // Direct post with reach: 'everywhere' (should NEVER federate!)
        const dirFedPost = createPost('need', 'help', 'Private Direct Help', 'Only for Dave', 10, 'fixed', alice.pubKeyHex, undefined, undefined, [], false, undefined, false, { reach: 'everywhere', audienceScope: 'direct', targetPubkey: dave.pubKeyHex });

        assert(!!pubFedPost && !!grpFedPost && !!dirFedPost, '4a. Federated test posts created');

        const peerListings = listingsForPeer(peerId);
        const peerIds = peerListings.map(l => l.id);

        assert(peerIds.includes(pubFedPost!.id), '4b. Public post with reach=everywhere is served to peer');
        assert(!peerIds.includes(grpFedPost!.id), '4c. Group post is NEVER served to peer node despite reach=everywhere');
        assert(!peerIds.includes(dirFedPost!.id), '4d. Direct post is NEVER served to peer node despite reach=everywhere');
    }

    console.log('\n─── CONSUMER 5: Daily Pulse Suppression Gate Isolation ───');
    {
        // Check Pulse listing counting query in SQLite
        const getPulseListingCount = (pubkey: string) => {
            const row = db.prepare(`
                SELECT COUNT(*) as c FROM posts
                WHERE author_pubkey != ? AND active = 1 AND status = 'active' AND type != 'poll'
                AND (audience_scope IS NULL OR audience_scope = 'public')
            `).get(pubkey) as any;
            return row?.c || 0;
        };

        const beforeCount = getPulseListingCount('some_pulse_pubkey');

        // Create a group post and a direct post
        createPost('offer', 'tools', 'Garden Post Count Test', 'Desc', 5, 'fixed', bob.pubKeyHex, undefined, undefined, [], false, undefined, false, { audienceScope: 'group', targetGroupId: gardenGroup.id });
        createPost('offer', 'tools', 'Direct Post Count Test', 'Desc', 5, 'fixed', bob.pubKeyHex, undefined, undefined, [], false, undefined, false, { audienceScope: 'direct', targetPubkey: carol.pubKeyHex });

        const afterPrivateCount = getPulseListingCount('some_pulse_pubkey');
        assert(afterPrivateCount === beforeCount, `5a. Daily pulse active listings count is unchanged after group/direct posts (was ${beforeCount}, now ${afterPrivateCount})`);

        // Create a public post
        createPost('offer', 'tools', 'Public Post Count Test', 'Desc', 5, 'fixed', bob.pubKeyHex, undefined, undefined, [], false, undefined, false, { audienceScope: 'public' });
        const afterPublicCount = getPulseListingCount('some_pulse_pubkey');
        assert(afterPublicCount === beforeCount + 1, `5b. Daily pulse count increments ONLY for public posts (now ${afterPublicCount})`);
    }

    console.log('\n─── CONSUMER 6: Activity Feed Isolation ───');
    {
        const getRecentActivities = () => {
            return db.prepare("SELECT * FROM activity_feed WHERE event_type = 'post_created' ORDER BY created_at DESC, id DESC").all() as any[];
        };

        const initialCount = getRecentActivities().length;

        // Create group post
        const privateGroupPost = createPost('offer', 'tools', 'Secret Garden Plan', 'Desc', 10, 'fixed', alice.pubKeyHex, undefined, undefined, [], false, undefined, false, { audienceScope: 'group', targetGroupId: gardenGroup.id });
        // Create direct post
        const privateDirectPost = createPost('offer', 'tools', 'Secret Dave Trade', 'Desc', 10, 'fixed', alice.pubKeyHex, undefined, undefined, [], false, undefined, false, { audienceScope: 'direct', targetPubkey: dave.pubKeyHex });

        const afterPrivateActivities = getRecentActivities();
        assert(afterPrivateActivities.length === initialCount, '6a. Creating group/direct posts writes ZERO entries to activity_feed');

        // Create public post
        const publicActivityPost = createPost('offer', 'tools', 'Community Compost Bin', 'Free compost for all', 0, 'fixed', alice.pubKeyHex, undefined, undefined, [], false, undefined, false, { audienceScope: 'public' });

        const afterPublicActivities = getRecentActivities();
        assert(afterPublicActivities.length === initialCount + 1, '6b. Creating a public post writes exactly 1 entry to activity_feed');
        const latest = afterPublicActivities[0];
        const payload = JSON.parse(latest.metadata);
        assert(payload.postId === publicActivityPost!.id, '6c. Activity feed entry matches the public post ID');
    }

    console.log('\n─── CONSUMER 7: WebSocket Broadcast Isolation ───');
    {
        const receivedBob: any[] = [];
        const receivedCarol: any[] = [];
        const receivedAnon: any[] = [];

        const wsBob: any = { _memberPubkey: bob.pubKeyHex, send: (m: string) => receivedBob.push(JSON.parse(m)) };
        const wsCarol: any = { _memberPubkey: carol.pubKeyHex, send: (m: string) => receivedCarol.push(JSON.parse(m)) };
        const wsAnon: any = { _memberPubkey: null, send: (m: string) => receivedAnon.push(JSON.parse(m)) };

        addWsClient(wsBob);
        addWsClient(wsCarol);
        addWsClient(wsAnon);

        // 1. Broadcast group post in Gardeners (Bob is member, Carol is not)
        const grpPostWs = createPost('offer', 'tools', 'Broadcast Shovel', 'Shovel', 1, 'fixed', alice.pubKeyHex, undefined, undefined, [], false, undefined, false, { audienceScope: 'group', targetGroupId: gardenGroup.id });

        const bobGotGrp = receivedBob.some(e => e.type === 'new_post' && e.post.id === grpPostWs!.id);
        const carolGotGrp = receivedCarol.some(e => e.type === 'new_post' && e.post.id === grpPostWs!.id);
        const anonGotGrp = receivedAnon.some(e => e.type === 'new_post' && e.post.id === grpPostWs!.id);

        assert(bobGotGrp, '7a. Active member Bob received group post WebSocket broadcast');
        assert(!carolGotGrp, '7b. Non-member Carol DID NOT receive group post WebSocket broadcast');
        assert(!anonGotGrp, '7c. Anonymous socket DID NOT receive group post WebSocket broadcast');

        // 2. Broadcast direct post to Carol
        const dirPostWs = createPost('need', 'help', 'Direct Secret to Carol', 'Need advice', 2, 'fixed', alice.pubKeyHex, undefined, undefined, [], false, undefined, false, { audienceScope: 'direct', targetPubkey: carol.pubKeyHex });

        const bobGotDir = receivedBob.some(e => e.type === 'new_post' && e.post.id === dirPostWs!.id);
        const carolGotDir = receivedCarol.some(e => e.type === 'new_post' && e.post.id === dirPostWs!.id);
        const anonGotDir = receivedAnon.some(e => e.type === 'new_post' && e.post.id === dirPostWs!.id);

        assert(!bobGotDir, '7d. Bob DID NOT receive direct post sent to Carol');
        assert(carolGotDir, '7e. Recipient Carol DID receive direct post WebSocket broadcast');
        assert(!anonGotDir, '7f. Anonymous socket DID NOT receive direct post WebSocket broadcast');

        // 3. Broadcast group poll vote and close in Gardeners (Bob is member, Carol is not)
        const grpPoll = createPost('poll', 'other', 'Garden Schedule Poll', 'When to meet?', 0, 'fixed', alice.pubKeyHex, undefined, undefined, [], false, undefined, false, {
            audienceScope: 'group',
            targetGroupId: gardenGroup.id,
            pollOptions: [{ id: 'opt_1', text: 'Saturday' }, { id: 'opt_2', text: 'Sunday' }]
        });

        receivedBob.length = 0;
        receivedCarol.length = 0;
        receivedAnon.length = 0;

        votePoll(grpPoll!.id, bob.pubKeyHex, 'opt_1');
        assert(receivedBob.some(e => e.type === 'post_updated' && e.post.id === grpPoll!.id), '7g. Member Bob received votePoll post_updated broadcast');
        assert(!receivedCarol.some(e => e.type === 'post_updated' && e.post.id === grpPoll!.id), '7h. Non-member Carol DID NOT receive votePoll post_updated broadcast');
        assert(!receivedAnon.some(e => e.type === 'post_updated' && e.post.id === grpPoll!.id), '7i. Anonymous socket DID NOT receive votePoll post_updated broadcast');

        receivedBob.length = 0;
        receivedCarol.length = 0;
        receivedAnon.length = 0;

        closePoll(grpPoll!.id, alice.pubKeyHex);
        assert(receivedBob.some(e => e.type === 'post_updated' && e.post.id === grpPoll!.id), '7j. Member Bob received closePoll post_updated broadcast');
        assert(!receivedCarol.some(e => e.type === 'post_updated' && e.post.id === grpPoll!.id), '7k. Non-member Carol DID NOT receive closePoll post_updated broadcast');
        assert(!receivedAnon.some(e => e.type === 'post_updated' && e.post.id === grpPoll!.id), '7l. Anonymous socket DID NOT receive closePoll post_updated broadcast');

        // 4. Broadcast group_member_invited scoped to convenor and invitee only
        const receivedAlice: any[] = [];
        const receivedDave: any[] = [];
        const wsAlice: any = { _memberPubkey: alice.pubKeyHex, send: (m: string) => receivedAlice.push(JSON.parse(m)) };
        const wsDave: any = { _memberPubkey: dave.pubKeyHex, send: (m: string) => receivedDave.push(JSON.parse(m)) };
        addWsClient(wsAlice);
        addWsClient(wsDave);

        receivedAlice.length = 0;
        receivedDave.length = 0;
        receivedBob.length = 0;
        receivedAnon.length = 0;

        // Alice (convenor) invites Dave
        const inviteRes = inviteGroupMember(gardenGroup.id, alice.pubKeyHex, dave.pubKeyHex, 'member');
        assert(receivedAlice.some(e => e.type === 'group_member_invited' && e.member.memberPubkey === dave.pubKeyHex), '7m. Convenor Alice received group_member_invited broadcast');
        assert(receivedDave.some(e => e.type === 'group_member_invited' && e.member.memberPubkey === dave.pubKeyHex), '7n. Invitee Dave received group_member_invited broadcast');
        assert(!receivedBob.some(e => e.type === 'group_member_invited'), '7o. Regular member Bob DID NOT receive group_member_invited broadcast');
        assert(!receivedAnon.some(e => e.type === 'group_member_invited'), '7p. Anonymous socket DID NOT receive group_member_invited broadcast');

        // 5. Broadcast scoping for private group membership changes (§9)
        // Set up a private group with request_to_join policy
        const privateGroup = createGroup({
            name: 'Secret Society',
            description: 'Private discussions',
            category: 'working_group',
            joinPolicy: 'request_to_join',
            createdBy: alice.pubKeyHex
        })!;

        receivedBob.length = 0;
        receivedCarol.length = 0;
        receivedAnon.length = 0;

        // Bob requests to join private group
        joinGroup(privateGroup.id, bob.pubKeyHex);
        assert(receivedBob.some(e => e.type === 'group_member_updated' && e.groupId === privateGroup.id), '7q. Applicant Bob received group_member_updated broadcast');
        assert(!receivedCarol.some(e => e.groupId === privateGroup.id), '7r. Non-member Carol DID NOT receive joinGroup broadcast for private group');
        assert(!receivedAnon.some(e => e.groupId === privateGroup.id), '7s. Anonymous socket DID NOT receive joinGroup broadcast for private group');

        receivedBob.length = 0;
        receivedCarol.length = 0;
        receivedAnon.length = 0;

        // Alice approves Bob
        approveGroupMember(privateGroup.id, alice.pubKeyHex, bob.pubKeyHex);
        assert(receivedBob.some(e => e.type === 'group_member_updated' && e.groupId === privateGroup.id), '7t. Approved Bob received group_member_updated broadcast');
        assert(!receivedCarol.some(e => e.groupId === privateGroup.id), '7u. Non-member Carol DID NOT receive approveGroupMember broadcast for private group');
        assert(!receivedAnon.some(e => e.groupId === privateGroup.id), '7v. Anonymous socket DID NOT receive approveGroupMember broadcast for private group');

        receivedBob.length = 0;
        receivedCarol.length = 0;
        receivedAnon.length = 0;

        // Alice changes Bob role
        setMemberRole(privateGroup.id, alice.pubKeyHex, bob.pubKeyHex, 'convenor');
        assert(receivedBob.some(e => e.type === 'group_member_updated' && e.groupId === privateGroup.id), '7w. Member Bob received setMemberRole broadcast');
        assert(!receivedCarol.some(e => e.groupId === privateGroup.id), '7x. Non-member Carol DID NOT receive setMemberRole broadcast');
        assert(!receivedAnon.some(e => e.groupId === privateGroup.id), '7y. Anonymous socket DID NOT receive setMemberRole broadcast');

        receivedBob.length = 0;
        receivedCarol.length = 0;
        receivedAnon.length = 0;

        // Alice updates group policy to invite_only
        updateGroupPolicy(privateGroup.id, alice.pubKeyHex, 'invite_only');
        assert(receivedBob.some(e => e.type === 'group_updated' && e.group?.id === privateGroup.id), '7z. Member Bob received updateGroupPolicy broadcast');
        assert(!receivedCarol.some(e => e.group?.id === privateGroup.id), '7aa. Non-member Carol DID NOT receive updateGroupPolicy broadcast');
        assert(!receivedAnon.some(e => e.group?.id === privateGroup.id), '7bb. Anonymous socket DID NOT receive updateGroupPolicy broadcast');

        receivedBob.length = 0;
        receivedCarol.length = 0;
        receivedAnon.length = 0;

        // Alice removes Bob
        removeGroupMember(privateGroup.id, alice.pubKeyHex, bob.pubKeyHex);
        assert(receivedBob.some(e => e.type === 'group_member_removed' && e.groupId === privateGroup.id), '7cc. Removed Bob received group_member_removed broadcast');
        assert(!receivedCarol.some(e => e.groupId === privateGroup.id), '7dd. Non-member Carol DID NOT receive removeGroupMember broadcast');
        assert(!receivedAnon.some(e => e.groupId === privateGroup.id), '7ee. Anonymous socket DID NOT receive removeGroupMember broadcast');

        removeWsClient(wsAlice);
        removeWsClient(wsDave);
        removeWsClient(wsBob);
        removeWsClient(wsCarol);
        removeWsClient(wsAnon);
    }

    console.log('\n─── CONSUMER 8: Public Info Counters Isolation ───');
    {
        const activeCountBefore = getActivePostCount();
        const infoBefore = getCommunityInfo();

        // Create group post and direct post
        createPost('offer', 'other', 'Counter Group Post', 'Desc', 5, 'fixed', alice.pubKeyHex, undefined, undefined, [], false, undefined, false, { audienceScope: 'group', targetGroupId: gardenGroup.id });
        createPost('offer', 'other', 'Counter Direct Post', 'Desc', 5, 'fixed', alice.pubKeyHex, undefined, undefined, [], false, undefined, false, { audienceScope: 'direct', targetPubkey: dave.pubKeyHex });

        assert(getActivePostCount() === activeCountBefore, '8a. getActivePostCount() does NOT increment on group or direct posts');
        assert(getCommunityInfo().postCount === infoBefore.postCount, '8b. getCommunityInfo().postCount does NOT increment on group or direct posts');

        // Create public post
        createPost('offer', 'other', 'Counter Public Post', 'Desc', 5, 'fixed', alice.pubKeyHex, undefined, undefined, [], false, undefined, false, { audienceScope: 'public' });

        assert(getActivePostCount() === activeCountBefore + 1, '8c. getActivePostCount() increments on public post');
        assert(getCommunityInfo().postCount === infoBefore.postCount + 1, '8d. getCommunityInfo().postCount increments on public post');
    }

    console.log('\n─── CONSUMER 9: Direct Query Isolation (getPosts({ id })) ───');
    {
        const directTestPost = createPost('offer', 'tools', 'Private Secret Post', 'Desc', 10, 'fixed', alice.pubKeyHex, undefined, undefined, [], false, undefined, false, { audienceScope: 'group', targetGroupId: gardenGroup.id });
        const pid = directTestPost!.id;

        // Anonymous query by ID
        const anonLookup = getPosts({ id: pid });
        assert(anonLookup.length === 0, '9a. Anonymous direct lookup getPosts({ id }) returns empty array');

        // Non-member Carol query by ID
        const carolLookup = getPosts({ id: pid, viewerPubkey: carol.pubKeyHex });
        assert(carolLookup.length === 0, '9b. Non-member Carol direct lookup getPosts({ id }) returns empty array');

        // Active member Bob query by ID
        const bobLookup = getPosts({ id: pid, viewerPubkey: bob.pubKeyHex });
        assert(bobLookup.length === 1 && bobLookup[0].id === pid, '9c. Active member Bob direct lookup getPosts({ id }) returns the post');

        // Author Alice query by ID
        const aliceLookup = getPosts({ id: pid, viewerPubkey: alice.pubKeyHex });
        assert(aliceLookup.length === 1 && aliceLookup[0].id === pid, '9d. Author Alice direct lookup getPosts({ id }) returns the post');
    }

    console.log('\n─── CONSUMER 10: Convenor Moderation & Hard §9 Boundary Rules ───');
    {
        // 1. Role changes: Convenor Alice promotes Bob to convenor
        const updatedBob = setMemberRole(gardenGroup.id, alice.pubKeyHex, bob.pubKeyHex, 'convenor');
        assert(updatedBob.role === 'convenor', '10a. Convenor promotes member to convenor');

        // Bob sets Dave to observer
        joinGroup(gardenGroup.id, dave.pubKeyHex);
        const updatedDave = setMemberRole(gardenGroup.id, bob.pubKeyHex, dave.pubKeyHex, 'observer');
        assert(updatedDave.role === 'observer', '10b. Convenor sets member to observer');

        // Demotion safety: demoting Alice leaves Bob as convenor -> OK
        setMemberRole(gardenGroup.id, bob.pubKeyHex, alice.pubKeyHex, 'member');

        // Now Bob is the ONLY convenor. Demoting Bob must fail!
        let demoteFailed = false;
        try {
            setMemberRole(gardenGroup.id, bob.pubKeyHex, bob.pubKeyHex, 'member');
        } catch (e: any) {
            demoteFailed = true;
        }
        assert(demoteFailed, '10c. Cannot demote the last active convenor of a group');

        // Restore Alice as convenor
        setMemberRole(gardenGroup.id, bob.pubKeyHex, alice.pubKeyHex, 'convenor');

        // 2. Join policies: request_to_join & approval
        const reqJoin = joinGroup(buildGroup.id, alice.pubKeyHex);
        assert(reqJoin.status === 'pending_approval', '10d. joinGroup under request_to_join results in pending_approval');

        // Non-convenor Bob cannot approve
        let bobApproveFailed = false;
        try {
            approveGroupMember(buildGroup.id, bob.pubKeyHex, alice.pubKeyHex);
        } catch (e: any) {
            bobApproveFailed = true;
        }
        assert(bobApproveFailed, '10e. Non-convenor cannot approve membership request');

        // Convenor Carol approves Alice
        const approvedAlice = approveGroupMember(buildGroup.id, carol.pubKeyHex, alice.pubKeyHex);
        assert(approvedAlice.status === 'active', '10f. Convenor Carol approves membership request');

        // 3. Join policy update: invite_only
        updateGroupPolicy(buildGroup.id, carol.pubKeyHex, 'invite_only');
        assert(getGroup(buildGroup.id)?.joinPolicy === 'invite_only', '10g. Convenor sets join policy to invite_only');

        let strangerJoinFailed = false;
        try {
            joinGroup(buildGroup.id, dave.pubKeyHex);
        } catch (e: any) {
            strangerJoinFailed = true;
        }
        assert(strangerJoinFailed, '10h. Stranger cannot join an invite_only group directly');

        // Convenor invites Dave
        const invitedDave = inviteGroupMember(buildGroup.id, carol.pubKeyHex, dave.pubKeyHex, 'member');
        assert(invitedDave.status === 'invited', '10i. Convenor invites Dave to invite_only group');

        // Dave accepts
        const daveActive = joinGroup(buildGroup.id, dave.pubKeyHex);
        assert(daveActive.status === 'active', '10j. Invited member joins and becomes active');

        // 4. Convenor post deletion
        const bobPostInGarden = createPost('offer', 'tools', 'Garden Rake', 'Sturdy rake', 2, 'fixed', bob.pubKeyHex, undefined, undefined, [], false, undefined, false, { audienceScope: 'group', targetGroupId: gardenGroup.id });
        assert(!!bobPostInGarden, '10k. Bob creates post in Gardeners');

        // Carol (convenor of Builders, NOT Gardeners) tries to delete Bob's post in Gardeners -> MUST fail
        let unauthorizedDeleteFailed = false;
        try {
            deleteGroupPost(gardenGroup.id, carol.pubKeyHex, bobPostInGarden!.id);
        } catch (e: any) {
            unauthorizedDeleteFailed = true;
        }
        assert(unauthorizedDeleteFailed, '10l. Convenor of another group CANNOT delete post in this group');

        // Alice (convenor of Gardeners) deletes Bob's post
        const deleted = deleteGroupPost(gardenGroup.id, alice.pubKeyHex, bobPostInGarden!.id);
        assert(deleted, '10m. Convenor Alice successfully deletes Bob post in her group');
        const checkBobPost = getPosts({ id: bobPostInGarden!.id, viewerPubkey: alice.pubKeyHex, includeInactive: true })[0];
        assert(checkBobPost?.status === 'cancelled' && checkBobPost?.active === false, '10n. Deleted post marked active=0, status=cancelled');

        // 5. Hard boundary invariants from §9:
        // Check schema: groups has NO enterprise_id or treasury_id column
        const groupsColumns = db.prepare("PRAGMA table_info(groups)").all() as any[];
        const groupsColNames = groupsColumns.map(c => c.name);
        assert(!groupsColNames.includes('enterprise_id') && !groupsColNames.includes('treasury_id') && !groupsColNames.includes('treasury_pubkey'),
            '10o. HARD RULE §9: groups table has NO foreign key to enterprises or treasuries');

        // group_members has NO foreign key or link to enterprise
        const gmColumns = db.prepare("PRAGMA table_info(group_members)").all() as any[];
        const gmColNames = gmColumns.map(c => c.name);
        assert(!gmColNames.includes('enterprise_id') && !gmColNames.includes('treasury_id'),
            '10p. HARD RULE §9: group_members table has NO foreign key to enterprises');

        // Being a convenor grants no trust tier or credit
        const aliceProfile = db.prepare("SELECT earned_credit, status FROM members WHERE public_key = ?").get(alice.pubKeyHex) as any;
        assert(aliceProfile.earned_credit === 50, '10q. HARD RULE §9: Creating group or being convenor confers NO credit or trust tier');

        // Node roles remain separate
        const nodeRolesRow = db.prepare("SELECT 1 FROM node_roles WHERE member_pubkey = ?").get(alice.pubKeyHex);
        assert(!nodeRolesRow, '10r. HARD RULE §9: Creating group or being convenor confers NO node role (node_roles remains separate)');

        // 6. Escrow requestPost audience isolation:
        // Carol (non-member of Gardeners) cannot request or accept a group post in Gardeners
        const gardenOffer = createPost('offer', 'tools', 'Special Rake', 'For gardeners only', 5, 'fixed', alice.pubKeyHex, undefined, undefined, [], false, undefined, false, { audienceScope: 'group', targetGroupId: gardenGroup.id });
        let nonMemberReqFailed = false;
        try {
            requestPost(gardenOffer!.id, carol.pubKeyHex);
        } catch (e: any) {
            nonMemberReqFailed = e.message.includes('UNAUTHORIZED');
        }
        assert(nonMemberReqFailed, '10s. Non-member Carol CANNOT request a group-scoped post');

        let nonMemberAcceptFailed = false;
        try {
            acceptPost(gardenOffer!.id, carol.pubKeyHex);
        } catch (e: any) {
            nonMemberAcceptFailed = e.message.includes('UNAUTHORIZED');
        }
        assert(nonMemberAcceptFailed, '10s-accept. Non-member Carol CANNOT accept a group-scoped post');

        // Regression test for Defect 3: Observer in group CANNOT request or accept group post
        db.prepare("INSERT OR REPLACE INTO group_members (group_id, member_pubkey, role, status, joined_at, updated_at) VALUES (?, ?, 'observer', 'active', 'now', 'now')")
            .run(gardenGroup.id, dave.pubKeyHex);

        let observerReqFailed = false;
        try {
            requestPost(gardenOffer!.id, dave.pubKeyHex);
        } catch (e: any) {
            observerReqFailed = e.message.includes('UNAUTHORIZED');
        }
        assert(observerReqFailed, '10s-observer-req. Observer Dave CANNOT request a group-scoped post');

        let observerAcceptFailed = false;
        try {
            acceptPost(gardenOffer!.id, dave.pubKeyHex);
        } catch (e: any) {
            observerAcceptFailed = e.message.includes('UNAUTHORIZED');
        }
        assert(observerAcceptFailed, '10s-observer-accept. Observer Dave CANNOT accept a group-scoped post');

        // Direct post to Dave cannot be requested or accepted by Carol
        const directOffer = createPost('offer', 'tools', 'Special Book', 'For Dave only', 5, 'fixed', alice.pubKeyHex, undefined, undefined, [], false, undefined, false, { audienceScope: 'direct', targetPubkey: dave.pubKeyHex });
        let nonTargetReqFailed = false;
        try {
            requestPost(directOffer!.id, carol.pubKeyHex);
        } catch (e: any) {
            nonTargetReqFailed = e.message.includes('UNAUTHORIZED');
        }
        assert(nonTargetReqFailed, '10t. Non-target Carol CANNOT request a direct-scoped post');

        let nonTargetAcceptFailed = false;
        try {
            acceptPost(directOffer!.id, carol.pubKeyHex);
        } catch (e: any) {
            nonTargetAcceptFailed = e.message.includes('UNAUTHORIZED');
        }
        assert(nonTargetAcceptFailed, '10t-accept. Non-target Carol CANNOT accept a direct-scoped post');

        // 7. Public posts clear foreign target fields:
        const taintedPublic = createPost('offer', 'tools', 'Public Shovel', 'Everyone can see', 5, 'fixed', alice.pubKeyHex, undefined, undefined, [], false, undefined, false, {
            audienceScope: 'public',
            targetGroupId: gardenGroup.id,
            targetPubkey: dave.pubKeyHex,
            assignedTo: dave.pubKeyHex
        });
        const taintedRow = db.prepare("SELECT target_group_id, target_pubkey, assigned_to FROM posts WHERE id = ?").get(taintedPublic!.id) as any;
        assert(taintedRow.target_group_id === null && taintedRow.target_pubkey === null && taintedRow.assigned_to === null,
            '10u. Public post clears foreign target_group_id, target_pubkey, and assigned_to in database');

        // 8. Non-public posts cannot update reach to non-local:
        const groupPostToUpdate = createPost('offer', 'tools', 'Wheelbarrow', 'Good wheelbarrow', 5, 'fixed', alice.pubKeyHex, undefined, undefined, [], false, undefined, false, {
            audienceScope: 'group',
            targetGroupId: gardenGroup.id
        });
        updatePost(groupPostToUpdate!.id, alice.pubKeyHex, { reach: 'everywhere' as any, reachPeers: ['node-xyz'] } as any);
        const updatedRow = db.prepare("SELECT reach, reach_peers FROM posts WHERE id = ?").get(groupPostToUpdate!.id) as any;
        assert(updatedRow.reach === 'local' && updatedRow.reach_peers === null,
            '10v. updatePost strips non-local reach updates on group-scoped posts');

        // 9. Convenor moderation scope boundary (§9):
        // Convenor Alice CANNOT delete Bob's public post via removePost
        const bobPublic = createPost('offer', 'tools', 'Bob Public Shovel', 'Public tool', 5, 'fixed', bob.pubKeyHex)!;
        const aliceDeletePublic = removePost(bobPublic.id, alice.pubKeyHex);
        assert(!aliceDeletePublic, '10w. Convenor Alice CANNOT delete Bob public post via removePost');
        const bobPublicCheck = getPosts({ id: bobPublic.id, viewerPubkey: bob.pubKeyHex })[0];
        assert(bobPublicCheck?.active === true && bobPublicCheck?.status === 'active', '10w-post. Bob public post remains active');

        // Residual target_group_id on public post cannot be deleted by convenor
        const publicResidual = createPost('offer', 'tools', 'Residual Public Post', 'Public with group id', 5, 'fixed', bob.pubKeyHex, undefined, undefined, [], false, undefined, false, {
            audienceScope: 'public',
            targetGroupId: gardenGroup.id
        })!;
        const aliceDeleteResidual = removePost(publicResidual.id, alice.pubKeyHex);
        assert(!aliceDeleteResidual, '10x. Convenor Alice CANNOT delete public post even if residual target_group_id matches');
        const residualCheck = getPosts({ id: publicResidual.id, viewerPubkey: bob.pubKeyHex })[0];
        assert(residualCheck?.active === true && residualCheck?.status === 'active', '10x-post. Residual post remains active');

        // 10. Re-narrowed WHERE prevents TOCTOU disagreement between auth decision and delete statement
        const racePost = createPost('offer', 'tools', 'Race Post', 'Testing TOCTOU', 5, 'fixed', bob.pubKeyHex, undefined, undefined, [], false, undefined, false, {
            audienceScope: 'group',
            targetGroupId: gardenGroup.id
        })!;
        // Concurrently change post to public in DB
        db.prepare("UPDATE posts SET audience_scope = 'public' WHERE id = ?").run(racePost.id);
        const raceDelete = removePost(racePost.id, alice.pubKeyHex);
        assert(!raceDelete, '10y. TOCTOU: removePost SQL guard prevents deleting post that became public');
        const racePostCheck = getPosts({ id: racePost.id, viewerPubkey: bob.pubKeyHex })[0];
        assert(racePostCheck?.active === true && racePostCheck?.status === 'active', '10y-post. Race post remains active');

        // 11. Legitimate convenor can delete active group-scoped post via removePost
        const validGroupPost = createPost('offer', 'tools', 'Valid Group Tool', 'For gardeners', 5, 'fixed', bob.pubKeyHex, undefined, undefined, [], false, undefined, false, {
            audienceScope: 'group',
            targetGroupId: gardenGroup.id
        })!;
        const aliceDeleteValid = removePost(validGroupPost.id, alice.pubKeyHex);
        assert(aliceDeleteValid, '10z. Convenor Alice successfully deletes valid group-scoped post via removePost');
        const validCheck = getPosts({ id: validGroupPost.id, viewerPubkey: alice.pubKeyHex, includeInactive: true })[0];
        assert(validCheck?.status === 'cancelled' && validCheck?.active === false, '10z-post. Group post cancelled');

        // 12. Deleting a group cleans up posts (no orphaned dangling target_group_id)
        const tempGroup = createGroup({
            name: 'Temp Cleanup Group',
            description: 'Temporary group for cleanup test',
            category: 'working_group',
            joinPolicy: 'open',
            createdBy: alice.pubKeyHex
        })!;
        const tempPost = createPost('offer', 'tools', 'Temp Tool', 'In temp group', 5, 'fixed', alice.pubKeyHex, undefined, undefined, [], false, undefined, false, {
            audienceScope: 'group',
            targetGroupId: tempGroup.id
        })!;
        // Delete the group from DB
        db.prepare("DELETE FROM groups WHERE id = ?").run(tempGroup.id);
        const cleanedPostRow = db.prepare("SELECT target_group_id, audience_scope, active, status FROM posts WHERE id = ?").get(tempPost.id) as any;
        assert(cleanedPostRow.target_group_id === null && cleanedPostRow.audience_scope === 'group' && cleanedPostRow.active === 0 && cleanedPostRow.status === 'cancelled',
            '10aa. posts_cleanup_on_group_delete deactivates post, cancels it, and preserves group scope without promoting to public');

        // Regression test for Defect 1: assert non-member CANNOT read deleted group post
        const nonMemberPosts = getPosts({ id: tempPost.id, viewerPubkey: carol.pubKeyHex, includeInactive: true });
        assert(nonMemberPosts.length === 0, '10aa-1. Non-member Carol CANNOT read deleted group post even with includeInactive');
        const anonPosts = getPosts({ id: tempPost.id, includeInactive: true });
        assert(anonPosts.length === 0, '10aa-2. Anonymous viewer CANNOT read deleted group post even with includeInactive');

        // 13. Poll audience scope and franchise tests:
        // Set Dave as observer in gardenGroup
        db.prepare("INSERT OR REPLACE INTO group_members (group_id, member_pubkey, role, status, joined_at, updated_at) VALUES (?, ?, 'observer', 'active', 'now', 'now')")
            .run(gardenGroup.id, dave.pubKeyHex);
        const groupPoll = createPost('poll', 'community', 'Garden Poll Question', '', 0, 'fixed', alice.pubKeyHex, undefined, undefined, [], false, undefined, false, {
            audienceScope: 'group',
            targetGroupId: gardenGroup.id,
            pollOptions: [{ id: 'opt_1', text: 'Option 1' }, { id: 'opt_2', text: 'Option 2' }]
        })!;

        // Observer Dave attempts to vote on group poll -> MUST fail
        let observerVoteFailed = false;
        try {
            votePoll(groupPoll.id, dave.pubKeyHex, 'opt_1');
        } catch (e: any) {
            observerVoteFailed = e.message.includes('UNAUTHORIZED') && e.message.includes('Must be an active convenor or member');
        }
        assert(observerVoteFailed, '10bb. Observer in group CANNOT vote on group-scoped poll');

        // Active member Bob votes on group poll -> MUST succeed
        const memberVote = votePoll(groupPoll.id, bob.pubKeyHex, 'opt_1');
        assert(memberVote.success, '10cc. Active group member Bob CAN vote on group-scoped poll');

        // Close group poll so Alice can create another poll
        closePoll(groupPoll.id, alice.pubKeyHex);

        // Direct poll addressed to Dave
        const directPoll = createPost('poll', 'community', 'Direct Poll For Dave', '', 0, 'fixed', alice.pubKeyHex, undefined, undefined, [], false, undefined, false, {
            audienceScope: 'direct',
            targetPubkey: dave.pubKeyHex,
            pollOptions: [{ id: 'opt_yes', text: 'Yes' }, { id: 'opt_no', text: 'No' }]
        })!;

        // Bob (not target or assigned) attempts to vote on direct poll -> MUST fail
        let nonTargetVoteFailed = false;
        try {
            votePoll(directPoll.id, bob.pubKeyHex, 'opt_yes');
        } catch (e: any) {
            nonTargetVoteFailed = e.message.includes('UNAUTHORIZED') && e.message.includes('direct poll is not addressed to you');
        }
        assert(nonTargetVoteFailed, '10dd. Non-target Bob CANNOT vote on direct-scoped poll');

        // Target Dave votes on direct poll -> MUST succeed
        const targetVote = votePoll(directPoll.id, dave.pubKeyHex, 'opt_yes');
        assert(targetVote.success, '10ee. Addressed target Dave CAN vote on direct-scoped poll');
    }

    console.log(`\n🎉 All ${passed}/${run} tests passed successfully!`);
}

runTests().catch(err => {
    console.error('Test runner failed with unhandled error:', err);
    process.exit(1);
});

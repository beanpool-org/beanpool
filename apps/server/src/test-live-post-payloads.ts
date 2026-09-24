/**
 * What a member socket receives for a listing change, now that the apps apply it instead of re-fetching.
 *
 * The apps write a pushed listing straight into the store their catch-up sync writes (@beanpool/core
 * `livePostChange`), and only when the payload says it is public. So the payload is now data the phone keeps,
 * not a doorbell it throws away, and two things about it matter that did not before:
 *
 *   1. Every public listing change says its audience — `post_removed` included, which carried only an id. A
 *      group or direct removal must be told apart from a public one, because those keep the doorbell.
 *   2. Nothing in it belongs to the author alone. `new_post`, `post_updated` and the poll broadcasts were read for
 *      the AUTHOR (`getPosts(..., viewerPubkey: author)`), so they carried `reachPeers` — which neighbouring
 *      communities the author singled out — to every member socket. `getPosts` gives that to the author only,
 *      and test-listing-reach §12 closed the HTTP board for the same reason; this was the other door.
 *
 * A signed member socket, a second member's socket and a stranger's socket are stood in for with objects on
 * the real broadcast() fan-out (addWsClient), driving the real state-engine write paths.
 *
 * Run: ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-live-post-payloads.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_WS_AUTH;

import crypto from 'node:crypto';
import { livePostChange } from '@beanpool/core';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ FAIL: ${msg}`);
}

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const PEER = '12D3KooWLivePayloadTestPeer000000000';

type Sock = { _memberPubkey: string | null; _openFeed?: boolean; events: any[]; send(m: string): void };
function socket(memberPubkey: string | null): Sock {
    return { _memberPubkey: memberPubkey, events: [], send(m: string) { this.events.push(JSON.parse(m)); } };
}
const last = (s: Sock, type: string) => [...s.events].reverse().find(e => e.type === type);

async function main() {
    console.log('A listing change on the live feed: public says so, and carries nothing that is the author\'s alone...\n');
    const { db } = await import('./db/db.js');
    const se = await import('./state-engine.js');
    se.initStateEngine();

    const member = (callsign: string): string => {
        const pub = crypto.randomBytes(32).toString('hex');
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, avatar_url, status, updated_at)
                    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pub, callsign, AVATAR);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pub);
        return pub;
    };
    const author = member('Ann');
    const watcher = member('Ben');
    const outsider = member('Cat');

    const ann = socket(author);
    const ben = socket(watcher);
    const cat = socket(outsider);
    const stranger = socket(null);
    for (const s of [ann, ben, cat, stranger]) se.addWsClient(s);
    const clear = () => { for (const s of [ann, ben, cat, stranger]) s.events.length = 0; };

    // ── 1. A new public offer ─────────────────────────────────────────────────────────────────────────
    clear();
    const offer = se.createPost('offer', 'food', 'Spare lemons', 'A bag of them', 5, 'fixed', author,
        -28.55, 153.5, undefined, false, undefined, false, { reach: 'peers', reachPeers: [PEER] })!;
    assert(!!offer, '1. setup: the author posts a public offer that names a neighbouring community');
    const created = last(ben, 'new_post');
    assert(created?.post?.id === offer.id && created.post.audienceScope === 'public',
        '1a. another member\'s socket gets the whole listing, marked public');
    assert(created !== undefined && !('reachPeers' in created.post),
        `1b. but NOT which communities the author named (got ${JSON.stringify(created?.post?.reachPeers)}) — that is the author's business, and getPosts gives it to nobody else`);
    assert(created?.post?.reach === 'peers',
        '1c. the listing\'s own reach stays — it is a property of the listing, not a fact about third parties');
    assert(livePostChange(created)?.kind === 'upsert',
        '1d. and it is exactly what the apps apply without fetching (livePostChange accepts it)');
    assert(se.getPosts({ id: offer.id, viewerPubkey: author })[0]?.reachPeers?.[0] === PEER,
        '1e. the author still reads their own list back — the edit form needs it');
    assert(JSON.stringify(last(stranger, 'new_post')) === JSON.stringify({ type: 'new_post' }),
        '1f. a stranger\'s socket still gets only the bare doorbell');

    // ── 2. An edit ────────────────────────────────────────────────────────────────────────────────────
    clear();
    se.updatePost(offer.id, author, { title: 'Spare lemons and limes' });
    const edited = last(ben, 'post_updated');
    assert(edited?.post?.title === 'Spare lemons and limes' && !('reachPeers' in edited.post),
        '2a. post_updated carries the edited listing, without the named communities');
    assert(livePostChange(edited)?.kind === 'upsert', '2b. and the apps apply it');

    // ── 3. Polls: closePoll and votePoll broadcast a row read for the author or the voter ──────────────
    clear();
    const poll = se.createPost('poll', 'general', 'Market day?', 'Pick one', 0, 'fixed', author,
        undefined, undefined, undefined, false, undefined, false,
        { reach: 'peers', reachPeers: [PEER], pollOptions: [{ id: 'a', text: 'Saturday' }, { id: 'b', text: 'Sunday' }], durationDays: 7 })!;
    assert(!!poll && !('reachPeers' in (last(ben, 'new_post')?.post ?? {})), '3a. a new poll\'s broadcast names no communities');
    clear();
    se.votePoll(poll.id, author, 'a');
    const voted = last(ben, 'post_updated');
    assert(voted?.post?.id === poll.id && !('reachPeers' in voted.post),
        `3b. the author voting on their own poll does not broadcast their named communities (got ${JSON.stringify(voted?.post?.reachPeers)})`);
    assert(livePostChange(voted) === null,
        '3c. a poll update stays a doorbell for the apps — it carries the voter\'s own choice, which is not every reader\'s');
    clear();
    se.closePoll(poll.id, author);
    const closed = last(ben, 'post_updated');
    assert(closed?.post?.status === 'completed' && !('reachPeers' in closed.post),
        `3d. closing a poll does not broadcast the author's named communities (got ${JSON.stringify(closed?.post?.reachPeers)})`);

    // ── 4. Removals say their audience ────────────────────────────────────────────────────────────────
    clear();
    assert(se.removePost(offer.id, author), '4. setup: the author removes the offer');
    const removed = last(ben, 'post_removed');
    assert(removed?.id === offer.id && removed.audienceScope === 'public',
        `4a. post_removed names the listing and says it was public (got ${JSON.stringify(removed)})`);
    assert(livePostChange(removed)?.kind === 'remove', '4b. and the apps apply it without fetching');
    assert(JSON.stringify(last(stranger, 'post_removed')) === JSON.stringify({ type: 'post_removed' }),
        '4c. the stranger\'s doorbell stays bare — the new field does not ride on it');

    clear();
    const second = se.createPost('need', 'food', 'Need eggs', 'A dozen', 5, 'fixed', author)!;
    assert(se.adminDeletePost(second.id), '4d. setup: an admin removes a public need');
    const adminRemoved = last(ben, 'post_removed');
    assert(adminRemoved?.id === second.id && adminRemoved.audienceScope === 'public',
        `4e. an admin removal says public too (got ${JSON.stringify(adminRemoved)})`);

    // ── 5. A group's listing keeps the doorbell ───────────────────────────────────────────────────────
    const group = se.createGroup({ name: 'Garden club', createdBy: author, joinPolicy: 'open' });
    se.joinGroup(group.id, watcher);
    clear();
    const groupOffer = se.createPost('offer', 'food', 'Seedlings', 'Tomatoes', 2, 'fixed', author,
        undefined, undefined, undefined, false, undefined, false, { audienceScope: 'group', targetGroupId: group.id })!;
    const groupCreated = last(ben, 'new_post');
    assert(groupCreated?.post?.id === groupOffer.id && groupCreated.post.audienceScope === 'group',
        '5a. a group member gets the group listing, marked group');
    assert(livePostChange(groupCreated) === null, '5b. which the apps leave to their catch-up sync');
    assert(last(cat, 'new_post') === undefined, '5c. and a member outside the group gets nothing');
    clear();
    assert(se.deleteGroupPost(group.id, author, groupOffer.id), '5d. setup: the convenor deletes it');
    const groupRemoved = last(ben, 'post_removed');
    assert(groupRemoved?.id === groupOffer.id && groupRemoved.audienceScope === 'group',
        `5e. the group's removal says group (got ${JSON.stringify(groupRemoved)})`);
    assert(livePostChange(groupRemoved) === null, '5f. and stays a doorbell');

    clear();
    const groupNeed = se.createPost('need', 'food', 'Need mulch', 'A trailer load', 2, 'fixed', author,
        undefined, undefined, undefined, false, undefined, false, { audienceScope: 'group', targetGroupId: group.id })!;
    assert(se.removePost(groupNeed.id, author), '5g. setup: the author removes a group listing');
    const authorGroupRemoved = last(ben, 'post_removed');
    assert(authorGroupRemoved?.audienceScope === 'group' && livePostChange(authorGroupRemoved) === null,
        `5h. says group, stays a doorbell (got ${JSON.stringify(authorGroupRemoved)})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ A listing change on the live feed says who it is for and carries nothing that is the author\'s alone.');
}

main().then(() => process.exit(0)).catch(e => { console.error('\n❌ Test failed:', e); process.exit(1); });

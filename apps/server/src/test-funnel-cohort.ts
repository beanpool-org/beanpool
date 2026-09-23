/**
 * The onboarding funnel's COHORT: the people who joined here in the window, and how far
 * those same people have got since.
 *
 * The bug this exists to stop coming back: the old screen put four numbers about four
 * DIFFERENT groups of people in one column and drew a funnel through them. "Actually got
 * started" counted anyone who first posted inside the window, including people who joined
 * months earlier — so a community with no new members at all could report that more people
 * got started than ever joined.
 *
 * Proves:
 *   1. Every member who joined in the window is counted once, dated by their JOIN day, and
 *      the photo and posted rows are subsets of that same group — so neither can exceed it.
 *   2. A real photo counts, no photo does not, and one of this node's own `/api/avatar/…`
 *      URLs round-tripped back into the column counts as NO photo. That last one is not a
 *      hypothetical: installed builds posted it back on every profile save (#1047), and a
 *      funnel that read it as a photo would report a community as fully photographed while
 *      every one of those members sees their initials.
 *   3. Somebody who joined BEFORE the window is absent even if they posted inside it. A
 *      cohort is a group of people, not a span of activity.
 *   4. Federation visitors and the genesis operator are not in the cohort.
 *   5. The response carries counts only — no public key, in any row, ever (M2).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-funnel-cohort.ts
 */
import { initStateEngine } from './state-engine.js';
import { getFunnel } from './engine/funnel.js';
import { db } from './db/db.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

/** The window every assertion below is made against. */
const WINDOW_DAYS = 3;

function daysAgo(n: number): string {
    return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

function total(event: string): number {
    return getFunnel(WINDOW_DAYS)
        .filter(r => r.event === event)
        .reduce((n, r) => n + r.count, 0);
}

function onDay(event: string, day: string): number {
    return getFunnel(WINDOW_DAYS)
        .filter(r => r.event === event && r.day === day)
        .reduce((n, r) => n + r.count, 0);
}

function addMember(
    key: string, callsign: string, joinedAt: string, avatar: string | null,
    opts: { homeNode?: string | null; inviteCode?: string } = {},
): void {
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, avatar_url, home_node_url)
                VALUES (?, ?, ?, 'seed', ?, ?, ?)`)
        .run(key, callsign, joinedAt, opts.inviteCode ?? 'x', avatar, opts.homeNode ?? null);
}

function addPost(id: string, author: string, at: string, originNode: string | null = null): void {
    db.prepare(
        `INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, status, origin_node)
         VALUES (?, 'offer', 'general', ?, '', 0, ?, ?, 'active', ?)`
    ).run(id, id, author, at, originNode);
}

async function main(): Promise<void> {
    initStateEngine();

    // Whatever a fresh node seeds itself with is the baseline. Every assertion below is a
    // delta from it, so this test says the same thing whether or not the fixture came with an
    // operator row already in place.
    const baseJoined = total('member_created');
    const basePhoto = total('cohort_photo');
    const basePosted = total('cohort_posted');

    const yesterday = daysAgo(1);
    const yesterdayDay = yesterday.slice(0, 10);

    // ---------- the cohort: five people who joined yesterday ----------
    const withPhoto = 'a'.repeat(64);
    const withoutPhoto = 'b'.repeat(64);
    const selfUrlAvatar = 'c'.repeat(64);
    const poster = 'd'.repeat(64);
    const bundled = 'e'.repeat(64);

    addMember(withPhoto, 'HasAPhoto', yesterday, 'data:image/png;base64,AAAA');
    addMember(withoutPhoto, 'NoPhoto', yesterday, null);
    // What an installed build posted back to the node as its own avatar (#1047). It is a link
    // to us, not an image: `GET /api/avatar/<pk>` on it 404s, and the member sees initials.
    addMember(selfUrlAvatar, 'SelfLink', yesterday, `/api/avatar/${selfUrlAvatar}?size=thumb&v=deadbeef`);
    addMember(poster, 'Poster', yesterday, 'data:image/png;base64,BBBB');
    addMember(bundled, 'BundledPic', yesterday, 'bundled://avatars/goat.png');

    addPost('cohort-post-1', poster, yesterday);
    // A second post by the same person is the same person, not a second one.
    addPost('cohort-post-2', poster, new Date().toISOString());

    assert(onDay('member_created', yesterdayDay) === 5, 'everyone who joined that day is counted once, on their join day');
    assert(onDay('cohort_photo', yesterdayDay) === 3,
        'a data: photo and a bundled asset count as photos; no avatar and a self-URL do not');
    assert(onDay('cohort_posted', yesterdayDay) === 1, 'two posts by one member is one person who has posted');

    // The three rows describe ONE group, so the follow-ups are subsets by construction.
    assert(total('cohort_photo') <= total('member_created') && total('cohort_posted') <= total('member_created'),
        'neither follow-up row can exceed the group it is drawn from');

    // ---------- somebody who joined before the window ----------
    // This is the old "Actually got started" bug in one assertion: they post INSIDE the
    // window, so the old activation row counted them, but they are not one of the people who
    // joined in it.
    const oldTimer = 'f'.repeat(64);
    addMember(oldTimer, 'JoinedAgesAgo', daysAgo(90), 'data:image/png;base64,CCCC');
    addPost('old-timer-post', oldTimer, new Date().toISOString());

    assert(total('member_created') === baseJoined + 5,
        'a member who joined before the window is not in the cohort');
    assert(total('cohort_photo') === basePhoto + 3, '...and their photo is not in it either');
    assert(total('cohort_posted') === basePosted + 1,
        '...nor their post, even though they posted inside the window');

    // ---------- federation visitors and genesis ----------
    const visitor = '1'.repeat(64);
    addMember(visitor, 'VisitingTrader', yesterday, 'data:image/png;base64,DDDD', { homeNode: 'https://peer.example.org' });
    addPost('visitor-post', visitor, yesterday);
    assert(total('member_created') === baseJoined + 5
        && total('cohort_photo') === basePhoto + 3
        && total('cohort_posted') === basePosted + 1,
        'a visitor from a peer node is in none of the three cohort rows');

    const genesis = '2'.repeat(64);
    addMember(genesis, 'TheOperator', yesterday, 'data:image/png;base64,EEEE', { inviteCode: 'genesis' });
    addPost('genesis-post', genesis, yesterday);
    assert(total('member_created') === baseJoined + 5
        && total('cohort_photo') === basePhoto + 3
        && total('cohort_posted') === basePosted + 1,
        'the operator seeding themselves is not somebody joining');

    // A federated post by a cohort member is not them getting started here.
    addPost('federated-post', withPhoto, yesterday, 'https://peer.example.org');
    assert(total('cohort_posted') === basePosted + 1, 'a post that arrived by federation is not a local first post');

    // ---------- M2: counts only ----------
    const payload = JSON.stringify(getFunnel(WINDOW_DAYS));
    assert(!/[0-9a-f]{64}/i.test(payload),
        'no row carries anything shaped like a public key — the funnel is counts, not a trail');
    assert(getFunnel(WINDOW_DAYS).every(r =>
        Object.keys(r).sort().join(',') === 'count,day,event,variant'),
        'every row is exactly (day, event, variant, count)');
    assert(getFunnel(WINDOW_DAYS).every(r => r.count > 0), 'no row is reported with a zero count');

    console.log(`\n${passed}/${run} passed`);
    // Explicit exit, as the other test-*.ts do: initStateEngine leaves handles open.
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });

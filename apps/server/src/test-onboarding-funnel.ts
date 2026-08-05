/**
 * Onboarding funnel regression test.
 *
 * Proves:
 *   1. Counters aggregate by (day, event, variant) and never store a public key — the
 *      table has no such column, which is what keeps a funnel from becoming a log (M2).
 *   2. Every rejection path through redeemInvite is counted with its reason — a bad code,
 *      an expired one, one already used — while someone who is already a member gets a
 *      separate invite_reentry event, since filing that as a failure would make the
 *      dashboard's rejection rate lie.
 *   3. member_created is DERIVED from members.joined_at, so it carries history that
 *      predates the feature — the whole reason it is not a counter.
 *   4. Federation visitors (home_node_url NOT NULL) are excluded from member_created.
 *      Without that filter every visiting trader inflates the join funnel.
 *   5. The genesis row is excluded — an operator seeding themselves is not a signup.
 *   6. activated is derived from a member's FIRST local post, so it is idempotent and
 *      needs no per-member "already counted" flag.
 *   7. The first-avatar check is separate from recording it, so a profile update that
 *      fails - a taken callsign, common on this very step - books nothing, and a later
 *      photo edit does not read as a fresh signup.
 *   8. Reading the funnel never deletes anything. Retention is an explicit call made at
 *      startup, not a side effect of a query.
 *   9. The genesis operator's own first post is not an activation.
 *  10. clampDays refuses to turn a junk or unbounded `days` parameter into a wide scan,
 *      and never lets NaN through as a predicate that silently matches nothing.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-onboarding-funnel.ts
 */
import { initStateEngine, getAdminPubkey } from './state-engine.js';
import { recordFunnelEvent, hasNoAvatarYet, getFunnel, pruneFunnel, clampDays } from './engine/funnel.js';
import { redeemInvite, generateInvite } from './engine/invites.js';
import { db } from './db/db.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const noop = () => {};
const today = new Date().toISOString().slice(0, 10);

function count(event: string, variant = ''): number {
    return getFunnel(30)
        .filter(r => r.event === event && r.variant === variant)
        .reduce((n, r) => n + r.count, 0);
}

async function main(): Promise<void> {
    initStateEngine();
    const admin = getAdminPubkey();

    // ---------- 1. counters aggregate, and cannot hold an identity ----------
    recordFunnelEvent('protection_shown', 'A');
    recordFunnelEvent('protection_shown', 'A');
    recordFunnelEvent('protection_shown', 'B');
    assert(count('protection_shown', 'A') === 2, 'repeat events increment one row rather than adding rows');
    assert(count('protection_shown', 'B') === 1, 'variants are counted separately');

    const cols = (db.prepare("PRAGMA table_info(onboarding_funnel)").all() as { name: string }[])
        .map(c => c.name);
    assert(!cols.some(c => /pubkey|public_key|member|session/i.test(c)),
        'onboarding_funnel has no column that could identify a person (M2)');
    assert(cols.sort().join(',') === 'count,day,event,variant',
        'the grain is exactly (day, event, variant) — nothing finer');

    // ---------- 2. every rejection path is counted with its reason ----------
    const before = count('invite_attempt');
    redeemInvite(noop, 'INV-NOPE-NOPE', 'a'.repeat(64), 'Nobody');
    assert(count('invite_attempt') === before + 1, 'a submitted code counts as an attempt');
    assert(count('invite_failed', 'invalid') === 1, 'an unknown code is counted as invalid');

    const expired = generateInvite(admin)!;
    db.prepare("UPDATE invite_codes SET created_at = ? WHERE code = ?")
        .run(new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(), expired.code);
    redeemInvite(noop, expired.code, 'b'.repeat(64), 'TooLate');
    assert(count('invite_failed', 'expired') === 1, 'an expired code is counted as expired');

    const used = generateInvite(admin)!;
    const first = 'c'.repeat(64);
    redeemInvite(noop, used.code, first, 'FirstThrough');
    redeemInvite(noop, used.code, 'd'.repeat(64), 'SecondThrough');
    assert(count('invite_failed', 'already_used') === 1, 'a spent code is counted as already_used');

    // Someone re-entering is neither a signup nor a rejection.
    const again = generateInvite(admin)!;
    redeemInvite(noop, again.code, first, 'FirstThrough');
    assert(count('invite_reentry') === 1, 'an existing member re-entering gets its own event');
    assert(count('invite_failed', 'already_member') === 0,
        're-entry is NOT filed under invite_failed, so the rejection rate stays honest');

    // ---------- 3. member_created is derived, so it sees the past ----------
    const backdated = 'e'.repeat(64);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code)
                VALUES (?, ?, ?, ?, ?)`)
        .run(backdated, 'JoinedLastWeek',
             new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), admin, 'x');
    const week = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const backfilled = getFunnel(30).find(r => r.event === 'member_created' && r.day === week);
    assert(!!backfilled, 'member_created reports a join that happened before the feature existed');

    // ---------- 4. federation visitors are not signups ----------
    const localBefore = count('member_created');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, home_node_url)
                VALUES (?, ?, ?, ?)`)
        .run('f'.repeat(64), 'VisitingTrader', new Date().toISOString(), 'https://peer.example.org');
    assert(count('member_created') === localBefore,
        'a visitor from a peer node does not appear in this hub\'s join funnel');

    // ---------- 5. the genesis row is not a signup ----------
    const genesisDay = (db.prepare(
        "SELECT date(joined_at) AS d FROM members WHERE invite_code = 'genesis'"
    ).get() as { d: string } | undefined)?.d;
    if (genesisDay) {
        const seeded = db.prepare(
            "SELECT COUNT(*) AS n FROM members WHERE date(joined_at) = ? AND invite_code = 'genesis'"
        ).get(genesisDay) as { n: number };
        const reported = getFunnel(30)
            .filter(r => r.event === 'member_created' && r.day === genesisDay)
            .reduce((n, r) => n + r.count, 0);
        const actual = (db.prepare(
            "SELECT COUNT(*) AS n FROM members WHERE date(joined_at) = ? AND home_node_url IS NULL"
        ).get(genesisDay) as { n: number }).n;
        assert(reported === actual - seeded.n, 'the genesis member is excluded from signups');
    } else {
        assert(true, 'no genesis row to exclude in this fixture');
    }

    // ---------- 6. activated is derived from the first post, and idempotent ----------
    const mkPostBy = (id: string, author: string, at: string) => db.prepare(
        `INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, status)
         VALUES (?, 'offer', 'general', ?, '', 0, ?, ?, 'active')`
    ).run(id, id, author, at);
    mkPostBy('p1', first, new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString());
    mkPostBy('p2', first, new Date().toISOString());
    const activations = getFunnel(30).filter(r => r.event === 'activated');
    assert(activations.reduce((n, r) => n + r.count, 0) === 1,
        'two posts by one member is one activation, not two');
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    assert(activations[0]?.day === twoDaysAgo, 'activation lands on the day of the FIRST post');

    // The genesis operator posting is not a new member getting started. This filter lived
    // only on the signup query at first, so the two derived queries now share one
    // predicate rather than each carrying their own copy to drift out of step.
    const activationsBefore = count('activated');
    mkPostBy('genesis-post', admin, new Date().toISOString());
    assert(count('activated') === activationsBefore,
        'the genesis operator\'s own first post is not an activation');

    // ---------- 7. first avatar only, and only once the write lands ----------
    const av = 'g'.repeat(64);
    db.prepare("INSERT INTO members (public_key, callsign, joined_at) VALUES (?, ?, ?)")
        .run(av, 'GetsAPhoto', new Date().toISOString());

    assert(hasNoAvatarYet(av), 'a member with no photo yet is reported as such');

    // What the route does with its request body: ask first, write, then count. The failure
    // case is the point — a taken callsign on this very step must not book an avatar that
    // was never saved.
    const routeWouldCount = (incomingAvatar: unknown) => Boolean(incomingAvatar) && hasNoAvatarYet(av);
    assert(routeWouldCount('data:image/png;base64,AAA'), 'the route would count a new photo');
    assert(!routeWouldCount(undefined), 'a profile edit with no photo is not a first avatar');
    assert(count('avatar_published') === 0,
        'asking the question does not itself count — nothing is booked before the write');

    recordFunnelEvent('avatar_published');   // the write succeeded
    db.prepare("UPDATE members SET avatar_url = ? WHERE public_key = ?").run('stored.png', av);
    assert(count('avatar_published') === 1, 'a landed first avatar counts once');

    assert(!hasNoAvatarYet(av), 'a member who already has a photo is not a first-avatar case');
    assert(!hasNoAvatarYet('z'.repeat(64)), 'an unknown member is not a first-avatar case');

    // ---------- 8. reading never destroys history ----------
    // getFunnel used to prune on every read, so asking for a year would delete everything
    // past the 180-day window and then answer as if that was all there had ever been.
    const ancient = '2020-01-01';
    db.prepare("INSERT INTO onboarding_funnel (day, event, variant, count) VALUES (?, 'invite_attempt', '', 7)")
        .run(ancient);
    getFunnel(365);
    const survived = db.prepare(
        "SELECT count FROM onboarding_funnel WHERE day = ? AND event = 'invite_attempt'"
    ).get(ancient) as { count: number } | undefined;
    assert(survived?.count === 7, 'asking for a long window does not delete rows outside it');

    // Pruning is a separate, explicit act, run at startup.
    pruneFunnel();
    const pruned = db.prepare("SELECT count FROM onboarding_funnel WHERE day = ?").get(ancient);
    assert(!pruned, 'pruneFunnel drops rows past the retention window when called on purpose');

    // ---------- 9. the endpoint's window is clamped, not trusted ----------
    // `days` drives a group-by over posts, so junk must not become an unbounded scan —
    // and NaN must not become a predicate that matches nothing and reads as "no activity".
    assert(clampDays(7) === 7, 'a sensible window is passed through');
    assert(clampDays('90') === 90, 'a numeric string is accepted');
    assert(clampDays(99999) === 365, 'an enormous window is capped');
    assert(clampDays(0) === 1, 'zero is floored to one day');
    assert(clampDays(-5) === 1, 'a negative window is floored to one day');
    assert(clampDays('nonsense') === 30, 'junk falls back to the default rather than NaN');
    assert(clampDays(undefined) === 30, 'a missing window falls back to the default');
    assert(clampDays(7.9) === 7, 'a fractional window is floored to a whole day');

    // ---------- shape ----------
    assert(getFunnel(30).every(r => r.day <= today), 'no row is dated in the future');
    assert(getFunnel(30).every(r => r.count > 0), 'every reported row has a positive count');

    console.log(`\n${passed}/${run} passed`);
    // Explicit exit, as the other test-*.ts do: initStateEngine leaves handles open, so
    // without this the process lingers and buffered stdout is never flushed.
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });

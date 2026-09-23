/**
 * Event reminders — "Your events", each person's own reminders, and delivery that never double-sends
 * (docs/events-on-the-map.md §2.2; board decision 2026-09-23, "all four, with reminders each person can set").
 *
 * Every check drives the sweep with an EXPLICIT `nowMs` and arms each RSVP by writing its `updated_at`, so
 * the suite runs in milliseconds and the time arithmetic is the thing under test rather than the wall clock.
 * The events themselves are created with real future start times, because `createPost` refuses an event in
 * the past — so "T+9 days" below is nine real days ahead of the moment the suite starts, and the fake clock
 * is a point we choose to stand at, not a lie we tell the database.
 *
 *  1. The default `[1440]` fires ONCE at T−1 day, and not again after a restart.
 *  2. A per-event choice overrides the default, and `null` gives the default back.
 *  3. `[]` is off.
 *  4. An offset whose moment had already passed when the member RSVPed, or when they chose it, is skipped.
 *  5. A time change re-arms the offsets still ahead and stays silent for the ones now behind.
 *  6. Nothing for a cancelled event, an ended event, a withdrawn RSVP, or Marketplace notifications off.
 *  7. A backup node sends nothing.
 *  8. "Your events" is the signer's own RSVPs, soonest first, without the cancelled and the ended.
 *  9. A reminder cannot be set on an event the member has no RSVP on, and the offsets are a closed set.
 * 10. Every reminder body is the same sentence whatever timezone the process runs in.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-event-reminders.ts
 */

// The footing every check starts from: check 10 moves it on purpose and puts it back. Set before any Date.
process.env.TZ = 'UTC';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { db } from './db/db.js';
import { initStateEngine } from './state-engine.js';
import { setNodeRole } from './engine/sync.js';
import {
    createPost as createPostEngine, updatePost, removePost, rsvpEvent,
} from './engine/posts.js';
import {
    runEventReminderSweep, tickEventReminders, setEventReminderOffsets, listMyEvents,
    parseReminderOffsets, setMemberDefaultReminderOffsets, getMemberDefaultReminderOffsets,
    reminderPushTitle, reminderPushBody, NO_RSVP_MESSAGE, DEFAULT_EVENT_REMINDER_OFFSETS,
    EVENT_REMINDER_OFFSETS,
} from './engine/event-reminders.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ FAIL: ${msg}`);
}

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The instant the suite started. Every event time and every fake clock reading is relative to it. */
const T0 = Date.now();
const at = (ms: number) => new Date(T0 + ms).toISOString();

function makeMember(callsign: string): string {
    const pub = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, avatar_url, status, updated_at)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
        .run(pub, callsign, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pub);
    return pub;
}

const broadcasts: any[] = [];
const capture = (event: any) => { broadcasts.push(event); };

interface PushCall { targets: string[]; actor: string; title: string; body: string; data: any; category: string }
let pushes: PushCall[] = [];
const pushSpy = (targets: string[], actor: string, title: string, body: string, data: any, category: any) => {
    pushes.push({ targets, actor, title, body, data, category });
};

/**
 * An event starting `startMs` after the suite began, two hours long.
 *
 * A FRESH host each time, because a member may only have five upcoming events at once — a real rule
 * (posts.ts), and not one this suite is here to exercise. `post.authorPublicKey` is the host when a check
 * needs to edit or cancel what it made.
 */
let hostSeq = 0;
function newEvent(startMs: number, title = 'Working bee', photos: string[] = [PHOTO]) {
    const author = makeMember(`Host${++hostSeq}`);
    return createPostEngine(capture, 'event', 'other', title, 'Bring gloves', 0, 'fixed', author,
        -28.55, 153.5, photos, false, undefined, true,
        { eventStartAt: at(startMs), eventEndAt: at(startMs + 2 * HOUR), eventPlaceName: 'The old bowls club' } as any)!;
}

/**
 * RSVP, then stamp WHEN it happened.
 *
 * `rsvpEvent` writes the real clock, and "was this offset still ahead when they said yes?" is the rule
 * under test — so the suite has to be able to say that somebody RSVPed nine days from now.
 */
function rsvpAt(postId: string, member: string, status: 'going' | 'interested', armedMs: number) {
    rsvpEvent(capture, postId, member, status);
    db.prepare('UPDATE event_rsvps SET updated_at = ? WHERE post_id = ? AND member_pubkey = ?')
        .run(at(armedMs), postId, member);
}

/**
 * Milliseconds from T0 to 22:00 UTC, `days` days ahead — 08:00 the NEXT morning in Sydney.
 *
 * The hour and the calendar day both differ between the two zones at that instant, which is what makes it
 * the instant to test a reminder's words against.
 */
function eveningUtcStart(days: number): number {
    const d = new Date(T0 + days * DAY);
    d.setUTCHours(22, 0, 0, 0);
    return d.getTime() - T0;
}

/** Run one sweep at a chosen moment and hand back the pushes it made. */
function sweepAt(ms: number): PushCall[] {
    pushes = [];
    runEventReminderSweep(pushSpy, T0 + ms);
    return pushes;
}

const sentMarks = (postId: string): number[] =>
    (db.prepare('SELECT offset_min FROM event_reminders_sent WHERE post_id = ? ORDER BY offset_min')
        .all(postId) as any[]).map(r => r.offset_min);

async function main(): Promise<void> {
    initStateEngine();

    const goer = makeMember('Goer');
    const other = makeMember('Other');

    // ── 1. The default fires once, and only once ─────────────────────────────────────────────
    console.log('\n--- 1. The default, once ---');
    const ev = newEvent(10 * DAY);
    rsvpAt(ev.id, goer, 'going', 0);

    assert(getMemberDefaultReminderOffsets(goer).join() === DEFAULT_EVENT_REMINDER_OFFSETS.join(),
        'a member who has never chosen gets the day-before default');

    assert(sweepAt(5 * DAY).length === 0, 'nothing is sent five days out, when no offset has come round');

    const first = sweepAt(9 * DAY);
    assert(first.length === 1, 'the day-before reminder fires at T−1 day');
    assert(first[0]?.targets.join() === goer, '...to the member who RSVPed');
    assert(first[0]?.category === 'marketplace', '...on the existing Marketplace push category');
    assert(first[0]?.data?.screen === 'post' && first[0]?.data?.postId === ev.id,
        '...carrying the payload the phone routes to /post/:id');
    assert(first[0]?.title === reminderPushTitle('Working bee'), '...titled with the event');
    assert(first[0]?.body === 'Starts in 1 day',
        `...and saying how long there is left, in words no timezone can shift (got "${first[0]?.body}")`);

    assert(sentMarks(ev.id).join() === '1440', 'the send is marked in event_reminders_sent');
    assert(sweepAt(9 * DAY).length === 0, 'the same sweep run again sends nothing');
    assert(sweepAt(9 * DAY + 2 * MIN).length === 0,
        'and a minute later — the mark, not an in-memory flag, is what stops it, so a restart cannot double-send');

    // The one thing a restart would clear is process memory. Nothing here lives there: drop the mark and
    // the reminder comes back, which is the proof that the table alone is holding the line.
    db.prepare('DELETE FROM event_reminders_sent WHERE post_id = ?').run(ev.id);
    assert(sweepAt(9 * DAY + 2 * MIN).length === 1, 'with the mark removed it would fire again — the mark is the whole mechanism');

    // And a mark written by something OTHER than a sweep — a node that got half way through before it was
    // killed, say — stops the next sweep just as flatly. Nothing in the process has to remember anything.
    const evMarked = newEvent(15 * DAY, 'Already told');
    rsvpAt(evMarked.id, goer, 'going', 0);
    db.prepare(`INSERT INTO event_reminders_sent (post_id, member_pubkey, offset_min, sent_at) VALUES (?, ?, 1440, ?)`)
        .run(evMarked.id, goer, at(14 * DAY));
    assert(sweepAt(14 * DAY).length === 0, 'a reminder already marked sent is never sent again');

    // ── 2. A per-event choice, and null ──────────────────────────────────────────────────────
    console.log('\n--- 2. Per event beats the default ---');
    const ev2 = newEvent(20 * DAY, 'Seed swap');
    rsvpAt(ev2.id, goer, 'going', 0);
    setEventReminderOffsets(ev2.id, goer, [120]);
    // setEventReminderOffsets bumps updated_at to the real clock — re-arm it to T0 so the choice counts as
    // having been made before the moments under test.
    db.prepare('UPDATE event_rsvps SET updated_at = ? WHERE post_id = ? AND member_pubkey = ?')
        .run(at(0), ev2.id, goer);

    assert(sweepAt(19 * DAY).length === 0, 'the default no longer fires once this event has its own choice');
    const twoHours = sweepAt(20 * DAY - 2 * HOUR);
    assert(twoHours.length === 1 && twoHours[0]?.body === 'Starts in 2 hours',
        `the chosen 2-hour reminder fires instead (got "${twoHours[0]?.body}")`);

    const ev3 = newEvent(30 * DAY, 'Repair café');
    rsvpAt(ev3.id, goer, 'going', 0);
    setEventReminderOffsets(ev3.id, goer, [30]);
    setEventReminderOffsets(ev3.id, goer, null);
    db.prepare('UPDATE event_rsvps SET updated_at = ? WHERE post_id = ? AND member_pubkey = ?')
        .run(at(0), ev3.id, goer);
    assert((db.prepare('SELECT reminder_offsets AS o FROM event_rsvps WHERE post_id = ? AND member_pubkey = ?')
        .get(ev3.id, goer) as any).o === null, 'null clears the per-event choice back to NULL in the row');
    assert(sweepAt(30 * DAY - 30 * MIN).length === 0, 'and the cleared 30-minute choice does not fire');
    assert(sweepAt(29 * DAY).length === 1, '...while the member default fires again at T−1 day');

    // ── 3. Empty means off ───────────────────────────────────────────────────────────────────
    console.log('\n--- 3. Off ---');
    const ev4 = newEvent(40 * DAY, 'Bush regen');
    rsvpAt(ev4.id, goer, 'going', 0);
    setEventReminderOffsets(ev4.id, goer, []);
    db.prepare('UPDATE event_rsvps SET updated_at = ? WHERE post_id = ? AND member_pubkey = ?')
        .run(at(0), ev4.id, goer);
    assert(sweepAt(39 * DAY).length === 0, 'an empty list means no reminders for this event');

    // A member whose SETTINGS default is empty hears nothing anywhere.
    const quiet = makeMember('Quiet');
    setMemberDefaultReminderOffsets(quiet, []);
    const ev5 = newEvent(50 * DAY, 'Market day');
    rsvpAt(ev5.id, quiet, 'interested', 0);
    assert(sweepAt(49 * DAY).length === 0, 'and an empty Settings default means none at all');
    assert(getMemberDefaultReminderOffsets(quiet).length === 0, '...which reads back as empty, not as the [1440] default');

    // ── 4. Already past when they chose it ───────────────────────────────────────────────────
    console.log('\n--- 4. Already past at RSVP time ---');
    const ev6 = newEvent(60 * DAY, 'Long-planned fête');
    // They RSVP two days before it starts, asking for the week-before reminder. That moment is five days
    // gone; it must not fire, now or at the next sweep.
    rsvpAt(ev6.id, goer, 'going', 58 * DAY);
    setEventReminderOffsets(ev6.id, goer, [10080, 1440]);
    db.prepare('UPDATE event_rsvps SET updated_at = ? WHERE post_id = ? AND member_pubkey = ?')
        .run(at(58 * DAY), ev6.id, goer);
    assert(sweepAt(58 * DAY).length === 0, 'the week-before offset, already past when they RSVPed, is skipped');
    assert(sweepAt(58 * DAY + 5 * MIN).length === 0, '...and is not waiting to fire on the next sweep either');
    assert(sweepAt(59 * DAY).length === 1, 'the day-before offset, still ahead of them, fires normally');

    // The case the grace window CANNOT cover, and the reason the armed-at check exists on its own: a member
    // who RSVPs five minutes after a moment went by. It is inside the window — a sweep a minute later is
    // looking straight at it — and it must still stay quiet, because it was already behind them when they
    // said yes.
    const ev6b = newEvent(65 * DAY, 'Joined a moment late');
    rsvpAt(ev6b.id, goer, 'going', 64 * DAY + 5 * MIN);
    assert(sweepAt(64 * DAY + 6 * MIN).length === 0,
        'an offset that went by five minutes before the RSVP stays quiet, though it is well inside the grace window');

    // Same again for CHOOSING the offset rather than RSVPing: the write bumps updated_at, so picking
    // "the day before" after that day has begun is a choice for next time, not a reminder now.
    const ev6c = newEvent(70 * DAY, 'Chose it a moment late');
    rsvpAt(ev6c.id, goer, 'going', 0);
    setEventReminderOffsets(ev6c.id, goer, [1440]);
    db.prepare('UPDATE event_rsvps SET updated_at = ? WHERE post_id = ? AND member_pubkey = ?')
        .run(at(69 * DAY + 5 * MIN), ev6c.id, goer);
    assert(sweepAt(69 * DAY + 6 * MIN).length === 0,
        '...and one CHOSEN five minutes after its moment stays quiet too');

    // ── 5. The host moves the time ───────────────────────────────────────────────────────────
    console.log('\n--- 5. A time change ---');
    const ev7 = newEvent(70 * DAY, 'Hall meeting');
    rsvpAt(ev7.id, goer, 'going', 0);
    // Pushed out three days: the day-before reminder should follow the event, not the original date.
    updatePost(capture, ev7.id, ev7.authorPublicKey, { eventStartAt: at(73 * DAY) } as any, pushSpy);
    db.prepare('UPDATE event_rsvps SET updated_at = ? WHERE post_id = ? AND member_pubkey = ?')
        .run(at(0), ev7.id, goer);
    assert(sweepAt(69 * DAY).length === 0, 'the reminder does not fire on the OLD date after the event moved');
    const rearmed = sweepAt(72 * DAY);
    assert(rearmed.length === 1 && rearmed[0]?.body === 'Starts in 1 day',
        're-arms against the new time and fires a day before THAT');

    // A start pulled backwards puts a moment in the past. It stays silent rather than arriving stale.
    const ev8 = newEvent(90 * DAY, 'Big one');
    rsvpAt(ev8.id, goer, 'going', 0);
    setEventReminderOffsets(ev8.id, goer, [10080]);
    db.prepare('UPDATE event_rsvps SET updated_at = ? WHERE post_id = ? AND member_pubkey = ?')
        .run(at(0), ev8.id, goer);
    updatePost(capture, ev8.id, ev8.authorPublicKey, { eventStartAt: at(85 * DAY) } as any, pushSpy);
    // The week-before moment is now T+78d — six days behind a sweep standing at T+84d, and after the
    // moment they RSVPed. Only the grace window keeps it quiet, which is the point of the window.
    assert(sweepAt(84 * DAY).length === 0, 'an offset the time change left in the past stays silent');
    assert(sweepAt(78 * DAY + 1 * MIN).length === 1,
        '...while the same offset, swept when it actually comes round, does fire');

    // ── 6. Cancelled, ended, withdrawn, and switched off ─────────────────────────────────────
    console.log('\n--- 6. Nothing to send ---');
    const cancelled = newEvent(100 * DAY, 'Called off');
    rsvpAt(cancelled.id, goer, 'going', 0);
    removePost(capture, cancelled.id, cancelled.authorPublicKey, pushSpy);
    assert(sweepAt(99 * DAY).length === 0, 'a cancelled event reminds nobody');

    const ended = newEvent(110 * DAY, 'Over and done');
    rsvpAt(ended.id, goer, 'going', 0);
    assert(sweepAt(110 * DAY + HOUR).length === 0, 'an event already under way reminds nobody');
    assert(sweepAt(112 * DAY).length === 0, '...nor does one that has ended');

    const withdrawn = newEvent(120 * DAY, 'Changed my mind');
    rsvpAt(withdrawn.id, goer, 'going', 0);
    rsvpEvent(capture, withdrawn.id, goer, null);
    assert(sweepAt(119 * DAY).length === 0, 'a withdrawn RSVP reminds nobody');

    // ── 7. A backup node sends nothing ───────────────────────────────────────────────────────
    console.log('\n--- 7. Role ---');
    const onBackup = newEvent(130 * DAY, 'Mirrored');
    rsvpAt(onBackup.id, goer, 'going', 0);
    setNodeRole('backup');
    pushes = [];
    const claimedOnBackup = tickEventReminders(pushSpy, T0 + 129 * DAY);
    assert(claimedOnBackup === 0 && pushes.length === 0, 'a backup node sends no reminders');
    assert(sentMarks(onBackup.id).length === 0, '...and marks nothing as sent, so the primary still will');
    setNodeRole('primary');
    assert(tickEventReminders(pushSpy, T0 + 129 * DAY) === 1, 'the primary sends the one the backup left alone');

    // ── 8. "Your events" ─────────────────────────────────────────────────────────────────────
    console.log('\n--- 8. Your events ---');
    const soon = newEvent(3 * DAY, 'Soonest');
    const later = newEvent(6 * DAY, 'Later');
    const notMine = newEvent(4 * DAY, 'Someone else’s');
    const offList = newEvent(5 * DAY, 'Called off too');
    const noPhoto = newEvent(7 * DAY, 'No photo', []);
    // A member of their own, so the list is exactly what this section RSVPed to and nothing the sections
    // above left lying around.
    const planner = makeMember('Planner');
    rsvpAt(later.id, planner, 'going', 0);
    rsvpAt(soon.id, planner, 'interested', 0);
    rsvpAt(offList.id, planner, 'going', 0);
    rsvpAt(noPhoto.id, planner, 'going', 0);
    rsvpAt(notMine.id, other, 'going', 0);
    removePost(capture, offList.id, offList.authorPublicKey, pushSpy);

    const mine = listMyEvents(planner, T0);
    assert(mine.map(e => e.title).join() === 'Soonest,Later,No photo',
        `"Your events" is soonest first, without the cancelled (got ${mine.map(e => e.title).join()})`);
    assert(!mine.some(e => e.postId === notMine.id), '...and never somebody else’s RSVP');
    assert(mine[0]?.rsvp === 'interested' && mine[1]?.rsvp === 'going', '...carrying each RSVP as it stands');
    assert(mine[0]?.placeName === 'The old bowls club' && mine[0]?.startAt === at(3 * DAY),
        '...with the place and the start time');
    assert(typeof mine[0]?.photo === 'string' && mine[0]!.photo!.startsWith(`/api/marketplace/posts/${soon.id}/photos/0?v=`),
        '...and the same photo URL the event card resolves');
    assert(mine[2]?.photo === null, 'an event with no photo says so rather than inventing a URL');
    assert(mine[0]?.reminderOffsets === null, 'no per-event choice reads as null — "my default applies"');
    setEventReminderOffsets(later.id, planner, [60, 30]);
    assert(listMyEvents(planner, T0).find(e => e.postId === later.id)?.reminderOffsets?.join() === '60,30',
        '...and a per-event choice comes back with the event');
    // An ended event drops off the list, which is the other half of "upcoming".
    assert(listMyEvents(planner, T0 + 4 * DAY).some(e => e.postId === soon.id) === false,
        'an event that has ended is no longer one of "your events"');

    // ── 9. Refusals ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- 9. Refusals ---');
    let refused = '';
    try { setEventReminderOffsets(notMine.id, goer, [60]); } catch (e: any) { refused = e.message; }
    assert(refused === NO_RSVP_MESSAGE, 'a reminder cannot be set on an event the member has no RSVP on');

    const bad = [[15], [1441], ['1440'], [null], [true], [1440.5], 'daily', 7];
    let allRefused = true;
    for (const b of bad) {
        try { parseReminderOffsets(b); allRefused = false; console.error(`  (accepted ${JSON.stringify(b)})`); }
        catch { /* expected */ }
    }
    assert(allRefused, 'every offset outside the five the picker offers is refused');
    assert(parseReminderOffsets([30, 10080, 30])?.join() === '10080,30',
        'a valid list is de-duplicated and stored in one fixed order');
    assert(parseReminderOffsets([])?.length === 0, 'an empty list is valid — it is how reminders are turned off');
    assert(parseReminderOffsets(null) === null, 'and null is "my default applies"');

    assert(reminderPushBody(10080) === 'Starts in 1 week'
        && reminderPushBody(1440) === 'Starts in 1 day'
        && reminderPushBody(120) === 'Starts in 2 hours'
        && reminderPushBody(60) === 'Starts in 1 hour'
        && reminderPushBody(30) === 'Starts in 30 minutes',
        'every offset reads as plain relative time, worded from the offset itself');

    // ── 10. The same words wherever the process clock stands ────────────────────────────────
    console.log('\n--- 10. Any timezone, the same reminder ---');
    // A node has no timezone. The runtime image sets no TZ, deploy sets none, and there is no timezone
    // field in node config or the schema — so the process clock is UTC while the community the node serves
    // is not. A body naming a clock time or a calendar day would therefore be wrong by the node's own
    // offset for every member reading it. The check is that property, not the wording: swept at the same
    // moment, in UTC and in the zone a live node's members actually live in, each offset must produce the
    // SAME sentence. These events start at 22:00 UTC, which is 08:00 the next morning in Sydney, so an
    // absolute hour and a calendar day both diverge between the two runs.
    for (const offset of EVENT_REMINDER_OFFSETS) {
        const tzStart = eveningUtcStart(200 + EVENT_REMINDER_OFFSETS.indexOf(offset));
        const evTz = newEvent(tzStart, `Timezone ${offset}`);
        rsvpAt(evTz.id, goer, 'going', 0);
        setEventReminderOffsets(evTz.id, goer, [offset]);
        db.prepare('UPDATE event_rsvps SET updated_at = ? WHERE post_id = ? AND member_pubkey = ?')
            .run(at(0), evTz.id, goer);

        const bodies = ['UTC', 'Australia/Sydney'].map(tz => {
            process.env.TZ = tz;                                  // Node re-reads it for the next Date
            db.prepare('DELETE FROM event_reminders_sent WHERE post_id = ?').run(evTz.id);
            return sweepAt(tzStart - offset * MIN)[0]?.body;
        });
        process.env.TZ = 'UTC';                                   // back to the suite's own footing

        assert(!!bodies[0] && bodies[0] === bodies[1],
            `the ${offset}-minute reminder reads the same in UTC as in the community's own zone `
            + `(UTC "${bodies[0]}", Sydney "${bodies[1]}")`);
    }

    // ── 11. All the way out to Expo, and the preference that silences it ─────────────────────
    console.log('\n--- 11. The dispatcher and the preference ---');
    const realFetch = globalThis.fetch;
    const sent: any[] = [];
    (globalThis as any).fetch = async (url: any, init: any) => {
        if (String(url).includes('exp.host')) {
            sent.push(...JSON.parse(init.body));
            return { ok: true, status: 200, json: async () => ({}) } as any;
        }
        return realFetch(url, init);
    };
    try {
        db.prepare(`INSERT OR REPLACE INTO push_tokens (public_key, token, platform) VALUES (?, ?, 'android')`)
            .run(goer, 'ExponentPushToken[goer]');

        const wired = newEvent(140 * DAY, 'Wired up');
        rsvpAt(wired.id, goer, 'going', 0);
        sent.length = 0;
        // The real dispatcher, exactly as the scheduler calls it.
        const { dispatchPushNotification } = await import('./state-engine.js');
        runEventReminderSweep(dispatchPushNotification, T0 + 139 * DAY);
        await new Promise(r => setImmediate(r));
        assert(sent.length === 1, 'the wired-up sweep sends one push message');
        assert(sent[0]?.to === 'ExponentPushToken[goer]', '...to the member’s device');
        assert(sent[0]?.channelId === 'marketplace' && sent[0]?.categoryId === 'marketplace',
            '...on the Marketplace Android channel and category, so no app in the store needs an update');
        assert(sent[0]?.data?.screen === 'post' && sent[0]?.data?.postId === wired.id,
            '...and the payload that opens /post/:id');

        const optedOut = newEvent(150 * DAY, 'Not interested in being told');
        rsvpAt(optedOut.id, goer, 'going', 0);
        db.prepare(`INSERT OR REPLACE INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, 'notify_marketplace', 'false')`)
            .run(goer);
        sent.length = 0;
        runEventReminderSweep(dispatchPushNotification, T0 + 149 * DAY);
        await new Promise(r => setImmediate(r));
        assert(sent.length === 0, 'a member with Marketplace notifications off is not reminded');
        assert(sentMarks(optedOut.id).join() === '1440',
            '...and the moment is still marked, so turning notifications on later does not release a stale reminder');
    } finally {
        (globalThis as any).fetch = realFetch;
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });

/**
 * Repeating events, slice 4 (scratch/global-node/DESIGN-event-times-fable.md §8 and §10), over REAL
 * HTTP — through the signature middleware — for create, read and cancel-a-date, and on the engine for the minute roll,
 * the reminder sweep, the prune and the copy, which no route drives (each is given its own clock).
 *
 * Verifies:
 *  1. A weekly series is created from the host's clock: the rule stored in its closed shape with the typed time and
 *     length; a first date not on the rule, an `until` before it or past 5 years, a rule the form never sends, a date
 *     longer than the gap to the next, and a repeating online event with no zone are each refused in words; one with a
 *     zone is accepted.
 *  2. The roll across the Sydney DST start: the local clocks are equal and the instants an hour apart; the state goes back
 *     to scheduled; the next date starts at nobody going (counts reset), the regular's RSVP reads as last week's
 *     (myLastRsvp), they keep the chat; a broadcast goes out. Between a date's end and the roll the chat stays open.
 *  3. Monthly on the 31st skips February; monthly on the last Friday.
 *  4. Until: the last date is the last; after it the series ends as a one-off does and is never rolled again.
 *  5. Cancel a date (POST/DELETE /api/events/:id/skip): host only; a date that is not the series' refused; cancelling the
 *     current date rolls at once and tells Going "… is cancelled. Next: …"; restoring it moves the series back and tells them
 *     "… is back on", but not once that date has ended, and a later date restored tells nobody; the final date can't be
 *     cancelled, while earlier dates are left or when it is the only one (a series ends on it). A cancelled date stays
 *     cancelled until it has ended: bringing back the current date leaves a later one the roll jumped cancelled (with a
 *     date cancelled, or an edit, in between), and the roll lets it go once it has ended. Your events (GET
 *     /api/events/mine) carries the pattern and last date, a one-off's neither.
 *  6. Reminders fire once per date: a regular is reminded for this week's date and next week's, once each; an RSVP for
 *     last week's date gets no reminder for this week's; a one-off moved by an edit sends nothing twice.
 *  7. A standby never rolls (nor prunes).
 *  8. The cap of 5 upcoming counts a series once, before and after it rolls.
 *  9. The 30-day prune: an RSVP for a date a month gone goes, with its tombstone and the chat seat (the host keeps theirs).
 * 10. A copy carries the rule, the last date, the cancelled dates and each RSVP's date, and an import restores them.
 * 11. An RSVP from before this build (no date) on an event an edit makes repeating is stamped with its date: the next
 *     date starts at nobody going, it reads as last week's, no reminder for the next date, and the prune takes it.
 * 12. A DST gap day: Sunday 02:30-03:30 reads 03:30-04:30 that day, and a form re-saving those clocks with the rule
 *     keeps the rule's 02:30, so the next Sunday is 02:30 again.
 * 13. "Only people I let in" (#1953) on a repeating online event: Going and not let in reads no note, no link and no chat,
 *     on this date and after the roll; a let-in carries to the next date (the series' note, link and chat, and Going again
 *     is in at once); the waiting count and "let everyone in" go by this date's Going, as the host's list does; "take back
 *     everyone" reaches every let-in, any date (a let-in from last week not Going this date too), and they then read none.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-event-series-http.ts
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, exportSyncState, importRemoteState, setNodeRole } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { rsvpEvent, eventWaitingCount } from './engine/posts.js';
import { runEventReminderSweep, dueEventReminders } from './engine/event-reminders.js';
import { rollDueSeries, pruneStaleRsvps, setSeriesDateSkipped, SKIP_HOST_ONLY, SKIP_LAST_DATE, DATE_CANCELLED_PUSH_TITLE, DATE_BACK_ON_PUSH_TITLE } from './engine/event-series-roll.js';
import { eventThreadReadOnlyReason, loadEventForThread } from './engine/event-thread.js';
import { setMemberPhoto, REPEAT_ERRORS } from '@beanpool/engine';
import { startP2P } from './p2p.js';
import { addConnector } from './connector-manager.js';

let BASE = '';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const SYDNEY = { lat: -33.8688, lng: 151.2093 };
const SYD = 'Australia/Sydney';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ FAIL: ${msg}`); }
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };

function makeIdentity(callsign: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, status, joined_at, updated_at)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .run(pubKeyHex, callsign);
    setMemberPhoto(db, pubKeyHex, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
    return { pubKeyHex, privateKey };
}

/** The replay-proof scheme the real middleware requires: method + path (no query) + timestamp + nonce + body. */
async function signed(method: 'GET' | 'POST' | 'DELETE', path: string, body: unknown, id: Id) {
    const bodyString = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`;
    const headers: Record<string, string> = {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts), 'X-Nonce': nonce,
    };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : bodyString });
    let json: any;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body: json, error: json?.error as string | undefined };
}

const row = (id: string) => db.prepare(`SELECT event_start_at, event_end_at, event_start_local, event_end_local, event_tz, event_state,
    event_repeat, event_repeat_until, event_repeat_skips, status, active FROM posts WHERE id = ?`).get(id) as any;

async function readEvent(id: string, who: Id): Promise<any> {
    const r = await signed('GET', `/api/marketplace/posts?id=${id}&types=offer,need,poll,event`, null, who);
    const b = r.body;
    return Array.isArray(b) ? b[0] : (b?.posts?.[0] ?? b?.post ?? b);
}

async function main(): Promise<void> {
    console.log('\nRepeating events over real HTTP\n');
    await initTls();
    initStateEngine();
    const p2pNode = await startP2P(0, 0);
    const nodeId = p2pNode.peerId.toString();
    addConnector(`/ip4/127.0.0.1/tcp/4043/p2p/${nodeId}`, 'mirror', 'self-test-peer');
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const host = makeIdentity('HostHana');
    const regular = makeIdentity('RegularRo');
    const stranger = makeIdentity('StrangerSam');
    const monthly = makeIdentity('MonthlyMo');
    const capper = makeIdentity('CapperCai');
    const skipper = makeIdentity('SkipperSki');
    const remind = makeIdentity('RemindRey');
    const onlineHost = makeIdentity('OnlineOla');
    const undatedHost = makeIdentity('UndatedUma');
    const gapHost = makeIdentity('GapGil');
    const jumper = makeIdentity('JumperJo');
    const create = (who: Id, body: Record<string, unknown>) => signed('POST', '/api/marketplace/posts', {
        type: 'event', title: 'Friday dinner', description: 'Bring a plate', authorPublicKey: who.pubKeyHex, ...SYDNEY, ...body,
    }, who);
    const weeklyFri = { freq: 'weekly', interval: 1, byDay: 'FR' };

    // ── 1. Create ───────────────────────────────────────────────────────────────────────────────
    console.log('── 1. A weekly series from the host\'s clock ──');
    // Sydney's DST starts Sun 3 Oct 2027: Fri 1 Oct is AEST (+10), Fri 8 Oct AEDT (+11).
    const series = await create(host, { eventStartLocal: '2027-10-01T20:50', eventEndLocal: '2027-10-01T22:50', eventTz: SYD, eventRepeat: weeklyFri });
    const sid = series.body?.post?.id as string;
    assert(series.status === 200 && !!sid, `a weekly series is accepted (got ${series.status} ${series.error ?? ''})`);
    const s0 = row(sid);
    assert(s0.event_repeat === '{"freq":"weekly","interval":1,"byDay":"FR","time":"20:50","minutes":120}' && s0.event_repeat_until === null && s0.event_repeat_skips === null,
        `the rule is stored in its closed shape with the typed time and length (got ${s0.event_repeat})`);
    assert(s0.event_start_at === '2027-10-01T10:50:00.000Z', `its first date is the row's own: 20:50 AEST is 10:50Z (got ${s0.event_start_at})`);
    assert(series.body?.post?.eventRepeat?.byDay === 'FR' && series.body?.post?.eventRepeat?.time === '20:50', 'the post carries its rule');

    const refusals: Array<[string, Record<string, unknown>, string]> = [
        ['a first date not on the rule (a Friday, every Saturday)', { eventRepeat: { freq: 'weekly', interval: 1, byDay: 'SA' } }, REPEAT_ERRORS.firstDate],
        ['an until before the first date', { eventRepeat: weeklyFri, eventRepeatUntil: '2027-09-30' }, REPEAT_ERRORS.until],
        ['an until past five years', { eventRepeat: weeklyFri, eventRepeatUntil: '2032-10-02' }, REPEAT_ERRORS.untilTooFar],
        ['a rule the form never sends (daily)', { eventRepeat: { freq: 'daily' } }, REPEAT_ERRORS.shape],
        ['RRULE text', { eventRepeat: 'FREQ=WEEKLY;BYDAY=FR' }, REPEAT_ERRORS.shape],
        ['a date longer than a week, every week', { eventRepeat: weeklyFri, eventEndLocal: '2027-10-08T20:50' }, REPEAT_ERRORS.tooLong],
    ];
    for (const [what, extra, words] of refusals) {
        const r = await create(stranger, { eventStartLocal: '2027-10-01T20:50', eventTz: SYD, ...extra });
        assert(r.status === 400 && r.error === words, `refused: ${what}, "${words}" (got ${r.status} ${r.error})`);
    }
    const onlineNoZone = await create(stranger, { lat: undefined, lng: undefined, eventOnline: true, eventStartAt: '2027-10-01T10:50:00.000Z', eventRepeat: weeklyFri });
    assert(onlineNoZone.status === 400 && onlineNoZone.error === 'Pick a time zone from the list',
        `a repeating online event with no zone is refused (got ${onlineNoZone.status} ${onlineNoZone.error})`);
    const onlineWithZone = await create(onlineHost, { lat: undefined, lng: undefined, eventOnline: true, eventStartLocal: '2028-04-07T19:00', eventTz: SYD, eventRepeat: weeklyFri });
    assert(onlineWithZone.status === 200 && !!onlineWithZone.body?.post?.id,
        `a weekly online event with a zone is accepted (got ${onlineWithZone.status} ${onlineWithZone.error ?? ''})`);

    // ── 2. The roll ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── 2. The roll across the Sydney DST start ──');
    rsvpEvent(() => {}, sid, regular.pubKeyHex, 'going');
    const rsvp0 = db.prepare('SELECT occurrence_at FROM event_rsvps WHERE post_id = ? AND member_pubkey = ?').get(sid, regular.pubKeyHex) as any;
    assert(rsvp0?.occurrence_at === '2027-10-01T10:50:00.000Z', `an RSVP is stamped with the date the card showed (got ${rsvp0?.occurrence_at})`);
    assert((await readEvent(sid, host))?.goingCount === 1, 'one going for the first date');
    db.prepare(`UPDATE posts SET event_state = 'updated' WHERE id = ?`).run(sid);
    const afterFirst = Date.parse('2027-10-01T12:50:00.000Z') + 1000;
    assert(eventThreadReadOnlyReason(loadEventForThread(sid), afterFirst) === null,
        'between a date\'s end and the roll the chat stays open (a regular can type in that minute)');
    const events: any[] = [];
    const rolled = rollDueSeries((e) => events.push(e), afterFirst);
    const s1 = row(sid);
    assert(rolled >= 1 && s1.event_start_at === '2027-10-08T09:50:00.000Z' && s1.event_end_at === '2027-10-08T11:50:00.000Z',
        `the roll moves it to Fri 8 Oct, 20:50 AEDT = 09:50Z (got ${s1.event_start_at} ${s1.event_end_at})`);
    assert(s1.event_start_local === '2027-10-08T20:50' && s0.event_start_local?.slice(11) === s1.event_start_local.slice(11),
        `the local clocks are equal across DST (${s0.event_start_local} → ${s1.event_start_local})`);
    assert(Date.parse(s1.event_start_at) - Date.parse(s0.event_start_at) === 7 * DAY - HOUR, 'and the instants are an hour short of a week apart');
    assert(s1.event_state === 'scheduled', `the state goes back to scheduled (got ${s1.event_state})`);
    assert(events.some(e => e.type === 'post_updated' && e.post?.id === sid && e.post?.eventStartAt === s1.event_start_at), 'the roll broadcasts the new date');
    const hostView = await readEvent(sid, host);
    const regView = await readEvent(sid, regular);
    assert(hostView?.goingCount === 0 && hostView?.eventStartAt === s1.event_start_at, `the next date starts at nobody going (got ${hostView?.goingCount})`);
    assert(regView?.myRsvp === null && regView?.myLastRsvp?.status === 'going' && regView?.myLastRsvp?.occurrenceAt === '2027-10-01T10:50:00.000Z',
        `the regular's RSVP reads as last week's (got ${JSON.stringify({ my: regView?.myRsvp, last: regView?.myLastRsvp })})`);
    assert(Array.isArray(regView?.eventNextDates) && regView.eventNextDates[0]?.date === '2027-10-08' && regView.eventNextDates.length === 6,
        `a by-id read lists the next six dates (got ${JSON.stringify(regView?.eventNextDates?.map((d: any) => d.date))})`);
    const seat = db.prepare('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND public_key = ?').get(sid, regular.pubKeyHex);
    assert(!!seat, 'the roll removes nobody from the chat');
    assert(rollDueSeries(undefined, afterFirst) === 0, 'a second roll in the same minute moves nothing');

    // ── 3. Monthly ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. Monthly on the 31st and on the last Friday ──');
    const m31 = await create(monthly, { eventStartLocal: '2027-01-31T18:00', eventEndLocal: '2027-01-31T19:00', eventTz: SYD, eventRepeat: { freq: 'monthly', interval: 1, byMonthDay: 31 } });
    const m31Id = m31.body?.post?.id as string;
    rollDueSeries(undefined, Date.parse(row(m31Id).event_end_at) + 1000);
    assert(row(m31Id).event_start_local === '2027-03-31T18:00', `monthly on the 31st skips February (got ${row(m31Id).event_start_local})`);
    const lastFri = await create(monthly, { eventStartLocal: '2027-01-29T19:00', eventEndLocal: '2027-01-29T20:30', eventTz: SYD, eventRepeat: { freq: 'monthly', interval: 1, byDay: 'FR', pos: -1 } });
    const lfId = lastFri.body?.post?.id as string;
    assert(lastFri.status === 200, `the last Friday of January 2027 (the 29th) takes "last Friday" (got ${lastFri.status} ${lastFri.error ?? ''})`);
    rollDueSeries(undefined, Date.parse(row(lfId).event_end_at) + 1000);
    assert(row(lfId).event_start_local === '2027-02-26T19:00', `monthly on the last Friday: 26 Feb (got ${row(lfId).event_start_local})`);

    // ── 4. Until ────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. Until ──');
    const until = await create(monthly, { eventStartLocal: '2027-11-05T20:50', eventTz: SYD, eventRepeat: weeklyFri, eventRepeatUntil: '2027-11-12' });
    const uId = until.body?.post?.id as string;
    rollDueSeries(undefined, Date.parse(row(uId).event_end_at) + 1000);
    assert(row(uId).event_start_local === '2027-11-12T20:50', `until: the last date comes (got ${row(uId).event_start_local})`);
    const lastEnd = Date.parse(row(uId).event_end_at) + 1000;
    rollDueSeries(undefined, lastEnd);
    const u2 = row(uId);
    assert(u2.event_start_local === '2027-11-12T20:50' && u2.status === 'active' && u2.event_repeat_until === '2027-11-12',
        `after it, the series ends as a one-off does: it stays on its last date, active for the scrub (got ${JSON.stringify(u2)})`);
    assert(eventThreadReadOnlyReason(loadEventForThread(uId), lastEnd) === 'This event has ended. The chat is read-only.',
        'and its chat is read-only, as an ended event\'s');
    const stamp = row(uId);
    rollDueSeries(undefined, lastEnd + 7 * DAY);
    assert(JSON.stringify(row(uId)) === JSON.stringify(stamp), 'an ended series is never rolled again');

    // ── 5. Cancel a date ────────────────────────────────────────────────────────────────────────
    console.log('\n── 5. Cancel a date ──');
    const sk = await create(skipper, { eventStartLocal: '2027-12-03T19:00', eventTz: SYD, eventRepeat: weeklyFri, eventRepeatUntil: '2027-12-24' });
    const skId = sk.body?.post?.id as string;
    const notHost = await signed('POST', `/api/events/${skId}/skip`, { date: '2027-12-10' }, stranger);
    assert(notHost.status === 403 && notHost.error === SKIP_HOST_ONLY, `only the host cancels a date (got ${notHost.status} ${notHost.error})`);
    const offRule = await signed('POST', `/api/events/${skId}/skip`, { date: '2027-12-11' }, skipper);
    assert(offRule.status === 400 && offRule.error === REPEAT_ERRORS.skipDate, `a date that is not the series' is refused (got ${offRule.status} ${offRule.error})`);
    const pastUntil = await signed('POST', `/api/events/${skId}/skip`, { date: '2027-12-31' }, skipper);
    assert(pastUntil.status === 400, `a date past its last one is refused (got ${pastUntil.status})`);
    const unsigned = await fetch(`${BASE}/api/events/${skId}/skip`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"date":"2027-12-10"}' });
    assert(unsigned.status === 401, `unsigned is 401 (got ${unsigned.status})`);
    const later = await signed('POST', `/api/events/${skId}/skip`, { date: '2027-12-17' }, skipper);
    assert(later.status === 200 && JSON.stringify(later.body?.skips) === '["2027-12-17"]' && row(skId).event_start_local === '2027-12-03T19:00',
        `a later date is cancelled; the current one stays (got ${later.status} ${JSON.stringify(later.body?.skips)})`);
    // The final date (the 24th, its until) can't be cancelled while earlier dates are left either: a series ends on it, so
    // the host's until is kept and a date cancelled before it can be restored (the deciding review of #1945, finding 7).
    const finalEarly = await signed('POST', `/api/events/${skId}/skip`, { date: '2027-12-24' }, skipper);
    assert(finalEarly.status === 400 && finalEarly.error === SKIP_LAST_DATE && row(skId).event_repeat_skips === '["2027-12-17"]',
        `the final date can't be cancelled while earlier ones are left (got ${finalEarly.status} ${finalEarly.error})`);
    rsvpEvent(() => {}, skId, regular.pubKeyHex, 'going');
    const pushes: Array<{ to: string[]; title: string; body: string }> = [];
    const push = ((to: string[], _from: string, title: string, body: string) => { pushes.push({ to, title, body }); }) as any;
    const cur = setSeriesDateSkipped(undefined, push, skId, skipper.pubKeyHex, '2027-12-03', true);
    // The cancelled 3rd is behind the series' date now, but it stays on the list until it has ended (it can be brought
    // back till then; the confirmation of #1993, B1); the 17th stays.
    assert(row(skId).event_start_local === '2027-12-10T19:00' && JSON.stringify(cur.skips) === '["2027-12-03","2027-12-17"]'
        && cur.post.eventNextDates?.[0]?.date === '2027-12-03' && cur.post.eventNextDates?.[0]?.cancelled === true
        && cur.post.eventNextDates?.[1]?.date === '2027-12-10' && cur.post.eventNextDates?.[1]?.cancelled === false,
        `cancelling the current date rolls it at once to Fri 10 Dec, the cancelled 3 Dec listed before it (got ${row(skId).event_start_local} ${JSON.stringify(cur.skips)} ${JSON.stringify(cur.post.eventNextDates?.slice(0, 2))})`);
    assert(pushes.length === 1 && pushes[0].to.includes(regular.pubKeyHex) && pushes[0].title === DATE_CANCELLED_PUSH_TITLE
        && pushes[0].body === 'Friday dinner: Fri 3 Dec is cancelled. Next: Fri 10 Dec.',
        `Going for it are told (got ${JSON.stringify(pushes)})`);
    // Brought back while it hasn't ended (the deciding review of #1993, N2): the series moves back to it, and Going for it
    // are told it is on again, as they were told it was off.
    setSeriesDateSkipped(undefined, push, skId, skipper.pubKeyHex, '2027-12-03', false);
    assert(row(skId).event_start_local === '2027-12-03T19:00' && pushes.length === 2 && pushes[1].to.includes(regular.pubKeyHex)
        && pushes[1].title === DATE_BACK_ON_PUSH_TITLE && pushes[1].body === 'Friday dinner: Fri 3 Dec is back on.',
        `bringing the current date back tells Going "… is back on" (got ${row(skId).event_start_local} ${JSON.stringify(pushes.slice(1))})`);
    // After the date's end it can't come back: the node refuses it, and nobody is told anything.
    setSeriesDateSkipped(undefined, push, skId, skipper.pubKeyHex, '2027-12-03', true);
    const thirdEnd = Date.parse(row(skId).event_end_at) - 7 * DAY;
    let lateError = '';
    try { setSeriesDateSkipped(undefined, push, skId, skipper.pubKeyHex, '2027-12-03', false, thirdEnd + 1000); } catch (e: any) { lateError = e?.message ?? ''; }
    assert(lateError === REPEAT_ERRORS.skipDate && row(skId).event_start_local === '2027-12-10T19:00' && pushes.length === 3,
        `once the cancelled date has ended it can't be brought back (got ${JSON.stringify(lateError)} ${row(skId).event_start_local} ${pushes.length})`);
    // Restoring a later date (not the current one) tells nobody: nobody can be Going for a date that isn't the event's yet.
    await signed('DELETE', `/api/events/${skId}/skip`, { date: '2027-12-17' }, skipper);
    assert(pushes.length === 3, `restoring a later date tells nobody (got ${pushes.length})`);
    await signed('POST', `/api/events/${skId}/skip`, { date: '2027-12-17' }, skipper);
    const restore = await signed('DELETE', `/api/events/${skId}/skip`, { date: '2027-12-03' }, skipper);
    assert(restore.status === 200 && row(skId).event_start_local === '2027-12-03T19:00' && !(restore.body?.skips ?? []).includes('2027-12-03'),
        `restoring it moves the series back to Fri 3 Dec (got ${restore.status} ${row(skId).event_start_local} ${JSON.stringify(restore.body?.skips)})`);
    // "Your events" (the deciding review of #1993, N5): the row says how it repeats and its last date, for the ↻ caption,
    // as Home's line does: the pattern only, never the host's clock or each date's length.
    const mine = await signed('GET', '/api/events/mine', null, regular);
    const mineRow = (mine.body?.events ?? []).find((e: any) => e.postId === skId);
    assert(mine.status === 200 && JSON.stringify(mineRow?.repeat) === '{"freq":"weekly","interval":1,"byDay":"FR"}' && mineRow?.repeatUntil === '2027-12-24',
        `Your events carries the pattern and the last date (got ${mine.status} ${JSON.stringify(mineRow)})`);
    // The 24th is the last date: cancel the 10th and the 24th, then roll to the 24th and try to cancel it.
    await signed('POST', `/api/events/${skId}/skip`, { date: '2027-12-10' }, skipper);
    rollDueSeries(undefined, Date.parse(row(skId).event_end_at) + 1000);
    assert(row(skId).event_start_local === '2027-12-24T19:00', `the roll passes the cancelled 10th and 17th (got ${row(skId).event_start_local})`);
    const lastOne = await signed('POST', `/api/events/${skId}/skip`, { date: '2027-12-24' }, skipper);
    assert(lastOne.status === 400 && lastOne.error === SKIP_LAST_DATE, `the only date left can't be cancelled (got ${lastOne.status} ${lastOne.error})`);

    // A later cancelled date the roll jumps stays cancelled until it has ended, so Bring it back on the current date finds it
    // still cancelled, and nobody is told it is on (the confirmation of #1993, B1: the undo wrote only the dates from the
    // current one on, and the row had dropped those it passed). (a) Monthly, the third Friday: 19 Nov cancelled, then the
    // current 15 Oct, which rolls past 19 Nov to 17 Dec.
    const nextOf = (dates: any[] | undefined) => (dates ?? []).slice(0, 4).map((d: any) => `${d.date}${d.cancelled ? ' cancelled' : ''}`).join(', ');
    const ja = await create(jumper, { eventStartLocal: '2027-10-15T18:50', eventEndLocal: '2027-10-15T20:50', eventTz: SYD,
        eventRepeat: { freq: 'monthly', interval: 1, byDay: 'FR', pos: 3 }, eventRepeatUntil: '2028-12-15' });
    const jaId = ja.body?.post?.id as string;
    await signed('POST', `/api/events/${jaId}/skip`, { date: '2027-11-19' }, jumper);
    rsvpEvent(() => {}, jaId, regular.pubKeyHex, 'going');
    const jaCancel = await signed('POST', `/api/events/${jaId}/skip`, { date: '2027-10-15' }, jumper);
    assert(jaCancel.status === 200 && row(jaId).event_start_local === '2027-12-17T18:50' && JSON.stringify(jaCancel.body?.skips) === '["2027-10-15","2027-11-19"]',
        `(a) cancelling the current 15 Oct rolls past the cancelled 19 Nov to 17 Dec, and both stay cancelled (got ${jaCancel.status} ${row(jaId).event_start_local} ${JSON.stringify(jaCancel.body?.skips)})`);
    pushes.length = 0;
    const jaBack = setSeriesDateSkipped(undefined, push, jaId, jumper.pubKeyHex, '2027-10-15', false);
    const jaRead = await readEvent(jaId, regular);
    assert(row(jaId).event_start_local === '2027-10-15T18:50' && JSON.stringify(jaBack.skips) === '["2027-11-19"]'
        && nextOf(jaRead?.eventNextDates) === '2027-10-15, 2027-11-19 cancelled, 2027-12-17, 2028-01-21',
        `(a) Bring it back on 15 Oct: 19 Nov is still cancelled, and the next dates say so (got ${row(jaId).event_start_local} ${JSON.stringify(jaBack.skips)}; ${nextOf(jaRead?.eventNextDates)})`);
    assert(pushes.length === 1 && pushes[0].body === 'Friday dinner: Fri 15 Oct is back on.' && !pushes.some(p => p.body.includes('19 Nov')),
        `(a) the one notice is "Fri 15 Oct is back on"; none says 19 Nov is on (got ${JSON.stringify(pushes.map(p => p.body))})`);

    // (b) Another later date cancelled between the cancel and the undo (its write kept only the dates from the current one
    // on): weekly, 22 Oct cancelled, then the current 15 Oct (→ 29 Oct), then 5 Nov; Bring it back over HTTP.
    const jb = await create(jumper, { eventStartLocal: '2027-10-15T19:00', eventEndLocal: '2027-10-15T21:00', eventTz: SYD, eventRepeat: weeklyFri });
    const jbId = jb.body?.post?.id as string;
    await signed('POST', `/api/events/${jbId}/skip`, { date: '2027-10-22' }, jumper);
    await signed('POST', `/api/events/${jbId}/skip`, { date: '2027-10-15' }, jumper);
    const jbBetween = await signed('POST', `/api/events/${jbId}/skip`, { date: '2027-11-05' }, jumper);
    assert(row(jbId).event_start_local === '2027-10-29T19:00' && JSON.stringify(jbBetween.body?.skips) === '["2027-10-15","2027-10-22","2027-11-05"]',
        `(b) a later date cancelled after the current one keeps the dates the roll passed (got ${row(jbId).event_start_local} ${JSON.stringify(jbBetween.body?.skips)})`);
    const jbBack = await signed('DELETE', `/api/events/${jbId}/skip`, { date: '2027-10-15' }, jumper);
    assert(jbBack.status === 200 && row(jbId).event_start_local === '2027-10-15T19:00' && JSON.stringify(jbBack.body?.skips) === '["2027-10-22","2027-11-05"]'
        && nextOf(jbBack.body?.post?.eventNextDates) === '2027-10-15, 2027-10-22 cancelled, 2027-10-29, 2027-11-05 cancelled',
        `(b) Bring it back on 15 Oct: 22 Oct and 5 Nov are still cancelled (got ${jbBack.status} ${JSON.stringify(jbBack.body?.skips)}; ${nextOf(jbBack.body?.post?.eventNextDates)})`);

    // (c) The weekly case from the review: 22 Oct cancelled, Going told the current 15 Oct is off; Bring it back tells them it
    // is on, and 22 Oct stays cancelled through the minute roll, which lets it go only once it has ended.
    const jc = await create(jumper, { eventStartLocal: '2027-10-15T19:00', eventEndLocal: '2027-10-15T21:00', eventTz: SYD, eventRepeat: weeklyFri });
    const jcId = jc.body?.post?.id as string;
    await signed('POST', `/api/events/${jcId}/skip`, { date: '2027-10-22' }, jumper);
    rsvpEvent(() => {}, jcId, regular.pubKeyHex, 'going');
    pushes.length = 0;
    setSeriesDateSkipped(undefined, push, jcId, jumper.pubKeyHex, '2027-10-15', true);
    const jcBack = setSeriesDateSkipped(undefined, push, jcId, jumper.pubKeyHex, '2027-10-15', false);
    assert(row(jcId).event_start_local === '2027-10-15T19:00' && JSON.stringify(jcBack.skips) === '["2027-10-22"]'
        && jcBack.post.eventNextDates?.[1]?.date === '2027-10-22' && jcBack.post.eventNextDates?.[1]?.cancelled === true,
        `(c) weekly: Bring it back on 15 Oct leaves 22 Oct cancelled (got ${JSON.stringify(jcBack.skips)}; ${nextOf(jcBack.post.eventNextDates)})`);
    assert(JSON.stringify(pushes.map(p => p.body)) === JSON.stringify(['Friday dinner: Fri 15 Oct is cancelled. Next: Fri 29 Oct.', 'Friday dinner: Fri 15 Oct is back on.']),
        `(c) Going hear 15 Oct is off, then back on, and nothing of 22 Oct (got ${JSON.stringify(pushes.map(p => p.body))})`);
    rollDueSeries(undefined, Date.parse(row(jcId).event_end_at) + 1000);
    assert(row(jcId).event_start_local === '2027-10-29T19:00' && row(jcId).event_repeat_skips === '["2027-10-22"]',
        `(c) the roll passes the cancelled 22 Oct to 29 Oct and keeps it cancelled until it ends (got ${row(jcId).event_start_local} ${row(jcId).event_repeat_skips})`);
    rollDueSeries(undefined, Date.parse(row(jcId).event_end_at) + 1000);
    assert(row(jcId).event_start_local === '2027-11-05T19:00' && row(jcId).event_repeat_skips === null,
        `(c) once 22 Oct has ended the roll lets it go (got ${row(jcId).event_start_local} ${row(jcId).event_repeat_skips})`);

    // (d) An edit between the cancel and the undo (here the last date) keeps the dates the roll passed as well.
    const jd = await create(jumper, { eventStartLocal: '2027-10-15T19:00', eventEndLocal: '2027-10-15T21:00', eventTz: SYD, eventRepeat: weeklyFri, eventRepeatUntil: '2028-03-31' });
    const jdId = jd.body?.post?.id as string;
    await signed('POST', `/api/events/${jdId}/skip`, { date: '2027-10-22' }, jumper);
    await signed('POST', `/api/events/${jdId}/skip`, { date: '2027-10-15' }, jumper);
    const jdEdit = await signed('POST', '/api/marketplace/posts/update', { id: jdId, authorPublicKey: jumper.pubKeyHex, eventRepeatUntil: '2028-06-30' }, jumper);
    assert(jdEdit.status === 200 && row(jdId).event_repeat_until === '2028-06-30' && row(jdId).event_repeat_skips === '["2027-10-15","2027-10-22"]',
        `(d) an edit of the last date keeps the cancelled dates the roll passed (got ${jdEdit.status} ${jdEdit.error ?? ''} ${row(jdId).event_repeat_skips})`);
    const jdBack = await signed('DELETE', `/api/events/${jdId}/skip`, { date: '2027-10-15' }, jumper);
    assert(jdBack.status === 200 && row(jdId).event_start_local === '2027-10-15T19:00' && JSON.stringify(jdBack.body?.skips) === '["2027-10-22"]',
        `(d) after the edit, Bring it back on 15 Oct leaves 22 Oct cancelled (got ${jdBack.status} ${JSON.stringify(jdBack.body?.skips)})`);

    // (e) An edit that moves Starts onto a cancelled date takes it back: the row's own date is never also a cancelled one,
    // which every member's Next dates would strike through while the card, Your events and the reminder say it is on (the
    // confirmation 2 of #1993, B1). Back onto the current date the host just cancelled, as the web form sends it (the clocks
    // and the rule), and as the phone or an older app does (the clocks only); and forward onto a later cancelled date.
    const editBack = async (withRule: boolean) => {
        const mover = makeIdentity(withRule ? 'MoverMei' : 'MoverMo');
        const e = await create(mover, { eventStartLocal: '2027-10-15T19:00', eventEndLocal: '2027-10-15T21:00', eventTz: SYD, eventRepeat: weeklyFri });
        const id = e.body?.post?.id as string;
        rsvpEvent(() => {}, id, regular.pubKeyHex, 'going');
        await signed('POST', `/api/events/${id}/skip`, { date: '2027-10-15' }, mover);
        const moved = await signed('POST', '/api/marketplace/posts/update', {
            id, authorPublicKey: mover.pubKeyHex, eventStartLocal: '2027-10-15T19:00', eventEndLocal: '2027-10-15T21:00', ...(withRule ? { eventRepeat: weeklyFri } : {}),
        }, mover);
        return { id, moved, read: await readEvent(id, regular) };
    };
    for (const withRule of [true, false]) {
        const { id, moved, read } = await editBack(withRule);
        assert(moved.status === 200 && row(id).event_start_local === '2027-10-15T19:00' && row(id).event_repeat_skips === null
            && nextOf(read?.eventNextDates) === '2027-10-15, 2027-10-22, 2027-10-29, 2027-11-05',
            `(e) cancel the current 15 Oct, then edit Starts back to it${withRule ? '' : ' (no rule in the edit)'}: it is on, and Next dates don't mark it (got ${moved.status} ${moved.error ?? ''} ${row(id).event_start_local} ${row(id).event_repeat_skips}; ${nextOf(read?.eventNextDates)})`);
    }
    const forward = makeIdentity('MoverMax');
    const jf = await create(forward, { eventStartLocal: '2027-10-15T19:00', eventEndLocal: '2027-10-15T21:00', eventTz: SYD, eventRepeat: weeklyFri });
    const jfId = jf.body?.post?.id as string;
    await signed('POST', `/api/events/${jfId}/skip`, { date: '2027-10-29' }, forward);
    const jfMoved = await signed('POST', '/api/marketplace/posts/update', {
        id: jfId, authorPublicKey: forward.pubKeyHex, eventStartLocal: '2027-10-29T19:00', eventEndLocal: '2027-10-29T21:00', eventRepeat: weeklyFri,
    }, forward);
    const jfRead = await readEvent(jfId, regular);
    assert(jfMoved.status === 200 && row(jfId).event_start_local === '2027-10-29T19:00' && row(jfId).event_repeat_skips === null
        && nextOf(jfRead?.eventNextDates) === '2027-10-29, 2027-11-05, 2027-11-12, 2027-11-19',
        `(e) edit Starts forward onto the cancelled 29 Oct: it is on, and Next dates don't mark it (got ${jfMoved.status} ${jfMoved.error ?? ''} ${row(jfId).event_start_local} ${row(jfId).event_repeat_skips}; ${nextOf(jfRead?.eventNextDates)})`);

    // (f) Bring it back survives a reload and reaches every device (the confirmation 2 of #1993, NB2): a fresh read lists a
    // cancelled date the series has passed, first and marked, with its end, while it hasn't ended; the host brings it back
    // from that list. 15 Oct 19:00–21:00 Sydney (AEDT) ends at 10:00Z.
    const reloader = makeIdentity('ReloadRia');
    const jg = await create(reloader, { eventStartLocal: '2027-10-15T19:00', eventEndLocal: '2027-10-15T21:00', eventTz: SYD, eventRepeat: weeklyFri });
    const jgId = jg.body?.post?.id as string;
    await signed('POST', `/api/events/${jgId}/skip`, { date: '2027-10-15' }, reloader);
    const jgHost = await readEvent(jgId, reloader);
    const jgMember = await readEvent(jgId, regular);
    assert(row(jgId).event_start_local === '2027-10-22T19:00' && nextOf(jgHost?.eventNextDates) === '2027-10-15 cancelled, 2027-10-22, 2027-10-29, 2027-11-05'
        && jgHost?.eventNextDates?.[0]?.endAt === '2027-10-15T10:00:00.000Z' && nextOf(jgMember?.eventNextDates) === nextOf(jgHost?.eventNextDates),
        `(f) after the cancel, a fresh read lists the cancelled 15 Oct first, marked, with its end, for the host and a member (got ${row(jgId).event_start_local}; ${JSON.stringify(jgHost?.eventNextDates?.[0])}; member ${nextOf(jgMember?.eventNextDates)})`);
    const jgBack = await signed('DELETE', `/api/events/${jgId}/skip`, { date: '2027-10-15' }, reloader);
    const jgAfter = await readEvent(jgId, regular);
    assert(jgBack.status === 200 && row(jgId).event_start_local === '2027-10-15T19:00' && nextOf(jgAfter?.eventNextDates) === '2027-10-15, 2027-10-22, 2027-10-29, 2027-11-05',
        `(f) Bring it back from the listed date: the series is on 15 Oct again, listed once and not marked (got ${jgBack.status} ${jgBack.error ?? ''} ${row(jgId).event_start_local}; ${nextOf(jgAfter?.eventNextDates)})`);
    // Once a cancelled date has ended it is neither listed nor brought back: Fri 9 Oct 2026 has, Fri 8 Oct 2027 hasn't, both
    // in the cell as it keeps them until the roll.
    db.prepare('UPDATE posts SET event_repeat_skips = ? WHERE id = ?').run('["2026-10-09","2027-10-08"]', jgId);
    const jgEnded = await readEvent(jgId, reloader);
    const jgLate = await signed('DELETE', `/api/events/${jgId}/skip`, { date: '2026-10-09' }, reloader);
    assert(nextOf(jgEnded?.eventNextDates) === '2027-10-08 cancelled, 2027-10-15, 2027-10-22, 2027-10-29'
        && jgLate.status === 400 && jgLate.error === REPEAT_ERRORS.skipDate && row(jgId).event_start_local === '2027-10-15T19:00',
        `(f) an ended cancelled date is not listed and can't be brought back; one not ended is (got ${nextOf(jgEnded?.eventNextDates)}; ${jgLate.status} ${jgLate.error})`);

    // (g) A date an edit moved the series past was never cancelled: it can't be "brought back", which moved the series back
    // to it with no notice and left Going on the later date, nor cancelled (the confirmation 2 of #1993, NB1).
    const passer = makeIdentity('PasserPia');
    const jh = await create(passer, { eventStartLocal: '2027-10-15T19:00', eventEndLocal: '2027-10-15T21:00', eventTz: SYD, eventRepeat: weeklyFri });
    const jhId = jh.body?.post?.id as string;
    rsvpEvent(() => {}, jhId, regular.pubKeyHex, 'going');
    const jhMoved = await signed('POST', '/api/marketplace/posts/update', {
        id: jhId, authorPublicKey: passer.pubKeyHex, eventStartLocal: '2027-10-29T19:00', eventEndLocal: '2027-10-29T21:00', eventRepeat: weeklyFri,
    }, passer);
    const jhBack = await signed('DELETE', `/api/events/${jhId}/skip`, { date: '2027-10-22' }, passer);
    const jhCancel = await signed('POST', `/api/events/${jhId}/skip`, { date: '2027-10-22' }, passer);
    const jhRead = await readEvent(jhId, regular);
    assert(jhMoved.status === 200 && jhBack.status === 400 && jhBack.error === REPEAT_ERRORS.skipDate && jhCancel.status === 400 && jhCancel.error === REPEAT_ERRORS.skipDate
        && row(jhId).event_start_local === '2027-10-29T19:00' && row(jhId).event_repeat_skips === null && jhRead?.myRsvp === 'going',
        `(g) after an edit to 29 Oct, the passed 22 Oct is refused both ways; the series stays on 29 Oct with Going on it (got ${jhMoved.status} ${jhBack.status} ${jhBack.error} / ${jhCancel.status} ${jhCancel.error}; ${row(jhId).event_start_local} ${row(jhId).event_repeat_skips} ${jhRead?.myRsvp})`);

    // ── 6. Reminders ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 6. Reminders once per date ──');
    const rs = await create(remind, { eventStartLocal: '2028-01-07T20:50', eventTz: SYD, eventRepeat: weeklyFri });
    const rsId = rs.body?.post?.id as string;
    rsvpEvent(() => {}, rsId, regular.pubKeyHex, 'going');
    db.prepare(`UPDATE event_rsvps SET reminder_offsets = '[1440]' WHERE post_id = ? AND member_pubkey = ?`).run(rsId, regular.pubKeyHex);
    const sent: string[] = [];
    const remindPush = ((_t: string[], _f: string, _title: string, _body: string, data: any) => { if (data?.postId === rsId) sent.push(data.postId); }) as any;
    const day1 = Date.parse(row(rsId).event_start_at) - DAY + 1000;
    runEventReminderSweep(remindPush, day1);
    runEventReminderSweep(remindPush, day1 + 60_000);
    assert(sent.length === 1, `the first date's reminder fires once (got ${sent.length})`);
    rollDueSeries(undefined, Date.parse(row(rsId).event_end_at) + 1000);
    const day2 = Date.parse(row(rsId).event_start_at) - DAY + 1000;
    runEventReminderSweep(remindPush, day2);
    assert(sent.length === 1, `an RSVP for last week's date gets no reminder for this week's (got ${sent.length})`);
    rsvpEvent(() => {}, rsId, regular.pubKeyHex, 'going');
    db.prepare(`UPDATE event_rsvps SET reminder_offsets = '[1440]' WHERE post_id = ? AND member_pubkey = ?`).run(rsId, regular.pubKeyHex);
    runEventReminderSweep(remindPush, day2);
    runEventReminderSweep(remindPush, day2 + 60_000);
    assert(sent.length === 2, `going again, the regular is reminded for this week's date, once (got ${sent.length})`);
    const marks = db.prepare('SELECT occurrence_at FROM event_reminders_sent WHERE post_id = ? ORDER BY occurrence_at').all(rsId) as any[];
    assert(marks.length === 2 && marks[0].occurrence_at !== marks[1].occurrence_at, `one mark per date (got ${JSON.stringify(marks)})`);

    // A one-off whose time an edit moves: the reminder already sent is not sent again, and Going still counts.
    const one = await create(remind, { eventStartLocal: '2028-02-04T20:50', eventTz: SYD });
    const oneId = one.body?.post?.id as string;
    rsvpEvent(() => {}, oneId, regular.pubKeyHex, 'going');
    db.prepare(`UPDATE event_rsvps SET reminder_offsets = '[1440]' WHERE post_id = ? AND member_pubkey = ?`).run(oneId, regular.pubKeyHex);
    const oneSent: string[] = [];
    const onePush = ((_t: string[], _f: string, _title: string, _body: string, data: any) => { if (data?.postId === oneId) oneSent.push(data.postId); }) as any;
    runEventReminderSweep(onePush, Date.parse(row(oneId).event_start_at) - DAY + 1000);
    const moved = await signed('POST', '/api/marketplace/posts/update', { id: oneId, authorPublicKey: remind.pubKeyHex, eventStartLocal: '2028-02-04T21:30', eventTz: SYD }, remind);
    assert(moved.status === 200 && row(oneId).event_start_local === '2028-02-04T21:30', `the one-off moves 40 minutes (got ${moved.status} ${moved.error ?? ''})`);
    runEventReminderSweep(onePush, Date.parse(row(oneId).event_start_at) - DAY + 1000);
    assert(oneSent.length === 1, `its reminder is not sent a second time (got ${oneSent.length})`);
    assert((await readEvent(oneId, remind))?.goingCount === 1, 'and the people going are still going for the moved date');
    const mineOne = ((await signed('GET', '/api/events/mine', null, regular)).body?.events ?? []).find((e: any) => e.postId === oneId);
    assert(!!mineOne && !('repeat' in mineOne) && !('repeatUntil' in mineOne), `a one-off's row in Your events says nothing of repeating (got ${JSON.stringify(mineOne)})`);

    // ── 7. A standby never rolls ────────────────────────────────────────────────────────────────
    console.log('\n── 7. A standby never rolls ──');
    const before = row(rsId);
    setNodeRole('backup');
    const standbyRolled = rollDueSeries(undefined, Date.parse(before.event_end_at) + 1000);
    const standbyPruned = pruneStaleRsvps(Date.parse(before.event_end_at) + 60 * DAY, true);
    setNodeRole('primary');
    assert(standbyRolled === 0 && standbyPruned === 0 && JSON.stringify(row(rsId)) === JSON.stringify(before),
        `a standby rolls nothing and prunes nothing (rolled ${standbyRolled}, pruned ${standbyPruned})`);
    rollDueSeries(undefined, Date.parse(before.event_end_at) + 1000);
    assert(row(rsId).event_start_at !== before.event_start_at, 'the main server rolls the same row');

    // ── 8. The cap ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── 8. The cap counts a series once ──');
    const capSeries = await create(capper, { eventStartLocal: '2028-03-03T20:50', eventTz: SYD, eventRepeat: weeklyFri });
    const capId = capSeries.body?.post?.id as string;
    for (let i = 0; i < 4; i++) await create(capper, { eventStartLocal: `2028-03-1${i}T10:00`, eventTz: SYD });
    const sixth = await create(capper, { eventStartLocal: '2028-03-20T10:00', eventTz: SYD });
    assert(!!capId && sixth.status === 400 && /Limit reached: 5 upcoming events/.test(sixth.error ?? ''),
        `a forever series and four one-offs are five: the sixth is refused (got ${sixth.status} ${sixth.error})`);
    rollDueSeries(undefined, Date.parse(row(capId).event_end_at) + 1000);
    const seventh = await create(capper, { eventStartLocal: '2028-03-21T10:00', eventTz: SYD });
    assert(seventh.status === 400, `after it rolls it still counts once (got ${seventh.status})`);

    // ── 9. The 30-day prune ─────────────────────────────────────────────────────────────────────
    console.log('\n── 9. The 30-day prune ──');
    // The regular's RSVP on the first series is for 1 Oct; the series is on 8 Oct now.
    const pruneAt = Date.parse('2027-10-01T10:50:00.000Z') + 31 * DAY;
    const pruned = pruneStaleRsvps(pruneAt, true);
    const gone = db.prepare('SELECT 1 FROM event_rsvps WHERE post_id = ? AND member_pubkey = ?').get(sid, regular.pubKeyHex);
    const tomb = db.prepare(`SELECT 1 FROM tombstones WHERE table_name = 'event_rsvps' AND row_key = ?`).get(`${sid}|${regular.pubKeyHex}`);
    const seatGone = db.prepare('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND public_key = ?').get(sid, regular.pubKeyHex);
    const seatTomb = db.prepare(`SELECT 1 FROM tombstones WHERE table_name = 'conversation_participants' AND row_key = ?`).get(`${sid}|${regular.pubKeyHex}`);
    const hostSeat = db.prepare('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND public_key = ?').get(sid, host.pubKeyHex);
    assert(pruned >= 1 && !gone && !!tomb, `an RSVP for a date a month gone is pruned, with its tombstone (pruned ${pruned})`);
    assert(!seatGone && !!seatTomb && !!hostSeat, 'and its chat seat with it; the host keeps theirs');
    const current = db.prepare('SELECT 1 FROM event_rsvps WHERE post_id = ? AND member_pubkey = ?').get(rsId, regular.pubKeyHex);
    assert(!!current, 'an RSVP for a current date stays');

    // ── 10. The copy ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 10. A copy carries the series ──');
    // A later date: one the series has passed was never cancelled, and can't be (the confirmation 2 of #1993, NB1).
    const weekOn = new Date(Date.parse(`${row(rsId).event_start_local.slice(0, 10)}T00:00:00Z`) + 7 * DAY).toISOString().slice(0, 10);
    const copySkip = await signed('POST', `/api/events/${rsId}/skip`, { date: weekOn }, remind);
    assert(copySkip.status === 200, `a later date is cancelled before the copy (got ${copySkip.status} ${copySkip.error ?? ''})`);
    const src = row(rsId);
    const payload = await exportSyncState(nodeId);
    const exported = (payload.posts ?? []).find((p: any) => p.id === rsId) as any;
    const exportedRsvp = (payload.eventRsvps ?? []).find((r: any) => r.postId === rsId && r.memberPubkey === regular.pubKeyHex) as any;
    assert(exported?.eventRepeat?.freq === 'weekly' && Array.isArray(exported?.eventRepeatSkips) && exported.eventRepeatSkips.length === 1,
        `the exported post carries the rule and the cancelled date (got ${JSON.stringify({ r: exported?.eventRepeat, s: exported?.eventRepeatSkips })})`);
    assert(typeof exportedRsvp?.occurrenceAt === 'string', `the exported RSVP carries its date (got ${exportedRsvp?.occurrenceAt})`);
    db.prepare(`UPDATE posts SET event_repeat = NULL, event_repeat_until = NULL, event_repeat_skips = NULL, updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(rsId);
    db.prepare(`UPDATE event_rsvps SET occurrence_at = NULL, updated_at = '2000-01-01T00:00:00.000Z' WHERE post_id = ?`).run(rsId);
    setNodeRole('backup');
    await importRemoteState(payload as any);
    setNodeRole('primary');
    const back = row(rsId);
    const backRsvp = db.prepare('SELECT occurrence_at FROM event_rsvps WHERE post_id = ? AND member_pubkey = ?').get(rsId, regular.pubKeyHex) as any;
    assert(back.event_repeat === src.event_repeat && back.event_repeat_skips === src.event_repeat_skips && back.event_repeat_until === src.event_repeat_until,
        `an import restores the rule and the dates byte for byte (got ${back.event_repeat} ${back.event_repeat_skips})`);
    assert(backRsvp?.occurrence_at === exportedRsvp?.occurrenceAt, `and each RSVP's date (got ${backRsvp?.occurrence_at})`);

    // ── 11. An RSVP from before this build ──────────────────────────────────────────────────────
    console.log('\n── 11. An RSVP from before this build, on an event an edit makes repeating ──');
    const und = await create(undatedHost, { eventStartLocal: '2028-05-05T20:50', eventEndLocal: '2028-05-05T22:50', eventTz: SYD });
    const undId = und.body?.post?.id as string;
    rsvpEvent(() => {}, undId, regular.pubKeyHex, 'going');
    // What the ALTER leaves on every RSVP written before this build: no date.
    db.prepare(`UPDATE event_rsvps SET occurrence_at = NULL, reminder_offsets = '[1440]' WHERE post_id = ? AND member_pubkey = ?`).run(undId, regular.pubKeyHex);
    const addRule = await signed('POST', '/api/marketplace/posts/update', { id: undId, authorPublicKey: undatedHost.pubKeyHex, eventRepeat: weeklyFri }, undatedHost);
    const stamped = db.prepare('SELECT occurrence_at FROM event_rsvps WHERE post_id = ? AND member_pubkey = ?').get(undId, regular.pubKeyHex) as any;
    assert(addRule.status === 200 && !!row(undId).event_repeat && stamped?.occurrence_at === row(undId).event_start_at,
        `an edit that makes it repeating stamps the undated RSVP with its current date (got ${addRule.status} ${addRule.error ?? ''} ${stamped?.occurrence_at})`);
    rollDueSeries(undefined, Date.parse(row(undId).event_end_at) + 1000);
    const undHostView = await readEvent(undId, undatedHost);
    const undRegView = await readEvent(undId, regular);
    assert(row(undId).event_start_local === '2028-05-12T20:50' && undHostView?.goingCount === 0,
        `so its next date starts at nobody going (got ${row(undId).event_start_local}, ${undHostView?.goingCount} going)`);
    assert(undRegView?.myRsvp === null && undRegView?.myLastRsvp?.status === 'going',
        `and the member's RSVP reads as last week's (got ${JSON.stringify({ my: undRegView?.myRsvp, last: undRegView?.myLastRsvp ?? null })})`);
    const dueNext = dueEventReminders(Date.parse(row(undId).event_start_at) - DAY + 30_000).filter(d => d.postId === undId);
    assert(dueNext.length === 0, `no reminder for the next date to that member (got ${dueNext.length})`);
    let undEnd = Date.parse(row(undId).event_end_at) + 1000;
    for (let i = 0; i < 5; i++) { rollDueSeries(undefined, undEnd); undEnd = Date.parse(row(undId).event_end_at) + 1000; }
    pruneStaleRsvps(undEnd, true);
    assert(!db.prepare('SELECT 1 FROM event_rsvps WHERE post_id = ? AND member_pubkey = ?').get(undId, regular.pubKeyHex),
        'and the prune takes it a month after its date');

    // ── 12. A DST gap day ───────────────────────────────────────────────────────────────────────
    console.log('\n── 12. A DST gap day: its end clock, and a re-save keeps the rule\'s own clock ──');
    // Sydney's clocks jump 02:00 → 03:00 on Sun 3 Oct 2027.
    const sundays = { freq: 'weekly', interval: 1, byDay: 'SU' };
    const gap = await create(gapHost, { eventStartLocal: '2027-09-26T02:30', eventEndLocal: '2027-09-26T03:30', eventTz: SYD, eventRepeat: sundays });
    const gapId = gap.body?.post?.id as string;
    rollDueSeries(undefined, Date.parse(row(gapId).event_end_at) + 1000);
    const g1 = row(gapId);
    assert(g1.event_start_local === '2027-10-03T03:30' && g1.event_end_local === '2027-10-03T04:30' && Date.parse(g1.event_end_at) - Date.parse(g1.event_start_at) === HOUR,
        `on the gap Sunday 02:30-03:30 reads 03:30-04:30, an hour, its end clock the end it stores (got ${g1.event_start_local}-${g1.event_end_local})`);
    const resave = await signed('POST', '/api/marketplace/posts/update', {
        id: gapId, authorPublicKey: gapHost.pubKeyHex, title: 'Early swim', eventStartLocal: g1.event_start_local, eventEndLocal: g1.event_end_local,
        eventTz: SYD, eventRepeat: sundays,
    }, gapHost);
    assert(resave.status === 200 && JSON.parse(row(gapId).event_repeat ?? '{}').time === '02:30' && JSON.parse(row(gapId).event_repeat ?? '{}').minutes === 60,
        `a form re-saving the gap day's clocks with the rule keeps the rule's 02:30 and its hour (got ${resave.status} ${resave.error ?? ''} ${row(gapId).event_repeat})`);
    rollDueSeries(undefined, Date.parse(row(gapId).event_end_at) + 1000);
    assert(row(gapId).event_start_local === '2027-10-10T02:30', `so the next Sunday is 02:30 again (got ${row(gapId).event_start_local})`);

    // ── 13. The host lets people in, on a repeating event ───────────────────────────────────────
    console.log('\n── 13. "Only people I let in" on a repeating event: the note, the link and the chat wait, across dates ──');
    const doorHost = makeIdentity('DoorDot');
    const inAnn = makeIdentity('InAnn');
    const waitWes = makeIdentity('WaitWes');
    const lateLu = makeIdentity('LateLu');
    const NOTE = 'Door code 4711';
    const LINK = 'https://meet.example.org/door';
    const door = await create(doorHost, {
        lat: undefined, lng: undefined, eventOnline: true, eventLink: LINK, eventPrivateNote: NOTE, eventHostLetsIn: true,
        eventStartLocal: '2028-06-02T19:00', eventEndLocal: '2028-06-02T21:00', eventTz: SYD, eventRepeat: weeklyFri,
    });
    const doorId = door.body?.post?.id as string;
    assert(door.status === 200 && door.body?.post?.eventHostLetsIn === true && door.body?.post?.eventRepeat?.byDay === 'FR',
        `a weekly online event whose host lets people in is accepted (got ${door.status} ${door.error ?? ''})`);
    const chatStatus = async (who: Id) => (await signed('GET', `/api/marketplace/posts/${doorId}/chat`, null, who)).status;
    const letIn = (body: Record<string, unknown>) => signed('POST', `/api/marketplace/posts/${doorId}/let-in`, body, doorHost);
    rsvpEvent(() => {}, doorId, inAnn.pubKeyHex, 'going');
    rsvpEvent(() => {}, doorId, waitWes.pubKeyHex, 'going');
    const letAnn = await letIn({ memberPublicKey: inAnn.pubKeyHex });
    assert(letAnn.status === 200 && letAnn.body?.changed === 1, `the host lets one of the two in (got ${letAnn.status} ${letAnn.error ?? ''})`);
    const ann0 = await readEvent(doorId, inAnn);
    const wes0 = await readEvent(doorId, waitWes);
    assert(ann0?.eventPrivateNote === NOTE && ann0?.eventLink === LINK && ann0?.myLetIn === true && await chatStatus(inAnn) === 200,
        `let in: the note, the link and the chat (got ${JSON.stringify({ note: ann0?.eventPrivateNote ?? null, link: ann0?.eventLink ?? null, letIn: ann0?.myLetIn })})`);
    assert(wes0?.eventPrivateNote === undefined && wes0?.eventLink === undefined && wes0?.myLetIn === false && await chatStatus(waitWes) === 403,
        `Going and not let in: no note, no link, the chat refused, as on a one-off (got ${JSON.stringify({ note: wes0?.eventPrivateNote ?? null, link: wes0?.eventLink ?? null, letIn: wes0?.myLetIn })})`);
    rollDueSeries(undefined, Date.parse(row(doorId).event_end_at) + 1000);
    assert(row(doorId).event_start_local === '2028-06-09T19:00', `it rolls to the next Friday (got ${row(doorId).event_start_local})`);
    const ann1 = await readEvent(doorId, inAnn);
    const wes1 = await readEvent(doorId, waitWes);
    assert(ann1?.myRsvp === null && ann1?.myLastRsvp?.status === 'going' && ann1?.eventPrivateNote === NOTE && ann1?.eventLink === LINK
        && await chatStatus(inAnn) === 200,
        `after the roll, last week's let-in still reads the series' note, link and chat (got ${JSON.stringify({ my: ann1?.myRsvp, note: ann1?.eventPrivateNote ?? null })})`);
    assert(wes1?.eventPrivateNote === undefined && wes1?.eventLink === undefined && await chatStatus(waitWes) === 403,
        `and last week's Going never let in still gets none of them (got ${JSON.stringify({ note: wes1?.eventPrivateNote ?? null, link: wes1?.eventLink ?? null })})`);
    assert(eventWaitingCount(loadEventForThread(doorId)) === 0,
        `nobody waits for this date: last week's Going is not counted (got ${eventWaitingCount(loadEventForThread(doorId))})`);
    rsvpEvent(() => {}, doorId, lateLu.pubKeyHex, 'going');
    const host1 = await readEvent(doorId, doorHost);
    const waitingRows = (host1?.eventRsvps ?? []).filter((v: any) => v.status === 'going' && v.letInAt === null).length;
    assert(eventWaitingCount(loadEventForThread(doorId)) === 1 && waitingRows === 1,
        `one taps Going for this date: the count and the host's list both say one waits (got ${eventWaitingCount(loadEventForThread(doorId))}, list ${waitingRows})`);
    const all = await letIn({ everyone: true });
    const wesLetIn = (db.prepare('SELECT let_in_at FROM event_rsvps WHERE post_id = ? AND member_pubkey = ?').get(doorId, waitWes.pubKeyHex) as any)?.let_in_at;
    assert(all.status === 200 && all.body?.changed === 1 && wesLetIn === null,
        `"let everyone in" lets in this date's Going, not last week's the host's list no longer shows (got ${all.status} changed ${all.body?.changed}, Wes ${wesLetIn})`);
    rsvpEvent(() => {}, doorId, inAnn.pubKeyHex, 'going');
    rsvpEvent(() => {}, doorId, waitWes.pubKeyHex, 'going');
    const ann2 = await readEvent(doorId, inAnn);
    const wes2 = await readEvent(doorId, waitWes);
    assert(ann2?.myRsvp === 'going' && ann2?.myLetIn === true && ann2?.eventPrivateNote === NOTE,
        `a regular let in once taps Going again and is in at once (got ${JSON.stringify({ my: ann2?.myRsvp, letIn: ann2?.myLetIn })})`);
    assert(wes2?.myRsvp === 'going' && wes2?.myLetIn === false && wes2?.eventPrivateNote === undefined && eventWaitingCount(loadEventForThread(doorId)) === 1,
        `one never let in taps Going again and waits, counted now (got ${JSON.stringify({ my: wes2?.myRsvp, letIn: wes2?.myLetIn })}, ${eventWaitingCount(loadEventForThread(doorId))} waiting)`);
    // A take-back reaches everyone let in, any date (the #1945 merge review's N2). After the next roll, Lu (let in for
    // 9 June, not Going for 16 June) is on no list the host sees: "take back everyone" is the host's one way to reach them.
    rollDueSeries(undefined, Date.parse(row(doorId).event_end_at) + 1000);
    rsvpEvent(() => {}, doorId, inAnn.pubKeyHex, 'going');
    const letInAt = (who: Id) => (db.prepare('SELECT let_in_at FROM event_rsvps WHERE post_id = ? AND member_pubkey = ?')
        .get(doorId, who.pubKeyHex) as { let_in_at: string | null } | undefined)?.let_in_at ?? null;
    const heldBefore = (db.prepare('SELECT COUNT(*) AS n FROM event_rsvps WHERE post_id = ? AND let_in_at IS NOT NULL').get(doorId) as { n: number }).n;
    const lu3 = await readEvent(doorId, lateLu);
    const ann3 = await readEvent(doorId, inAnn);
    assert(row(doorId).event_start_local === '2028-06-16T19:00' && heldBefore === 2 && lu3?.myRsvp === null && lu3?.myLastRsvp?.status === 'going'
        && lu3?.eventPrivateNote === NOTE && lu3?.eventLink === LINK && await chatStatus(lateLu) === 200 && ann3?.myRsvp === 'going' && ann3?.myLetIn === true,
        `rolled to 16 June: two let in, Lu (last week's, not Going this date) still reads the note, link and chat, Ann is Going and in (got ${row(doorId).event_start_local}, ${heldBefore} let in, Lu ${JSON.stringify({ my: lu3?.myRsvp, note: lu3?.eventPrivateNote ?? null })})`);
    const takeBack = await letIn({ everyone: true, letIn: false });
    assert(takeBack.status === 200 && takeBack.body?.changed === 2 && letInAt(lateLu) === null && letInAt(inAnn) === null,
        `"take back everyone" reaches both: last week's let-in and this date's Going (got ${takeBack.status} changed ${takeBack.body?.changed}, Lu ${letInAt(lateLu)}, Ann ${letInAt(inAnn)})`);
    for (const [name, who] of [['last week\'s let-in', lateLu], ['this date\'s Going', inAnn]] as const) {
        const seen = await readEvent(doorId, who);
        const chat = await chatStatus(who);
        assert(seen?.eventPrivateNote === undefined && seen?.eventLink === undefined && chat === 403,
            `then ${name} reads no note, no link, the chat refused (got ${JSON.stringify({ note: seen?.eventPrivateNote ?? null, link: seen?.eventLink ?? null, chat })})`);
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Repeating events over HTTP PASSED.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

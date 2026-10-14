/**
 * Repeating events, slice 4 (scratch/global-node/DESIGN-event-times-fable.md §8, §10 and Director amendment 2), over REAL
 * HTTP — through the signature middleware — for create, read and cancel-a-date, and on the engine for the minute roll,
 * the reminder sweep, the prune and the copy, which no route drives (each is given its own clock).
 *
 * Verifies:
 *  1. A weekly series is created from the host's clock: the rule stored in its closed shape with the typed time and
 *     length; a first date not on the rule, an `until` before it or past 5 years, a rule the form never sends, a date
 *     longer than the gap to the next, and a repeating online event with no zone are each refused in words.
 *  2. The roll across the Sydney DST start: the local clocks are equal and the instants an hour apart; the state goes back
 *     to scheduled; the next date starts at nobody going (counts reset), the regular's RSVP reads as last week's
 *     (myLastRsvp), they keep the chat; a broadcast goes out. Between a date's end and the roll the chat stays open.
 *  3. Monthly on the 31st skips February; monthly on the last Friday.
 *  4. Until: the last date is the last; after it the series ends as a one-off does and is never rolled again.
 *  5. Cancel a date (POST/DELETE /api/events/:id/skip): host only; a date that is not the series' refused; cancelling the
 *     current date rolls at once and tells Going "… is cancelled. Next: …"; restoring it moves the series back; the only
 *     date left can't be cancelled.
 *  6. Reminders fire once per date: a regular is reminded for this week's date and next week's, once each; an RSVP for
 *     last week's date gets no reminder for this week's; a one-off moved by an edit sends nothing twice.
 *  7. A standby never rolls (nor prunes).
 *  8. The cap of 5 upcoming counts a series once, before and after it rolls.
 *  9. The 30-day prune: an RSVP for a date a month gone goes, with its tombstone and the chat seat (the host keeps theirs).
 * 10. A copy carries the rule, the last date, the cancelled dates and each RSVP's date, and an import restores them.
 * 11. Amendment 2: an online event is in a member's set on a node that syncs by area, wherever their area is.
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
import { rsvpEvent } from './engine/posts.js';
import { runEventReminderSweep } from './engine/event-reminders.js';
import { rollDueSeries, pruneStaleRsvps, setSeriesDateSkipped, SKIP_HOST_ONLY, SKIP_LAST_DATE, DATE_CANCELLED_PUSH_TITLE } from './engine/event-series-roll.js';
import { eventThreadReadOnlyReason, loadEventForThread } from './engine/event-thread.js';
import { setMemberPhoto, getNearbySet, REPEAT_ERRORS } from '@beanpool/engine';
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
    rsvpEvent(() => {}, skId, regular.pubKeyHex, 'going');
    const pushes: Array<{ to: string[]; title: string; body: string }> = [];
    const push = ((to: string[], _from: string, title: string, body: string) => { pushes.push({ to, title, body }); }) as any;
    const cur = setSeriesDateSkipped(undefined, push, skId, skipper.pubKeyHex, '2027-12-03', true);
    // The cancelled 3rd is behind the series' date now, so it leaves the list (the roll never looks back); the 17th stays.
    assert(row(skId).event_start_local === '2027-12-10T19:00' && JSON.stringify(cur.skips) === '["2027-12-17"]'
        && cur.post.eventNextDates?.[0]?.date === '2027-12-10',
        `cancelling the current date rolls it at once to Fri 10 Dec (got ${row(skId).event_start_local} ${JSON.stringify(cur.skips)})`);
    assert(pushes.length === 1 && pushes[0].to.includes(regular.pubKeyHex) && pushes[0].title === DATE_CANCELLED_PUSH_TITLE
        && pushes[0].body === 'Friday dinner: Fri 3 Dec is cancelled. Next: Fri 10 Dec.',
        `Going for it are told (got ${JSON.stringify(pushes)})`);
    const restore = await signed('DELETE', `/api/events/${skId}/skip`, { date: '2027-12-03' }, skipper);
    assert(restore.status === 200 && row(skId).event_start_local === '2027-12-03T19:00' && !(restore.body?.skips ?? []).includes('2027-12-03'),
        `restoring it moves the series back to Fri 3 Dec (got ${restore.status} ${row(skId).event_start_local} ${JSON.stringify(restore.body?.skips)})`);
    // The 24th is the last date: cancel the 10th and the 24th, then roll to the 24th and try to cancel it.
    await signed('POST', `/api/events/${skId}/skip`, { date: '2027-12-10' }, skipper);
    rollDueSeries(undefined, Date.parse(row(skId).event_end_at) + 1000);
    assert(row(skId).event_start_local === '2027-12-24T19:00', `the roll passes the cancelled 10th and 17th (got ${row(skId).event_start_local})`);
    const lastOne = await signed('POST', `/api/events/${skId}/skip`, { date: '2027-12-24' }, skipper);
    assert(lastOne.status === 400 && lastOne.error === SKIP_LAST_DATE, `the only date left can't be cancelled (got ${lastOne.status} ${lastOne.error})`);

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
    await signed('POST', `/api/events/${rsId}/skip`, { date: row(rsId).event_start_local.slice(0, 10) === '2028-01-21' ? '2028-02-04' : '2028-02-11' }, remind);
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

    // ── 11. Amendment 2 ─────────────────────────────────────────────────────────────────────────
    console.log('\n── 11. Online events reach every member\'s set ──');
    const onl = await create(onlineHost, { lat: undefined, lng: undefined, eventOnline: true, eventStartLocal: '2028-04-07T19:00', eventTz: SYD, eventRepeat: weeklyFri });
    const onlId = onl.body?.post?.id as string;
    assert(onl.status === 200 && !!onlId, `a weekly online event with a zone is accepted (got ${onl.status} ${onl.error ?? ''})`);
    // A member whose area is in Lagos, half a world from any pin here.
    const set = getNearbySet(db, stranger.pubKeyHex, { area: { lat: 6.5, lng: 3.4 }, radiusKm: 50, max: 100, newestWithoutArea: 100 });
    assert(set.ids.includes(onlId) && !set.ids.includes(sid), `the online event is in a far member's set; a Sydney one is not (got ${set.ids.length} ids)`);
    const noEvents = getNearbySet(db, stranger.pubKeyHex, { area: { lat: 6.5, lng: 3.4 }, radiusKm: 50, max: 100, newestWithoutArea: 100, excludeEvents: true });
    assert(!noEvents.ids.includes(onlId), 'a set read without events holds none');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Repeating events over HTTP PASSED.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

/**
 * "Your events" and reminders over REAL HTTP — through the signature middleware, not the router alone.
 *
 * This suite exists for the same reason test-enterprise-event-http.ts does, and it is the lesson #1054
 * charged us for one more time: a route whose own tests drive the handler directly can be dead on the wire
 * and still green. The middleware refuses unsigned writes, refuses gated reads, consumes nonces, and
 * rejects any body field that names somebody other than the signer — so a new route has to be driven over
 * the wire before anyone can say it works.
 *
 * Every check here goes over the wire:
 *  1. GET /api/events/mine is the SIGNER's own RSVPs and nobody else's, soonest first, and it needs a
 *     signature: unsigned is 401.
 *  2. Cancelled and ended events are not on it.
 *  3. PUT /api/events/:postId/reminder saves this member's reminders for that event and nobody else's.
 *  4. …on an event the signer has no RSVP on: 403.
 *  5. …with an offset outside the five: 400, and nothing is written.
 *  6. …unsigned: 401 from the middleware, before the route runs.
 *  7. The Settings default rides on the existing member preferences: GET returns eventReminderOffsets and
 *     POST saves it, both signed, and a bad value is a 400 that saves nothing at all.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-event-reminders-http.ts
 */

process.env.TZ = 'UTC';
// Self-signed cert in LAN mode → relax TLS verification for the test client only.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { createPost as createPostEngine, removePost, rsvpEvent } from './engine/posts.js';

const PORT = 8703;
const BASE = `https://localhost:${PORT}`;
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.now();
const at = (ms: number) => new Date(T0 + ms).toISOString();

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ FAIL: ${msg}`); }
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };

function makeIdentity(callsign: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, avatar_url, status, joined_at, updated_at)
                VALUES (?, ?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
        .run(pubKeyHex, callsign, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
    return { pubKeyHex, privateKey };
}

/** The replay-proof scheme the real middleware requires: method + path + timestamp + nonce + body. */
async function signedFetch(method: 'GET' | 'POST' | 'PUT', path: string, body: unknown, id: Id | null) {
    // A GET carries no body, and the middleware signs the empty string for it — send neither.
    const bodyString = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        // The middleware signs `ctx.path`, which does NOT include the query string — a client that signs
        // `?publicKey=…` too gets a 403 from a valid key, which is exactly what real clients do.
        const canonical = `${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`;
        headers['X-Public-Key'] = id.pubKeyHex;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, {
        method, headers, body: method === 'GET' ? undefined : bodyString,
    });
    let json: any;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body: json, error: json?.error as string | undefined };
}

let hostSeq = 0;
/** An event starting `startMs` from now. A fresh host each time — five upcoming events per member is the cap. */
function newEvent(startMs: number, title: string) {
    const author = makeIdentity(`EvHost${++hostSeq}`).pubKeyHex;
    return createPostEngine(() => { }, 'event', 'other', title, 'Bring gloves', 0, 'fixed', author,
        -28.55, 153.5, [], false, undefined, true,
        { eventStartAt: at(startMs), eventEndAt: at(startMs + 2 * HOUR), eventPlaceName: 'The old bowls club' } as any)!;
}

const storedOffsets = (postId: string, pubkey: string): string | null =>
    (db.prepare('SELECT reminder_offsets AS o FROM event_rsvps WHERE post_id = ? AND member_pubkey = ?')
        .get(postId, pubkey) as any)?.o ?? null;

async function main(): Promise<void> {
    console.log('\nYour events and reminders, over real HTTP\n');
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    const me = makeIdentity('MineMaeve');
    const someoneElse = makeIdentity('OtherOtto');

    const soon = newEvent(2 * DAY, 'Soonest');
    const later = newEvent(5 * DAY, 'Later');
    const theirs = newEvent(3 * DAY, 'Not mine');
    const calledOff = newEvent(4 * DAY, 'Called off');

    rsvpEvent(() => { }, later.id, me.pubKeyHex, 'going');
    rsvpEvent(() => { }, soon.id, me.pubKeyHex, 'interested');
    rsvpEvent(() => { }, calledOff.id, me.pubKeyHex, 'going');
    rsvpEvent(() => { }, theirs.id, someoneElse.pubKeyHex, 'going');

    // ── 1. GET /api/events/mine ──────────────────────────────────────────────────────────────
    console.log('── 1. Your events ──');
    const unsignedList = await signedFetch('GET', '/api/events/mine', null, null);
    assert(unsignedList.status === 401, `an unsigned read of your events is refused (got ${unsignedList.status})`);

    const list = await signedFetch('GET', '/api/events/mine', null, me);
    assert(list.status === 200, `a signed read is accepted through the real middleware (got ${list.status} ${list.error ?? ''})`);
    const titles = (list.body?.events ?? []).map((e: any) => e.title);
    assert(titles.join() === 'Soonest,Called off,Later',
        `every event this member RSVPed to, soonest first (got ${titles.join()})`);
    assert(!titles.includes('Not mine'), '...and never an event somebody else RSVPed to');
    const firstEvent = list.body?.events?.[0];
    assert(firstEvent?.postId === soon.id && firstEvent?.rsvp === 'interested'
        && firstEvent?.startAt === at(2 * DAY) && firstEvent?.placeName === 'The old bowls club'
        && firstEvent?.photo === null && firstEvent?.reminderOffsets === null,
        '...in the shape the two lanes agreed: postId, rsvp, startAt, placeName, photo, reminderOffsets');

    const theirList = await signedFetch('GET', '/api/events/mine', null, someoneElse);
    assert((theirList.body?.events ?? []).map((e: any) => e.title).join() === 'Not mine',
        'a different signer gets a different list — the actor comes from the signature, not a parameter');

    // ── 2. Cancelled and ended drop off ──────────────────────────────────────────────────────
    console.log('\n── 2. Cancelled and ended ──');
    removePost(() => { }, calledOff.id, calledOff.authorPublicKey);
    const afterCancel = await signedFetch('GET', '/api/events/mine', null, me);
    assert(!(afterCancel.body?.events ?? []).some((e: any) => e.postId === calledOff.id),
        'a cancelled event leaves "your events"');

    // An event whose end has passed goes the same way. Moved in the table rather than waited for.
    db.prepare(`UPDATE posts SET event_start_at = ?, event_end_at = ? WHERE id = ?`)
        .run(at(-2 * DAY), at(-2 * DAY + HOUR), soon.id);
    const afterEnd = await signedFetch('GET', '/api/events/mine', null, me);
    assert(!(afterEnd.body?.events ?? []).some((e: any) => e.postId === soon.id),
        'an event that has ended leaves it too');

    // ── 3. Setting a reminder for one event ──────────────────────────────────────────────────
    console.log('\n── 3. Per-event reminders ──');
    const path = `/api/events/${later.id}/reminder`;
    const set = await signedFetch('PUT', path, { offsets: [1440, 60] }, me);
    assert(set.status === 200 && set.body?.success === true,
        `a signed PUT is accepted (got ${set.status} ${set.error ?? ''})`);
    assert(set.body?.reminderOffsets?.join() === '1440,60', '...and answers with what was saved');
    assert(storedOffsets(later.id, me.pubKeyHex) === '[1440,60]', '...which is what is in the row');

    const backToDefault = await signedFetch('PUT', path, { offsets: null }, me);
    assert(backToDefault.status === 200 && storedOffsets(later.id, me.pubKeyHex) === null,
        'null puts the event back on the member’s own default');

    const none = await signedFetch('PUT', path, { offsets: [] }, me);
    assert(none.status === 200 && storedOffsets(later.id, me.pubKeyHex) === '[]',
        'an empty list turns reminders off for this event');

    // ── 4. No RSVP ───────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. Without an RSVP ──');
    const noRsvp = await signedFetch('PUT', `/api/events/${theirs.id}/reminder`, { offsets: [60] }, me);
    assert(noRsvp.status === 403, `a reminder on an event you have not RSVPed to is refused (got ${noRsvp.status})`);
    assert(storedOffsets(theirs.id, someoneElse.pubKeyHex) === null,
        '...and the OTHER member’s reminder on that event is untouched');

    // ── 5. A bad offset ──────────────────────────────────────────────────────────────────────
    console.log('\n── 5. A bad offset ──');
    for (const bad of [[15], [1441], ['1440'], [1440, 15], 'daily', 7, [null]]) {
        const res = await signedFetch('PUT', path, { offsets: bad }, me);
        assert(res.status === 400, `offsets ${JSON.stringify(bad)} is refused (got ${res.status})`);
    }
    assert(storedOffsets(later.id, me.pubKeyHex) === '[]', 'and none of them changed what was already saved');
    const missing = await signedFetch('PUT', path, {}, me);
    assert(missing.status === 400, 'a body with no offsets at all is refused rather than read as null');

    // ── 6. Unsigned ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 6. Unsigned ──');
    const unsigned = await signedFetch('PUT', path, { offsets: [60] }, null);
    assert(unsigned.status === 401, `an unsigned PUT never reaches the route (got ${unsigned.status})`);
    assert(storedOffsets(later.id, me.pubKeyHex) === '[]', '...and changed nothing');

    // ── 7. The Settings default ──────────────────────────────────────────────────────────────
    console.log('\n── 7. The Settings default ──');
    const prefs = await signedFetch('GET', `/api/members/preferences?publicKey=${me.pubKeyHex}`, null, me);
    assert(prefs.status === 200, `preferences read back (got ${prefs.status} ${prefs.error ?? ''})`);
    assert(JSON.stringify(prefs.body?.eventReminderOffsets) === '[1440]',
        `everyone starts on the day before (got ${JSON.stringify(prefs.body?.eventReminderOffsets)})`);
    assert(prefs.body?.notify_marketplace === 'true', '...beside the notification toggles that were always there');

    const savePref = await signedFetch('POST', '/api/members/preferences',
        { publicKey: me.pubKeyHex, preferences: { eventReminderOffsets: [10080, 120], notify_chat: false } }, me);
    assert(savePref.status === 200 && savePref.body?.success === true,
        `a new default saves (got ${savePref.status} ${savePref.error ?? ''})`);
    const reread = await signedFetch('GET', `/api/members/preferences?publicKey=${me.pubKeyHex}`, null, me);
    assert(JSON.stringify(reread.body?.eventReminderOffsets) === '[10080,120]', '...and reads back');
    assert(reread.body?.notify_chat === 'false', '...alongside the toggle saved in the same request');

    const badPref = await signedFetch('POST', '/api/members/preferences',
        { publicKey: me.pubKeyHex, preferences: { eventReminderOffsets: [15], notify_escrow: false } }, me);
    assert(badPref.status === 400, `a bad default is refused (got ${badPref.status})`);
    const afterBad = await signedFetch('GET', `/api/members/preferences?publicKey=${me.pubKeyHex}`, null, me);
    assert(JSON.stringify(afterBad.body?.eventReminderOffsets) === '[10080,120]'
        && afterBad.body?.notify_escrow === 'true',
        '...and the whole request is refused with it — no half-saved preferences');

    const offPref = await signedFetch('POST', '/api/members/preferences',
        { publicKey: me.pubKeyHex, preferences: { eventReminderOffsets: [] } }, me);
    const afterOff = await signedFetch('GET', `/api/members/preferences?publicKey=${me.pubKeyHex}`, null, me);
    assert(offPref.status === 200 && JSON.stringify(afterOff.body?.eventReminderOffsets) === '[]',
        'an empty list is how a member turns reminders off everywhere');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });

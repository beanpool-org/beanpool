/**
 * Events slice 5 — change and cancel notifications (docs/events-on-the-map.md §2.2, §4 row 5; decisions 10,
 * 27 and 29).
 *
 *  1. A change of time or of place (pin or place name) notifies everyone marked Going — and only them:
 *     never Interested, never a member with no RSVP, never the host who made the change.
 *  2. Every other edit — title, description, photo, private note — is silent, the same rule that decides
 *     whether the card shows UPDATED.
 *  3. Cancelling notifies Going, sets event_state = 'cancelled', and turns the event chat read-only.
 *  4. A keeper editing an enterprise's event is not notified of their own change, even though the request
 *     names the ENTERPRISE as the author.
 *  5. The whole way out to Expo: the payload goes on the existing `marketplace` category and Android
 *     channel, carries { screen: 'post', postId } so the phone opens /post/:id, and a member who turned
 *     notify_marketplace off gets nothing.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { db } from './db/db.js';
import {
    initStateEngine, createTreasury, adminAssignTreasuryOperator,
    removePost as removePostStateful, updatePost as updatePostStateful,
} from './state-engine.js';
import {
    createPost as createPostEngine, updatePost, removePost, rsvpEvent,
    EVENT_CANCELLED_PUSH_TITLE, EVENT_UPDATED_PUSH_TITLE, eventPushBody,
} from './engine/posts.js';
import { getEventThread } from './engine/event-thread.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ FAIL: ${msg}`);
}

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const HOUR = 60 * 60 * 1000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();

function makeMember(callsign: string): string {
    const pub = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, avatar_url, status, updated_at)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pub, callsign, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pub);
    return pub;
}

const broadcasts: any[] = [];
const capture = (event: any) => { broadcasts.push(event); };

/**
 * Wait out the current millisecond before the next write to the same post.
 *
 * NOT cosmetic, and not about events. `posts_touch_updated_at` (schema.sql) fires
 * `WHEN NEW.updated_at IS OLD.updated_at` and runs a nested `UPDATE posts` — and that nested update
 * interleaves with the posts_au FTS delete/insert pair, leaving the posts_fts external-content index out of
 * step with the row. The next edit that changes the title or description then throws SQLITE_CORRUPT_VTAB
 * ("database disk image is malformed") and is rolled back. `updatePost` stamps `updated_at` from
 * `Date.now()`, so two writes to one post inside a millisecond collide — which is what a test that edits the
 * same event several times in a row does every time, and what a retried or replayed request does in
 * production. This is a bug on main, reproduced on origin/main without any of this slice's code, and it is
 * reported with the PR rather than fixed here: the trigger is on every post write path, not just events.
 */
function nextMillisecond(): void {
    const t = Date.now();
    while (Date.now() === t) { /* spin: shorter than any timer, and this is a test */ }
}

/** Every call the engine made to the push dispatcher, in order. */
interface PushCall { targets: string[]; actor: string; title: string; body: string; data: any; category: string }
let pushes: PushCall[] = [];
const pushSpy = (targets: string[], actor: string, title: string, body: string, data: any, category: any) => {
    pushes.push({ targets, actor, title, body, data, category });
};
/** The dispatcher drops the actor itself, so the assertions below do the same to read as "who was told". */
const told = (call: PushCall | undefined): string[] => (call?.targets ?? []).filter(t => t !== call!.actor);

function newEvent(author: string, extra: Record<string, unknown> = {}, lat = -28.55, lng = 153.5) {
    return createPostEngine(capture, 'event', 'other', 'Working bee', 'Bring gloves', 0, 'fixed', author,
        lat, lng, [PHOTO], false, undefined, true,
        { eventStartAt: inHours(24), eventPlaceName: 'The old bowls club', eventPrivateNote: 'Gate code 1234', ...extra } as any)!;
}

async function main(): Promise<void> {
    initStateEngine();

    const host = makeMember('Host');
    const goer = makeMember('Goer');
    const alsoGoing = makeMember('AlsoGoing');
    const maybe = makeMember('Maybe');
    const stranger = makeMember('Stranger');

    // ── 1. A time or place change notifies Going, and nobody else ────────────────────────────
    console.log('\n--- 1. Time and place changes ---');
    const ev = newEvent(host);
    rsvpEvent(capture, ev.id, goer, 'going');
    rsvpEvent(capture, ev.id, alsoGoing, 'going');
    rsvpEvent(capture, ev.id, maybe, 'interested');

    pushes = [];
    nextMillisecond();
    const moved = inHours(48);
    assert(updatePost(capture, ev.id, host, { eventStartAt: moved } as any, pushSpy)?.eventState === 'updated',
        'a time change still marks the event UPDATED');
    assert(pushes.length === 1, 'a time change sends exactly one push batch');
    assert(told(pushes[0]).sort().join() === [goer, alsoGoing].sort().join(),
        'the two members marked Going are notified');
    assert(!pushes[0]?.targets.includes(maybe), 'a member marked Interested is NOT notified');
    assert(!pushes[0]?.targets.includes(stranger), 'a member with no RSVP is NOT notified');
    assert(pushes[0]?.actor === host, 'the host who made the change is the actor, so the dispatcher drops them');
    assert(pushes[0]?.title === EVENT_UPDATED_PUSH_TITLE && pushes[0]?.body === eventPushBody('updated', 'Working bee'),
        'the change notification names the event');
    assert(pushes[0]?.category === 'marketplace', 'it goes on the existing marketplace category (decision 27)');
    assert(pushes[0]?.data?.screen === 'post' && pushes[0]?.data?.postId === ev.id,
        'the payload routes the phone to /post/:id');

    pushes = [];
    nextMillisecond();
    updatePost(capture, ev.id, host, { lat: -28.61, lng: 153.51 } as any, pushSpy);
    assert(pushes.length === 1 && told(pushes[0]).length === 2, 'moving the pin notifies Going');

    pushes = [];
    nextMillisecond();
    updatePost(capture, ev.id, host, { eventPlaceName: 'The hall' } as any, pushSpy);
    assert(pushes.length === 1 && told(pushes[0]).length === 2, 'renaming the place notifies Going');

    pushes = [];
    nextMillisecond();
    updatePost(capture, ev.id, host, { eventPlaceName: 'The hall' } as any, pushSpy);
    assert(pushes.length === 0, 'setting the place name to what it already was notifies nobody');

    // ── 2. Every other edit is silent ────────────────────────────────────────────────────────
    console.log('\n--- 2. Silent edits ---');
    pushes = [];
    nextMillisecond();
    updatePost(capture, ev.id, host, { title: 'Working bee and morning tea' } as any, pushSpy);
    assert(pushes.length === 0, 'a title edit is silent');
    nextMillisecond();
    updatePost(capture, ev.id, host, { description: 'Bring gloves and a hat' } as any, pushSpy);
    assert(pushes.length === 0, 'a description edit is silent');
    nextMillisecond();
    updatePost(capture, ev.id, host, { eventPrivateNote: 'Gate code 9999' } as any, pushSpy);
    assert(pushes.length === 0, 'editing the note for people going is silent');
    nextMillisecond();
    updatePost(capture, ev.id, host, { photos: [PHOTO] } as any, pushSpy);
    assert(pushes.length === 0, 'changing the photo is silent');

    const quiet = newEvent(stranger);
    pushes = [];
    nextMillisecond();
    updatePost(capture, quiet.id, stranger, { eventStartAt: inHours(72) } as any, pushSpy);
    assert(pushes.length === 0, 'an event nobody is going to sends no push at all');

    // ── 3. Cancelling ────────────────────────────────────────────────────────────────────────
    console.log('\n--- 3. Cancel ---');
    pushes = [];
    nextMillisecond();
    assert(removePost(capture, ev.id, host, pushSpy) === true, 'the host cancels through the remove path');
    assert(pushes.length === 1 && told(pushes[0]).sort().join() === [goer, alsoGoing].sort().join(),
        'cancelling notifies everyone marked Going');
    assert(!pushes[0]?.targets.includes(maybe), 'cancelling does not notify Interested');
    assert(pushes[0]?.title === EVENT_CANCELLED_PUSH_TITLE && pushes[0].category === 'marketplace',
        'the cancellation goes out on the marketplace category too');
    const row = db.prepare('SELECT active, status, event_state FROM posts WHERE id = ?').get(ev.id) as any;
    assert(row.active === 0 && row.status === 'cancelled' && row.event_state === 'cancelled',
        'cancel sets active 0, status and state cancelled');
    const thread = getEventThread(ev.id, host);
    assert(thread.readOnly && !thread.canPost && /cancelled/i.test(thread.readOnlyReason || ''),
        'the event chat is read-only once the event is cancelled');

    const noRsvps = newEvent(stranger);
    pushes = [];
    assert(removePost(capture, noRsvps.id, stranger, pushSpy) === true, 'an event with no RSVPs still cancels');
    assert(pushes.length === 0, 'and notifies nobody');

    // Only events notify: cancelling an ordinary listing must not push on this path.
    const offer = createPostEngine(capture, 'offer', 'other', 'Spare tomatoes', 'Free to a good home', 5,
        'fixed', stranger, undefined, undefined, [], false)!;
    pushes = [];
    assert(removePost(capture, offer.id, stranger, pushSpy) === true, 'an offer can still be removed');
    assert(pushes.length === 0, 'removing an offer sends no event notification');

    // ── 4. A keeper is not notified of their own change ──────────────────────────────────────
    console.log('\n--- 4. Enterprise host ---');
    const enterprisePubkey = createTreasury('Bindarrabi Hall', AVATAR, 0).publicKey;
    const keeper = makeMember('Keeper');
    adminAssignTreasuryOperator(enterprisePubkey, keeper, 'admin');
    const entEvent = newEvent(enterprisePubkey);
    rsvpEvent(capture, entEvent.id, goer, 'going');
    rsvpEvent(capture, entEvent.id, keeper, 'going');

    pushes = [];
    // The route sends the ENTERPRISE as authorPublicKey and the signed keeper as the actor.
    updatePost(capture, entEvent.id, enterprisePubkey, { eventStartAt: inHours(96) } as any, pushSpy, keeper);
    assert(pushes.length === 1, 'a keeper moving an enterprise event notifies Going');
    assert(told(pushes[0]).join() === goer, 'the keeper who made the change is not notified of it');

    pushes = [];
    // Without a signed actor the author is the fallback, which is the enterprise — nobody is dropped wrongly.
    nextMillisecond();
    updatePost(capture, entEvent.id, enterprisePubkey, { eventStartAt: inHours(120) } as any, pushSpy);
    assert(pushes.length === 1 && told(pushes[0]).sort().join() === [goer, keeper].sort().join(),
        'with no signed actor everyone going is notified');

    // ── 5. All the way out to Expo, through the wired-up state engine ────────────────────────
    console.log('\n--- 5. The dispatcher, the channel and the preference ---');
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
        db.prepare(`INSERT OR REPLACE INTO push_tokens (public_key, token, platform) VALUES (?, ?, 'android')`)
            .run(maybe, 'ExponentPushToken[maybe]');

        const wired = newEvent(host);
        rsvpEvent(capture, wired.id, goer, 'going');
        rsvpEvent(capture, wired.id, maybe, 'interested');

        sent.length = 0;
        nextMillisecond();
        // state-engine's own wrappers: this is the path the HTTP routes take.
        updatePostStateful(wired.id, host, { eventStartAt: inHours(30) } as any, host);
        // The dispatcher fires the HTTP send without awaiting it.
        await new Promise(r => setImmediate(r));
        assert(sent.length === 1, 'the wired-up update route sends one push message');
        assert(sent[0]?.to === 'ExponentPushToken[goer]', 'to the member marked Going');
        assert(sent[0]?.channelId === 'marketplace' && sent[0].categoryId === 'marketplace',
            'on the marketplace Android channel and category — no app in the store needs an update (decision 27)');
        assert(sent[0]?.title === EVENT_UPDATED_PUSH_TITLE, 'with the change title');
        assert(sent[0]?.data?.screen === 'post' && sent[0]?.data?.postId === wired.id,
            'and the payload the phone routes to /post/:id');

        sent.length = 0;
        nextMillisecond();
        removePostStateful(wired.id, host);
        await new Promise(r => setImmediate(r));
        assert(sent.length === 1 && sent[0]?.title === EVENT_CANCELLED_PUSH_TITLE && sent[0]?.channelId === 'marketplace',
            'the wired-up cancel route sends the cancellation on the same channel');

        // A member who turned Marketplace notifications off hears nothing.
        const optedOut = newEvent(host);
        rsvpEvent(capture, optedOut.id, goer, 'going');
        db.prepare(`INSERT OR REPLACE INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, 'notify_marketplace', 'false')`).run(goer);
        sent.length = 0;
        nextMillisecond();
        updatePostStateful(optedOut.id, host, { eventStartAt: inHours(34) } as any, host);
        await new Promise(r => setImmediate(r));
        assert(sent.length === 0, 'a member with notify_marketplace off is not pushed to');
    } finally {
        (globalThis as any).fetch = realFetch;
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });

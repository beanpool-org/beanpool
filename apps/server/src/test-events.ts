/**
 * Events slice 1 — server: event post, RSVP, opt-in guard (docs/events-on-the-map.md §2, §4 row 1).
 *
 *  1. Create validates start (future), end (after start), pin, place name ≤ 80, note ≤ 1000, audience.
 *  2. End defaults to start + 2 hours.
 *  3. Reach is forced local; credits/category/price forced as for polls; pin and photos kept.
 *  4. Cap of 5 upcoming events per author, with member, enterprise and group pools separate.
 *  5. RSVP upsert (going ↔ interested) and delete (not going), refused on cancelled/ended/non-group-member.
 *  6. Private note: host and Going only; never in a broadcast.
 *  7. GET /api/marketplace/posts omits events without `types=` (also in sync mode); includes them with it;
 *     a types= list is intersected with the known types, so a very long one cannot 500.
 *  8. Ended events leave the feed; by id they stay readable to the host and Going only.
 *  9. Edit: time/place change marks UPDATED, other edits do not; convenor may edit; cancel via remove.
 * 10. Events cannot be traded.
 * 11. Sync round-trip of event fields and event_rsvps, including a "not going" tombstone, and the hash.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { db } from './db/db.js';
import {
    initStateEngine, createTreasury, adminAssignTreasuryOperator, createPost, requestPost,
    exportSyncState, importRemoteState, setNodeRole, signSyncPayload,
} from './state-engine.js';
import { createPost as createPostEngine, updatePost, removePost, rsvpEvent } from './engine/posts.js';
import { createMarketplaceRoutes } from './routes/marketplace.js';
import { getPosts, getStateHash } from '@beanpool/engine';
import { startP2P } from './p2p.js';
import { addConnector } from './connector-manager.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ FAIL: ${msg}`);
}
function assertThrows(fn: () => unknown, match: RegExp, msg: string): void {
    run++;
    try {
        fn();
        console.error(`✗ FAIL: ${msg} (nothing thrown)`);
    } catch (e: any) {
        if (match.test(e?.message ?? '')) { passed++; console.log(`✓ ${msg}`); }
        else console.error(`✗ FAIL: ${msg} (got "${e?.message}")`);
    }
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

function newEvent(author: string, extra: Record<string, unknown> = {}, lat = -28.55, lng = 153.5) {
    return createPostEngine(capture, 'event', 'other', 'Working bee', 'Bring gloves', 50, 'hourly', author,
        lat, lng, [PHOTO], true, undefined, true,
        { eventStartAt: inHours(24), eventPlaceName: 'The old bowls club', eventPrivateNote: 'Gate code 1234', reach: 'everywhere', ...extra } as any)!;
}

/** Move an event into the past without going through the validation that forbids it. */
function endEvent(id: string, endedAgoMs = HOUR): void {
    const end = new Date(Date.now() - endedAgoMs).toISOString();
    const start = new Date(Date.now() - endedAgoMs - 2 * HOUR).toISOString();
    db.prepare(`UPDATE posts SET event_start_at = ?, event_end_at = ? WHERE id = ?`).run(start, end, id);
}

async function dispatch(router: any, method: string, path: string, ctx: any) {
    const matched = router.match(path, method);
    const layer = matched.pathAndMethod.find((l: any) => l.methods.includes(method));
    if (!layer) throw new Error(`No route found for ${method} ${path}`);
    await layer.stack[layer.stack.length - 1](ctx);
    return ctx;
}

function listCtx(query: Record<string, string>, actor?: string): any {
    const querystring = new URLSearchParams(query).toString();
    return {
        query, querystring, state: actor ? { actor } : {}, params: {},
        get: () => '', set: () => { }, headers: {},
    };
}

async function listIds(router: any, query: Record<string, string>, actor?: string): Promise<string[]> {
    const ctx = await dispatch(router, 'GET', '/api/marketplace/posts', listCtx(query, actor));
    return (JSON.parse(ctx.body) as any[]).map(p => p.id);
}

async function main(): Promise<void> {
    initStateEngine();
    const p2pNode = await startP2P(4042, 4043);
    const nodeId = p2pNode.peerId.toString();
    addConnector(`/ip4/127.0.0.1/tcp/4043/p2p/${nodeId}`, 'mirror', 'self-test-peer');

    const router = createMarketplaceRoutes({
        clampLimit: (n: any) => Number(n) || 50,
        clampOffset: (n: any) => Number(n) || 0,
        enforceReadAuth: false,
    } as any);

    const host = makeMember('Host');
    const goer = makeMember('Goer');
    const maybe = makeMember('Maybe');
    const stranger = makeMember('Stranger');
    const convenor = makeMember('Convenor');
    const groupie = makeMember('Groupie');

    // ── 1. Validation ────────────────────────────────────────────────────────────────────────
    console.log('\n--- 1. Create validation ---');
    const base = (o: Record<string, unknown>, pin: [number, number] | null = [-28.5, 153.5]) =>
        () => createPostEngine(capture, 'event', 'community', 'T', 'D', 0, 'fixed', host, pin?.[0], pin?.[1], [], false, undefined, false, o as any);
    assertThrows(base({}), /Start time must be a valid date/, 'an event without a start time is refused');
    assertThrows(base({ eventStartAt: 'next tuesday' }), /Start time must be a valid date/, 'an unparseable start is refused');
    assertThrows(base({ eventStartAt: inHours(-1) }), /must start in the future/, 'an event starting in the past is refused');
    assertThrows(base({ eventStartAt: inHours(5), eventEndAt: inHours(4) }), /must end after it starts/, 'an end before the start is refused');
    assertThrows(base({ eventStartAt: inHours(5), eventEndAt: inHours(5) }), /must end after it starts/, 'an end equal to the start is refused');
    assertThrows(base({ eventStartAt: inHours(5) }, null), /needs a place on the map/, 'an event without a pin is refused');
    assertThrows(base({ eventStartAt: inHours(5), eventPlaceName: 'x'.repeat(81) }), /80 characters/, 'a place name over 80 characters is refused');
    assertThrows(base({ eventStartAt: inHours(5), eventPrivateNote: 'x'.repeat(1001) }), /1000 characters/, 'a private note over 1000 characters is refused');
    assertThrows(base({ eventStartAt: inHours(5), audienceScope: 'direct', targetPubkey: goer }), /community or a group/, 'a direct-audience event is refused');

    // ── 2 & 3. Defaults and forced fields ────────────────────────────────────────────────────
    console.log('\n--- 2/3. End default, forced fields ---');
    const start = inHours(24);
    const ev = createPostEngine(capture, 'event', 'food', 'Repair café', 'Fix things', 30, 'hourly', host, -28.55, 153.5, [PHOTO], true, undefined, true,
        { eventStartAt: start, eventPlaceName: '  Bowls club  ', eventPrivateNote: 'Gate 1234', reach: 'everywhere' } as any)!;
    const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(ev.id) as any;
    assert(row.event_end_at === new Date(Date.parse(start) + 2 * HOUR).toISOString(), 'end time defaults to start + 2 hours');
    assert(row.reach === 'local' && row.reach_peers === null, "reach is forced to 'local' even when 'everywhere' is sent");
    assert(row.credits === 0 && row.price_type === 'fixed' && row.category === 'community', 'credits 0, fixed price, community category are forced');
    assert(row.repeatable === 0 && row.cash_also_needed === 0, 'repeatable and cash-also-needed are forced off');
    assert(row.lat === -28.55 && row.lng === 153.5, 'the pin is kept (unlike polls)');
    assert((db.prepare('SELECT COUNT(*) c FROM post_photos WHERE post_id = ?').get(ev.id) as any).c === 1, 'photos are kept (unlike polls)');
    assert(row.event_place_name === 'Bowls club' && row.event_state === 'scheduled', 'place name is trimmed; state starts scheduled');
    const explicitEnd = inHours(30);
    const ev2 = newEvent(host, { eventEndAt: explicitEnd });
    assert(ev2.eventEndAt === explicitEnd, 'an explicit end time after the start is kept');
    assert(ev.type === 'event' && ev.eventStartAt === start && ev.eventPlaceName === 'Bowls club', 'the returned post carries the event fields');
    const newPostBroadcast = broadcasts.find(b => b.type === 'new_post' && b.post?.id === ev.id);
    assert(!!newPostBroadcast && newPostBroadcast.post.eventPrivateNote === undefined, 'the new_post broadcast carries no private note');
    assert(ev.eventPrivateNote === 'Gate 1234', 'the host creating the event gets the note back');
    assertThrows(() => requestPost(ev.id, goer), /Events cannot be requested or transacted/, 'an event cannot be requested as a trade');

    // ── 4. Upcoming cap ──────────────────────────────────────────────────────────────────────
    console.log('\n--- 4. Upcoming cap ---');
    // host already has ev and ev2: three more reach the cap.
    for (let i = 0; i < 3; i++) newEvent(host);
    assertThrows(() => newEvent(host), /5 upcoming events/, 'a sixth upcoming event by the same member is refused');
    endEvent(ev2.id);
    assert(!!newEvent(host), 'an ended event no longer holds a slot');
    assertThrows(() => newEvent(host), /5 upcoming events/, 'and the cap applies again at five');

    const treasury = createTreasury('Bowls Club Co-op', AVATAR, 0).publicKey;
    adminAssignTreasuryOperator(treasury, host, 'admin');
    let enterpriseCreated = 0;
    for (let i = 0; i < 5; i++) {
        if (createPost('event', 'community', `Enterprise event ${i}`, '', 0, 'fixed', treasury, -28.5, 153.5, [], false, undefined, false,
            { eventStartAt: inHours(48), createdBy: host })) enterpriseCreated++;
    }
    assert(enterpriseCreated === 5, 'an enterprise hosts 5 events while its keeper is already at the member cap (separate pool)');
    assertThrows(() => createPost('event', 'community', 'Enterprise event 6', '', 0, 'fixed', treasury, -28.5, 153.5, [], false, undefined, false,
        { eventStartAt: inHours(48), createdBy: host }), /5 upcoming events/, "the enterprise's own pool caps at 5");

    const groupId = crypto.randomUUID();
    db.prepare(`INSERT INTO groups (id, name, slug, created_by) VALUES (?, 'Repair group', ?, ?)`).run(groupId, `repair-${groupId.slice(0, 8)}`, convenor);
    db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status) VALUES (?, ?, 'convenor', 'active')`).run(groupId, convenor);
    db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status) VALUES (?, ?, 'member', 'active')`).run(groupId, groupie);
    db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status) VALUES (?, ?, 'member', 'active')`).run(groupId, host);
    const groupEvents: any[] = [];
    for (let i = 0; i < 5; i++) groupEvents.push(newEvent(host, { audienceScope: 'group', targetGroupId: groupId }));
    assert(groupEvents.every(Boolean), 'a group hosts 5 events posted by a member already at the member cap (separate pool)');
    assertThrows(() => newEvent(convenor, { audienceScope: 'group', targetGroupId: groupId }), /5 upcoming events/,
        "the group's pool caps at 5 whoever posts");
    assert(!!newEvent(convenor), "the convenor's own member pool is untouched by the group's");

    // ── 5. RSVP ──────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 5. RSVP ---');
    let r = rsvpEvent(capture, ev.id, goer, 'going');
    assert(r.post.goingCount === 1 && r.post.interestedCount === 0 && r.post.myRsvp === 'going', 'going is recorded and counted');
    r = rsvpEvent(capture, ev.id, goer, 'interested');
    assert(r.post.goingCount === 0 && r.post.interestedCount === 1 && r.post.myRsvp === 'interested', 'switching to interested upserts, not duplicates');
    assert((db.prepare('SELECT COUNT(*) c FROM event_rsvps WHERE post_id = ? AND member_pubkey = ?').get(ev.id, goer) as any).c === 1, 'one row per member per event');
    r = rsvpEvent(capture, ev.id, goer, null);
    assert(r.post.goingCount === 0 && r.post.interestedCount === 0 && r.post.myRsvp === null, 'not going deletes the RSVP');
    assert(!!db.prepare(`SELECT 1 FROM tombstones WHERE table_name = 'event_rsvps' AND row_key = ?`).get(`${ev.id}|${goer}`), 'the delete writes a tombstone so a replica learns of it');
    rsvpEvent(capture, ev.id, goer, 'going');
    const reGoing = db.prepare('SELECT updated_at FROM event_rsvps WHERE post_id = ? AND member_pubkey = ?').get(ev.id, goer) as any;
    const goneAt = db.prepare(`SELECT deleted_at FROM tombstones WHERE table_name = 'event_rsvps' AND row_key = ?`).get(`${ev.id}|${goer}`) as any;
    assert(reGoing.updated_at > goneAt.deleted_at, 'going again right after not going is stamped strictly after the tombstone');
    rsvpEvent(capture, ev.id, maybe, 'interested');
    assertThrows(() => rsvpEvent(capture, ev.id, goer, 'maybe' as any), /must be 'going', 'interested' or null/, 'an unknown RSVP status is refused');
    assertThrows(() => rsvpEvent(capture, ev2.id, goer, 'going'), /has ended/, 'RSVP to an ended event is refused');
    assertThrows(() => rsvpEvent(capture, groupEvents[0].id, stranger, 'going'), /UNAUTHORIZED/, 'a non-member cannot RSVP to a group-only event');
    assert(rsvpEvent(capture, groupEvents[0].id, groupie, 'going').post.goingCount === 1, 'a group member can RSVP to a group-only event');
    const offer = createPost('offer', 'food', 'Carrots', 'Fresh', 5, 'fixed', stranger, undefined, undefined, [])!;
    assertThrows(() => rsvpEvent(capture, offer.id, goer, 'going'), /Event not found/, 'RSVP to a post that is not an event is refused');

    // The route: actor comes from auth, never the body.
    const rsvpCtx = (actor: string | undefined, body: any) => ({ params: { id: ev.id }, requestBody: body, state: actor ? { actor } : {} });
    let ctx: any = await dispatch(router, 'POST', `/api/marketplace/posts/${ev.id}/rsvp`, rsvpCtx(undefined, { status: 'going' }));
    assert(ctx.status === 401, 'the RSVP route requires authentication');
    ctx = await dispatch(router, 'POST', `/api/marketplace/posts/${ev.id}/rsvp`, rsvpCtx(stranger, { status: 'going', memberPubkey: goer }));
    assert(ctx.status === 403, 'the RSVP route refuses to act for another member');
    ctx = await dispatch(router, 'POST', `/api/marketplace/posts/${ev.id}/rsvp`, rsvpCtx(stranger, { status: 'yes' }));
    assert(ctx.status === 400, 'the RSVP route refuses an unknown status');
    ctx = await dispatch(router, 'POST', `/api/marketplace/posts/${ev.id}/rsvp`, rsvpCtx(stranger, { status: 'interested' }));
    assert(ctx.body?.success === true && ctx.body.post.myRsvp === 'interested', 'the RSVP route records the signed actor');
    ctx = await dispatch(router, 'POST', `/api/marketplace/posts/${ev.id}/rsvp`, rsvpCtx(stranger, { status: null }));
    assert(ctx.body?.success === true && ctx.body.post.myRsvp === null, 'the RSVP route accepts null as not going');

    // ── 6. Private note ──────────────────────────────────────────────────────────────────────
    console.log('\n--- 6. Private note ---');
    const view = (viewer?: string) => getPosts(db, { id: ev.id, viewerPubkey: viewer })[0];
    assert(view(host)?.eventPrivateNote === 'Gate 1234', 'the host sees the private note');
    assert(view(goer)?.eventPrivateNote === 'Gate 1234', 'a member marked Going sees the private note');
    assert(view(maybe)!.eventPrivateNote === undefined, 'a member marked Interested does not');
    assert(view(stranger)!.eventPrivateNote === undefined, 'a member with no RSVP does not');
    assert(view(undefined)!.eventPrivateNote === undefined, 'a guest does not');
    assert(Array.isArray(view(host)?.eventRsvps) && view(host)!.eventRsvps!.length === 2, 'the host sees the RSVP list');
    assert(view(goer)!.eventRsvps === undefined && view(goer)!.goingCount === 1 && view(goer)!.interestedCount === 1,
        'everyone else sees counts, not names');
    const keeperEvent = getPosts(db, { authorPubkey: treasury, viewerPubkey: host, types: ['event'] })[0];

    // The list route posts as the SIGNER and nobody else (2026-09-23). It used to accept a keeper naming
    // their enterprise as the author and record them as created_by — and this suite asserted that, while
    // over HTTP it could never happen: the signature middleware refuses any body field ending in
    // `publickey` that is not the signer, so an enterprise-hosted event died with 403 "Signature validation
    // failed" before the handler ran. Hosting for an enterprise now goes through the enterprise's own route,
    // POST /api/treasury/:treasury/event, covered end-to-end in test-enterprise-event-http.ts.
    const treasury2 = createTreasury('Hall Committee', AVATAR, 0).publicKey;
    adminAssignTreasuryOperator(treasury2, goer, 'admin');
    const createCtx = (actor: string, author: string) => ({
        params: {}, state: { actor }, get: () => '', set: () => { },
        requestBody: { type: 'event', title: 'Hall working bee', authorPublicKey: author, lat: -28.5, lng: 153.5, eventStartAt: inHours(30) },
    });
    let hostCtx: any = await dispatch(router, 'POST', '/api/marketplace/posts', createCtx(goer, treasury2));
    assert(hostCtx.status === 403 && /treasury/.test(hostCtx.body?.error ?? ''),
        'a keeper naming their enterprise on the list route is refused, and told the route to use');
    assert(!db.prepare("SELECT 1 FROM posts WHERE author_pubkey = ? AND type = 'event'").get(treasury2),
        '...and no event was created for the enterprise');
    hostCtx = await dispatch(router, 'POST', '/api/marketplace/posts', createCtx(stranger, treasury2));
    assert(hostCtx.status === 403, 'a member who is not a keeper cannot host an event for the enterprise');
    assert(hostCtx.body?.error === 'You are not an authorized keeper of this enterprise',
        '...and gets the keeper refusal, not the wrong-route one');
    hostCtx = await dispatch(router, 'POST', '/api/marketplace/posts', createCtx(stranger, stranger));
    const ownRow = hostCtx.body?.post && db.prepare('SELECT created_by FROM posts WHERE id = ?').get(hostCtx.body.post.id) as any;
    assert(!!ownRow && ownRow.created_by === null, "a member's own event has no created_by");
    assert(!!keeperEvent && Array.isArray(keeperEvent.eventRsvps), "a keeper is a host of the enterprise's event");
    const leaked = broadcasts.filter(b => b.post?.type === 'event' && (b.post.eventPrivateNote !== undefined || b.post.eventRsvps !== undefined || b.post.myRsvp !== undefined));
    assert(leaked.length === 0, 'no broadcast carries a private note, RSVP list or viewer status');

    // ── 7. Opt-in guard on the list route ────────────────────────────────────────────────────
    console.log('\n--- 7. Opt-in guard ---');
    const oldApp = await listIds(router, { limit: '1000', sync: 'true' }, goer);
    assert(oldApp.includes(offer.id) && !oldApp.includes(ev.id), 'the store-app feed pull (sync=true, no types) gets offers and no events');
    const oldAppNoSync = await listIds(router, { limit: '1000' }, goer);
    assert(!oldAppNoSync.includes(ev.id), 'the plain list without types gets no events');
    const oldAppDelta = await listIds(router, { updatedAfter: '2000-01-01T00:00:00.000Z' }, goer);
    assert(!oldAppDelta.includes(ev.id), 'the delta list without types gets no events');
    const oldAppAuthor = await listIds(router, { author: host }, host);
    assert(!oldAppAuthor.includes(ev.id), "an author's own list without types gets no events");
    const newApp = await listIds(router, { limit: '1000', types: 'offer,need,poll,event' }, goer);
    assert(newApp.includes(ev.id) && newApp.includes(offer.id), 'types=offer,need,poll,event gets both');
    const onlyEvents = await listIds(router, { type: 'event' }, goer);
    assert(onlyEvents.includes(ev.id) && !onlyEvents.includes(offer.id), 'type=event gets events only');
    const byId = await listIds(router, { id: ev.id }, goer);
    assert(byId.length === 1 && byId[0] === ev.id, 'a by-id fetch returns the event without types');
    // A types= list is intersected with the four known post types before it reaches SQL, so a very long
    // list cannot exceed SQLite's bound-variable limit and 500 the route.
    let longCtx: any;
    try {
        longCtx = await dispatch(router, 'GET', '/api/marketplace/posts', listCtx({ types: `${'offer,'.repeat(40000)}event` }, goer));
    } catch (e: any) {
        longCtx = { status: 500, body: '[]', error: e?.message };
    }
    const longIds = longCtx.status === 200 ? (JSON.parse(longCtx.body) as any[]).map(p => p.id) : [];
    assert(longCtx.status === 200 && longIds.includes(ev.id) && longIds.includes(offer.id),
        `a types= list of 40,001 entries answers 200 with offers and events (got ${longCtx.status}${longCtx.error ? `: ${longCtx.error}` : ''})`);
    const unknownOnly = await listIds(router, { types: 'bogus,nonsense' }, goer);
    assert(unknownOnly.length === 0, 'a types= list of unknown types matches nothing, not everything');
    const withJunk = await listIds(router, { types: 'bogus,event' }, goer);
    assert(withJunk.includes(ev.id) && !withJunk.includes(offer.id), 'unknown entries are dropped and known ones kept');

    // ── 8. Auto-hide at end; by id after end ─────────────────────────────────────────────────
    console.log('\n--- 8. Ended events ---');
    // ev2 ended in step 4 with no RSVPs; give it a Going and an Interested directly, as the RSVP route now refuses.
    db.prepare(`INSERT INTO event_rsvps (post_id, member_pubkey, status, signature) VALUES (?, ?, 'going', '')`).run(ev2.id, goer);
    db.prepare(`INSERT INTO event_rsvps (post_id, member_pubkey, status, signature) VALUES (?, ?, 'interested', '')`).run(ev2.id, maybe);
    const feed = await listIds(router, { types: 'offer,need,poll,event' }, host);
    assert(feed.includes(ev.id) && !feed.includes(ev2.id), 'an ended event drops off the feed, even for its host');
    assert((await listIds(router, { id: ev2.id }, host)).length === 1, 'the host can still open an ended event by id');
    assert((await listIds(router, { id: ev2.id }, goer)).length === 1, 'a member marked Going can still open it by id');
    assert((await listIds(router, { id: ev2.id }, maybe)).length === 0, 'a member marked Interested cannot');
    assert((await listIds(router, { id: ev2.id }, stranger)).length === 0, 'a member with no RSVP cannot');
    assert((await listIds(router, { id: ev2.id })).length === 0, 'a guest cannot');
    endEvent(ev2.id, 31 * 24 * HOUR);
    assert((await listIds(router, { id: ev2.id }, host)).length === 0, 'after 30 days not even the host can open it by id');

    // ── 9. Edit and cancel ───────────────────────────────────────────────────────────────────
    console.log('\n--- 9. Edit and cancel ---');
    let edited = updatePost(capture, ev.id, host, { description: 'Bring gloves and a hat', eventPrivateNote: 'Gate 9999' } as any)!;
    assert(edited.description === 'Bring gloves and a hat' && edited.eventState === 'scheduled', 'a description or note edit is silent (state unchanged)');
    assert(edited.eventPrivateNote === 'Gate 9999', 'the note can be edited after RSVPs');
    const movedStart = inHours(48);
    edited = updatePost(capture, ev.id, host, { eventStartAt: movedStart } as any)!;
    assert(edited.eventState === 'updated', 'a time change marks the event UPDATED');
    assert(edited.eventEndAt === new Date(Date.parse(movedStart) + 2 * HOUR).toISOString(), 'moving the start without an end keeps the length');
    const ev3 = newEvent(stranger);
    edited = updatePost(capture, ev3.id, stranger, { lat: -28.6 } as any)!;
    assert(edited.eventState === 'updated', 'a pin change marks the event UPDATED');
    const ev4 = newEvent(stranger);
    edited = updatePost(capture, ev4.id, stranger, { eventPlaceName: 'The hall' } as any)!;
    assert(edited.eventState === 'updated', 'a place-name change marks the event UPDATED');
    assert(updatePost(capture, ev4.id, stranger, { credits: 99, reach: 'everywhere' } as any)!.credits === 0, 'an edit cannot give an event a price');
    assert((db.prepare('SELECT reach FROM posts WHERE id = ?').get(ev4.id) as any).reach === 'local', 'an edit cannot widen reach');
    assertThrows(() => updatePost(capture, ev4.id, stranger, { lat: null, lng: null } as any), /needs a place on the map/, 'an edit cannot remove the pin');
    assertThrows(() => updatePost(capture, ev4.id, stranger, { eventEndAt: inHours(-5) } as any), /must end after it starts/, 'an edit cannot end before the start');
    assert(updatePost(capture, ev4.id, goer, { title: 'Hijack' } as any) === null, 'a non-host cannot edit');
    const gEdit = updatePost(capture, groupEvents[1].id, convenor, { title: 'Convenor retitled' } as any);
    assert(gEdit?.title === 'Convenor retitled', "an active convenor can edit a group event they did not post");
    const kEdit = updatePost(capture, keeperEvent.id, host, { title: 'Keeper retitled' } as any);
    assert(kEdit?.title === 'Keeper retitled', 'a keeper can edit the enterprise event acting as themselves');
    assertThrows(() => updatePost(capture, ev2.id, host, { title: 'Too late' } as any), /has ended/, 'an ended event cannot be edited');

    broadcasts.length = 0;
    assert(removePost(capture, ev.id, host) === true, 'the host cancels through the remove path');
    const cancelled = db.prepare('SELECT active, status, event_state FROM posts WHERE id = ?').get(ev.id) as any;
    assert(cancelled.active === 0 && cancelled.status === 'cancelled' && cancelled.event_state === 'cancelled', 'cancel sets active 0, status and state cancelled');
    assert(broadcasts.some(b => b.type === 'post_removed' && b.id === ev.id), 'cancel broadcasts post_removed');
    assertThrows(() => updatePost(capture, ev.id, host, { title: 'Back on' } as any), /cancelled event/, 'a cancelled event cannot be edited');
    assertThrows(() => rsvpEvent(capture, ev.id, maybe, 'going'), /cancelled/, 'a cancelled event cannot be RSVPd');
    assert(removePost(capture, groupEvents[2].id, convenor) === true, 'an active convenor can cancel a group event');

    // A cancelled event leaves the feed but its page still opens by id for the host and the people going,
    // marked cancelled, so a host is never left with only the chat (events round 2, A4).
    const openById = async (id: string, actor?: string) =>
        JSON.parse((await dispatch(router, 'GET', '/api/marketplace/posts', listCtx({ id, types: 'offer,need,poll,event' }, actor))).body) as any[];
    const hostView = (await openById(ev.id, host))[0];
    assert(hostView?.id === ev.id && hostView.eventState === 'cancelled' && hostView.status === 'cancelled',
        'the host can still open a cancelled event by id, and it reads as cancelled');
    assert(Array.isArray(hostView?.eventRsvps), "the host's view of a cancelled event still carries who was going");
    assert(!(await listIds(router, { types: 'offer,need,poll,event' }, host)).includes(ev.id), 'a cancelled event is not in the feed, even for its host');
    db.prepare(`INSERT OR REPLACE INTO event_rsvps (post_id, member_pubkey, status, signature) VALUES (?, ?, 'going', '')`).run(ev.id, goer);
    db.prepare(`INSERT OR REPLACE INTO event_rsvps (post_id, member_pubkey, status, signature) VALUES (?, ?, 'interested', '')`).run(ev.id, maybe);
    assert((await openById(ev.id, goer)).length === 1, 'a member marked Going can open the cancelled event');
    assert((await openById(ev.id, maybe)).length === 0, 'a member marked Interested cannot');
    assert((await openById(ev.id, stranger)).length === 0, 'a member with no RSVP cannot');
    assert((await openById(ev.id)).length === 0, 'a guest cannot');
    assert((await openById(groupEvents[2].id, convenor)).length === 1, 'a convenor can open the group event they cancelled');

    // The edit screen saves through the signed update route with the host's OWN key as authorPublicKey — a
    // convenor or keeper who did not post the event included — and only a host gets through.
    const updateVia = async (actor: string, body: Record<string, unknown>) => {
        const ctx: any = { state: { actor }, params: {}, requestBody: { authorPublicKey: actor, ...body }, get: () => '', set: () => { }, headers: {} };
        await dispatch(router, 'POST', '/api/marketplace/posts/update', ctx);
        return ctx;
    };
    const routeEvent = newEvent(groupie, { audienceScope: 'group', targetGroupId: groupEvents[0].targetGroupId });
    const viaConvenor = await updateVia(convenor, { id: routeEvent.id, title: 'Renamed by the convenor' });
    assert(viaConvenor.status === undefined && viaConvenor.body?.post?.title === 'Renamed by the convenor',
        `a convenor who did not post the event can save an edit through the route (got ${viaConvenor.status}: ${viaConvenor.body?.error ?? 'ok'})`);
    assert(viaConvenor.body?.post?.eventState === 'scheduled', 'a title-only save through the route is silent');
    const viaGoer = await updateVia(goer, { id: routeEvent.id, title: 'Hijack' });
    assert(viaGoer.status === 404, `a member who is not a host is refused by the route (got ${viaGoer.status})`);
    // A save that re-sends the time and place unchanged must not mark the event UPDATED or push to Going.
    const unchanged = newEvent(stranger);
    const resaved = updatePost(capture, unchanged.id, stranger, {
        title: 'Same time, new name', eventStartAt: unchanged.eventStartAt, eventEndAt: unchanged.eventEndAt,
        eventPlaceName: unchanged.eventPlaceName, lat: unchanged.lat, lng: unchanged.lng,
    } as any)!;
    assert(resaved.title === 'Same time, new name' && resaved.eventState === 'scheduled', 're-sending an unchanged time and place is silent');
    const cancelledEdit = await updateVia(host, { id: ev.id, title: 'Back on' });
    assert(cancelledEdit.status === 400 && /cancelled event/.test(cancelledEdit.body?.error || ''), 'the route refuses an edit to a cancelled event with a plain reason');

    // ── 11. Sync round-trip ──────────────────────────────────────────────────────────────────
    console.log('\n--- 11. Sync round-trip ---');
    const syncEvent = newEvent(stranger, { eventPrivateNote: 'Back gate' });
    rsvpEvent(capture, syncEvent.id, goer, 'going');
    rsvpEvent(capture, syncEvent.id, maybe, 'interested');
    rsvpEvent(capture, syncEvent.id, host, 'going');
    rsvpEvent(capture, syncEvent.id, host, null);
    const hashBefore = getStateHash(db);

    const payload = await exportSyncState(nodeId);
    const exportedPost = (payload.posts ?? []).find(p => p.id === syncEvent.id);
    assert(exportedPost?.eventStartAt === syncEvent.eventStartAt && exportedPost?.eventPrivateNote === 'Back gate' && exportedPost?.eventState === 'scheduled',
        'the exported post carries the event fields');
    const exportedRsvps = (payload.eventRsvps ?? []).filter(e => e.postId === syncEvent.id);
    assert(exportedRsvps.length === 2 && exportedRsvps.some(e => e.memberPubkey === goer && e.status === 'going'), 'event_rsvps are exported');
    assert((payload.tombstones ?? []).some(t => t.tableName === 'event_rsvps' && t.rowKey === `${syncEvent.id}|${host}`), 'the not-going tombstone is exported');

    // Simulate a replica that holds the stale state: the host still Going, the others missing, event fields blank.
    db.prepare(`DELETE FROM event_rsvps WHERE post_id = ?`).run(syncEvent.id);
    db.prepare(`DELETE FROM tombstones WHERE table_name = 'event_rsvps'`).run();
    db.prepare(`INSERT INTO event_rsvps (post_id, member_pubkey, status, signature, updated_at) VALUES (?, ?, 'going', '', '2000-01-01T00:00:00.000Z')`).run(syncEvent.id, host);
    db.prepare(`UPDATE posts SET event_start_at = NULL, event_private_note = NULL, event_state = NULL, updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(syncEvent.id);
    assert(getStateHash(db) !== hashBefore, 'the state hash sees RSVP divergence');

    setNodeRole('backup');
    await importRemoteState(payload as any);
    const imported = db.prepare('SELECT event_start_at, event_private_note, event_state FROM posts WHERE id = ?').get(syncEvent.id) as any;
    assert(imported.event_start_at === syncEvent.eventStartAt && imported.event_private_note === 'Back gate' && imported.event_state === 'scheduled',
        'import restores the event fields');
    const importedRsvps = db.prepare('SELECT member_pubkey, status FROM event_rsvps WHERE post_id = ? ORDER BY member_pubkey').all(syncEvent.id) as any[];
    assert(importedRsvps.length === 2 && importedRsvps.some(x => x.member_pubkey === goer && x.status === 'going')
        && importedRsvps.some(x => x.member_pubkey === maybe && x.status === 'interested'), 'import restores the RSVPs');
    assert(!importedRsvps.some(x => x.member_pubkey === host), 'the not-going tombstone removes the stale RSVP on import');
    assert(getStateHash(db) === hashBefore, 'after import the state hash matches the primary');

    // A stale row older than the tombstone must not resurrect a not-going.
    const { signature: _s, publicKey: _p, ...unsigned } = payload as any;
    const stale = await signSyncPayload({
        ...unsigned,
        eventRsvps: [{ postId: syncEvent.id, memberPubkey: host, status: 'going', signature: '', updatedAt: '2000-01-01T00:00:00.000Z' }],
        tombstones: [],
    } as any);
    await importRemoteState(stale as any);
    assert(!db.prepare('SELECT 1 FROM event_rsvps WHERE post_id = ? AND member_pubkey = ?').get(syncEvent.id, host),
        'an RSVP older than its tombstone does not come back');

    // Reminders ride on the RSVP (docs/events-on-the-map.md §2.1): a member who restores from a backup
    // still has the reminders they set. The last two checks are the pair that made the import two
    // statements — "the peer left the field out" and "this person cleared it" must not mean the same thing.
    const withOffsets = await signSyncPayload({
        ...unsigned,
        eventRsvps: [{ postId: syncEvent.id, memberPubkey: goer, status: 'going', signature: '',
                       reminderOffsets: '[1440,60]', updatedAt: '2099-01-01T00:00:00.000Z' }],
        tombstones: [],
    } as any);
    await importRemoteState(withOffsets as any);
    const offsetsRow = () => (db.prepare('SELECT reminder_offsets AS o FROM event_rsvps WHERE post_id = ? AND member_pubkey = ?')
        .get(syncEvent.id, goer) as any)?.o ?? null;
    assert(offsetsRow() === '[1440,60]', 'an imported RSVP carries the reminders that were set on it');

    const fromOldNode = await signSyncPayload({
        ...unsigned,
        eventRsvps: [{ postId: syncEvent.id, memberPubkey: goer, status: 'going', signature: '',
                       updatedAt: '2099-01-02T00:00:00.000Z' }],
        tombstones: [],
    } as any);
    await importRemoteState(fromOldNode as any);
    assert(offsetsRow() === '[1440,60]',
        'a snapshot from a node that predates reminders does not erase the ones this replica holds');

    const cleared = await signSyncPayload({
        ...unsigned,
        eventRsvps: [{ postId: syncEvent.id, memberPubkey: goer, status: 'going', signature: '',
                       reminderOffsets: null, updatedAt: '2099-01-03T00:00:00.000Z' }],
        tombstones: [],
    } as any);
    await importRemoteState(cleared as any);
    assert(offsetsRow() === null, 'while a member who really cleared theirs back to "my default" replicates that too');

    setNodeRole('primary');

    await p2pNode.stop();
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });

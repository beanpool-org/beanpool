/**
 * Test Suite: retention's other half on the global node (DESIGN-global-mothership-fable §4.2, decision 7, slice A5; Marty,
 * 2026-10-18): events a week after they end, polls a week after they close (the director, 3 Nov), and a listing a member
 * traded on inside the 90 days kept. The listings' own archive is test-global-cost-limits'. One database, over REAL HTTPS for the reads a phone makes;
 * every fixture dated from now.
 *
 *  1. A local community (no NODE_PROFILE). profileLimits(): no event archive, no poll archive. An event that ended 20 days
 *     ago and a closed poll, both with photos, keep everything through the minute's run; the closed poll stays on the board.
 *  2. The global profile. The boot line names both weeks. An event 8 days past its end loses its photos (the
 *     rows gone, a post_photos tombstone per slot) and is stamped; nothing
 *     else of it moves: still readable by id to its host, its RSVPs and chat kept (retention never cuts a chat short; the
 *     30-day scrub takes them on every node). A repeating event whose series has ended goes the same way. Left alone: one 6
 *     days past its end, one changed 2 days ago, a series that goes on, one a report waits on, one hidden for the
 *     moderators, another community's copy, one still to come.
 *     A poll closed 8 days ago leaves the board (active 0, still `completed`) and its audience hears `post_removed`; one
 *     closed a day ago stays, and so does one past its closing time, closed by closeExpiredPolls in the same tick; an open
 *     poll stays, and so does one closed 8 days ago that a report waits on. The board and a by-id read have the 8-day poll
 *     before, not after; its author still opens it by id, closed, with its answers. The phone's delta brings it inactive,
 *     and the event with no photos; a standby's copy (exportSyncState since) carries both rows and each photo tombstone. A
 *     second run does nothing.
 * 2b. A poll's typed Other through its week (the deciding review of #2791, BLOCKING): an anonymous poll with Other, closed
 *     by its maker. Through the week it stays on the board, closed, with its result and where its votes came from, a vote
 *     is refused (so no count moves after it shows), it holds back neither its maker's next poll nor the community's five,
 *     and its maker reads the typed line. A report of the line holds it on the board past the week, still waiting; once an
 *     owner has dismissed it the poll leaves the board, the report still dismissed (not actioned), the line still in its
 *     table, read by its maker and an owner, who can still remove it.
 *  3. Bounded, main server only, the operator's: a batch of 1 says more are due; a standby archives nothing; the override
 *     retention = false on global archives nothing.
 *  4. Touched inside the window: a listing unchanged for 100 days that a member traded on 10 days ago stays up with its
 *     photo; one whose last deal was 100 days ago is archived.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-retention.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.LISTING_ARCHIVE_DAYS;

import crypto from 'node:crypto';
import { setMemberPhoto } from '@beanpool/engine';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

let BASE = '';
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const HERE = { lat: -28.6, lng: 153.5 };

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject; callsign: string };

async function call(method: 'GET' | 'POST', urlPath: string, body: unknown, id: Id | null) {
    const bodyString = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pubKeyHex;
        headers['X-Signature'] = signRequest(id.privateKey, { method, path: urlPath.split('?')[0], timestamp: ts, nonce, body: bodyString });
        headers[SIGNED_FOR_HEADER] = signedForHost();
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${urlPath}`, { method, headers, body: method === 'GET' ? undefined : bodyString });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
}

/** Everything console.log said while `fn` ran. */
async function capture(fn: () => unknown | Promise<unknown>): Promise<string[]> {
    const logs: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
    try { await fn(); } finally { console.log = log; }
    return logs;
}

async function main() {
    const { db, initSchema } = await import('./db/db.js');
    const { aWeekPasses } = await import('./post-test-helper.js');
    const { mirrorNodeProfileAtBoot, profileLimits, setSwitchOverride } = await import('./config/node-profile.js');
    const { setNodeRole } = await import('./config/node-role.js');
    const { getImageStore } = await import('./storage/image-store.js');

    initSchema();
    const se = await import('./state-engine.js');
    await se.initStateEngine();
    const { archiveEndedPosts: archiveEngine } = await import('./engine/posts.js');
    const { initTls } = await import('./services/tls.js');
    const { startHttpsServer } = await import('./https-server.js');
    await initTls();
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    const { stopPricingAggregatorWorker } = await import('./pricing-aggregator.js');
    stopPricingAggregatorWorker();

    const member = (callsign: string): Id => {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, updated_at, invited_by, invite_code)
                    VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', ?)`)
            .run(pubKeyHex, callsign, `INV-${callsign.toUpperCase()}`);
        setMemberPhoto(db, pubKeyHex, TINY_PNG);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(pubKeyHex);
        return { pubKeyHex, privateKey, callsign };
    };
    const noPhoto = (n: number) => (n === 0 ? { allowNoPhoto: true } : {});
    /**
     * An event made as the engine makes one (tomorrow), then moved to have ended `endedDays` ago, last changed then too, in ONE
     * update: posts' touch trigger stamps `now` on any update that leaves updated_at as it was, a second one included.
     */
    const event = (host: Id, title: string, photos: number, endedDays: number,
        opts: { changedDays?: number; repeat?: 'on' | 'ended'; hidden?: boolean; origin?: string } = {}): string => {
        const start = new Date(Date.now() + DAY);
        const p = se.createPost('event', 'general', title, `${title}, described`, 0, 'fixed', host.pubKeyHex, HERE.lat, HERE.lng,
            Array(photos).fill(TINY_PNG), false, undefined, false,
            { eventStartAt: start.toISOString(), eventEndAt: new Date(start.getTime() + 2 * 60 * 60 * 1000).toISOString(), ...noPhoto(photos) } as any);
        if (!p) throw new Error(`could not make ${title}`);
        const end = ago(endedDays);
        const begin = new Date(Date.parse(end) - 2 * 60 * 60 * 1000).toISOString();
        const changed = ago(opts.changedDays ?? endedDays);
        // A weekly series: one that goes on has no last date; one that has ended has its last date on this date.
        db.prepare(`UPDATE posts SET event_start_at = ?, event_end_at = ?, event_start_local = ?, created_at = ?, updated_at = ?,
                           event_repeat = ?, event_repeat_until = ?, event_tz = ?, hidden_by_reports_at = ?, origin_node = ? WHERE id = ?`)
            .run(begin, end, begin.slice(0, 16), ago(endedDays + 10), changed,
                opts.repeat ? 'weekly' : null, opts.repeat === 'ended' ? begin.slice(0, 10) : null, opts.repeat ? 'UTC' : null,
                opts.hidden ? ago(endedDays) : null, opts.origin ?? null, p.id);
        return p.id;
    };
    /** A poll made as the engine makes one (a poll carries no photo), by its own author (one open poll each), then closed a
     *  day ago (inside its week), closed 8 days ago (past it), past its closing time a second ago, or left open. */
    const askers = new Map<string, Id>();
    const poll = (title: string, state: 'closed' | 'closed-8-days' | 'open' | 'past-close'): string => {
        const author = member(`Asker${crypto.randomBytes(3).toString('hex')}`);
        const p = se.createPost('poll', 'general', title, `${title}?`, 0, 'fixed', author.pubKeyHex, HERE.lat, HERE.lng,
            [], false, undefined, false,
            { pollOptions: [{ id: 'yes', text: 'Yes' }, { id: 'no', text: 'No' }], durationDays: 7, allowNoPhoto: true } as any);
        if (!p) throw new Error(`could not make ${title}`);
        if (state === 'closed') db.prepare("UPDATE posts SET status = 'completed', poll_closes_at = ?, updated_at = ? WHERE id = ?").run(ago(1), ago(1), p.id);
        if (state === 'closed-8-days') db.prepare("UPDATE posts SET status = 'completed', poll_closes_at = ?, updated_at = ? WHERE id = ?").run(ago(8), ago(8), p.id);
        if (state === 'past-close') db.prepare('UPDATE posts SET poll_closes_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), p.id);
        askers.set(p.id, author);
        return p.id;
    };
    const listing = (author: Id, title: string, days: number): string => {
        const p = se.createPost('offer', 'general', title, `${title}, described`, 0, 'fixed', author.pubKeyHex, HERE.lat, HERE.lng,
            [TINY_PNG], false, undefined, false);
        if (!p) throw new Error(`could not make ${title}`);
        db.prepare('UPDATE posts SET created_at = ?, updated_at = ? WHERE id = ?').run(ago(days), ago(days), p.id);
        return p.id;
    };
    const rowOf = (id: string) => db.prepare('SELECT status, active, updated_at FROM posts WHERE id = ?').get(id) as { status: string; active: number; updated_at: string };
    const photosOf = (id: string) => (db.prepare('SELECT COUNT(*) AS n FROM post_photos WHERE post_id = ?').get(id) as { n: number }).n;
    const keysOf = (id: string) => (db.prepare('SELECT storage_key FROM post_photos WHERE post_id = ? ORDER BY order_num').all(id) as { storage_key: string | null }[])
        .map(r => r.storage_key);
    const photoTombstones = (id: string) => (db.prepare(`SELECT row_key FROM tombstones WHERE table_name = 'post_photos' AND row_key LIKE ? ORDER BY row_key`)
        .all(`${id}|%`) as { row_key: string }[]).map(r => r.row_key);
    const fresh = (iso: string) => Date.now() - Date.parse(iso) < 60_000;
    const boardHas = async (reader: Id, id: string) => {
        const res = await call('GET', '/api/marketplace/posts?limit=200&types=poll,event,offer', null, reader);
        const list: any[] = Array.isArray(res.body) ? res.body : (res.body?.posts ?? []);
        return { status: res.status, has: list.some((p: any) => p.id === id) };
    };
    const byIdFor = async (reader: Id, id: string) => call('GET', `/api/marketplace/posts?id=${encodeURIComponent(id)}`, null, reader);
    /** Whether a by-id read gives this reader the post. */
    const readsById = async (reader: Id, id: string) => {
        const res = await byIdFor(reader, id);
        const list: any[] = Array.isArray(res.body) ? res.body : (res.body?.posts ?? []);
        return list.some((p: any) => p.id === id);
    };

    const ana = member('Ana');
    const ben = member('Ben');

    // ── 1. A local community ──
    console.log('── 1. a local community: no event or poll is archived ──');
    const localLimits = profileLimits();
    assert(localLimits.eventArchiveDays === null && localLimits.pollArchiveDays === null,
        `profileLimits(): no event archive, no poll archive (${JSON.stringify(localLimits)})`);
    const localEvent = event(ana, 'Local market day', 2, 20);
    const localPoll = poll('Local question', 'closed-8-days');
    const localBefore = [rowOf(localEvent).updated_at, rowOf(localPoll).updated_at];
    const localRun = se.archiveEndedPosts();
    assert(localRun.events === 0 && localRun.polls === 0 && localRun.photosDropped === 0 && photosOf(localEvent) === 2
        && rowOf(localEvent).updated_at === localBefore[0] && rowOf(localPoll).updated_at === localBefore[1] && rowOf(localPoll).active === 1,
        `the minute's run leaves a 20-day-old event (photos and all) and a poll closed 8 days ago whole (${JSON.stringify(localRun)})`);
    assert((await boardHas(ben, localPoll)).has, 'a closed poll stays on a local community\'s board with its result');

    // ── 2. The global profile ──
    console.log('\n── 2. NODE_PROFILE=global: events a week after they end, polls a week after they close ──');
    process.env.NODE_PROFILE = 'global';
    const boot = await capture(() => mirrorNodeProfileAtBoot());
    assert(boot.some(l => /an event loses its photos 7 days after it ends; a poll leaves the board 7 days after it closes/.test(l)),
        `the boot line names both weeks (${boot.filter(l => /Retention/.test(l)).join(' | ') || 'nothing'})`);
    setSwitchOverride('probation', false);
    const limits = profileLimits();
    assert(limits.eventArchiveDays === 7 && limits.pollArchiveDays === 7 && limits.listingArchiveDays === 90,
        `profileLimits(): events 7 days, polls 7 days, listings 90 days (${JSON.stringify(limits)})`);

    const ended = event(ana, 'Ended a week ago', 2, 8);
    // Ben was going, and wrote in the event's chat: both stay.
    db.prepare(`INSERT INTO event_rsvps (post_id, member_pubkey, status, signature) VALUES (?, ?, 'going', 'sig')`).run(ended, ben.pubKeyHex);
    db.prepare(`INSERT OR IGNORE INTO conversations (id, type, name, created_by) VALUES (?, 'event_thread', 'Ended a week ago', ?)`).run(ended, ana.pubKeyHex);
    db.prepare(`INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)`).run(ended, ben.pubKeyHex);
    db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce) VALUES (?, ?, ?, 'x', 'n')`).run(crypto.randomUUID(), ended, ben.pubKeyHex);
    const chatOf = (id: string) => (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(id) as { n: number }).n;
    const rsvpsOf = (id: string) => (db.prepare('SELECT COUNT(*) AS n FROM event_rsvps WHERE post_id = ?').get(id) as { n: number }).n;
    const seriesEnded = event(ana, 'A series that has ended', 1, 9, { repeat: 'ended' });
    const sixDays = event(ana, 'Ended six days ago', 1, 6);
    const changedLately = event(ana, 'Photos added after the day', 1, 10, { changedDays: 2 });
    const seriesOn = event(ana, 'A series that goes on', 1, 9, { repeat: 'on' });
    const reportedEvent = event(ana, 'Reported event', 1, 9);
    db.prepare(`INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, target_post_id, reason, status) VALUES (?, ?, ?, ?, 'spam', 'pending')`)
        .run(crypto.randomUUID(), ben.pubKeyHex, ana.pubKeyHex, reportedEvent);
    const hiddenEvent = event(ana, 'Hidden event', 1, 9, { hidden: true });
    const copyEvent = event(ana, 'Another community\'s event', 1, 9, { origin: 'peer-elsewhere' });
    const start = new Date(Date.now() + 3 * DAY);
    const upcoming = se.createPost('event', 'general', 'Still to come', 'Soon', 0, 'fixed', ana.pubKeyHex, HERE.lat, HERE.lng, [TINY_PNG], false, undefined, false,
        { eventStartAt: start.toISOString(), eventEndAt: new Date(start.getTime() + 3600_000).toISOString() } as any)!.id;

    const closed = poll('Closed eight days ago', 'closed-8-days');
    const inWeek = poll('Closed yesterday', 'closed');
    const pastClose = poll('Past its closing time', 'past-close');
    const open = poll('Still open', 'open');
    const reportedPoll = poll('Reported poll', 'closed-8-days');
    db.prepare(`INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, target_post_id, reason, status) VALUES (?, ?, ?, ?, 'spam', 'pending')`)
        .run(crypto.randomUUID(), ben.pubKeyHex, ana.pubKeyHex, reportedPoll);

    const keptEvents = [sixDays, changedLately, seriesOn, reportedEvent, hiddenEvent, copyEvent, upcoming];
    const before = new Map([...keptEvents, open, reportedPoll, inWeek].map(id => [id, rowOf(id).updated_at]));
    const endedKeys = keysOf(ended);
    const store = getImageStore();
    assert(endedKeys.length === 2 && endedKeys.every(k => !!k && !!store.head(k)), `the ended event's photos are objects in the store (${JSON.stringify(endedKeys)})`);
    assert((await boardHas(ben, closed)).has && await readsById(ben, closed), 'before the run, the closed poll is on the board and read by id (as on every node today)');
    const since = new Date(Date.now() - 1000).toISOString();

    // The minute's tick, in its order: polls past their time are closed, then the archive runs.
    se.closeExpiredPolls();
    const heard: Array<{ event: any; recipients?: string[] }> = [];
    const first = archiveEngine((ev, recipients) => { heard.push({ event: ev, recipients }); });
    // Section 1's event and poll are here too: switched to global, the node takes them as well.
    assert(first.events === 3 && first.polls === 2 && first.photosDropped === 2 + 1 + 2 && !first.more,
        `one run: three events lose their photos (5 photos), the two polls closed 8 days ago leave the board (${JSON.stringify(first)})`);

    const e = rowOf(ended);
    assert(photosOf(ended) === 0 && e.active === 1 && e.status === 'active' && fresh(e.updated_at),
        `the event 8 days past its end has no photos left, is stamped, and nothing else of it moved (${JSON.stringify(e)})`);
    assert(JSON.stringify(photoTombstones(ended)) === JSON.stringify([`${ended}|0`, `${ended}|1`]),
        `a post_photos tombstone per slot, for a standby (${JSON.stringify(photoTombstones(ended))})`);
    assert(rsvpsOf(ended) === 1 && chatOf(ended) === 1, 'its RSVP and its chat are kept: retention never cuts a chat short');
    const hostRead = await byIdFor(ana, ended);
    const hostList: any[] = Array.isArray(hostRead.body) ? hostRead.body : (hostRead.body?.posts ?? []);
    assert(hostRead.status === 200 && hostList.some((p: any) => p.id === ended && (p.photos ?? []).length === 0),
        `its host still opens it by id, with no photos (${hostRead.status}, ${hostList.length})`);
    assert(photosOf(seriesEnded) === 0 && photoTombstones(seriesEnded).length === 1, 'a series that has ended loses its photos too');
    assert(keptEvents.every(id => photosOf(id) === 1 && rowOf(id).updated_at === before.get(id)),
        'left whole: 6 days past its end, changed 2 days ago, a series that goes on, reported, hidden, another community\'s copy, still to come');

    for (const id of [closed, localPoll]) {
        const r = rowOf(id);
        assert(r.active === 0 && r.status === 'completed' && fresh(r.updated_at),
            `the poll "${(db.prepare('SELECT title FROM posts WHERE id = ?').get(id) as any).title}", closed 8 days ago, is off the board, still completed, stamped (${JSON.stringify(r)})`);
    }
    const iw = rowOf(inWeek);
    assert(iw.active === 1 && iw.status === 'completed' && iw.updated_at === before.get(inWeek), `one closed yesterday stays on the board for its week (${JSON.stringify(iw)})`);
    const pc = rowOf(pastClose);
    assert(pc.active === 1 && pc.status === 'completed',
        `one past its closing time is closed by closeExpiredPolls in the same tick and stays on the board, closed, for its week (${JSON.stringify(pc)})`);
    assert((await boardHas(ben, inWeek)).has && (await boardHas(ben, pastClose)).has && await readsById(ben, pastClose),
        'members still find both on the board and by id, with their result');
    const o = rowOf(open);
    assert(o.active === 1 && o.status === 'active' && o.updated_at === before.get(open), 'an open poll is left whole');
    const rp = rowOf(reportedPoll);
    assert(rp.active === 1 && rp.updated_at === before.get(reportedPoll), 'a closed poll a report waits on stays for the moderator');
    const removed = heard.filter(h => h.event?.type === 'post_removed').map(h => h.event.id).sort();
    assert(JSON.stringify(removed) === JSON.stringify([closed, localPoll].sort()) && heard.length === 2 && heard.every(h => h.event?.audienceScope === 'public'),
        `each poll taken off is post_removed to its audience, and no event is (${JSON.stringify(heard.map(h => h.event?.type))})`);
    const boardAfter = await boardHas(ben, closed);
    assert(boardAfter.status === 200 && !boardAfter.has, `after the run, the closed poll is on no board (${boardAfter.status})`);
    assert(!(await readsById(ben, closed)) && !(await readsById(ana, closed)), 'nor read by id, by Ben or by Ana');
    // The author keeps their own copy: their phone opens it by id, closed, with its result.
    const own = await byIdFor(askers.get(closed)!, closed);
    const ownList: any[] = Array.isArray(own.body) ? own.body : (own.body?.posts ?? []);
    const ownPoll = ownList.find((p: any) => p.id === closed);
    assert(own.status === 200 && !!ownPoll && ownPoll.status === 'completed' && Array.isArray(ownPoll.pollOptions) && ownPoll.pollOptions.length >= 2,
        `its author still opens it by id, closed, with its answers (${own.status}: ${JSON.stringify(ownPoll && { status: ownPoll.status, options: ownPoll.pollOptions?.length, total: ownPoll.totalVotes })})`);

    const delta = await call('GET', `/api/marketplace/posts?limit=200&sync=true&types=poll,event&updatedAfter=${encodeURIComponent(since)}`, null, ben);
    const deltaRows: any[] = Array.isArray(delta.body) ? delta.body : (delta.body?.posts ?? []);
    const dPoll = deltaRows.find((p: any) => p.id === closed);
    const dEvent = deltaRows.find((p: any) => p.id === ended);
    assert(delta.status === 200 && !!dPoll && dPoll.active === false && !!dEvent && (dEvent.photos ?? []).length === 0,
        `the phone's delta brings the poll inactive and the event with no photos (${delta.status}: ${JSON.stringify({ poll: dPoll && dPoll.active, event: dEvent && dEvent.photos })})`);

    const payload: any = await se.exportSyncState('retention-suite', since);
    const sentPosts: any[] = payload.posts ?? [];
    const sentTombs = new Set((payload.tombstones ?? []).filter((t: any) => t.tableName === 'post_photos').map((t: any) => t.rowKey));
    assert(sentPosts.some(p => p.id === closed && p.active === false) && sentPosts.some(p => p.id === ended)
        && [`${ended}|0`, `${ended}|1`, `${seriesEnded}|0`].every(k => sentTombs.has(k)),
        `a standby's copy since then carries the poll off the board, the event, and each photo tombstone (${sentPosts.length} posts, ${sentTombs.size} tombstones)`);

    const second = archiveEngine(() => { throw new Error('a second run broadcast something'); });
    assert(second.events === 0 && second.polls === 0 && second.photosDropped === 0, `a second run does nothing (${JSON.stringify(second)})`);

    // ── 2b. A poll's typed Other through its week ──
    console.log('\n── 2b. a poll\'s typed Other: read through its week, kept after it, a report never closed by the archive ──');
    const { grantNodeRole } = await import('./engine/node-roles.js');
    const oona = member('OwnerOona');
    grantNodeRole(oona.pubKeyHex, 'owner', 'SYSTEM');
    const maker = member('MakerMo');
    const tess = member('TypistTess');
    const LINE = 'Saturday morning please';
    const asked = se.createPost('poll', 'general', 'When should the market run', 'Pick one', 0, 'fixed', maker.pubKeyHex, HERE.lat, HERE.lng,
        [], false, undefined, false,
        { pollOptions: [{ id: 'sun', text: 'Sunday' }, { id: 'sat', text: 'Saturday' }], durationDays: 7, pollOther: true, allowNoPhoto: true } as any);
    if (!asked) throw new Error('could not make the poll with Other');
    const otherId = (asked.pollOptions ?? []).find((o: any) => o.other === true)?.id as string;
    // Probation as the global profile has it (section 2 turned it off for its fixtures): a vote keeps its voter's kind as they
    // vote, so Tess's, a new account's, counts as one.
    setSwitchOverride('probation', true);
    const typed = await call('POST', `/api/marketplace/posts/${asked.id}/vote`, { optionId: otherId, otherWords: LINE }, tess);
    assert(typed.status === 200 && !!otherId, `a member answers Other with a typed line (${typed.status} ${JSON.stringify(typed.body?.error ?? '')})`);
    const closedByMaker = await call('POST', `/api/marketplace/posts/${asked.id}/close`, {}, maker);
    assert(closedByMaker.status === 200 && rowOf(asked.id).status === 'completed', `its maker closes it with Close Poll (${closedByMaker.status})`);
    const wordsPath = `/api/marketplace/posts/${asked.id}/other-answers`;
    const linesFor = async (reader: Id) => {
        const r = await call('GET', wordsPath, null, reader);
        return { status: r.status, state: r.body?.state, lines: (r.body?.answers ?? []).map((a: any) => a.words) as string[], answers: (r.body?.answers ?? []) as any[] };
    };
    const storedWords = () => (db.prepare('SELECT words, words_removed FROM poll_answers WHERE post_id = ?').all(asked.id) as { words: string | null; words_removed: number }[]);

    // The minute's tick, as it runs right after the close.
    se.closeExpiredPolls();
    archiveEngine(() => {});
    const inItsWeek = await linesFor(maker);
    assert(rowOf(asked.id).active === 1 && inItsWeek.status === 200 && inItsWeek.state === 'open' && inItsWeek.lines.includes(LINE),
        `the minute's run after the close leaves it on the board, and its maker reads the typed line (${JSON.stringify({ active: rowOf(asked.id).active, ...inItsWeek, answers: undefined })})`);
    // Where its votes came from shows only once it has closed (probation, the global profile): the week is when members read it.
    const onBoardInWeek = await call('GET', '/api/marketplace/posts?limit=200&types=poll', null, ben);
    const seen = (Array.isArray(onBoardInWeek.body) ? onBoardInWeek.body : (onBoardInWeek.body?.posts ?? [])).find((p: any) => p.id === asked.id);
    setSwitchOverride('probation', false);
    assert(!!seen && seen.status === 'completed' && seen.totalVotes === 1 && seen.pollNewOrWordsVotes === 1,
        `in its week a member reads it on the board, closed, with its result and where its votes came from (${JSON.stringify(seen && { status: seen.status, total: seen.totalVotes, newOrWords: seen.pollNewOrWordsVotes })})`);
    const lateVote = await call('POST', `/api/marketplace/posts/${asked.id}/vote`, { optionId: 'sun' }, ben);
    const votesNow = (db.prepare('SELECT COUNT(*) AS n FROM poll_votes WHERE post_id = ?').get(asked.id) as { n: number }).n;
    assert(lateVote.status >= 400 && votesNow === 1, `a vote in its week is refused, so no count moves once where they came from shows (${lateVote.status}, ${votesNow} vote)`);
    const openPolls = (db.prepare("SELECT COUNT(*) AS n FROM posts WHERE type = 'poll' AND status = 'active'").get() as { n: number }).n;
    // A week on from its maker's start: the member's week between polls (engine/poll-week.ts, test-poll-week.ts) is not what is held here.
    aWeekPasses(db, maker.pubKeyHex);
    const next = se.createPost('poll', 'general', 'And the next question', 'Next', 0, 'fixed', maker.pubKeyHex, HERE.lat, HERE.lng, [], false, undefined, false,
        { pollOptions: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], durationDays: 3, allowNoPhoto: true } as any);
    assert(!!next && openPolls < 5, `a closed poll in its week holds back neither its maker's next poll (one open each) nor the community's five (${openPolls} open before it)`);
    if (next) db.prepare("UPDATE posts SET status = 'completed', active = 0 WHERE id = ?").run(next.id);

    // The maker reports the line; then the week passes.
    const line = inItsWeek.answers.find((a: any) => a.words === LINE);
    const filed = await call('POST', `${wordsPath}/${line?.id}/report`, {}, maker);
    // The route answers { success }: the report is found by what it names, the poll and the line.
    const reportId = (db.prepare("SELECT id FROM abuse_reports WHERE json_extract(disclosure, '$.postId') = ? AND json_extract(disclosure, '$.answerId') = ?")
        .get(asked.id, line?.id) as { id: string } | undefined)?.id;
    assert(filed.status === 200 && filed.body?.success === true && !!reportId, `its maker reports the line (${filed.status} ${JSON.stringify(filed.body)})`);
    const reportStatus = () => (db.prepare('SELECT status FROM abuse_reports WHERE id = ?').get(reportId) as { status: string | null } | undefined)?.status;
    // Its week passes: closed 8 days ago. Once only: a second write of the same instant (a fast machine) would leave
    // updated_at where it was, and posts_touch_updated_at stamps such a write now.
    const eightDaysAgo = ago(8);
    db.prepare('UPDATE posts SET updated_at = ? WHERE id = ?').run(eightDaysAgo, asked.id);
    const heldRun = archiveEngine(() => {});
    assert(heldRun.polls === 0 && rowOf(asked.id).active === 1 && reportStatus() === 'pending',
        `past its week, a report of one of its lines holds it on the board, the report still waiting for an owner (${JSON.stringify({ run: heldRun, active: rowOf(asked.id).active, report: reportStatus() })})`);
    // An owner looks and dismisses it (the queue's Dismiss: `reviewed`), which leaves the poll as it was.
    assert(se.dismissReport(reportId!) && rowOf(asked.id).updated_at === eightDaysAgo, 'an owner dismisses the report, and the poll is as it was');
    const offRun8 = archiveEngine(() => {});
    assert(offRun8.polls === 1 && rowOf(asked.id).active === 0 && rowOf(asked.id).status === 'completed',
        `then the run takes it off the board (${JSON.stringify({ run: offRun8, row: rowOf(asked.id) })})`);
    assert(reportStatus() === 'reviewed', `the dismissed report stays dismissed: the archive closes no report as actioned (${reportStatus()})`);
    assert(storedWords().some(w => w.words === LINE) && storedWords().every(w => w.words_removed === 0),
        `its typed line stays in its table (${JSON.stringify(storedWords())})`);
    const makerAfter = await linesFor(maker);
    assert(makerAfter.status === 200 && makerAfter.lines.includes(LINE), `off the board, its maker still reads the line (${JSON.stringify({ ...makerAfter, answers: undefined })})`);
    const ownerAfter = await linesFor(oona);
    assert(ownerAfter.status === 200 && ownerAfter.lines.includes(LINE), `and so does an owner (${JSON.stringify({ ...ownerAfter, answers: undefined })})`);
    const benAfter = await linesFor(ben);
    assert(benAfter.status === 403 || benAfter.status === 404, `a member still reads no line (${benAfter.status})`);
    const removedByOwner = await call('POST', `${wordsPath}/${line?.id}/remove`, {}, oona);
    assert(removedByOwner.status === 200 && storedWords().every(w => w.words === null),
        `an owner can still remove it, as a line the maker reports after the week asks (${removedByOwner.status})`);

    // ── 3. Bounded, main server only, the operator's ──
    console.log('\n── 3. a batch; a standby; the override ──');
    const b1 = poll('Batch one', 'closed-8-days');
    const b2 = poll('Batch two', 'closed-8-days');
    const batched = archiveEngine(() => {}, Date.now(), 1);
    assert(batched.polls === 1 && batched.more, `a batch of 1 takes one and says more are due (${JSON.stringify(batched)})`);
    archiveEngine(() => {});
    assert(rowOf(b1).active === 0 && rowOf(b2).active === 0, 'the next run takes the other');
    const onStandbyPoll = poll('On a standby', 'closed-8-days');
    const onStandbyEvent = event(ana, 'Ended, on a standby', 1, 9);
    setNodeRole('backup');
    const onStandby = archiveEngine(() => {});
    setNodeRole('primary');
    assert(onStandby.polls === 0 && onStandby.events === 0 && rowOf(onStandbyPoll).active === 1 && photosOf(onStandbyEvent) === 1,
        'a standby archives nothing: its main server\'s copy brings the result');
    setSwitchOverride('retention', false);
    const offRun = se.archiveEndedPosts();
    assert(offRun.polls === 0 && offRun.events === 0 && rowOf(onStandbyPoll).active === 1 && photosOf(onStandbyEvent) === 1
        && profileLimits().eventArchiveDays === null && profileLimits().pollArchiveDays === null,
        'the override retention = false on global archives nothing');
    setSwitchOverride('retention', true); // the profile's own value: the override row goes

    // ── 4. Touched inside the window: a deal on a listing ──
    console.log('\n── 4. a listing a member traded on inside the 90 days stays ──');
    const traded = listing(ana, 'Traded on lately', 100);
    const tradedLongAgo = listing(ana, 'Traded on long ago', 100);
    const deal = db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, amount_c, status, created_at, completed_at, updated_at)
                             VALUES (?, ?, ?, ?, 5, 'completed', ?, ?, ?)`);
    deal.run(crypto.randomUUID(), traded, ben.pubKeyHex, ana.pubKeyHex, ago(12), ago(10), ago(10));
    deal.run(crypto.randomUUID(), tradedLongAgo, ben.pubKeyHex, ana.pubKeyHex, ago(102), ago(100), ago(100));
    se.archiveStaleListings();
    const t = rowOf(traded), tl = rowOf(tradedLongAgo);
    assert(t.status === 'active' && t.active === 1 && photosOf(traded) === 1,
        `a listing unchanged for 100 days that a member traded on 10 days ago stays up with its photo (${JSON.stringify(t)})`);
    assert(tl.status === 'cancelled' && tl.active === 0 && photosOf(tradedLongAgo) === 0,
        `one whose last deal was 100 days ago is archived (${JSON.stringify(tl)})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });


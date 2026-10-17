/**
 * Test Suite: the global node's limits that keep its cost flat, free with limits and the limits published
 * (DESIGN-global-mothership-fable §4.2, decision 7; Marty, 2026-10-18), and the same actions on a local community, untouched.
 * One database, over REAL HTTPS with signed members; every fixture dated from now.
 *
 *  1. A local community. profileLimits(): no archive, no nearby cap, 5 photos, 3 place watches. A listing nothing has
 *     changed in 200 days stays up with its photos through the hourly hygiene. A phone that asks for its nearby set gets
 *     every listing. There are no place watches to set (404). A sixth photo is refused as it always was; five go through.
 *     With the operator's override nodeProfile.retention = true, the same listing is archived (the switch is theirs), and
 *     one with a deal asked for on it is not.
 *  2. The global profile. The boot line says retention is on. profileLimits(): 90, 5, NEARBY_LISTINGS_MAX, 3. A phone's
 *     nearby set holds NEARBY_LISTINGS_MAX (3 here) of the 5 listings near it. A sixth photo on a new listing and on an
 *     edit: 400, "A post can have at most 5 photos. Take one off to add another." A fourth place watch: 409 watch_limit,
 *     limit 3, "You can watch up to 3 places. Remove one to watch another."; PLACE_WATCHES_MAX=2 makes it the third; a
 *     value out of range keeps 3 and says so once.
 *  3. The archive on global. A listing unchanged for 91 days and a paused one for 100 are taken off the Market (cancelled,
 *     inactive, stamped now) and lose their photos: the rows gone, a post_photos tombstone per slot, the image store's
 *     objects left to its orphan sweep, which takes them. One taken down 120 days ago loses its photos and is stamped;
 *     one taken down with none is not touched. Left alone: 89 days, one a report waits on, one hidden for the moderators
 *     with no report (a burst clean-up's), one a keeper's wage claim waits on (the claim waits on too), an event, a poll,
 *     another community's copy. Each archived listing is `post_removed` to its audience, and its author hears once a run. The
 *     phone's delta brings the cancelled row with no photos. A second run does nothing.
 *  4. Crash-safe, bounded, main server only, the operator's. A listing whose transaction fails keeps everything and the
 *     rest go; the next run takes it. A batch of 1 says more are due. A standby archives nothing. LISTING_ARCHIVE_DAYS=120
 *     keeps a 100-day listing and takes a 130-day one; 7 is out of range and keeps 90. The override retention = false on
 *     global archives nothing.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-global-cost-limits.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.LISTING_ARCHIVE_DAYS;
delete process.env.PLACE_WATCHES_MAX;
delete process.env.NEARBY_LISTINGS_RADIUS_KM;
// Read once, at the first ask: a cap small enough to see.
process.env.NEARBY_LISTINGS_MAX = '3';
process.env.ADMIN_PASSWORD = 'Global-Cost-Limits-Admin-77!';

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setMemberPhoto } from '@beanpool/engine';

let BASE = '';
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';
const PHOTO_CAP = 'A post can have at most 5 photos. Take one off to add another.';
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
/** Where the nearby listings and their reader are; every other fixture is far from here. */
const HERE = { lat: -28.6, lng: 153.5 };
const FAR = { lat: 40.0, lng: -100.0 };

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
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${urlPath.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`), id.privateKey).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${urlPath}`, { method, headers, body: method === 'GET' ? undefined : bodyString });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
}

/** Everything console.log and console.warn said while `fn` ran. */
async function capture(fn: () => unknown | Promise<unknown>): Promise<{ logs: string[]; warns: string[] }> {
    const logs: string[] = [], warns: string[] = [];
    const log = console.log, warn = console.warn;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
    console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')); };
    try { await fn(); } finally { console.log = log; console.warn = warn; }
    return { logs, warns };
}

const SYNC = '/api/marketplace/posts?limit=200&sync=true&types=offer,need,poll,event';

async function main() {
    const { db, initSchema } = await import('./db/db.js');
    const { mirrorNodeProfileAtBoot, profileLimits, setSwitchOverride } = await import('./config/node-profile.js');
    const { setNodeRole } = await import('./config/node-role.js');
    const { getImageStore } = await import('./storage/image-store.js');
    const { cleanStorageAndCompressLogs } = await import('./engine/storage-health.js');

    initSchema();
    const { initAdminPassword } = await import('./config/local-config.js');
    initAdminPassword();
    const se = await import('./state-engine.js');
    await se.initStateEngine();
    const { archiveStaleListings: archiveEngine } = await import('./engine/posts.js');
    const { initTls } = await import('./services/tls.js');
    const { startHttpsServer } = await import('./https-server.js');
    await initTls();
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    const { stopPricingAggregatorWorker } = await import('./pricing-aggregator.js');
    stopPricingAggregatorWorker();

    /** A member as a join leaves one, with a profile photo (a local community asks for one before a listing). */
    const member = (callsign: string, area: { lat: number; lng: number } | null = null): Id => {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, updated_at, invited_by, invite_code, area_lat, area_lng, area_updated_at)
                    VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', ?, ?, ?, ?)`)
            .run(pubKeyHex, callsign, `INV-${callsign.toUpperCase()}`, area?.lat ?? null, area?.lng ?? null, area ? new Date().toISOString() : null);
        setMemberPhoto(db, pubKeyHex, TINY_PNG);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(pubKeyHex);
        return { pubKeyHex, privateKey, callsign };
    };
    /** An Offer made as the engine makes one, then dated: its last change `days` ago, and taken down or paused if asked. */
    const listing = (author: Id, title: string, photos: number, days: number, opts: { status?: 'paused' | 'cancelled' | 'completed'; at?: { lat: number; lng: number } } = {}): string => {
        const at = opts.at ?? FAR;
        const p = se.createPost('offer', 'general', title, `${title}, described`, 0, 'fixed', author.pubKeyHex, at.lat, at.lng,
            Array(photos).fill(TINY_PNG));
        if (!p) throw new Error(`could not make ${title}`);
        const stamp = ago(days);
        if (opts.status) {
            db.prepare('UPDATE posts SET status = ?, active = 0, created_at = ?, updated_at = ? WHERE id = ?').run(opts.status, stamp, stamp, p.id);
        } else {
            db.prepare('UPDATE posts SET created_at = ?, updated_at = ? WHERE id = ?').run(stamp, stamp, p.id);
        }
        return p.id;
    };
    const rowOf = (id: string) => db.prepare('SELECT status, active, updated_at FROM posts WHERE id = ?').get(id) as { status: string; active: number; updated_at: string };
    const photosOf = (id: string) => (db.prepare('SELECT COUNT(*) AS n FROM post_photos WHERE post_id = ?').get(id) as { n: number }).n;
    const keysOf = (id: string) => (db.prepare('SELECT storage_key FROM post_photos WHERE post_id = ? ORDER BY order_num').all(id) as { storage_key: string | null }[])
        .map(r => r.storage_key);
    const photoTombstones = (id: string) => (db.prepare(`SELECT row_key FROM tombstones WHERE table_name = 'post_photos' AND row_key LIKE ? ORDER BY row_key`)
        .all(`${id}|%`) as { row_key: string }[]).map(r => r.row_key);
    const isUp = (id: string) => { const r = rowOf(id); return r.status === 'active' && r.active === 1; };
    const isArchived = (id: string) => { const r = rowOf(id); return r.status === 'cancelled' && r.active === 0; };
    const fresh = (iso: string) => Date.now() - Date.parse(iso) < 60_000;
    const post = (who: Id, body: Record<string, unknown>) =>
        call('POST', '/api/marketplace/posts', { type: 'offer', category: 'general', description: 'Spare', ...body, authorPublicKey: who.pubKeyHex }, who);
    const sixPhotos = Array(6).fill(TINY_PNG);
    const fivePhotos = Array(5).fill(TINY_PNG);

    // ── 1. A local community ──
    console.log('── 1. a local community: nothing archived, the caps as they were ──');
    const localLimits = profileLimits();
    assert(localLimits.listingArchiveDays === null && localLimits.nearbyListingsMax === null && localLimits.photosPerListing === 5 && localLimits.placeWatches === 3,
        `profileLimits(): no archive, no nearby cap, 5 photos, 3 place watches (${JSON.stringify(localLimits)})`);
    const lena = member('Lena', HERE);
    const lenaOld = listing(lena, 'Old ladder', 2, 200);
    se.runMarketplaceHygiene();
    assert(isUp(lenaOld) && photosOf(lenaOld) === 2, `a listing nothing has changed in 200 days stays up with its 2 photos through the hourly hygiene (${JSON.stringify(rowOf(lenaOld))}, ${photosOf(lenaOld)})`);
    const localDirect = archiveEngine(() => {}, undefined);
    assert(localDirect.archived === 0 && localDirect.photosDropped === 0, `and the archive itself does nothing here (${JSON.stringify(localDirect)})`);

    const near = Array.from({ length: 5 }, (_, i) => listing(lena, `Near thing ${i}`, 0, 1, { at: { lat: HERE.lat + i * 0.01, lng: HERE.lng } }));
    const reader = member('Rae', HERE);
    const localNearby = await call('GET', `${SYNC}&nearby=1`, null, reader);
    const localIds: string[] = Array.isArray(localNearby.body) ? localNearby.body.map((p: any) => p.id) : [];
    assert(localNearby.status === 200 && Array.isArray(localNearby.body) && near.every(id => localIds.includes(id)) && localIds.includes(lenaOld),
        `a phone that asks for its nearby set gets every listing, the 5 near it and the far one (${localNearby.status}, ${localIds.length} rows)`);

    const localWatch = await call('POST', '/api/global/watches', { lat: 10, lng: 10 }, reader);
    assert(localWatch.status === 404, `there are no place watches to set here (${localWatch.status})`);

    const localSix = await post(lena, { title: 'Six photos', photos: sixPhotos });
    assert(localSix.status === 400 && localSix.body?.error === PHOTO_CAP, `a sixth photo is refused as always, now saying what to do (${localSix.status} ${JSON.stringify(localSix.body)})`);
    const localFive = await post(lena, { title: 'Five photos', photos: fivePhotos });
    assert(localFive.status === 200, `five go through (${localFive.status} ${JSON.stringify(localFive.body?.error ?? '')})`);

    console.log('\n── 1b. the operator turns retention on here ──');
    setSwitchOverride('retention', true);
    assert(profileLimits().listingArchiveDays === 90, `with nodeProfile.retention = true the archive is 90 days here too (${profileLimits().listingArchiveDays})`);
    const asked = listing(lena, 'Asked for', 1, 150);
    const buyer = member('Bo');
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status) VALUES (?, ?, ?, ?, 0, 'requested')`)
        .run(crypto.randomUUID(), asked, buyer.pubKeyHex, lena.pubKeyHex);
    const optIn = se.archiveStaleListings();
    assert(optIn.archived === 1 && isArchived(lenaOld) && photosOf(lenaOld) === 0, `the 200-day listing is archived, its photos gone (${JSON.stringify(optIn)})`);
    assert(isUp(asked) && photosOf(asked) === 1, 'one with a deal asked for on it is left alone');
    assert(near.every(isUp), 'the listings changed yesterday stay up');
    setSwitchOverride('retention', false);
    assert(profileLimits().listingArchiveDays === null, 'the override taken off, a local community archives nothing again');
    // Out of the way of what follows: no deal on the node (a ledger that has moved keeps Beans on wherever the profile
    // goes), and the listing changed today.
    db.prepare('DELETE FROM marketplace_transactions WHERE post_id = ?').run(asked);
    db.prepare('UPDATE posts SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), asked);

    // ── 2. The global profile ──
    console.log('\n── 2. NODE_PROFILE=global: the limits, and where a member meets them ──');
    process.env.NODE_PROFILE = 'global';
    const boot = await capture(() => mirrorNodeProfileAtBoot());
    assert(boot.logs.some(l => /Retention is on: a listing is archived 90 days after it last changed/.test(l)),
        `the boot says retention is on, and the number (${boot.logs.filter(l => /Retention/.test(l)).join(' | ') || 'nothing'})`);
    // Probation's own daily photo allowance is test-global-moderation's; here only the listing's cap answers.
    setSwitchOverride('probation', false);
    const limits = profileLimits();
    assert(limits.listingArchiveDays === 90 && limits.photosPerListing === 5 && limits.nearbyListingsMax === 3 && limits.placeWatches === 3,
        `profileLimits(): 90 days, 5 photos, NEARBY_LISTINGS_MAX (3 here; 500 unset), 3 place watches (${JSON.stringify(limits)})`);

    const globalNearby = await call('GET', `${SYNC}&nearby=1`, null, reader);
    const set: string[] = globalNearby.body?.set ?? [];
    assert(globalNearby.status === 200 && set.length === 3 && set.every(id => near.includes(id)),
        `a phone's nearby set holds 3 of the 5 listings near it (${globalNearby.status}, ${JSON.stringify(set)})`);

    const gia = member('Gia');
    const globalSix = await post(gia, { title: 'Six photos', photos: sixPhotos });
    assert(globalSix.status === 400 && globalSix.body?.error === PHOTO_CAP, `a sixth photo on a new listing: 400, the sentence (${globalSix.status} ${JSON.stringify(globalSix.body)})`);
    const globalFive = await post(gia, { title: 'Five photos', photos: fivePhotos });
    assert(globalFive.status === 200 && photosOf(globalFive.body?.post?.id) === 5, `five go through (${globalFive.status} ${JSON.stringify(globalFive.body?.error ?? '')})`);
    const edit = await call('POST', '/api/marketplace/posts/update', { id: globalFive.body?.post?.id, authorPublicKey: gia.pubKeyHex, photos: sixPhotos }, gia);
    assert(edit.status === 400 && edit.body?.error === PHOTO_CAP && photosOf(globalFive.body?.post?.id) === 5,
        `a sixth photo on an edit: 400, the sentence, and the listing keeps its five (${edit.status} ${JSON.stringify(edit.body)})`);

    const watchAt = (who: Id, i: number) => call('POST', '/api/global/watches', { lat: 10 + i * 0.5, lng: 10 + i * 0.5 }, who);
    const w = [await watchAt(gia, 0), await watchAt(gia, 1), await watchAt(gia, 2)];
    const fourth = await watchAt(gia, 3);
    assert(w.every(r => r.status === 200) && fourth.status === 409 && fourth.body?.code === 'watch_limit' && fourth.body?.limit === 3
        && fourth.body?.error === 'You can watch up to 3 places. Remove one to watch another.',
        `three place watches; a fourth: 409 watch_limit, limit 3, the sentence (${w.map(r => r.status).join(',')} → ${fourth.status} ${JSON.stringify(fourth.body)})`);
    process.env.PLACE_WATCHES_MAX = '2';
    const hal = member('Hal');
    const h = [await watchAt(hal, 0), await watchAt(hal, 1)];
    const halThird = await watchAt(hal, 2);
    const halList = await call('GET', '/api/global/watches', null, hal);
    assert(h.every(r => r.status === 200) && halThird.status === 409 && halThird.body?.limit === 2
        && halThird.body?.error === 'You can watch up to 2 places. Remove one to watch another.' && halList.body?.limit === 2,
        `PLACE_WATCHES_MAX=2: the third is refused, limit 2, and the list says 2 (${h.map(r => r.status).join(',')} → ${halThird.status} ${JSON.stringify(halThird.body)}; list ${halList.body?.limit})`);
    process.env.PLACE_WATCHES_MAX = '500';
    const outOfRange = await capture(() => { profileLimits(); profileLimits(); });
    assert(profileLimits().placeWatches === 3 && outOfRange.warns.filter(x => x.includes('PLACE_WATCHES_MAX="500"')).length === 1,
        `PLACE_WATCHES_MAX=500 is out of range: 3, said once (${outOfRange.warns.join(' | ')})`);
    delete process.env.PLACE_WATCHES_MAX;

    // ── 3. The archive ──
    console.log('\n── 3. the 90-day archive on global ──');
    const ana = member('Ana');
    const old = listing(ana, 'Old bike', 2, 91);
    const paused = listing(ana, 'Paused chairs', 1, 100, { status: 'paused' });
    const down = listing(ana, 'Taken down', 1, 120, { status: 'cancelled' });
    const downBare = listing(ana, 'Taken down, no photo', 0, 120, { status: 'cancelled' });
    const young = listing(ana, 'Still fresh', 1, 89);
    const reported = listing(ana, 'Reported', 1, 100);
    db.prepare(`INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, target_post_id, reason, status) VALUES (?, ?, ?, ?, 'spam', 'pending')`)
        .run(crypto.randomUUID(), gia.pubKeyHex, ana.pubKeyHex, reported);
    // Hidden 100 days ago as a burst clean-up hides (engine/burst-cleanup.ts hideBurstPosts): the hide stamp is the
    // listing's last change, and there is no report row.
    const hidden = listing(ana, 'Hidden for review', 1, 101);
    db.prepare('UPDATE posts SET hidden_by_reports_at = ?, updated_at = ? WHERE id = ?').run(ago(100), ago(100), hidden);
    // A keeper's job its enterprise asked to pay for and couldn't yet (escrow.ts requestPost): no deal row, the listing's
    // clock not moved, and the claim paid the day the enterprise can (processDeferredWageClaims).
    const waged = listing(ana, 'Waged job', 1, 100);
    const workshop = member('Workshop');
    const claim = crypto.randomUUID();
    db.prepare(`INSERT INTO deferred_wage_claims (id, enterprise_pubkey, keeper_pubkey, post_id, amount, status) VALUES (?, ?, ?, ?, 40, 'pending')`)
        .run(claim, workshop.pubKeyHex, ana.pubKeyHex, waged);
    const raw = db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status, active, created_at, updated_at, origin_node)
                            VALUES (?, ?, 'general', ?, '', 0, ?, 'active', 1, ?, ?, ?)`);
    const event = `ev-${crypto.randomUUID()}`;
    raw.run(event, 'event', 'Old event', ana.pubKeyHex, ago(100), ago(100), null);
    const pollId = `poll-${crypto.randomUUID()}`;
    raw.run(pollId, 'poll', 'Old poll', ana.pubKeyHex, ago(100), ago(100), null);
    const copy = `copy-${crypto.randomUUID()}`;
    raw.run(copy, 'offer', 'Another community\'s', ana.pubKeyHex, ago(100), ago(100), 'peer-elsewhere');
    const untouched = [young, reported, hidden, waged, event, pollId, copy, downBare];
    const before = new Map(untouched.map(id => [id, rowOf(id).updated_at]));
    const oldKeys = keysOf(old);
    const youngKeys = keysOf(young);
    const store = getImageStore();
    assert(oldKeys.length === 2 && oldKeys.every(k => !!k && !!store.head(k)) && youngKeys.every(k => !!k && !!store.head(k)),
        `the fixtures' photos are objects in the image store (${JSON.stringify(oldKeys)})`);
    const since = new Date(Date.now() - 1000).toISOString();

    const heard: Array<{ event: any; recipients?: string[] }> = [];
    const told: Array<{ to: string[]; title: string; body: string; kind: string }> = [];
    const first = archiveEngine((event, recipients) => { heard.push({ event, recipients }); }, (to, _actor, title, body, _data, _cat, kind) => { told.push({ to, title, body, kind }); });
    assert(first.archived === 2 && first.photosDropped === 4 && first.more === false,
        `one run: 2 listings archived, 4 photos dropped (2 + 1 + the taken-down one's 1) (${JSON.stringify(first)})`);
    for (const [id, what] of [[old, '91 days'], [paused, 'paused, 100 days']] as const) {
        const r = rowOf(id);
        assert(isArchived(id) && fresh(r.updated_at) && photosOf(id) === 0,
            `${what}: cancelled, inactive, stamped now, no photo rows (${JSON.stringify(r)}, ${photosOf(id)})`);
    }
    assert(JSON.stringify(photoTombstones(old)) === JSON.stringify([`${old}|0`, `${old}|1`]) && photoTombstones(paused).length === 1,
        `a post_photos tombstone per slot, for a standby (${JSON.stringify(photoTombstones(old))})`);
    const downRow = rowOf(down);
    assert(downRow.status === 'cancelled' && photosOf(down) === 0 && fresh(downRow.updated_at) && photoTombstones(down).length === 1,
        `taken down 120 days ago: loses its photo, stays cancelled, stamped so a phone reads it again (${JSON.stringify(downRow)})`);
    for (const id of untouched) {
        assert(rowOf(id).updated_at === before.get(id) && rowOf(id).status === (id === downBare ? 'cancelled' : 'active'),
            `left alone: ${db.prepare('SELECT title FROM posts WHERE id = ?').pluck().get(id)} (${JSON.stringify(rowOf(id))})`);
    }
    assert(photosOf(young) === 1 && photosOf(reported) === 1, 'the 89-day listing and the reported one keep their photos');
    assert(photosOf(hidden) === 1, `one hidden for the moderators with no report keeps its photos, for a moderator to see as it was (${photosOf(hidden)})`);
    const claimStatus = db.prepare('SELECT status FROM deferred_wage_claims WHERE id = ?').pluck().get(claim);
    assert(photosOf(waged) === 1 && claimStatus === 'pending',
        `one a keeper's wage claim waits on keeps its photos, and the claim still waits to be paid (${photosOf(waged)}, ${claimStatus})`);
    const removedIds = heard.filter(h => h.event?.type === 'post_removed').map(h => h.event.id);
    assert(removedIds.length === 2 && removedIds.includes(old) && removedIds.includes(paused), `post_removed for each archived listing, and nothing else (${JSON.stringify(removedIds)})`);
    assert(told.length === 1 && told[0].to[0] === ana.pubKeyHex && told[0].kind === 'market.listing' && /^2 of your listings were taken off the Market: nothing had changed on them in 90 days/.test(told[0].body),
        `the author hears once for the run (${JSON.stringify(told)})`);

    assert(oldKeys.every(k => !!store.head(k!)), 'the objects wait for the image store\'s orphan sweep, not this run');
    const disk = (store as any).root as string | undefined;
    if (store.kind === 'disk' && disk) {
        const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
        for (const k of [...oldKeys, ...youngKeys]) fs.utimesSync(path.join(disk, k!), past, past);
    }
    await cleanStorageAndCompressLogs();
    assert(oldKeys.every(k => !store.head(k!)) && youngKeys.every(k => !!store.head(k!)),
        `the orphan sweep takes the archived listing's objects, and keeps the young one's (${store.kind})`);

    const delta = await call('GET', `${SYNC}&updatedAfter=${encodeURIComponent(since)}`, null, gia);
    const deltaRow = (Array.isArray(delta.body) ? delta.body : delta.body?.posts ?? []).find((p: any) => p.id === old);
    assert(delta.status === 200 && deltaRow?.status === 'cancelled' && (deltaRow?.photos ?? []).length === 0,
        `the phone's delta brings the archived listing, cancelled, with no photos (${delta.status} ${JSON.stringify(deltaRow && { status: deltaRow.status, photos: deltaRow.photos })})`);

    const again = se.archiveStaleListings();
    assert(again.archived === 0 && again.photosDropped === 0, `a second run does nothing (${JSON.stringify(again)})`);

    // ── 4. Crash-safe, bounded, main server only, the operator's ──
    console.log('\n── 4. one transaction a listing; a batch; a standby; the operator\'s settings ──');
    const stuck = listing(ana, 'Stuck', 1, 95);
    const free1 = listing(ana, 'Free one', 1, 96);
    db.exec(`CREATE TEMP TRIGGER refuse_stuck BEFORE UPDATE ON posts WHEN OLD.id = '${stuck}' BEGIN SELECT RAISE(ABORT, 'refused by the test'); END`);
    const partial = await capture(() => se.archiveStaleListings());
    assert(isUp(stuck) && photosOf(stuck) === 1 && photoTombstones(stuck).length === 0 && isArchived(free1),
        'a listing whose transaction fails keeps its row and photos whole, and the rest are archived');
    assert(partial.warns.some(x => x.includes('[Retention] could not archive listing')), 'and the log says which');
    db.exec('DROP TRIGGER refuse_stuck');
    assert(se.archiveStaleListings().archived === 1 && isArchived(stuck) && photosOf(stuck) === 0, 'the next run takes it');

    const b1 = listing(ana, 'Batch one', 0, 97);
    const b2 = listing(ana, 'Batch two', 0, 98);
    const batchRun = archiveEngine(() => {}, undefined, Date.now(), 1);
    assert(batchRun.archived === 1 && batchRun.more === true && isArchived(b2) && isUp(b1), `a batch of 1 takes the oldest and says more are due (${JSON.stringify(batchRun)})`);
    assert(archiveEngine(() => {}, undefined, Date.now(), 1).more === false && isArchived(b1), 'the next takes the rest');

    const standbyOld = listing(ana, 'On a standby', 1, 100);
    setNodeRole('backup');
    const onStandby = archiveEngine(() => {}, undefined);
    setNodeRole('primary');
    assert(onStandby.archived === 0 && isUp(standbyOld) && photosOf(standbyOld) === 1, 'a standby archives nothing: its main server\'s copy brings the result');
    se.archiveStaleListings();

    process.env.LISTING_ARCHIVE_DAYS = '120';
    const hundred = listing(ana, 'A hundred days', 0, 100);
    const hundredThirty = listing(ana, 'A hundred and thirty', 0, 130);
    const longer = se.archiveStaleListings();
    assert(profileLimits().listingArchiveDays === 120 && longer.archived === 1 && isUp(hundred) && isArchived(hundredThirty),
        `LISTING_ARCHIVE_DAYS=120 keeps a 100-day listing and takes a 130-day one (${JSON.stringify(longer)})`);
    process.env.LISTING_ARCHIVE_DAYS = '7';
    const tooShort = await capture(() => profileLimits());
    assert(profileLimits().listingArchiveDays === 90 && tooShort.warns.some(x => x.includes('LISTING_ARCHIVE_DAYS="7"') && x.includes('90')),
        `LISTING_ARCHIVE_DAYS=7 is out of range: 90, and the log says so (${tooShort.warns.join(' | ')})`);
    delete process.env.LISTING_ARCHIVE_DAYS;

    setSwitchOverride('retention', false);
    const offRun = se.archiveStaleListings();
    assert(profileLimits().listingArchiveDays === null && offRun.archived === 0 && isUp(hundred),
        `the override nodeProfile.retention = false on global archives nothing (${JSON.stringify(offRun)})`);
    setSwitchOverride('retention', true);
    assert(se.archiveStaleListings().archived === 1 && isArchived(hundred), 'back on, it does');
    delete process.env.NODE_PROFILE;

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ On global a listing nobody touches goes after 90 days with its photos, and the caps answer in plain words; a local community is as it was.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });

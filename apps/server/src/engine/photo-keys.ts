/**
 * A listing's photos for those who may read the listing, on a node whose listings are not a public read: a local
 * community's (Marty, 2026-09-28), where the board is its members' (https-server.ts PUBLIC_ONLY_ON_GUEST_LISTINGS_EXACT).
 *
 * `/api/marketplace/posts/:id/photos/:n` is fetched by `<img>`, which cannot sign a request. Its URL used to be the
 * listing's id and nothing more: a UUID (122 random bits, or whatever id an app sent), and the public pricing guide
 * handed out the photo URLs of listings its prices came from. So on such a node every listing-photo URL the node emits
 * carries a key, `k=` (the engine's postPhotoUrl), and the route serves a photo only to a URL whose key is right for that
 * photo as it is NOW; any other request is answered as if there were no photo (404 `Photo not found`, the same answer,
 * so it tells nobody which is which). The node hands those URLs out only with the listing: its reads, its live events,
 * a trade's cover and an event on one's own calendar all go to those who may read it. The pricing guide carries one
 * only to a reader who may read the listing (routes/pricing-guide.ts). No app changes: every app renders the URL it is
 * given.
 *
 * - The key is `base64url(HMAC-SHA256(secret, 'post-photo|' + postId + '|' + orderNum + '|' + version)).slice(0, 22)`
 *   (132 bits). `version` is the photo row's `updated_at` in ms, the URL's `v`: a replaced photo has a new key, and the
 *   old key opens nothing. Moving a photo into the image store keeps its `updated_at` (services/image-evacuation.ts), so
 *   it keeps its key.
 * - The secret is 32 random bytes in `node_config.photoKeySecret`, written once: it travels with the database (file and
 *   sealed backups, a restore). A server that has no copy of it (a standby that takes over) mints its own: the phones
 *   sync whole when a take-over changes the node's identity epoch (native services/pillar-sync.ts), and the web app
 *   reads the listings again, so both get the new URLs.
 * - Decided at boot, like the rest of what a node runs as: keyed where reads are enforced (ENFORCE_READ_AUTH) and the
 *   visitors' view (`guestListingsOnly`) is off. Elsewhere the listings are a public read, and so are their photos, as
 *   before. An operator who changes either restarts the node, so the URLs it emits and the URLs it serves agree.
 * - A phone keeps the photo URLs it was handed in its own copy of the listings, and syncs by cursor: it is sent again
 *   only a listing that changed. Keying (or no longer keying) the photos, or a new secret (a restore from a backup
 *   older than it), changes every listing's URLs and no listing's `updated_at`, so the URLs such a phone holds would
 *   answer 404 for good. So the boot that changes the URLs' shape records when (`node_config.photoKeysSince`, beside
 *   `photoKeysShape`, what they were), and a sync whose cursor is older is answered whole (routes/marketplace.ts,
 *   photoHealFor): the delta it asked for, every row main would send, first, then a page of the node's other listings
 *   in heal order (engine getPostsForPhotoHeal: those with a photo first, the ones on the board before the finished
 *   ones), at most PHOTO_HEAL_PAGE_ROWS of them, so one answer is never much past main's largest. A standby's first boot as the main server
 *   counts as a change (photoUrlShape), and so does a standby promoted in this process by a take-over that finishes at
 *   boot (notePhotoUrlShapeNow). A restart that changes nothing keeps both. To make every phone's next sync whole by
 *   hand (a rollback to an image from before these records, then forward again), delete the photoKeysShape row and
 *   restart (operator manual, Updates and health).
 * - A node with more listings with a photo than one page heals a phone over its next syncs: the page's last place in
 *   heal order is kept for that key (`photo_url_heals`, this server's own), and each sync after it carries its delta
 *   and the next page, until no listing with a photo is left. The phone moves its cursor only when a whole sync
 *   succeeded (pillar-sync.ts), so a cursor other than the one the last page went to means that page arrived: the
 *   next page follows. The same cursor again means it may not have (a pull that ran out of time, a cycle that failed
 *   after it): the same page again, so no page is skipped. That holds inside the phone's five-minute overlap too, where
 *   its cursor is still older than photoKeysSince: a cursor newer than the one the last page went to carries on from
 *   it, and a finished heal's row is kept (after_key NULL) until the key's cursor is past photoKeysSince, so the whole
 *   answer goes once, not at every sync of those five minutes. An older cursor than that row's (not the phone that
 *   moved it) starts again from the first page, as it can't be told what arrived.
 * - The place is kept per key, not per phone or per read. One key on two phones takes the pages in turn: each sync of
 *   either gets the page after the last one sent to the key, so each phone gets some of the pages; each keeps healing,
 *   and each gets every listing it lacks when the other stops syncing or the listing changes (reviewed on a6b65b84: at
 *   1,471 listings one phone healed all, the other 997). And any read with a cursor counts, whatever its filters: a
 *   filtered delta (`author=`) from that key would take a page nobody shows. No client sends a cursor with a filter
 *   today, so that is latent. A read with no key, or a signer who is no member, keeps no place: each of its syncs from
 *   before photoKeysSince gets the first page, and each after it a delta, as before. Rows from an earlier shape, and
 *   rows not asked for in 30 days, are dropped at the next boot (noteUrlShape), not as they age.
 */
import crypto from 'node:crypto';
import { configurePhotoKeys, photoVersionOf } from '@beanpool/engine';
import { db } from '../db/db.js';
import { getProfileSwitches } from '../config/node-profile.js';
import { getNodeRole } from '../config/node-role.js';

export const PHOTO_KEY_SECRET_ROW = 'photoKeySecret';
/**
 * What the photo URLs this server emits look like: `open`, or `keyed:` and a fingerprint of the secret, and `@standby`
 * on a standby (photoUrlShape).
 */
export const PHOTO_KEYS_SHAPE_ROW = 'photoKeysShape';
/** When that last changed (ISO 8601): a sync from before it holds URLs that no longer open. */
export const PHOTO_KEYS_SINCE_ROW = 'photoKeysSince';
/**
 * The most listings a heal page adds to the delta it follows: the 200 every other page stops at (https-server.ts
 * clampLimit). The node sends JSON uncompressed, and the phone's posts pull has 30 s for the whole answer
 * (apps/native services/pillar-sync.ts); a page of 1000 was about 900 KB, which a phone below about 250 kbit/s never
 * finished, retrying the same page for ever (review of a6b65b84, finding 2). The rest heals over the key's next syncs.
 */
export const PHOTO_HEAL_PAGE_ROWS = 200;
/** How long a heal under way is kept for a key that stops asking (photo_url_heals). */
const HEAL_KEPT_MS = 30 * 24 * 60 * 60 * 1000;

/** The key's length: 22 base64url characters, 132 bits. */
const KEY_CHARS = 22;

let secret: Buffer | null = null;
/** photoKeysSince in ms, as this boot found or wrote it; null before installPhotoKeysAtBoot. */
let urlsChangedAtMs: number | null = null;

function photoKeySecret(): Buffer {
    let row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(PHOTO_KEY_SECRET_ROW) as { value: string } | undefined;
    if (!row) {
        // INSERT OR IGNORE then read back: whoever wrote first wins, and every caller uses what was written.
        db.prepare('INSERT OR IGNORE INTO node_config (key, value) VALUES (?, ?)')
            .run(PHOTO_KEY_SECRET_ROW, crypto.randomBytes(32).toString('base64url'));
        row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(PHOTO_KEY_SECRET_ROW) as { value: string };
    }
    const key = Buffer.from(String(row.value), 'base64url');
    // A secret edited down to nothing would make every key guessable: refuse to start rather than serve photos with it.
    if (key.length < 16) throw new Error(`node_config ${PHOTO_KEY_SECRET_ROW} is too short to key listings' photos`);
    return key;
}

function keyFor(s: Buffer, postId: string, orderNum: number, version: number): string {
    return crypto.createHmac('sha256', s).update(`post-photo|${postId}|${orderNum}|${version}`, 'utf-8').digest('base64url').slice(0, KEY_CHARS);
}

/**
 * At boot: on a node whose listings are not a public read (reads enforced, no visitors' view), every listing-photo URL
 * carries its key from now on and the route asks for it; elsewhere neither. Returns whether photos are keyed.
 */
export function installPhotoKeysAtBoot(enforceReadAuth: boolean = process.env.ENFORCE_READ_AUTH !== 'false'): boolean {
    if (!enforceReadAuth || getProfileSwitches().guestListingsOnly) {
        secret = null;
        configurePhotoKeys(null);
        noteUrlShape(null);
        return false;
    }
    const s = photoKeySecret();
    secret = s;
    configurePhotoKeys((postId, orderNum, version) => keyFor(s, postId, orderNum, version));
    noteUrlShape(s);
    return true;
}

/**
 * The shape of every listing-photo URL this server emits with `s` (null: unkeyed). Keyed, a fingerprint of the secret
 * (an HMAC of a fixed text, so it says nothing of the secret): a new secret is a new shape. A standby's is marked as
 * such: no phone syncs from it, and the phones that sync from it once it takes over hold the URLs of the main server
 * it replaced, keyed with that server's secret, not its own. So its first boot as the main server (a take-over, or a
 * promotion by hand) is a new shape too, for a phone that predates the identity epoch (apps/native
 * services/pillar-sync.ts) as much as for one that has it.
 */
function photoUrlShape(s: Buffer | null): string {
    const shape = s ? `keyed:${crypto.createHmac('sha256', s).update('photo-url-shape', 'utf-8').digest('base64url').slice(0, 16)}` : 'open';
    return getNodeRole() === 'backup' ? `${shape}@standby` : shape;
}

/**
 * At boot: when the photo URLs' shape is not the one recorded (keys switched on or off, a new secret, or no record, as on
 * a node from before this record, whose phones may hold URLs of either shape), record it, and as photoKeysSince now, or
 * the start of time where the node holds no listing photo yet (a new node): no phone can hold a URL that stopped
 * opening, so no sync is answered whole for it. Otherwise keep both. Either way this boot answers by photoKeysSince
 * (photoUrlsChangedAfter).
 */
function noteUrlShape(s: Buffer | null): void {
    const read = (key: string) => (db.prepare('SELECT value FROM node_config WHERE key = ?').get(key) as { value: string } | undefined)?.value;
    const shape = photoUrlShape(s);
    let since = read(PHOTO_KEYS_SINCE_ROW);
    if (read(PHOTO_KEYS_SHAPE_ROW) !== shape || !since || !Number.isFinite(Date.parse(since))) {
        const anyPhoto = db.prepare('SELECT 1 FROM post_photos LIMIT 1').get() !== undefined;
        since = new Date(anyPhoto ? Date.now() : 0).toISOString();
        const put = db.prepare('INSERT OR REPLACE INTO node_config (key, value) VALUES (?, ?)');
        db.transaction(() => {
            put.run(PHOTO_KEYS_SHAPE_ROW, shape);
            put.run(PHOTO_KEYS_SINCE_ROW, since);
        })();
    }
    urlsChangedAtMs = Date.parse(since);
    // A heal's pages are for the shape it began under: one left from an earlier shape starts again from its first page.
    // And one not asked for in a month is forgotten: that phone's next sync, if it comes, is whole anyway or a delta.
    db.prepare('DELETE FROM photo_url_heals WHERE since != ? OR served_at < ?').run(since, new Date(Date.now() - HEAL_KEPT_MS).toISOString());
}

/**
 * The shape again, now: for a standby that a take-over finishing at boot promotes in this process (services/takeover.ts
 * resumeTakeoverAtBoot), after installPhotoKeysAtBoot recorded it as a standby's. Without it the phones that synced from
 * the server it replaced would wait for the next restart. Does nothing before installPhotoKeysAtBoot.
 */
export function notePhotoUrlShapeNow(): void {
    if (urlsChangedAtMs === null) return;
    noteUrlShape(secret);
}

/**
 * Whether a sync whose cursor is `updatedAfter` (an ISO 8601 time) was made before this server's listing-photo URLs
 * last changed shape (photoKeysSince): then every listing it holds may carry a URL that no longer opens, and it is
 * healed (photoHealFor). False without a cursor, or with one that isn't a time.
 *
 * The phone's cursor is its clock at its last sync less five minutes (apps/native services/pillar-sync.ts), so a phone
 * that syncs in the five minutes after the change still sends a cursor older than photoKeysSince; that is what heals a
 * phone whose clock is up to five minutes fast, and it happens only after a boot that changed the URLs. Its key's heal
 * row tells photoHealFor which of those syncs already got a page, so each page goes once.
 */
export function photoUrlsChangedAfter(updatedAfter: string | undefined): boolean {
    if (urlsChangedAtMs === null || !updatedAfter) return false;
    const cursor = Date.parse(updatedAfter);
    return Number.isFinite(cursor) && cursor < urlsChangedAtMs;
}

/** How a sync is answered for its photo URLs (photoHealFor). */
export interface PhotoHealPlan {
    /** `whole`: from the first page. `heal:…`: a later page for this key. */
    tag: string;
    /** Where the page starts ('' for the first). */
    after: string;
}

interface HealRow { cursor: string; from_key: string; after_key: string | null }

const sinceIso = () => new Date(urlsChangedAtMs!).toISOString();

/** The plan for a page starting at `from` ('' the first). */
function pageFrom(from: string): PhotoHealPlan {
    return from === '' ? { tag: 'whole', after: '' }
        : { tag: `heal:${crypto.createHash('sha256').update(from).digest('hex').slice(0, 16)}`, after: from };
}

/**
 * How the sync of `viewer` (the signer, if any) with cursor `updatedAfter` is answered: a heal page (its delta, then the
 * page), or null for a plain delta. By the key's row (photo_url_heals), when it has one for this shape:
 * - the same cursor the row's last page went to: that page again. The phone moves its cursor only after a sync that
 *   succeeded, so it may never have had it (a retry);
 * - another cursor, past photoKeysSince, or older than it but newer than the row's (the phone that got the last page,
 *   syncing again inside its five-minute overlap): the page after it, or, when the heal is done, null. The row goes once
 *   the cursor is past photoKeysSince; inside the overlap it stays, so the whole answer isn't sent again;
 * - otherwise (no row, or a cursor older than photoKeysSince and no newer than the row's): from the first page when the
 *   cursor is older than photoKeysSince, else null.
 */
export function photoHealFor(updatedAfter: string | undefined, viewer: string | undefined): PhotoHealPlan | null {
    if (urlsChangedAtMs === null || !updatedAfter) return null;
    const cursor = Date.parse(updatedAfter);
    if (!Number.isFinite(cursor)) return null;
    const stale = photoUrlsChangedAfter(updatedAfter);
    const row = viewer
        ? db.prepare('SELECT cursor, from_key, after_key FROM photo_url_heals WHERE viewer = ? AND since = ?').get(viewer, sinceIso()) as HealRow | undefined
        : undefined;
    if (row) {
        if (row.cursor === updatedAfter) return pageFrom(row.from_key);
        const rowCursor = Date.parse(row.cursor);
        if (!stale || (Number.isFinite(rowCursor) && cursor > rowCursor)) {
            if (row.after_key !== null) return pageFrom(row.after_key);
            if (!stale) db.prepare('DELETE FROM photo_url_heals WHERE viewer = ?').run(viewer);
            return null;
        }
    }
    return stale ? pageFrom('') : null;
}

/**
 * After a page of `plan` went to `viewer` for cursor `updatedAfter`: where its next sync picks up (`next`, the read's; null
 * when no listing with a photo is left, kept so the key's next syncs inside the overlap are deltas). Kept only for a key
 * with a member row here, so a key that merely signs can't fill what the node keeps; a read with no key keeps nothing.
 */
export function notePhotoHealServed(viewer: string | undefined, updatedAfter: string, plan: PhotoHealPlan, next: string | null): void {
    if (!viewer || urlsChangedAtMs === null) return;
    if (!db.prepare('SELECT 1 FROM members WHERE public_key = ?').get(viewer)) return;
    db.prepare(`INSERT OR REPLACE INTO photo_url_heals (viewer, since, cursor, from_key, after_key, served_at)
                VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
        .run(viewer, sinceIso(), updatedAfter, plan.after, next);
}

/** Whether this node serves a listing's photo only to a URL with its key (installPhotoKeysAtBoot). */
export function photoKeysRequired(): boolean {
    return secret !== null;
}

/**
 * Whether `k` is the key for this photo as its row is now (`updatedAt`, the row's). False for anything else: the route
 * answers a wrong key as it answers a photo that isn't there.
 */
export function photoKeyMatches(postId: string, orderNum: number, updatedAt: string | null | undefined, k: unknown): boolean {
    if (!secret || typeof k !== 'string' || k.length !== KEY_CHARS) return false;
    const want = Buffer.from(keyFor(secret, postId, orderNum, photoVersionOf(updatedAt)));
    const got = Buffer.from(k);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
}

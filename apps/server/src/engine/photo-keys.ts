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
 */
import crypto from 'node:crypto';
import { configurePhotoKeys, photoVersionOf } from '@beanpool/engine';
import { db } from '../db/db.js';
import { getProfileSwitches } from '../config/node-profile.js';

export const PHOTO_KEY_SECRET_ROW = 'photoKeySecret';

/** The key's length: 22 base64url characters, 132 bits. */
const KEY_CHARS = 22;

let secret: Buffer | null = null;

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
        return false;
    }
    const s = photoKeySecret();
    secret = s;
    configurePhotoKeys((postId, orderNum, version) => keyFor(s, postId, orderNum, version));
    return true;
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

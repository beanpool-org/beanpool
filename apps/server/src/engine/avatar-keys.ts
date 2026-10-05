/**
 * Faces for members only, on a node that shows visitors the listings and not the people (global node G9a-2, design
 * §4; the profile's `guestListingsOnly`).
 *
 * `/api/avatar/:pubkey` is fetched by `<img>`, which cannot sign a request, so it has always been public: anyone with a
 * member's key could fetch their face. On such a node every avatar URL the node emits carries a key, `k=`, and the
 * route serves a face only to a URL whose key is right for that member's photo as it is NOW; any other request is
 * answered as if there were no photo (404 `Avatar not found`, the same answer, so it tells nobody which is which). The
 * node hands those URLs to members alone: the members list, profiles, DMs, groups and RSVPs are members-only, and a
 * visitor's listings carry no face (the engine's guestPost). No app changes: every app renders the URL it is given.
 *
 * - The key is `base64url(HMAC-SHA256(secret, id + '|' + version)).slice(0, 22)` (132 bits). `version` is the photo's
 *   content version (@beanpool/core avatarVersionOf, kept in the members row's avatar_ref), so a new photo has a new
 *   key, and the old key opens nothing; it changes exactly when the URL's `v` does, which already brings members the
 *   new URL.
 * - The secret is 32 random bytes in `node_config.avatarKeySecret`, written once: it travels with the database (file
 *   and sealed backups, a restore). A server that has no copy of it (a standby, a take-over) mints its own, and members'
 *   saved URLs show initials until their next members sync brings the new ones: a nuisance, never a leak.
 * - Decided at boot, like the rest of what a node runs as: an operator who switches `guestListingsOnly` restarts the
 *   node, so the URLs it emits and the URLs it serves always agree.
 * - A phone keeps the face URLs it was handed in its own copy of the members, and between its hourly whole reads asks
 *   only for the members changed since its cursor (apps/native services/pillar-sync.ts, `/api/members?updatedAfter=`).
 *   Keying faces or no longer keying them (`guestListingsOnly` or a private preview switched), or a new secret, changes
 *   every member's URL and no member's row, so the URLs such a phone holds would stop opening until its next whole read
 *   (review of #1645). So the boot that changes the URLs' shape records when (`node_config.avatarKeysSince`, beside
 *   `avatarKeysShape`, what they were), and a delta from a phone with no sync since then is answered with the whole
 *   directory (routes/community.ts, faceUrlsChangedAfter), as listing photos are healed (engine/photo-keys.ts). A
 *   restart that changes nothing keeps both, and every delta is as before.
 *
 * A GROUP's own picture (#1486) is served the same way, at `/api/groups/:id/picture`, and keyed on EVERY node: a group is
 * a members' read everywhere (https-server.ts gates every /api/groups read), so its picture goes only to a URL a group read
 * handed out. Its key is the same HMAC with the same secret over `'group-picture|' + id + '|' + version`, so it can never
 * be a member's key, and a new picture has a new key.
 */
import crypto from 'node:crypto';
import { avatarVersionOfRef, configureAvatarKeys, configureGroupPictureKeys } from '@beanpool/core';
import { db } from '../db/db.js';
import { getProfileSwitches } from '../config/node-profile.js';
import { isPrivatePreview } from '../config/private-preview.js';
import { getNodeRole } from '../config/node-role.js';

export const AVATAR_KEY_SECRET_ROW = 'avatarKeySecret';

/**
 * What the face URLs this server emits look like (faceUrlShape): `open` (no key), or `keyed:` and a fingerprint of the
 * secret; a keyed shape gets `@standby` on a standby, whose own secret is not the one its main server's phones hold (an
 * open URL carries no key, so it is the same on both, and a take-over of an open node changes no face URL).
 */
export const AVATAR_KEYS_SHAPE_ROW = 'avatarKeysShape';
/** When that last changed (ISO 8601): a members delta from before it holds face URLs that may no longer open. */
export const AVATAR_KEYS_SINCE_ROW = 'avatarKeysSince';
/**
 * How far a phone's cursor trails its last successful sync (apps/native services/pillar-sync.ts: its last sync less
 * 300,000 ms): a cursor this much older than avatarKeysSince, or more, comes from a device with no sync since the change.
 */
const PHONE_CURSOR_LAG_MS = 5 * 60 * 1000;

/** The key's length: 22 base64url characters, 132 bits. */
const KEY_CHARS = 22;

// The secret as one KeyObject, made at boot. Given the bytes, createHmac checks them as a key on every call: measured
// 12 µs an HMAC on Node 26 against 2 µs with the KeyObject (2.3 against 1.7 on Node 22), and every post on the board and
// every member in the list has a URL with one.
let secret: crypto.KeyObject | null = null;

function avatarKeySecret(): Buffer {
    let row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(AVATAR_KEY_SECRET_ROW) as { value: string } | undefined;
    if (!row) {
        // INSERT OR IGNORE then read back: whoever wrote first wins, and every caller uses what was written.
        db.prepare('INSERT OR IGNORE INTO node_config (key, value) VALUES (?, ?)')
            .run(AVATAR_KEY_SECRET_ROW, crypto.randomBytes(32).toString('base64url'));
        row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(AVATAR_KEY_SECRET_ROW) as { value: string };
    }
    const key = Buffer.from(String(row.value), 'base64url');
    // A secret edited down to nothing would make every key guessable: refuse to start rather than serve faces with it.
    if (key.length < 16) throw new Error(`node_config ${AVATAR_KEY_SECRET_ROW} is too short to key members' faces`);
    return key;
}

/** How many keys {@link keyFor} remembers per secret: a members list and a board's faces, a few hundred bytes each. */
export const AVATAR_KEY_MEMO_MAX = 8192;

// The keys already worked out, per secret, most recently used last. A key is a pure function of the secret and
// `id|version`, so a remembered one is byte for byte the one the HMAC would give: a new photo is a new version and so
// a new entry, and a new secret (installAvatarKeysAtBoot makes a new KeyObject) starts an empty memo. Every post on the
// board and every member in the list asks for one on every read: 4 s of 165 s busy in the 10-05 load model.
const memos = new WeakMap<crypto.KeyObject, Map<string, string>>();

function keyFor(s: crypto.KeyObject, id: string, version: string): string {
    const input = `${id}|${version}`;
    let memo = memos.get(s);
    if (!memo) memos.set(s, memo = new Map());
    const known = memo.get(input);
    if (known !== undefined) {
        memo.delete(input);
        memo.set(input, known);
        return known;
    }
    const key = crypto.createHmac('sha256', s).update(input, 'utf-8').digest('base64url').slice(0, KEY_CHARS);
    if (memo.size >= AVATAR_KEY_MEMO_MAX) memo.delete(memo.keys().next().value as string);
    memo.set(input, key);
    return key;
}

/** Test seam: how many keys the memo holds for the secret members' faces are keyed with now (0 with none). */
export function avatarKeyMemoSize(): number {
    return secret ? memos.get(secret)?.size ?? 0 : 0;
}

/**
 * At boot: on a node whose `guestListingsOnly` switch is on, or in a private preview (config/private-preview.ts: a member's
 * face reaches the apps' unsigned `<img>` only with its key), every avatar URL carries its key from now on and the route
 * asks for it; elsewhere neither. Returns whether faces are keyed.
 */
export function installAvatarKeysAtBoot(): boolean {
    // Groups' pictures are keyed on every node (above).
    const s = crypto.createSecretKey(avatarKeySecret());
    groupSecret = s;
    configureGroupPictureKeys((id, version) => keyFor(s, `group-picture|${id}`, version));
    const guestListingsOnly = getProfileSwitches().guestListingsOnly;
    const keyed = guestListingsOnly || isPrivatePreview();
    shapeOf = () => ({ shape: faceUrlShape(s, keyed), unrecorded: faceUrlShape(s, guestListingsOnly) });
    // Before this record, faces were keyed by guestListingsOnly alone (the preview came later): what a node with none had.
    noteFaceUrlShape(shapeOf().shape, shapeOf().unrecorded);
    if (!keyed) {
        secret = null;
        configureAvatarKeys(null);
        return false;
    }
    secret = s;
    configureAvatarKeys((id, version) => keyFor(s, id, version));
    return true;
}

/** avatarKeysSince in ms, as this boot found or wrote it; null before installAvatarKeysAtBoot. */
let facesChangedAtMs: number | null = null;
/** This boot's face-URL shape, worked out again for the role as it is now; null before installAvatarKeysAtBoot. */
let shapeOf: (() => { shape: string; unrecorded: string }) | null = null;

/**
 * The shape again, now: for a standby a take-over promotes in this process, or a roll-back makes a standby again
 * (services/takeover.ts), as engine/photo-keys.ts notePhotoUrlShapeNow. Does nothing before installAvatarKeysAtBoot.
 */
export function noteFaceUrlShapeNow(): void {
    if (!shapeOf) return;
    const { shape, unrecorded } = shapeOf();
    noteFaceUrlShape(shape, unrecorded);
}

/** The shape of the face URLs this server emits (AVATAR_KEYS_SHAPE_ROW). The fingerprint is an HMAC of a fixed text. */
function faceUrlShape(s: crypto.KeyObject, keyed: boolean): string {
    const shape = keyed ? `keyed:${crypto.createHmac('sha256', s).update('avatar-url-shape', 'utf-8').digest('base64url').slice(0, 16)}` : 'open';
    return keyed && getNodeRole() === 'backup' ? `${shape}@standby` : shape;
}

/**
 * At boot: when the face URLs' shape is not the one recorded (or, with no record, not `unrecorded`, the shape the node
 * had before this record), record it, and as avatarKeysSince now, or the start of time where no member has a face (no
 * phone holds a URL that stopped opening). Otherwise keep both, so no delta changes.
 */
function noteFaceUrlShape(shape: string, unrecorded: string): void {
    const read = (key: string) => (db.prepare('SELECT value FROM node_config WHERE key = ?').get(key) as { value: string } | undefined)?.value;
    const stored = read(AVATAR_KEYS_SHAPE_ROW);
    const found = read(AVATAR_KEYS_SINCE_ROW);
    const kept = found && Number.isFinite(Date.parse(found)) ? found : null;
    let since: string;
    if ((stored ?? unrecorded) === shape && kept !== null) {
        since = kept;
    } else {
        const changed = (stored ?? unrecorded) !== shape;
        const anyFace = db.prepare('SELECT 1 FROM members WHERE avatar_ref IS NOT NULL LIMIT 1').get() !== undefined;
        since = changed && anyFace ? new Date().toISOString() : new Date(0).toISOString();
    }
    if (stored !== shape || found !== since) {
        const put = db.prepare('INSERT OR REPLACE INTO node_config (key, value) VALUES (?, ?)');
        db.transaction(() => {
            put.run(AVATAR_KEYS_SHAPE_ROW, shape);
            put.run(AVATAR_KEYS_SINCE_ROW, since);
        })();
    }
    facesChangedAtMs = Date.parse(since);
}

/**
 * Whether a members delta whose cursor is `updatedAfter` comes from a device with no sync since this server's face URLs
 * last changed shape (avatarKeysSince): its cursor, its last sync less five minutes, is older than that by more than the
 * five minutes. Then the faces it holds may not open, and it is answered with the whole directory. A device that synced
 * since (inside those five minutes, or after) gets its delta as before, so each phone gets the whole directory once. A
 * phone whose clock is fast by more than the time between its last sync and the change gets a delta, and its faces come
 * back at its next hourly whole read. False without a cursor, or with one that isn't a time.
 */
export function faceUrlsChangedAfter(updatedAfter: unknown): boolean {
    if (facesChangedAtMs === null || typeof updatedAfter !== 'string') return false;
    const cursor = Date.parse(updatedAfter);
    return Number.isFinite(cursor) && cursor + PHONE_CURSOR_LAG_MS < facesChangedAtMs;
}

// The secret groups' pictures are keyed with: installed at every boot (installAvatarKeysAtBoot).
let groupSecret: crypto.KeyObject | null = null;

/**
 * Whether `k` is the key for group `groupId`'s picture as it is now (the row's avatar_ref). False for anything else, a
 * picture that isn't there and a server that installed no keys included: the route answers each as no picture.
 */
export function groupPictureKeyMatches(groupId: string, k: unknown): boolean {
    if (!groupSecret || typeof k !== 'string' || k.length !== KEY_CHARS) return false;
    const row = db.prepare('SELECT avatar_ref FROM groups WHERE id = ?').get(groupId) as { avatar_ref: string | null } | undefined;
    if (!row || !row.avatar_ref) return false;
    const want = Buffer.from(keyFor(groupSecret, `group-picture|${groupId}`, avatarVersionOfRef(row.avatar_ref)));
    const got = Buffer.from(k);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** Whether this node serves a face only to a URL with its key (installAvatarKeysAtBoot). */
export function avatarKeysRequired(): boolean {
    return secret !== null;
}

/**
 * Whether `k` is the key for `pubkey`'s photo as it is now. False for anything else, a photo that isn't there included:
 * the route answers both the same.
 */
export function avatarKeyMatches(pubkey: string, k: unknown): boolean {
    if (!secret || typeof k !== 'string' || k.length !== KEY_CHARS) return false;
    const row = db.prepare('SELECT avatar_ref FROM members WHERE public_key = ?').get(pubkey) as { avatar_ref: string | null } | undefined;
    if (!row || !row.avatar_ref) return false;
    // The version avatarUrlOf put in the URL, from the row's reference: the photo is never read.
    const want = Buffer.from(keyFor(secret, pubkey, avatarVersionOfRef(row.avatar_ref)));
    const got = Buffer.from(k);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
}

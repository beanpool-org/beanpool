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
 *   content version (@beanpool/core avatarVersionOf), so a new photo has a new key, and the old key opens nothing; it
 *   changes exactly when the URL's `v` does, which already brings members the new URL.
 * - The secret is 32 random bytes in `node_config.avatarKeySecret`, written once: it travels with the database (file
 *   and sealed backups, a restore). A server that has no copy of it (a standby, a take-over) mints its own, and members'
 *   saved URLs show initials until their next members sync brings the new ones: a nuisance, never a leak.
 * - Decided at boot, like the rest of what a node runs as: an operator who switches `guestListingsOnly` restarts the
 *   node, so the URLs it emits and the URLs it serves always agree.
 */
import crypto from 'node:crypto';
import { avatarVersionOf, configureAvatarKeys, isServableAvatarValue } from '@beanpool/core';
import { db } from '../db/db.js';
import { getProfileSwitches } from '../config/node-profile.js';

export const AVATAR_KEY_SECRET_ROW = 'avatarKeySecret';

/** The key's length: 22 base64url characters, 132 bits. */
const KEY_CHARS = 22;

let secret: Buffer | null = null;

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

function keyFor(s: Buffer, id: string, version: string): string {
    return crypto.createHmac('sha256', s).update(`${id}|${version}`, 'utf-8').digest('base64url').slice(0, KEY_CHARS);
}

/**
 * At boot: on a node whose `guestListingsOnly` switch is on, every avatar URL carries its key from now on and the route
 * asks for it; elsewhere neither. Returns whether faces are keyed.
 */
export function installAvatarKeysAtBoot(): boolean {
    if (!getProfileSwitches().guestListingsOnly) {
        secret = null;
        configureAvatarKeys(null);
        return false;
    }
    const s = avatarKeySecret();
    secret = s;
    configureAvatarKeys((id, version) => keyFor(s, id, version));
    return true;
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
    const row = db.prepare('SELECT avatar_url FROM members WHERE public_key = ?').get(pubkey) as { avatar_url: string | null } | undefined;
    if (!row || !isServableAvatarValue(row.avatar_url)) return false;
    // The version avatarUrlFor put in the URL, from the same trimmed value.
    const want = Buffer.from(keyFor(secret, pubkey, avatarVersionOf(pubkey, row.avatar_url.trim())));
    const got = Buffer.from(k);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
}

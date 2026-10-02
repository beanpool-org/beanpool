/**
 * The ONE place a member's avatar becomes a URL this node emits, and the ONE place that decides
 * whether a stored value is a real avatar at all.
 *
 * Three problems live here.
 *
 * STALENESS. `/api/avatar/<pk>?size=thumb` carried no version, so a changed photo kept the
 * same URL. Every client that caches by URL — expo-image with `cachePolicy="memory-disk"` on
 * the phone, and the browser for the PWA — kept serving the old bytes, and the route's
 * `must-revalidate` + ETag never got the chance to say otherwise. The URL now carries `&v=`,
 * derived from the CONTENT of the stored avatar (avatarVersionOf), so a changed photo is a new
 * URL. Fixing this at the server fixed the builds already on members' phones, and the PWA, as
 * soon as a node updated.
 *
 * SELF-REFERENCE. Installed app builds read the avatar out of their synced local row — which
 * since #725 holds this node's own `/api/avatar/…` string — and post it straight back as
 * `avatar` on the next profile save. The node stored it, and from then on
 * `GET /api/avatar/<pk>` 404d: the photo was gone. Such a value reads as NO avatar
 * (emitted null, and no photo for the marketplace gate), so members see their initials rather
 * than a blank ring and the phone's existing self-heal republishes the canonical copy.
 * `isSelfAvatarUrl` is the write-side half: see the server's `engine/members.ts` and `db/db.ts`.
 *
 * COST. A photo is about 27 KB of base64. While it sat in its member's row, every list of members
 * read every photo to version its URL: at about 6,400 members with photos one full member list
 * ran a 256 MB heap out of memory (the global node's load rehearsal, 2026-10-02). So the photo
 * lives in its own table (the server's `member_photos`), and the members row keeps only its
 * reference, `avatar_ref` (avatarRefOf), written with the photo: its version, or a shipped
 * picture's name. Every URL is made from the reference alone (avatarUrlOf), so no list, count
 * or URL reads a photo, and each is the URL the node made when the photo sat in the row.
 *
 * It lives in @beanpool/core because the emission sites are split across two packages — the
 * server's routes and state engine, and @beanpool/engine's posts, messaging and social
 * readers — and decision (a) is that there be exactly ONE of these, not one per package.
 */

// The digest comes from `@noble/hashes`, not `node:crypto`, because the barrel this module is
// exported from is bundled by Metro for android and ios, where Expo's resolver deliberately
// errors on Node built-ins rather than shimming them. A `node:` import here does not fail tsc
// or vitest — both run in Node — it fails `expo export`, i.e. the phone app.
// `barrel-is-universal.test.ts` guards that for the whole barrel.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * Is this string one of THIS node's own avatar URLs, round-tripped back to us?
 *
 * Matched relative (`/api/avatar/<pk>?size=thumb`) and absolute on ANY host: the phone
 * resolves the relative path against whichever node it is anchored to before it renders,
 * and a member who joins a second node can carry the first node's absolute URL over.
 * Deliberately host-agnostic — a URL naming some other node's avatar route is no more a
 * portable avatar than one naming ours.
 */
export function isSelfAvatarUrl(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    // Relative: the exact shape emitted below.
    if (/^\/api\/avatar\//i.test(trimmed)) return true;
    // Absolute: any scheme, any host, provided the PATH is the avatar route.
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/]*\/api\/avatar\//i.test(trimmed)) return true;
    return false;
}

/**
 * Is this stored value something the node can actually serve as an avatar?
 *
 * `bundled://…` is a reference to a shipped asset; anything else is expected to be image
 * bytes (a `data:` URI, or the legacy bare base64 the avatar service still decodes). A
 * self-referential URL is neither, and reads as "no avatar".
 */
export function isServableAvatarValue(stored: string | null | undefined): stored is string {
    if (!stored || !stored.trim()) return false;
    return !isSelfAvatarUrl(stored);
}

/**
 * A short, stable, content-derived version for a stored avatar value (trimmed): the first 8 hex
 * characters of its SHA-256.
 *
 * Same bytes in, same version out, for the life of the node and across restarts — it is a
 * hash, not a counter, so a restore or an import that brings back an older photo brings back
 * its old version too, which is correct: the bytes really are those bytes. Worked out once, as
 * the photo is written (avatarRefOf), never per row of a list.
 */
export function avatarVersionOf(stored: string): string {
    return bytesToHex(sha256(utf8ToBytes(stored))).slice(0, 8);
}

/** Is this avatar a shipped picture (`bundled://<name>`), named rather than stored as bytes? */
export function isBundledAvatar(value: string): boolean {
    return value.trim().startsWith('bundled://');
}

/**
 * What a member's row keeps of their avatar (the server's `members.avatar_ref`): everything
 * avatarUrlOf needs, and nothing of the photo. Null when the stored value is not one the node
 * serves (isServableAvatarValue); a shipped picture's `bundled://…` exactly as stored, since it
 * is emitted as it is (its name versions it); otherwise the photo's version, avatarVersionOf
 * its trimmed value, which is what goes in the URL's `v`.
 */
export function avatarRefOf(stored: string | null | undefined): string | null {
    if (!isServableAvatarValue(stored)) return null;
    if (isBundledAvatar(stored)) return stored;
    return avatarVersionOf(stored.trim());
}

/**
 * The content version an avatar's key is made with (configureAvatarKeys), from its reference: a
 * photo's reference is its version; a shipped picture's is avatarVersionOf its name, as when the
 * name sat in the row (its URL is the name itself, which carries no key, so no app is given one).
 */
export function avatarVersionOfRef(ref: string): string {
    return isBundledAvatar(ref) ? avatarVersionOf(ref.trim()) : ref;
}

/**
 * The member-only key a node puts in every avatar URL it emits, or null (every node but the global
 * one). On a node that shows visitors the listings and not the people (global node G9a), a face is
 * served only to a URL carrying the key for that photo, and the node hands the URLs to members
 * alone: every response that carries one is either members-only or has its faces taken off for a
 * visitor. An `<img>` cannot sign a request; the key rides inside the URL, so every app renders it
 * as it renders any URL, old builds included.
 *
 * The server installs it at boot (its keyed hash needs `node:crypto`, which this package must not
 * import: see the note on `@noble/hashes` above). It is given the id and the content version, so a
 * changed photo has a new key as it has a new URL.
 */
export type AvatarKeyer = (id: string, version: string) => string;
let avatarKeyer: AvatarKeyer | null = null;

/** Installs (or, with null, removes) the key every emitted avatar URL carries. */
export function configureAvatarKeys(keyer: AvatarKeyer | null): void {
    avatarKeyer = keyer;
}

/**
 * The avatar URL to emit for a member, enterprise or treasury (each a members row).
 *
 * @param id   the key `/api/avatar/:pubkey` will be looked up by — a member public key, an
 *             enterprise or treasury pubkey.
 * @param ref  the row's `avatar_ref` (avatarRefOf), exactly as the row holds it.
 *
 * Returns null when there is no avatar, a shipped picture's `bundled://…` unchanged (it names a
 * shipped asset, so it is already versioned by its name and needs no buster), and otherwise the
 * versioned route URL, with its member-only key where the node has one (configureAvatarKeys).
 */
export function avatarUrlOf(id: string, ref: string | null | undefined): string | null {
    if (!ref) return null;
    if (isBundledAvatar(ref)) return ref;
    const url = `/api/avatar/${id}?size=thumb&v=${ref}`;
    return avatarKeyer ? `${url}&k=${avatarKeyer(id, ref)}` : url;
}

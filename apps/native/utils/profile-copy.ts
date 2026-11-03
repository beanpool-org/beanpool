import AsyncStorage from '@react-native-async-storage/async-storage';
import { isSelfAvatarUrl, photoCanTravel, profileCopySend, type ProfileCopyChoice, type ProfileCopySend } from '@beanpool/core';
import { getMemberProfile } from './db';
import { plainOriginOf } from './node-url';
import { keepPendingProfileChange } from './pending-profile-sync';

/**
 * Copy on request (Profile S4, scratch/fable-design/DESIGN-per-community-profile-fable.md §3-§4; Marty, 28-29 Oct 2026).
 *
 * "Use this name and photo in another community…" (components/CopyProfileCard.tsx, Settings): the member picks a community
 * and what to carry, taps Copy, and only then does anything move. Nothing copies by itself, and nothing but what was ticked:
 * core's profileCopySend is the one rule for what a copy carries, the same one the web asks.
 *
 * What it does is KEEP the copy for the chosen community (pending-profile-sync.ts keepPendingProfileChange, `copy`), as an
 * offline Save is kept. The phone publishes to the community it is on, so the copy goes the next time the member opens that
 * community (pillar-sync's retry, db.ts pushProfileToServer), and it carries the name and the photo kept and nothing of
 * that community's own row. No community is contacted here but the one the copy is made FROM, for the photo's bytes.
 */

/** What the community the phone is on holds for the member, as a copy would read it: local, nothing fetched yet. */
export interface CopySource {
    /** The community (its address) the name and the photo are read from: the one the phone is on. */
    from: string;
    callsign: string | null;
    /** The row's photo value as it stands; null when the row holds none (the ready-made picture is no chosen photo). */
    photoValue: string | null;
    /** `portable`: a `data:` or `bundled://` value. `node`: the community's own picture URL, whose bytes are fetched at the tap. */
    photo: 'none' | 'portable' | 'node';
}

/** How long the community has to give the one photo. */
const PHOTO_TIMEOUT_MS = 20_000;

/**
 * The most photo bytes a copy takes. The copy waits in AsyncStorage as base64 (a third larger), and Android reads a stored
 * value of about 2 MB or more badly; a member's photo is a 512 px crop of some tens of KB, so 1 MiB is far above any real
 * one and well under that.
 */
export const COPY_PHOTO_MAX_BYTES = 1024 * 1024;

/** The picture types the community's avatar service takes in (apps/server engine/avatar.ts ALLOWED_AVATAR_MIMES): never an SVG. */
const COPY_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const SENTINELS = new Set(['', 'null', 'undefined']);

/** This community's name and photo for the member, read from its row on this phone. Null when there is no community or no row. */
export async function readCopySource(publicKey: string): Promise<CopySource | null> {
    const from = await AsyncStorage.getItem('beanpool_anchor_url').catch(() => null);
    if (!from || !publicKey) return null;
    let row: { callsign?: unknown; avatar_url?: unknown } | null | undefined;
    try {
        row = await getMemberProfile(publicKey);
    } catch {
        // The copy closed under the read (a switch): the screen reads again.
        return null;
    }
    // getDb opens the copy the anchor names as it is asked: read for this community only if it is still the phone's.
    if ((await AsyncStorage.getItem('beanpool_anchor_url').catch(() => null)) !== from) return null;
    const callsign = typeof row?.callsign === 'string' && !SENTINELS.has(row.callsign.trim()) ? row.callsign.trim() : null;
    const value = typeof row?.avatar_url === 'string' && !SENTINELS.has(row.avatar_url.trim()) ? row.avatar_url.trim() : null;
    const photo: CopySource['photo'] = value === null ? 'none' : photoCanTravel(value) ? 'portable' : isSelfAvatarUrl(value) ? 'node' : 'none';
    return { from, callsign, photoValue: photo === 'none' ? null : value, photo };
}

/** The community's own picture URL for the full photo: its address resolved, and the thumbnail size taken off. */
function fullPhotoUrl(value: string, from: string): string | null {
    const absolute = value.startsWith('/') ? `${from.replace(/\/+$/, '')}${value}` : value;
    // Only the community the copy is made from: a URL naming another node's picture is not read.
    if (plainOriginOf(absolute) !== plainOriginOf(from)) return null;
    const [path, query = ''] = absolute.split('#')[0].split('?');
    const kept = query.split('&').filter((part) => part && !/^size=/i.test(part));
    return kept.length ? `${path}?${kept.join('&')}` : path;
}

function dataUrlOf(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('unreadable photo'));
        reader.readAsDataURL(blob);
    });
}

/**
 * The photo as a value that can travel, or null when it can't be had now. A `data:` or `bundled://` value is itself. The
 * community's own picture URL is fetched from that community as any phone fetches it, unsigned, at full size and its bytes
 * unchanged (a second JPEG pass would only lose detail); a 200 that isn't one of the pictures the community takes in (a
 * captive portal's page, an SVG), one past {@link COPY_PHOTO_MAX_BYTES}, or no answer in time is no photo.
 */
export async function portablePhotoOf(source: CopySource, fetchImpl: typeof fetch = fetch): Promise<string | null> {
    if (source.photo === 'none' || !source.photoValue) return null;
    if (source.photo === 'portable') return source.photoValue;
    const url = fullPhotoUrl(source.photoValue, source.from);
    if (!url) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PHOTO_TIMEOUT_MS);
    try {
        const res = await fetchImpl(url, { signal: controller.signal });
        if (!res.ok) return null;
        const mime = (res.headers?.get?.('content-type') ?? '').split(';')[0].trim().toLowerCase();
        if (!COPY_PHOTO_TYPES.has(mime)) return null;
        const blob = await res.blob();
        if (blob.size === 0 || blob.size > COPY_PHOTO_MAX_BYTES) return null;
        const b64 = (await dataUrlOf(blob)).replace(/^data:[^,]*,/, '');
        return b64 ? `data:${mime};base64,${b64}` : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * What the tap did.
 *  - `waits`: kept for the community; it goes the next time the member opens it.
 *  - `nothing`: nothing was ticked, or what was ticked has nothing behind it.
 *  - `photo-unreadable`: the photo was ticked and can't be had now; NOTHING was kept (not the name alone), so the member
 *    decides: try again, or untick the photo.
 *  - `same-community`: the community chosen is the one the copy is made from.
 *  - `moved`: the phone is no longer on the community the copy was read from; nothing was kept.
 *  - `not-a-community`: the address can't hold a copy (node-url.ts); nothing was kept.
 */
export type CopyResult = 'waits' | 'nothing' | 'photo-unreadable' | 'same-community' | 'moved' | 'not-a-community';

/**
 * The tap on Copy: keep the name and/or the photo ticked for `target`, and nothing else. Never contacts `target`; the photo is
 * fetched from the community the copy is made from, and only when it is ticked.
 */
export async function queueProfileCopy(input: {
    publicKey: string;
    source: CopySource;
    target: string;
    choice: ProfileCopyChoice;
    fetchImpl?: typeof fetch;
}): Promise<{ result: CopyResult; sent: ProfileCopySend | null }> {
    const { publicKey, source, target, choice } = input;
    if (plainOriginOf(target) !== null && plainOriginOf(target) === plainOriginOf(source.from)) return { result: 'same-community', sent: null };
    const photo = choice.photo && source.photo !== 'none' ? await portablePhotoOf(source, input.fetchImpl) : null;
    if (choice.photo && source.photo !== 'none' && !photo) return { result: 'photo-unreadable', sent: null };
    const send = profileCopySend({ callsign: source.callsign, photo }, choice);
    if (!send) return { result: 'nothing', sent: null };
    // The phone may have moved on while the photo was out: what was read is that community's, and no other's.
    if ((await AsyncStorage.getItem('beanpool_anchor_url').catch(() => null)) !== source.from) return { result: 'moved', sent: null };
    const kept = await keepPendingProfileChange(target, publicKey, send, { copy: true });
    return kept ? { result: 'waits', sent: send } : { result: 'not-a-community', sent: null };
}

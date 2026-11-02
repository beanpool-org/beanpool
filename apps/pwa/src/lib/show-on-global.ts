/**
 * "Also show this on the global community" in the web app (slice G3): @beanpool/core show-on-global.ts is what it does and why,
 * and the phone runs the same file. Here is what is the browser's: the pairs in IndexedDB (lib/copy-pairs.ts), its signed requests
 * (lib/api.ts signedCopyFetch: what the phone sends and nothing more), which global its community names, and the tend on load.
 *
 * No lock-in: global is the one this community names (`globalCommunityUrl`, lib/global-entry.ts). A community that names none
 * has no tick, and nothing here asks anyone anything until the member taps or already has a copy to tend.
 *
 * A phone on the same account keeps its own pairs and the two find one copy: core's header says what happens.
 */
import {
    audienceOf, copyResultLine, fetchedPhotoOf, makeCopyKeeper, type CopyDeps, type CopyPair, type CopyResult, type FetchedPhoto, type HomeEvent,
} from '@beanpool/core';
import { copyIdFor, getNodeApiUrl, signedCopyFetch } from './api';
import { copyPairs } from './copy-pairs';
import { eventEndMs } from './events';
import { globalCommunityLink } from './global-entry';
import type { BeanPoolIdentity } from './identity';
import { communityInfoOnce } from './visitor-lobby-gate';

export { copyResultLine, stopLaterLine } from '@beanpool/core';

/** What the global community last said of a key: the phone's global-entry words. */
export type GlobalStanding = 'member' | 'stranger' | 'unknown';

const TEND_EVERY_MS = 60 * 60 * 1000;
const FETCH_PHOTO_TIMEOUT_MS = 20_000;
const ASK_TIMEOUT_MS = 12_000;
const STANDING_TTL_MS = 24 * 60 * 60 * 1000;
const STANDING_KEY = 'beanpool_global_standing';
const TENDED_KEY = 'beanpool_copies_tended';

const homeAddress = () => getNodeApiUrl() || window.location.origin;
const hostHere = () => audienceOf(homeAddress());

/** The global community this web app's community names, or null: never a fixed name of ours. */
export async function globalAddress(): Promise<string | null> {
    const info = await communityInfoOnce().catch(() => null);
    if (info?.profile !== 'local') return null;
    return globalCommunityLink(info, hostHere())?.href.replace(/\/+$/, '') ?? null;
}

function dataUrlOf(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('unreadable photo'));
        reader.readAsDataURL(blob);
    });
}

/** A listing's photo as the phone fetches it, its bytes unchanged, from the member's own community. */
async function fetchedPhoto(url: string): Promise<FetchedPhoto> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_PHOTO_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
        if (!res.ok) return { failed: res.status === 408 || res.status === 429 || res.status >= 500 ? 'later' : 'gone' };
        return fetchedPhotoOf((await dataUrlOf(await res.blob())).replace(/^data:[^,]*,/, ''));
    } catch {
        return { failed: 'later' };
    } finally {
        clearTimeout(timer);
    }
}

async function homeHostOf(home: string): Promise<string | null> {
    const info = await communityInfoOnce().catch(() => null);
    return info?.primaryAddress ?? audienceOf(home);
}

function depsFor(global: string): CopyDeps<BeanPoolIdentity> {
    return {
        global,
        get: (url, path, identity, signal) => signedCopyFetch('GET', url, path, undefined, identity, signal),
        post: (url, path, body, identity, signal) => signedCopyFetch('POST', url, path, body, identity, signal),
        del: (url, path, identity, signal) => signedCopyFetch('DELETE', url, path, undefined, identity, signal),
        fetchPhoto: fetchedPhoto,
        hostOf: homeHostOf,
    };
}

const keeper = makeCopyKeeper<BeanPoolIdentity>({
    store: copyPairs,
    // Each call below hands in the global this community names.
    deps: depsFor(''),
    copyId: copyIdFor,
    plainOrigin: (url) => { try { return new URL(url).origin; } catch { return null; } },
    isEventEnded: (home: HomeEvent) => {
        const end = eventEndMs({ eventStartAt: home.eventStartAt, eventEndAt: home.eventEndAt });
        return Number.isFinite(end) && end <= Date.now();
    },
});

async function withGlobal<T>(run: (deps: CopyDeps<BeanPoolIdentity>) => Promise<T>, none: T): Promise<T> {
    const global = await globalAddress();
    return global ? run(depsFor(global)) : none;
}

/** This key's pair for a listing or an event, if it has one. Asks nobody. */
export const copyPairOf = (homeId: string, publicKey: string): Promise<CopyPair | null> => keeper.pairOf(homeId, publicKey);

/** The tick, for a post as its community answered it. Never throws: it says what it owes the member, or nothing. */
export async function showPostOnGlobal(post: HomeEvent, identity: BeanPoolIdentity): Promise<string | null> {
    const result: CopyResult = await withGlobal((deps) => keeper.showOnGlobal(post, homeAddress(), identity, deps), 'later' as CopyResult).catch(() => 'later' as const);
    return copyResultLine(result);
}

/** After an edit of an event or a cancelled date: the copy follows. A listing's edit goes by its community's word: a tend. */
export async function repeatOnCopy(post: HomeEvent, identity: BeanPoolIdentity): Promise<void> {
    if ((await copyPairs.read()).length === 0) return;
    await withGlobal((deps) => (post.type === 'offer' || post.type === 'need' ? keeper.tendCopies(identity, deps) : keeper.repeatOnCopy(post, identity, deps)), undefined);
}

/** Stop showing, and a removal at home. False: global didn't answer, and it is tried again. */
export async function stopShowing(id: string, identity: BeanPoolIdentity): Promise<boolean> {
    if ((await copyPairs.read()).length === 0) return true;
    return withGlobal((deps) => keeper.stopShowing(id, identity, deps), true);
}

/** Every copy brought into step: a pause, a holiday, a return. */
export async function tendCopies(identity: BeanPoolIdentity): Promise<void> {
    if ((await copyPairs.read()).some((p) => p.publicKey === identity.publicKey)) await withGlobal((deps) => keeper.tendCopies(identity, deps), undefined);
}

/**
 * On load and when the tab comes back, as the phone does when it comes to the front: at most hourly, across reloads and tabs, and
 * never in anyone's way.
 */
export async function tendCopiesSoon(identity: BeanPoolIdentity | null | undefined, now: number = Date.now()): Promise<void> {
    if (!identity?.privateKey) return;
    try {
        if (now - Number(localStorage.getItem(TENDED_KEY) ?? 0) < TEND_EVERY_MS) return;
        localStorage.setItem(TENDED_KEY, String(now));
    } catch { /* storage off: this load tends */ }
    await tendCopies(identity).catch(() => {});
}

function keptStanding(publicKey: string, now: number): GlobalStanding {
    try {
        const kept = JSON.parse(localStorage.getItem(STANDING_KEY) ?? 'null');
        if (kept?.publicKey !== publicKey || now - Number(kept?.at) >= STANDING_TTL_MS) return 'unknown';
        return kept.standing === 'member' || kept.standing === 'stranger' ? kept.standing : 'unknown';
    } catch {
        return 'unknown';
    }
}

/** What global last said of this key, from this browser's memory: drawing a row asks it nothing. */
export const readGlobalStanding = (publicKey: string, now: number = Date.now()): GlobalStanding => keptStanding(publicKey, now);

/** At the tap: is this key a member of global? `unknown` when global didn't say. */
export async function askGlobalStanding(identity: BeanPoolIdentity, now: number = Date.now()): Promise<GlobalStanding> {
    if (keptStanding(identity.publicKey, now) === 'member') return 'member';
    const global = await globalAddress();
    if (!global) return 'unknown';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ASK_TIMEOUT_MS);
    try {
        const res = await signedCopyFetch('GET', global, `/api/community/membership/${encodeURIComponent(identity.publicKey)}`, undefined, identity, controller.signal);
        const answer: unknown = res.ok ? await res.json() : null;
        const isMember = (answer as { isMember?: unknown } | null)?.isMember;
        if (typeof isMember !== 'boolean') return 'unknown';
        const standing: GlobalStanding = isMember ? 'member' : 'stranger';
        try { localStorage.setItem(STANDING_KEY, JSON.stringify({ publicKey: identity.publicKey, standing, at: now })); } catch { /* it asks again */ }
        return standing;
    } catch {
        return keptStanding(identity.publicKey, now);
    } finally {
        clearTimeout(timer);
    }
}

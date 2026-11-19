/**
 * "Also show this on the global community" on the phone: @beanpool/core show-on-global.ts is what it does and why, and the web
 * app runs the same file. Here is what is the phone's: the pairs in AsyncStorage, its signed requests, the fixed address of the
 * global community, and the tend when the app comes to the front. Sign Out wipes the pairs (utils/identity.ts
 * wipeIdentityScopedStorage).
 *
 * A phone with no pair still finds its copies by their ids. A delete or a cancel on a local community asks after every id the
 * listing can have, for a listing that could have had a copy ({@link stopShowingGone}): the copy may be the web app's, on a
 * phone that never joined global. The daily look for copies to tend (core adoptCopies) runs only on a phone that holds the
 * global community as a member, not a guest ({@link localHomeWithGlobal}).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { audienceOf, copyIdOf, makeCopyKeeper, type CopyDeps as CoreCopyDeps, type CopyPair, type CopyStore, type HomeEvent, type ShowableListing } from '@beanpool/core';
import { SHOWN_ON_GLOBAL_STORE_KEY } from './storage-keys';
import { GLOBAL_NODE_URL } from './global-node-url';
import { fetchNodeProfile, getCachedNodeProfile } from './node-profile';
import { plainOriginOf } from './node-url';
import { anchorUrl, signedDelete, signedGet, signedPost, type SignedSendOptions } from './node-post';
import { memberSigner } from './crypto';
import { isEventEnded } from './events';
import type { BeanPoolIdentity } from './identity';

export { COPY_KEEP_ALIVE_MS, COPY_TIMEOUT_MS, copyResultLine, questionsLaterLine, stopLaterLine, type CopyPair, type CopyResult, type HomeEvent } from '@beanpool/core';
export type CopyDeps = CoreCopyDeps<BeanPoolIdentity>;

/** {@link tendCopiesSoon}: at most this often. */
const TEND_EVERY_MS = 60 * 60 * 1000;

/**
 * The host the directory has a community at: its main address, which a phone still on an older name of the community
 * doesn't use. Global matches the whole host, so the older name would read as a community that isn't listed.
 */
export async function homeHostOf(home: string): Promise<string | null> {
    const profile = await fetchNodeProfile(home) ?? await getCachedNodeProfile(home);
    return profile?.primaryAddress ?? audienceOf(home);
}

/**
 * A copy names nobody (#2731): its requests carry the signature's headers and nothing of the member, the web's as the phone's,
 * so not the member's language either (utils/request-language.ts). Global's refusals here stay in English, as they were.
 */
const A_COPY: SignedSendOptions = { language: false };

const liveDeps: CopyDeps = {
    global: GLOBAL_NODE_URL,
    get: (url, path, identity, signal) => signedGet(url, path, identity, signal, undefined, A_COPY),
    post: (url, path, body, identity, signal) => signedPost(url, path, body, identity, signal, A_COPY),
    del: (url, path, identity, signal) => signedDelete(url, path, identity, signal, A_COPY),
    fetchPhoto: async (url) => (await import('./post-photo')).fetchedPostPhoto(url),
    hostOf: homeHostOf,
};

async function readPairs(): Promise<CopyPair[]> {
    const raw = await AsyncStorage.getItem(SHOWN_ON_GLOBAL_STORE_KEY).catch(() => null);
    try {
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

const store: CopyStore = {
    read: readPairs,
    change: async (edit) => AsyncStorage.setItem(SHOWN_ON_GLOBAL_STORE_KEY, JSON.stringify(edit(await readPairs()))),
};

/** Core's id for this key's copy of a listing (request-signing.ts copyIdOf): a browser on the same account works out the same one. */
function copyIdFor(homeId: string, generation: number, identity: BeanPoolIdentity): Promise<string> {
    return copyIdOf(homeId, generation, memberSigner(identity.privateKey));
}

/** The community in use if it is a local one, by the phone's cached profile: the only kind a listing is copied from. */
async function localHere(): Promise<string | null> {
    const here = await anchorUrl();
    return here && (await getCachedNodeProfile(here))?.profile === 'local' ? here : null;
}

/**
 * The community in use, where a phone with no pair may look for its copies: a local one, on a phone that holds the global
 * community as a member (a saved community that isn't a guest's look). Null anywhere else. Asks nobody.
 */
async function localHomeWithGlobal(): Promise<string | null> {
    const here = await localHere();
    if (!here) return null;
    const { getSavedNodes, isGuestNode } = await import('./nodes');
    const global = plainOriginOf(GLOBAL_NODE_URL);
    const held = (await getSavedNodes()).find((n) => plainOriginOf(n.url) === global);
    return held && !(await isGuestNode(held.url)) ? here : null;
}

export const { pairOf, mayShowOnGlobal, copyFields, showOnGlobal, takeQuestions, repeatOnCopy, stopShowing, tendCopies, tendOwedOffs } = makeCopyKeeper<BeanPoolIdentity>({
    store,
    deps: liveDeps,
    copyId: copyIdFor,
    plainOrigin: plainOriginOf,
    isEventEnded: (home: HomeEvent) => isEventEnded(home),
    homesOf: async () => {
        const here = await localHomeWithGlobal().catch(() => null);
        return here ? [here] : [];
    },
});

/**
 * A listing deleted or an event cancelled here (utils/db.ts deletePost): its copy comes down whichever device made it, as
 * the phone's cached row last had the listing. Without a pair, global is asked only on a local community, and core asks it
 * only for a listing that could have had a copy.
 */
export async function stopShowingGone(gone: ShowableListing & { id: string }, identity: BeanPoolIdentity): Promise<boolean> {
    const here = await localHere().catch(() => null);
    return stopShowing(gone.id, identity, undefined, here ? gone : undefined);
}

let lastTended = 0;

/**
 * {@link tendCopies} when the app comes to the front and on the 5-minute timer (app/_layout.tsx), at most hourly. Never in anyone's
 * way. Inside the hour only an Off global hasn't answered goes: that is a name left up, and nothing else here is in a hurry.
 */
export async function tendCopiesSoon(identity: BeanPoolIdentity | null | undefined, now: number = Date.now()): Promise<void> {
    if (!identity) return;
    if (now - lastTended < TEND_EVERY_MS) {
        await tendOwedOffs(identity, undefined, now).catch(() => {});
        return;
    }
    lastTended = now;
    await tendCopies(identity, undefined, now).catch(() => {});
}

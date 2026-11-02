/**
 * "Also show this on the global community" on the phone: @beanpool/core show-on-global.ts is what it does and why, and the web
 * app runs the same file. Here is what is the phone's: the pairs in AsyncStorage, its signed requests, the fixed address of the
 * global community, and the tend when the app comes to the front. Sign Out wipes the pairs (utils/identity.ts
 * wipeIdentityScopedStorage).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { audienceOf, copyIdOf, makeCopyKeeper, type CopyDeps as CoreCopyDeps, type CopyPair, type CopyStore, type HomeEvent } from '@beanpool/core';
import { SHOWN_ON_GLOBAL_STORE_KEY } from './storage-keys';
import { GLOBAL_NODE_URL } from './global-node-url';
import { fetchNodeProfile, getCachedNodeProfile } from './node-profile';
import { plainOriginOf } from './node-url';
import { signedDelete, signedGet, signedPost } from './node-post';
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

const liveDeps: CopyDeps = {
    global: GLOBAL_NODE_URL,
    get: (...args) => signedGet(...args),
    post: (...args) => signedPost(...args),
    del: (...args) => signedDelete(...args),
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

export const { pairOf, mayShowOnGlobal, copyFields, showOnGlobal, takeQuestions, repeatOnCopy, stopShowing, tendCopies } = makeCopyKeeper<BeanPoolIdentity>({
    store,
    deps: liveDeps,
    copyId: copyIdFor,
    plainOrigin: plainOriginOf,
    isEventEnded: (home: HomeEvent) => isEventEnded(home),
});

let lastTended = 0;

/** {@link tendCopies} when the app comes to the front, at most hourly. Never in anyone's way. */
export async function tendCopiesSoon(identity: BeanPoolIdentity | null | undefined, now: number = Date.now()): Promise<void> {
    if (!identity || now - lastTended < TEND_EVERY_MS) return;
    lastTended = now;
    await tendCopies(identity).catch(() => {});
}

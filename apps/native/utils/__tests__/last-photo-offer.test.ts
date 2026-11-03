/**
 * Profile S3: what the phone keeps as "the picture I used last", and the offer made from it on joining another community
 * (utils/canonical-profile.ts getLastPhoto, utils/last-photo-offer.ts). The store is the real one over an in-memory
 * AsyncStorage; the rule is core's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mem = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => mem.store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { mem.store.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.store.delete(k); }),
    },
}));
const saved = vi.hoisted(() => ({ nodes: [] as Array<{ url: string; alias?: string }>, fail: false }));
vi.mock('../nodes', () => ({ getSavedNodes: vi.fn(async () => { if (saved.fail) throw new Error('unreadable'); return saved.nodes; }) }));

import { getLastPhoto, saveCanonicalProfile } from '../canonical-profile';
import { loadLastPhotoOffer } from '../last-photo-offer';
import { CANONICAL_PROFILE_STORE_KEY } from '../storage-keys';

const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const FIRST = 'https://first.example.test';
const HERE = 'https://second.example.test';

beforeEach(() => {
    mem.store.clear();
    mem.store.set('beanpool_anchor_url', HERE);
    saved.nodes = [{ url: FIRST, alias: 'First Beans' }];
    saved.fail = false;
});

describe('the picture I used last', () => {
    it('keeps the photo and the community it was set in, and a bio-only save leaves both alone', async () => {
        await saveCanonicalProfile({ avatar: PHOTO, avatarFrom: FIRST });
        await saveCanonicalProfile({ bio: 'hello' });
        expect(await getLastPhoto()).toEqual({ avatar: PHOTO, from: FIRST });
    });

    it('moves the community only when a new photo arrives with one', async () => {
        await saveCanonicalProfile({ avatar: PHOTO, avatarFrom: FIRST });
        await saveCanonicalProfile({ avatar: 'bundled://leaf', avatarFrom: HERE });
        expect(await getLastPhoto()).toEqual({ avatar: 'bundled://leaf', from: HERE });
    });

    it('reads a copy kept before the community was recorded as "not known", and a store with no photo as none', async () => {
        mem.store.set(CANONICAL_PROFILE_STORE_KEY, JSON.stringify({ avatar: PHOTO, bio: 'old' }));
        expect(await getLastPhoto()).toEqual({ avatar: PHOTO, from: null });
        mem.store.set(CANONICAL_PROFILE_STORE_KEY, JSON.stringify({ bio: 'no photo' }));
        expect(await getLastPhoto()).toBeNull();
        mem.store.delete(CANONICAL_PROFILE_STORE_KEY);
        expect(await getLastPhoto()).toBeNull();
    });
});

describe('loadLastPhotoOffer', () => {
    it('offers the photo from another community, named by what the phone calls that community', async () => {
        await saveCanonicalProfile({ avatar: PHOTO, avatarFrom: FIRST });
        expect(await loadLastPhotoOffer(null)).toEqual({ avatar: PHOTO, from: 'First Beans' });
    });

    it('names the community by its host when the phone keeps no name for it', async () => {
        saved.nodes = [];
        await saveCanonicalProfile({ avatar: PHOTO, avatarFrom: FIRST });
        expect(await loadLastPhotoOffer(undefined)).toEqual({ avatar: PHOTO, from: 'first.example.test' });
    });

    it('offers without a name when it does not know where the photo came from, or the address is not a plain one', async () => {
        await saveCanonicalProfile({ avatar: PHOTO });
        expect(await loadLastPhotoOffer(null)).toEqual({ avatar: PHOTO, from: null });
        await saveCanonicalProfile({ avatar: PHOTO, avatarFrom: 'https://first.example.test@evil.example' });
        expect(await loadLastPhotoOffer(null)).toEqual({ avatar: PHOTO, from: null });
    });

    it('still offers when the saved list cannot be read', async () => {
        saved.fail = true;
        await saveCanonicalProfile({ avatar: PHOTO, avatarFrom: FIRST });
        expect(await loadLastPhotoOffer(null)).toEqual({ avatar: PHOTO, from: 'first.example.test' });
    });

    it('offers nothing to a community that already holds a photo for the member', async () => {
        await saveCanonicalProfile({ avatar: PHOTO, avatarFrom: FIRST });
        expect(await loadLastPhotoOffer('/api/avatar/abc?size=thumb&v=1&k=2')).toBeNull();
        expect(await loadLastPhotoOffer('bundled://sun')).toBeNull();
    });

    it('offers nothing back to the community the photo was set in, however the address is spelled', async () => {
        await saveCanonicalProfile({ avatar: PHOTO, avatarFrom: 'HTTPS://Second.Example.test:443/' });
        expect(await loadLastPhotoOffer(null)).toBeNull();
    });

    it('offers nothing when there is no photo, and never throws when the store is unreadable', async () => {
        expect(await loadLastPhotoOffer(null)).toBeNull();
        mem.store.set(CANONICAL_PROFILE_STORE_KEY, '{not json');
        expect(await loadLastPhotoOffer(null)).toBeNull();
    });
});

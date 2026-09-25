/**
 * G9c: the phone keeps a posts answer only when its `X-BeanPool-View` is one it may keep (utils/posts-view.ts;
 * design scratch/global-node/DESIGN-g9a-guest-view-fable.md §7). A guest view reaching a member is a failed fetch:
 * nothing written. No header is today's behaviour.
 *
 * Through `performSync` itself, with the node played by a fetch stub and the local database a spy.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const state = vi.hoisted(() => ({
    anchor: 'https://global.beanpool.org' as string | null,
    identity: { publicKey: 'aa'.repeat(32), privateKey: '07'.repeat(32), callsign: 'Sam', createdAt: '' } as any,
    guestNodes: [] as string[],
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => (key === 'beanpool_anchor_url' ? state.anchor : null)),
        setItem: vi.fn(async () => undefined),
        removeItem: vi.fn(async () => undefined),
    },
}));
vi.mock('../db', () => ({
    applyDelta: vi.fn().mockResolvedValue(undefined),
    fetchFriendsFromServer: vi.fn().mockResolvedValue([]),
    getDb: vi.fn().mockResolvedValue({ getFirstAsync: vi.fn().mockResolvedValue({ count: 0 }) }),
}));
vi.mock('../nodes', () => ({
    getDatabaseFilenameForNode: vi.fn().mockReturnValue('test.db'),
    isGuestNode: vi.fn(async (url: string) => state.guestNodes.includes(url)),
}));
vi.mock('../identity', () => ({
    loadIdentity: vi.fn(async () => state.identity),
}));
vi.mock('expo-constants', () => ({ default: { experienceUrl: undefined, expoConfig: undefined } }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { applyDelta } from '../db';
import { performSync, resetSyncFingerprints } from '../../services/pillar-sync';
import { viewOf, postsViewRefusal, expectedView, isHiddenAuthor, HIDDEN_AUTHOR } from '../posts-view';

const NODE = 'https://global.beanpool.org';
const POSTS = [{ id: 'p1', type: 'offer', title: 'Bike repair', authorPublicKey: 'hidden', authorCallsign: '', lat: 1.5, lng: 2.5 }];

function withView(view: string | null) {
    return { headers: new Headers(view === null ? {} : { 'X-BeanPool-View': view }) };
}

function installNode(view: string | null) {
    globalThis.fetch = vi.fn(async (input: any) => {
        const url = String(input);
        if (url.startsWith(`${NODE}/api/marketplace/posts`)) {
            return { ok: true, status: 200, ...withView(view), text: async () => JSON.stringify(POSTS) } as any;
        }
        return { ok: false, status: 404, headers: new Headers(), text: async () => '', json: async () => ({}) } as any;
    }) as any;
}

const postsWritten = () => vi.mocked(applyDelta).mock.calls.some(([delta]) => Array.isArray((delta as any)?.posts));
const cursorMoved = () => vi.mocked(AsyncStorage.setItem).mock.calls.some(([key]) => String(key).includes('last-sync'));

const originalFetch = globalThis.fetch;
beforeEach(() => {
    vi.clearAllMocks();
    resetSyncFingerprints();
    state.anchor = NODE;
    state.identity = { publicKey: 'aa'.repeat(32), privateKey: '07'.repeat(32), callsign: 'Sam', createdAt: '' };
    state.guestNodes = [];
});
afterEach(() => { globalThis.fetch = originalFetch; });

describe('the sync and the view it was sent', () => {
    it('a guest view reaching a member is a failed fetch: nothing written, the cursor not moved', async () => {
        installNode('guest');
        const result = await performSync();
        expect(result.success).toBe(false);
        expect(result.errorMessage).toMatch(/visitors' view/);
        expect(postsWritten()).toBe(false);
        expect(applyDelta).not.toHaveBeenCalled();
        expect(cursorMoved()).toBe(false);
    });

    it('no header is today\'s behaviour: the posts are written', async () => {
        installNode(null);
        const result = await performSync();
        expect(result.success).toBe(true);
        expect(postsWritten()).toBe(true);
    });

    it('the member view is written', async () => {
        installNode('member');
        expect((await performSync()).success).toBe(true);
        expect(postsWritten()).toBe(true);
    });

    it('a deliberate guest (a node added by hand, not joined) keeps the guest view it asked for', async () => {
        state.guestNodes = [NODE];
        installNode('guest');
        expect((await performSync()).success).toBe(true);
        expect(postsWritten()).toBe(true);
    });

    it('a phone with no key at all keeps the guest view', async () => {
        state.identity = null;
        installNode('guest');
        expect((await performSync()).success).toBe(true);
        expect(postsWritten()).toBe(true);
    });
});

describe('posts-view', () => {
    it('reads the header, whatever its case, and nothing it does not know', () => {
        expect(viewOf(withView('guest'))).toBe('guest');
        expect(viewOf(withView(' Member '))).toBe('member');
        expect(viewOf(withView('admin'))).toBeNull();
        expect(viewOf(withView(null))).toBeNull();
        expect(viewOf({})).toBeNull();
        expect(viewOf(null)).toBeNull();
    });

    it('expects the member view only from a phone with a key that did not choose to visit as a guest', async () => {
        expect(await expectedView(NODE, 'aa'.repeat(32))).toBe('member');
        expect(await expectedView(NODE, null)).toBe('guest');
        state.guestNodes = [NODE];
        expect(await expectedView(NODE, 'aa'.repeat(32))).toBe('guest');
    });

    it('refuses only a guest view sent to a member', async () => {
        expect(await postsViewRefusal(withView('guest'), NODE, 'aa'.repeat(32))).toMatch(/not saved/);
        expect(await postsViewRefusal(withView('member'), NODE, 'aa'.repeat(32))).toBeNull();
        expect(await postsViewRefusal(withView(null), NODE, 'aa'.repeat(32))).toBeNull();
        expect(await postsViewRefusal(withView('guest'), NODE, '')).toBeNull();
    });

    it('knows the author a guest view puts on every listing', () => {
        expect(HIDDEN_AUTHOR).toBe('hidden');
        expect(isHiddenAuthor('hidden')).toBe(true);
        expect(isHiddenAuthor('')).toBe(true);
        expect(isHiddenAuthor(undefined)).toBe(true);
        expect(isHiddenAuthor('aa'.repeat(32))).toBe(false);
    });
});

describe('an author a guest view hides is never opened', () => {
    const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf-8');

    it('the profile screen answers the hidden author with a plain state, and asks the node nothing', () => {
        const s = read('app/public-profile.tsx');
        expect(s).toMatch(/if \(!pubKeyStr \|\| isHiddenAuthor\(pubKeyStr\)\) \{\s*setLoading\(false\);/);
        expect(s).toMatch(/if \(pubKeyStr === HIDDEN_AUTHOR\) \{\s*return \(/);
    });

    it('the listing\'s "Posted by" card does not open for it', () => {
        expect(read('app/post/[id].tsx')).toMatch(/disabled=\{isHiddenAuthor\(post\.author_pubkey\)\}/);
    });

    it('nor does the author chip', () => {
        const s = read('components/PostAuthorTrust.tsx');
        expect(s).toMatch(/const canOpen = navigable && !isHiddenAuthor\(pubkey\);/);
        expect(s).toMatch(/const Wrapper = canOpen \? Pressable : View;/);
    });

    it('a post opened on its own (getPost) never writes a guest view over a member\'s row', () => {
        expect(read('utils/db.ts')).toMatch(/if \(viewOf\(res\) === 'guest' && await postsViewRefusal\(res, anchorUrl, \(await loadIdentity\(\)\)\?\.publicKey\)\) return null;/);
    });
});

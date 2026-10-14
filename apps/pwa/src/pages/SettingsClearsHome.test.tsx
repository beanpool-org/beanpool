/**
 * Home's last answer (lib/home-cache.ts) is the member's own: their Beans, who wrote to them, their groups, their
 * layout. It goes wherever this browser's account storage goes (PR #1479's review, BLOCKING 1): Sign Out (Device Only),
 * a delete at the last community, a delete at a community the web app was pointed at, and Force Clear & Re-Sync. Each
 * path is driven through Settings as a member uses it; IndexedDB is the in-memory stand-in, and nothing contacts a node.
 *
 * And nothing puts it back (round 2): a Home still open when the path runs (another tab, or this one) drops what it holds,
 * and every write of a member's copy checks the account's epoch (lib/account-epoch.ts) first and again after.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './SettingsPage';
import { HomePage } from './HomePage';
import * as api from '../lib/api';
import { memoryIndexedDB, type MemoryIndexedDB } from '../lib/memory-indexeddb';
import { clearHomeCache, homeCacheKey, readCachedHome, resetHomeCacheForTest, writeCachedHome } from '../lib/home-cache';
import { readLayout } from '../lib/home-layout';
import { clearAccountStorage } from '../lib/device-prefs';
import { resetAccountEpochForTest } from '../lib/account-epoch';
import { epochEndsInAnotherTab, signOutInAnotherTab } from '../lib/another-tab';
import { NOTICES_SEEN_EVENT } from '../lib/home-cards';
import type { HomeAnswer } from '../lib/home-cards';
import type { BeanPoolIdentity } from '../lib/identity';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return {
        ...actual,
        getNotificationPreferences: vi.fn(async () => ({})),
        getMemberPreferences: vi.fn(async () => ({})),
        getMemberProfile: vi.fn(async () => ({})),
        getNodeStats: vi.fn(async () => null),
        getCommunityHealth: vi.fn(async () => ({})),
        getSignInRecovery: vi.fn(async () => null),
        purgeAccountApi: vi.fn(async () => ({ ok: true, message: 'Account purged' })),
        getHome: vi.fn(),
    };
});
vi.mock('../lib/identity', async () => {
    const actual = await vi.importActual('../lib/identity');
    return { ...actual, wipeIdentity: vi.fn(async () => {}), loadIdentity: vi.fn(async () => null) };
});

const WORDS = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'];
const identity = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Kim', mnemonic: WORDS } as unknown as BeanPoolIdentity;
const CASTLEMAINE = 'https://castlemaine.beanpool.org';

/** What the reviewer found left behind: a balance, an unread-from name, a group, a layout. */
const KIMS_HOME: HomeAnswer = {
    generatedAt: new Date().toISOString(), profile: 'local',
    features: { beans: true },
    me: { joinedAt: '2026-09-01T00:00:00.000Z', isKeeper: false, probation: null, interests: ['food'], area: { lat: -37.06, lng: 144.21 }, firstOffer: true, standing: 'member' },
    layout: { v: 1, order: [], hidden: ['pulse'], dismissed: {}, updatedAt: '2026-10-01T00:00:00.000Z' },
    cards: {
        needs: { items: [{ kind: 'message', count: 1, accent: false, label: 'Unread message from Kofi', target: { to: 'unread-messages' } }] },
        groups: { items: [{ id: 'g1', kind: 'group', name: 'Garden group', unread: 2, muted: false }], total: 1 },
        beans: { balance: -35, room: 165, tier: 'Resident', activated: true, frozen: false },
        community: { name: 'Castlemaine', members: 81 },
    },
};

let idb: MemoryIndexedDB;

/** Kim's Home kept in this browser, for the community the web app talks to now (and, pointed elsewhere, for that one). */
async function keepKimsHome(): Promise<string> {
    const key = homeCacheKey(identity.publicKey);
    await writeCachedHome(key, { answer: KIMS_HOME, asked: null, etag: 'W/"home-kim"', layout: readLayout(KIMS_HOME.layout), layoutUnsaved: false, savedAt: Date.now() });
    expect(await readCachedHome(key)).not.toBeNull();
    return key;
}

/** Nothing of Kim's Home is left: no copy can be read back, and the database itself is gone. */
async function expectNoHomeLeft(key: string) {
    await waitFor(() => expect(idb.has('beanpool-home')).toBe(false));
    expect(idb.peek('beanpool-home', 'answers', key)).toBeUndefined();
    resetHomeCacheForTest();
    expect(await readCachedHome(key)).toBeNull();
}

/** The page's own node's answer about the key (only the delete's plan asks it); every other request is refused. */
function pageNode(answer: 'member' | 'stranger') {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/community/membership/')) {
            return new Response(JSON.stringify(answer === 'member' ? { isMember: true } : { isMember: false, isRecovering: false }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
    }));
}

function openSettings() {
    render(<SettingsPage identity={identity} onIdentityUpdated={() => {}} onBack={() => {}} themePreference="system" onThemePreferenceChange={() => {}} />);
}

async function openDelete() {
    openSettings();
    fireEvent.click(await screen.findByText('⚠️ Account Deletion & Sign Out'));
    fireEvent.click(screen.getByRole('button', { name: 'Permanently Delete Account' }));
    fireEvent.change(screen.getByLabelText(/Type callsign Kim or DELETE/), { target: { value: 'DELETE' } });
}

beforeEach(() => {
    localStorage.clear();
    // Each test is a page loaded afresh: the sign-out an earlier test ran is not this one's.
    resetAccountEpochForTest();
    idb = memoryIndexedDB();
    vi.stubGlobal('indexedDB', idb);
    resetHomeCacheForTest();
    vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
    // The reload the page schedules after a sign-out or a delete never runs here.
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.mocked(api.purgeAccountApi).mockClear();
    vi.mocked(api.getHome).mockReset();
});

describe("every path that clears this browser's account storage takes the cached Home with it", () => {
    it('Sign Out (Device Only)', async () => {
        const key = await keepKimsHome();
        openSettings();
        fireEvent.click(await screen.findByText('⚠️ Account Deletion & Sign Out'));
        fireEvent.click(screen.getByRole('button', { name: 'Sign Out (Device Only)' }));
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm Sign Out' })); });
        await expectNoHomeLeft(key);
    });

    it('Permanently Delete Account at the last community this browser serves', async () => {
        pageNode('member');
        const key = await keepKimsHome();
        await openDelete();
        await waitFor(() => expect(screen.getByTestId('delete-key-plan')).toHaveTextContent('Your key and 12 words leave this browser'));
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Purge Account/ })); });
        expect(api.purgeAccountApi).toHaveBeenCalledTimes(1);
        await expectNoHomeLeft(key);
    });

    it('Permanently Delete Account at a community the web app was pointed at: its Home goes, though the key stays', async () => {
        localStorage.setItem('bp_node_url', CASTLEMAINE);
        pageNode('member');
        const key = await keepKimsHome();
        expect(key).toBe(`${CASTLEMAINE}|me-pk`);
        await openDelete();
        await screen.findByText(/Your key and 12 words stay in this browser/);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Purge Account/ })); });
        expect(localStorage.getItem('bp_node_url')).toBeNull();
        await expectNoHomeLeft(key);
    });

    it('Force Clear & Re-Sync Database', async () => {
        const key = await keepKimsHome();
        vi.stubGlobal('confirm', vi.fn(() => true));
        // The diagnostics' storage estimate, answered at once.
        Object.defineProperty(navigator, 'storage', { configurable: true, value: { estimate: async () => ({ usage: 1024 }) } });
        openSettings();
        fireEvent.click(await screen.findByText('Database Health & Stats'));
        const clear = await screen.findByText('⚡ Force Clear & Re-Sync Database');
        await act(async () => { fireEvent.click(clear); });
        await expectNoHomeLeft(key);
    });

    it('the one routine, clearAccountStorage, takes it: every reader and community, and device preferences stay', async () => {
        const mine = await keepKimsHome();
        const visitor = homeCacheKey(null);
        await writeCachedHome(visitor, { answer: KIMS_HOME, asked: null, etag: null, layout: null, layoutUnsaved: false, savedAt: 1 });
        localStorage.setItem('beanpool-install-dismissed', '1');
        await clearAccountStorage();
        expect(localStorage.getItem('beanpool-install-dismissed')).toBe('1');
        await expectNoHomeLeft(mine);
        expect(await readCachedHome(visitor)).toBeNull();
    });

    it('a browser with no IndexedDB signs out all the same', async () => {
        vi.stubGlobal('indexedDB', undefined);
        resetHomeCacheForTest();
        await expect(clearHomeCache('cleared')).resolves.toBeUndefined();
        await expect(clearAccountStorage()).resolves.toBeUndefined();
    });
});

describe('a Home still open when each path runs (another tab of this browser) drops her Home, and never writes it back (round 2)', () => {
    /** Kim's Home open, read from the node and kept. */
    async function homeOpen(key: string) {
        vi.mocked(api.getHome).mockResolvedValue({ notModified: false, answer: KIMS_HOME, etag: 'W/"home-kim"' });
        render(<HomePage identity={identity} onNavigate={() => {}} />);
        await screen.findByText('Unread message from Kofi');
        await waitFor(() => expect(idb.peek('beanpool-home', 'answers', key)).toBeDefined());
    }
    /** That Home, after the path: signed out, it reads nothing more however it is asked, and shows nothing of hers. */
    async function expectHomeSignedOut() {
        await waitFor(() => expect(screen.queryByText('Unread message from Kofi')).toBeNull(), { timeout: 2_000 });
        expect(screen.getByTestId('home-signed-out')).toBeInTheDocument();
        const reads = vi.mocked(api.getHome).mock.calls.length;
        await act(async () => { window.dispatchEvent(new Event(NOTICES_SEEN_EVENT)); });
        expect(vi.mocked(api.getHome).mock.calls.length).toBe(reads);
    }
    /** That Home, after a clear that keeps the account: read afresh, with no tag. */
    async function expectHomeReadAfresh() {
        await waitFor(() => expect(api.getHome).toHaveBeenCalledTimes(2), { timeout: 2_000 });
        expect(vi.mocked(api.getHome).mock.calls[1][1]).toBeNull();
    }

    it('Sign Out (Device Only)', async () => {
        const key = homeCacheKey(identity.publicKey);
        await homeOpen(key);
        openSettings();
        fireEvent.click(await screen.findByText('⚠️ Account Deletion & Sign Out'));
        fireEvent.click(screen.getByRole('button', { name: 'Sign Out (Device Only)' }));
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm Sign Out' })); });
        await expectHomeSignedOut();
        await expectNoHomeLeft(key);
    });

    it('Permanently Delete Account at the last community this browser serves', async () => {
        pageNode('member');
        const key = homeCacheKey(identity.publicKey);
        await homeOpen(key);
        await openDelete();
        await waitFor(() => expect(screen.getByTestId('delete-key-plan')).toHaveTextContent('Your key and 12 words leave this browser'));
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Purge Account/ })); });
        await expectHomeSignedOut();
        await expectNoHomeLeft(key);
    });

    it('Permanently Delete Account at a community the web app was pointed at: that Home goes, and the page\'s own is read afresh', async () => {
        localStorage.setItem('bp_node_url', CASTLEMAINE);
        pageNode('member');
        const key = homeCacheKey(identity.publicKey);
        expect(key).toBe(`${CASTLEMAINE}|me-pk`);
        await homeOpen(key);
        await openDelete();
        await screen.findByText(/Your key and 12 words stay in this browser/);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Purge Account/ })); });
        await expectHomeReadAfresh();
        await act(async () => { await new Promise(r => setTimeout(r, 30)); });
        expect(idb.peek('beanpool-home', 'answers', key)).toBeUndefined();
    });

    it('Force Clear & Re-Sync Database: read afresh, and the old copy never comes back', async () => {
        const key = homeCacheKey(identity.publicKey);
        await homeOpen(key);
        vi.mocked(api.getHome).mockResolvedValue({ notModified: false, answer: { ...KIMS_HOME, cards: { ...KIMS_HOME.cards, community: { name: 'Castlemaine', members: 82 } } }, etag: 'W/"home-fresh"' });
        vi.stubGlobal('confirm', vi.fn(() => true));
        Object.defineProperty(navigator, 'storage', { configurable: true, value: { estimate: async () => ({ usage: 1024 }) } });
        openSettings();
        fireEvent.click(await screen.findByText('Database Health & Stats'));
        const clear = await screen.findByText('⚡ Force Clear & Re-Sync Database');
        await act(async () => { fireEvent.click(clear); });
        await expectHomeReadAfresh();
        // Whatever is kept now is the answer read afresh, never the one from before the clear.
        await act(async () => { await new Promise(r => setTimeout(r, 30)); });
        expect((idb.peek('beanpool-home', 'answers', key) as { etag?: string } | undefined)?.etag).not.toBe('W/"home-kim"');
    });
});

describe('every write of a member\'s Home checks the account\'s epoch (round 2)', () => {
    it('after Sign Out in another tab, a write of her Home from this one is dropped', async () => {
        const key = await keepKimsHome();
        await signOutInAnotherTab();
        await writeCachedHome(key, { answer: KIMS_HOME, asked: null, etag: 'W/"home-kim"', layout: readLayout(KIMS_HOME.layout), layoutUnsaved: false, savedAt: Date.now() });
        expect(idb.peek('beanpool-home', 'answers', key)).toBeUndefined();
    });

    it('one that lands just as another tab signs out is taken out again', async () => {
        const key = homeCacheKey(identity.publicKey);
        // The sign-out is heard between this tab's check and its write's commit (two processes, one disk).
        const open = idb.open.bind(idb);
        let armed = true;
        idb.open = ((name: string, version?: number) => {
            const req = open(name, version) as ReturnType<typeof open> & { onsuccess: ((ev: unknown) => void) | null };
            let then: ((ev: unknown) => void) | null = null;
            Object.defineProperty(req, 'onsuccess', {
                configurable: true,
                set: (fn: ((ev: unknown) => void) | null) => { then = fn; },
                get: () => (ev: unknown) => {
                    const db = req.result as { transaction: (s: string, m?: IDBTransactionMode) => { objectStore: (n: string) => { put: (v: unknown, k: IDBValidKey) => unknown } } };
                    const transaction = db.transaction.bind(db);
                    db.transaction = (s, m) => {
                        const tx = transaction(s, m);
                        const objectStore = tx.objectStore.bind(tx);
                        tx.objectStore = (n) => {
                            const os = objectStore(n);
                            const put = os.put.bind(os);
                            os.put = (v, k) => {
                                const r = put(v, k);
                                if (armed) { armed = false; epochEndsInAnotherTab('signed-out'); }
                                return r;
                            };
                            return os;
                        };
                        return tx;
                    };
                    then?.(ev);
                },
            });
            return req;
        }) as typeof idb.open;
        await writeCachedHome(key, { answer: KIMS_HOME, asked: null, etag: 'W/"home-kim"', layout: readLayout(KIMS_HOME.layout), layoutUnsaved: false, savedAt: Date.now() });
        expect(armed).toBe(false);
        expect(idb.peek('beanpool-home', 'answers', key)).toBeUndefined();
    });

    it('the lobby\'s copy holds no account: a visitor\'s Home is still kept after another tab signs out', async () => {
        await signOutInAnotherTab();
        const visitor = homeCacheKey(null);
        await writeCachedHome(visitor, { answer: KIMS_HOME, asked: null, etag: null, layout: null, layoutUnsaved: false, savedAt: 1 });
        expect(await readCachedHome(visitor)).not.toBeNull();
    });
});

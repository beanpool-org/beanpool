/**
 * Home's last answer (lib/home-cache.ts) is the member's own: their Beans, who wrote to them, their groups, their
 * layout. It goes wherever this browser's account storage goes (PR #1479's review, BLOCKING 1): Sign Out (Device Only),
 * a delete at the last community, a delete at a community the web app was pointed at, and Force Clear & Re-Sync. Each
 * path is driven through Settings as a member uses it; IndexedDB is the in-memory stand-in, and nothing contacts a node.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './SettingsPage';
import * as api from '../lib/api';
import { memoryIndexedDB, type MemoryIndexedDB } from '../lib/memory-indexeddb';
import { clearHomeCache, homeCacheKey, readCachedHome, resetHomeCacheForTest, writeCachedHome } from '../lib/home-cache';
import { clearAccountStorage } from '../lib/device-prefs';
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
    await writeCachedHome(key, { answer: KIMS_HOME, asked: null, etag: 'W/"home-kim"', layout: KIMS_HOME.layout, layoutUnsaved: false, savedAt: Date.now() });
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
        await expect(clearHomeCache()).resolves.toBeUndefined();
        await expect(clearAccountStorage()).resolves.toBeUndefined();
    });
});

/**
 * A stranger on a post a member shared outside (front doors S6), and the page reloaded: App takes `?post=` and `?peek=`
 * out of the address as it loads, so a reload (pull to refresh, Reload, or Android bringing back a tab it dropped while
 * they were in the chat app) found plain `/app` and showed the welcome page, with no post and nothing said. The peek is
 * kept in this tab (lib/peek.ts keepPeek) and read back at an address with nothing in it.
 *
 * The whole App, with no account here; the peek and welcome pages stood in, the node's reads mocked at their modules.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

const identityMocks = vi.hoisted(() => ({
    loadIdentity: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock('./lib/identity', async (orig) => ({ ...(await orig<typeof import('./lib/identity')>()), ...identityMocks }));
vi.mock('./lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => ({ memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local', features: { shareOutside: true } })),
    joinInFlight: vi.fn(async () => false),
}));
vi.mock('./lib/sync', () => ({
    connectToAnchor: vi.fn(),
    reconnectToAnchor: vi.fn(),
    onSyncActivity: vi.fn(() => () => {}),
    onSyncChange: vi.fn(() => () => {}),
    onSystemAnnouncement: vi.fn(() => () => {}),
    onSocketOpen: vi.fn(() => () => {}),
    getSyncState: vi.fn(() => ({ connected: false, lastSyncTime: null, merkleRoot: null, accountCount: 0 })),
}));
vi.mock('./lib/api', async (orig) => ({
    ...(await orig<typeof import('./lib/api')>()),
    getNodeApiUrl: vi.fn(() => ''),
    getCommunityHealth: vi.fn(async () => ({ online: true, version: '1.2.28' })),
    getMyUnread: vi.fn(async () => ({ unread: 0, requests: 0, asOf: '2026-11-01T00:00:00.000Z' })),
    getMyMarketplaceTransactions: vi.fn(async () => []),
}));
vi.mock('./components/InstallPrompt', () => ({ InstallPrompt: () => null }));
vi.mock('./components/FormerAddressBanner', () => ({ FormerAddressBanner: () => null }));
vi.mock('./pages/WelcomePage', () => ({ WelcomePage: () => <div data-testid="welcome-page" /> }));
vi.mock('./pages/PeekPage', () => ({
    PeekPage: ({ postId, ticket, onWelcome }: { postId: string; ticket: string; onWelcome: (door: 'invite' | 'signin') => void }) => (
        <div data-testid="peek-page" data-post={postId} data-ticket={ticket}>
            <button type="button" onClick={() => onWelcome('invite')}>I have an invite</button>
        </div>
    ),
}));

import { App } from './App';
import { PEEK_STORAGE_KEY } from './lib/peek';
import { generateIdentity } from './lib/identity';

const POST_ID = '3f0c8a8e-1b2c-4d5e-8f90-123456789abc';
const T = 'AbCdEfGhIjKlMnOpQrSt_-';
const address = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;

/** The page loads at `at` (or wherever the last one left it): a reload. */
async function load(at?: string): Promise<'peek' | 'welcome'> {
    cleanup();
    if (at !== undefined) window.history.replaceState(null, '', at);
    render(<App />);
    const shown = await screen.findByTestId(/^(peek|welcome)-page$/);
    return shown.getAttribute('data-testid') === 'peek-page' ? 'peek' : 'welcome';
}

beforeEach(() => {
    window.matchMedia = ((query: string) => ({
        matches: false, media: query, onchange: null,
        addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    identityMocks.loadIdentity.mockImplementation(async () => null);
    sessionStorage.clear();
    window.history.replaceState(null, '', '/app');
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
    window.history.replaceState(null, '', '/app');
});

describe('a stranger on a shared post, and the page reloaded', () => {
    it('reloaded at the address the first load left behind, the same post is shown again, as often as it reloads', async () => {
        expect(await load(`/app?post=${POST_ID}&peek=${T}`)).toBe('peek');
        // The link is taken out of the address as before: the ticket isn't left in the bar.
        expect(address()).toBe('/app');

        for (let i = 0; i < 2; i++) {
            expect(await load()).toBe('peek');
            expect(screen.getByTestId('peek-page').getAttribute('data-post')).toBe(POST_ID);
            expect(screen.getByTestId('peek-page').getAttribute('data-ticket')).toBe(T);
        }
    });

    it('taking a door forgets it: a reload then is the welcome page, at its door or at plain /app', async () => {
        expect(await load(`/app?post=${POST_ID}&peek=${T}`)).toBe('peek');
        fireEvent.click(screen.getByText('I have an invite'));
        await screen.findByTestId('welcome-page');
        expect(address()).toBe('/app?door=invite');
        expect(sessionStorage.getItem(PEEK_STORAGE_KEY)).toBeNull();
        // Reloaded once the welcome page has its door out of the address, or at its door.
        expect(await load('/app')).toBe('welcome');
        expect(await load('/app?door=invite')).toBe('welcome');
    });

    it('another link in the tab is that link, and the kept peek is forgotten', async () => {
        expect(await load(`/app?post=${POST_ID}&peek=${T}`)).toBe('peek');
        expect(await load('/app?invite=INV-1')).toBe('welcome');
        expect(await load('/app')).toBe('welcome');
    });

    it('a newer link in the tab replaces it', async () => {
        const OTHER = 'ZyXwVuTsRqPoNmLkJiHg_-';
        expect(await load(`/app?post=${POST_ID}&peek=${T}`)).toBe('peek');
        expect(await load(`/app?post=p-other&peek=${OTHER}`)).toBe('peek');
        expect(await load()).toBe('peek');
        expect(screen.getByTestId('peek-page').getAttribute('data-post')).toBe('p-other');
        expect(screen.getByTestId('peek-page').getAttribute('data-ticket')).toBe(OTHER);
    });

    it('a member who opens the link keeps nothing: the post opens as any shared post', async () => {
        const member = await generateIdentity('Alice');
        identityMocks.loadIdentity.mockImplementation(async () => member);
        // The member app's own reads: none of them is what this checks.
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
        window.history.replaceState(null, '', `/app?post=${POST_ID}&peek=${T}`);
        render(<App />);
        await act(async () => { await identityMocks.loadIdentity.mock.results[0]?.value; });
        expect(screen.queryByTestId('peek-page')).toBeNull();
        expect(sessionStorage.getItem(PEEK_STORAGE_KEY)).toBeNull();
    });
});

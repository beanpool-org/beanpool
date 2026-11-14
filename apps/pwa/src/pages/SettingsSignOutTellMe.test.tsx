/**
 * Sign-out and delete-everything keep web push W2's promise for Home's Tell me too (review of #3167, BLOCKING): a member who
 * asked another community from Home's Find card and tapped Tell me holds a registration at /app/knock/<host>/ and that
 * community keeps an `asker` row for it. Before the key and the pins go (localStorage.clear()), that community is told to let
 * go (signed DELETE) and the registration ends, so a yes for the account that has gone never reaches this browser. Driven
 * through Settings as a member uses it; nothing contacts a node.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './SettingsPage';
import * as api from '../lib/api';
import { wipeIdentity, type BeanPoolIdentity } from '../lib/identity';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { resetHomeCacheForTest } from '../lib/home-cache';
import { resetAccountEpochForTest } from '../lib/account-epoch';

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
        sendSignedAt: vi.fn(async () => {}),
        signedFetchAt: vi.fn(async () => new Response('{}', { status: 200 })),
    };
});
vi.mock('../lib/identity', async () => {
    const actual = await vi.importActual('../lib/identity');
    return { ...actual, wipeIdentity: vi.fn(async () => {}), loadIdentity: vi.fn(async () => null) };
});

const WORDS = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'];
const identity = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Kim', mnemonic: WORDS } as unknown as BeanPoolIdentity;
const RIVERSIDE = 'https://riverside.example';
const POINTED = 'https://hilltop.example';

/** What happened, in order: the browser's own calls and the key's wipe. */
let order: string[];
let knock: { scope: string; unregister: ReturnType<typeof vi.fn>; unsubscribe: ReturnType<typeof vi.fn> };
let own: { scope: string; unregister: ReturnType<typeof vi.fn> };

/** Kim tapped Tell me on Riverside's row on Home: its pin, and this browser's registration for Riverside. */
function tellMeKept() {
    localStorage.setItem('beanpool_web_push', JSON.stringify([
        { origin: RIVERSIDE, publicKey: identity.publicKey, subId: 'e'.repeat(64), pushKey: 'd'.repeat(64), vapidKey: 'v', for: 'asker' },
    ]));
    const unsubscribe = vi.fn(async () => { order.push('unsubscribe riverside'); return true; });
    knock = { scope: `${window.location.origin}/app/knock/riverside.example/`, unsubscribe, unregister: vi.fn(async () => { order.push('unregister riverside'); return true; }) };
    own = { scope: `${window.location.origin}/app/`, unregister: vi.fn(async () => true) };
    const registrations = [own, { ...knock, pushManager: { getSubscription: async () => ({ unsubscribe }) } }];
    Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: {
            getRegistrations: vi.fn(async () => registrations),
            getRegistration: vi.fn(async () => ({ ...own, pushManager: { getSubscription: async () => null } })),
        },
    });
}

/** The page's own node's answer about the key (only the delete's plan asks it); every other request is refused. */
function pageNode() {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('/api/community/membership/')) return new Response(JSON.stringify({ isMember: true }), { status: 200 });
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

const deletesTo = (origin: string) => vi.mocked(api.sendSignedAt).mock.calls.filter(c => c[0] === 'DELETE' && c[1] === origin);

/** Riverside was told, signed by Kim's key, and the registration ended, all before the key went. */
function expectRiversideLetGo() {
    expect(deletesTo(RIVERSIDE).map(c => [c[2], c[3], c[4]])).toEqual([['/api/web-push', JSON.stringify({ subId: 'e'.repeat(64) }), identity]]);
    expect(knock.unsubscribe).toHaveBeenCalledTimes(1);
    expect(knock.unregister).toHaveBeenCalledTimes(1);
    expect(own.unregister).not.toHaveBeenCalled();
    const wiped = order.indexOf('wipe key');
    expect(wiped).toBeGreaterThan(-1);
    expect(order.indexOf('DELETE riverside')).toBeLessThan(wiped);
    expect(order.indexOf('unregister riverside')).toBeLessThan(wiped);
}

beforeEach(() => {
    localStorage.clear();
    order = [];
    resetAccountEpochForTest();
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetHomeCacheForTest();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.sendSignedAt).mockReset();
    vi.mocked(api.sendSignedAt).mockImplementation(async (method, origin) => { order.push(`${method} ${new URL(origin).hostname.split('.')[0]}`); });
    vi.mocked(wipeIdentity).mockReset();
    vi.mocked(wipeIdentity).mockImplementation(async () => { order.push('wipe key'); });
    tellMeKept();
});
afterEach(() => {
    // The reload the page schedules after a sign-out or a delete never runs here.
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.mocked(api.purgeAccountApi).mockClear();
});

describe("every path that takes the key from this browser lets go of Home's Tell me first", () => {
    it('Sign Out (Device Only)', async () => {
        openSettings();
        fireEvent.click(await screen.findByText('⚠️ Account Deletion & Sign Out'));
        fireEvent.click(screen.getByRole('button', { name: 'Sign Out (Device Only)' }));
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm Sign Out' })); });
        await waitFor(() => expect(wipeIdentity).toHaveBeenCalledTimes(1));
        expectRiversideLetGo();
        expect(localStorage.getItem('beanpool_web_push')).toBeNull();
    });

    it('Permanently Delete Account at the last community this browser serves', async () => {
        pageNode();
        await openDelete();
        await waitFor(() => expect(screen.getByTestId('delete-key-plan')).toHaveTextContent('Your key and 12 words leave this browser'));
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Purge Account/ })); });
        await waitFor(() => expect(wipeIdentity).toHaveBeenCalledTimes(1));
        expect(api.purgeAccountApi).toHaveBeenCalledTimes(1);
        expectRiversideLetGo();
    });

    it('a delete at a community the web app was pointed at keeps the key here, and Home keeps its Tell me (its own let-go ends it)', async () => {
        localStorage.setItem('bp_node_url', POINTED);
        pageNode();
        await openDelete();
        await screen.findByText(/Your key and 12 words stay in this browser/);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Purge Account/ })); });
        await waitFor(() => expect(localStorage.getItem('bp_node_url')).toBeNull());
        expect(wipeIdentity).not.toHaveBeenCalled();
        expect(deletesTo(RIVERSIDE)).toEqual([]);
        expect(knock.unregister).not.toHaveBeenCalled();
        expect(JSON.parse(localStorage.getItem('beanpool_web_push') ?? '[]').map((p: { origin: string }) => p.origin)).toEqual([RIVERSIDE]);
    });
});

/**
 * Settings → Advanced → the community address (web push W2, review of 67cdc710): a browser's pushes and their pin are the
 * node the web app talks to (lib/web-push.ts webPushOrigin). Pointing the app at another community, or back to the page's
 * own, first lets the one it talked to go of this browser (Turn off: DELETE signed while the key is here, the browser's
 * subscription ends), so the old one's notices don't keep arriving to be refused here as forgeries.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './SettingsPage';
import * as webPush from '../lib/web-push';
import { LanguageRoot } from '../words-w3.test-support';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return {
        ...actual,
        getNotificationPreferences: vi.fn(async () => ({})),
        getMemberPreferences: vi.fn(async () => ({ holiday_mode: 'false', show_as_connection_in_common: 'true' })),
        getMemberProfile: vi.fn(async () => ({ publicKey: 'me-pk', callsign: 'Kim', avatar: null, bio: '', contact: null })),
        checkMembership: vi.fn(async () => ({ isMember: true, callsign: 'Kim' })),
        getNodeStats: vi.fn(async () => ({ members: 14, posts: 30, transactions: 9 })),
        getCommunityHealth: vi.fn(async () => ({})),
        getSignInRecovery: vi.fn(async () => null),
        getFriends: vi.fn(async () => []),
    };
});
vi.mock('../lib/blocklist', async () => {
    const actual = await vi.importActual('../lib/blocklist');
    return { ...actual, loadBlocklist: vi.fn(async () => []) };
});
vi.mock('../lib/member-area', async () => {
    const actual = await vi.importActual('../lib/member-area');
    return { ...actual, useNearbyLimits: vi.fn(() => null), readMyArea: vi.fn(async () => null) };
});
vi.mock('../lib/web-push', async () => {
    const actual = await vi.importActual('../lib/web-push');
    return { ...actual, turnOffWebPush: vi.fn(async () => {}) };
});

const identity: any = { publicKey: 'me-pk', privateKey: 'priv-key-hex', callsign: 'Kim', mnemonic: [] };

beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    vi.mocked(webPush.turnOffWebPush).mockClear();
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
});

const openAdvanced = async () => {
    render(
        <LanguageRoot draw={() => (
            <SettingsPage identity={identity} onIdentityUpdated={() => {}} onBack={() => {}} themePreference="system" onThemePreferenceChange={() => {}}
                onReRunSetup={() => {}} nodeVersion="1.4.0" />
        )} />,
    );
    fireEvent.click(await screen.findByText('Advanced / Subsystem'));
};

describe('Settings → the community address: the community the app talked to lets go of this browser first', () => {
    it('Reset to this page’s community: Turn off at the address it talked to, before the address goes', async () => {
        localStorage.setItem('bp_node_url', 'https://other.example');
        await openAdvanced();
        fireEvent.click(await screen.findByText('Reset to this page’s community'));
        await waitFor(() => expect(localStorage.getItem('bp_node_url')).toBeNull());
        expect(webPush.turnOffWebPush).toHaveBeenCalledTimes(1);
        expect(vi.mocked(webPush.turnOffWebPush).mock.calls[0]).toEqual(['https://other.example', identity]);
    });
    it("Save & Connect to another community: Turn off at the page's own, the one it talked to", async () => {
        await openAdvanced();
        fireEvent.change(await screen.findByPlaceholderText('Node API URL (e.g. https://riverside.example.org)'), { target: { value: 'https://riverside.example/' } });
        fireEvent.click(screen.getByText('💾 Save & Connect'));
        await waitFor(() => expect(localStorage.getItem('bp_node_url')).toBe('https://riverside.example'));
        expect(vi.mocked(webPush.turnOffWebPush).mock.calls).toEqual([[window.location.origin, identity]]);
    });
    it('Save & Connect to the address it already talks to: this browser is kept', async () => {
        localStorage.setItem('bp_node_url', 'https://riverside.example');
        await openAdvanced();
        fireEvent.change(await screen.findByPlaceholderText('Node API URL (e.g. https://riverside.example.org)'), { target: { value: 'https://riverside.example' } });
        fireEvent.click(screen.getByText('💾 Save & Connect'));
        await waitFor(() => expect(localStorage.getItem('bp_node_url')).toBe('https://riverside.example'));
        expect(webPush.turnOffWebPush).not.toHaveBeenCalled();
    });
});

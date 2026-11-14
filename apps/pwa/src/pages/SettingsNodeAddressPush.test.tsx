/**
 * Settings → Advanced → the community address (web push W2, reviews of 67cdc710 and 7b3f900e): a browser's pushes and their
 * pin are the node the web app talks to (lib/web-push.ts webPushOrigin). Pointing the app at another community, or back to the
 * page's own, changes the address on the tap, and the one it talked to lets go of this browser (its origin read first, the
 * signed DELETE sent there and never waited for: letGoOfWebPushAt), so the old one's notices don't keep arriving to be refused
 * here as forgeries, and an old community out of reach holds nothing up. The same community, however typed, keeps it.
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
    return { ...actual, turnOffWebPush: vi.fn(async () => {}), letGoOfWebPushAt: vi.fn(async () => {}) };
});

const identity: any = { publicKey: 'me-pk', privateKey: 'priv-key-hex', callsign: 'Kim', mnemonic: [] };

beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    vi.mocked(webPush.turnOffWebPush).mockClear();
    vi.mocked(webPush.letGoOfWebPushAt).mockReset();
    vi.mocked(webPush.letGoOfWebPushAt).mockResolvedValue(undefined);
});
/** The old community out of reach: the letting go never settles (its LET_GO_WAIT_MS bound is web-push.members.test's). */
const oldCommunityOutOfReach = () => vi.mocked(webPush.letGoOfWebPushAt).mockImplementation(() => new Promise<void>(() => {}));
const urlField = () => screen.findByPlaceholderText('Node API URL (e.g. https://riverside.example.org)');
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

describe('Settings → the community address: changed on the tap; the community the app talked to lets go of this browser', () => {
    it('Reset to this page’s community: the address goes at once, and the one it talked to lets go, from the origin read first', async () => {
        localStorage.setItem('bp_node_url', 'https://other.example');
        oldCommunityOutOfReach();
        await openAdvanced();
        const reset = await screen.findByText('Reset to this page’s community');
        fireEvent.click(reset);
        expect(localStorage.getItem('bp_node_url')).toBeNull();
        expect(vi.mocked(webPush.letGoOfWebPushAt).mock.calls).toEqual([['https://other.example', identity]]);
        expect(webPush.turnOffWebPush).not.toHaveBeenCalled();
        // While the letting go is on its way (at most a second, web-push.ts LET_GO_WAIT_MS), neither button is tapped twice.
        await waitFor(() => expect(reset).toBeDisabled());
        expect(screen.getByText('💾 Save & Connect')).toBeDisabled();
    });
    it("Save & Connect to another community: the address is saved at once; the page's own, the one it talked to, lets go", async () => {
        oldCommunityOutOfReach();
        await openAdvanced();
        fireEvent.change(await urlField(), { target: { value: 'https://riverside.example/' } });
        fireEvent.click(screen.getByText('💾 Save & Connect'));
        expect(localStorage.getItem('bp_node_url')).toBe('https://riverside.example');
        expect(vi.mocked(webPush.letGoOfWebPushAt).mock.calls).toEqual([[window.location.origin, identity]]);
        expect(webPush.turnOffWebPush).not.toHaveBeenCalled();
    });
    it('Save & Connect to the address it already talks to: this browser is kept', async () => {
        localStorage.setItem('bp_node_url', 'https://riverside.example');
        await openAdvanced();
        fireEvent.change(await urlField(), { target: { value: 'https://riverside.example' } });
        fireEvent.click(screen.getByText('💾 Save & Connect'));
        expect(localStorage.getItem('bp_node_url')).toBe('https://riverside.example');
        expect(webPush.letGoOfWebPushAt).not.toHaveBeenCalled();
        expect(webPush.turnOffWebPush).not.toHaveBeenCalled();
    });
    it('Save & Connect to the same community typed differently (capitals, :443, a trailing /): this browser is kept', async () => {
        localStorage.setItem('bp_node_url', 'https://riverside.example');
        await openAdvanced();
        fireEvent.change(await urlField(), { target: { value: 'HTTPS://Riverside.Example:443/' } });
        fireEvent.click(screen.getByText('💾 Save & Connect'));
        expect(localStorage.getItem('bp_node_url')).toBe('HTTPS://Riverside.Example:443');
        expect(webPush.letGoOfWebPushAt).not.toHaveBeenCalled();
        expect(webPush.turnOffWebPush).not.toHaveBeenCalled();
    });
});

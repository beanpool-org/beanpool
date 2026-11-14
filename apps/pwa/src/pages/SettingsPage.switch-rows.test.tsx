/**
 * Settings on the web: the words beside a switch leave a gap before it (the phone app's Settings → Notifications ran its
 * words right up to the switch, Marty's Pixel, 1.3.2; the web had the same rows, flex with `justify-between` and no gap).
 *
 * jsdom has no layout, so this reads the one thing that makes the gap in a browser: each switch's row is a flex row with a
 * `gap-*` and the words before the switch are a `min-w-0` column (so they wrap inside the room left, instead of pushing
 * against the switch). The switch itself is `shrink-0` (ToggleSwitch). It does not measure pixels.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './SettingsPage';
import * as api from '../lib/api';
import { LanguageRoot } from '../words-w3.test-support';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return {
        ...actual,
        getNotificationPreferences: vi.fn(async () => ({ notify_chat: 'true', notify_marketplace: 'true', notify_escrow: 'false', notify_knocks: 'true' })),
        getMemberPreferences: vi.fn(async () => ({ holiday_mode: 'false', show_as_connection_in_common: 'true' })),
        getMemberProfile: vi.fn(async () => ({ publicKey: 'me-pk', callsign: 'Kim', avatar: null, bio: '', contact: null })),
        updateMemberProfile: vi.fn(async () => ({ success: true, profile: null })),
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

const identity: any = { publicKey: 'me-pk', privateKey: 'priv-key-hex', callsign: 'Kim', mnemonic: [] };

beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    vi.mocked(api.getNotificationPreferences).mockClear();
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

const renderSettings = () => render(
    <LanguageRoot draw={() => (
        <SettingsPage identity={identity} onIdentityUpdated={() => {}} onBack={() => {}} themePreference="system" onThemePreferenceChange={() => {}}
            onReRunSetup={() => {}} nodeVersion="1.2.29" />
    )} />,
);

/** Every switch drawn now: its name, whether its row has a gap, and whether the words before it can shrink to fit. */
function switchRows() {
    return Array.from(document.querySelectorAll('[role="switch"]')).map((sw) => {
        const row = sw.parentElement!;
        const words = sw.previousElementSibling;
        return {
            name: sw.getAttribute('aria-label') ?? '?',
            rowIsFlex: /\bflex\b/.test(row.className),
            rowGap: /\bgap-\d/.test(row.className),
            wordsMinW0: !!words && /\bmin-w-0\b/.test(words.className),
            switchShrinks: !/\bshrink-0\b/.test(sw.className),
        };
    });
}
function expectGapBeforeEverySwitch(names: string[]) {
    const rows = switchRows();
    for (const name of names) expect(rows.map((r) => r.name), `a switch named ${name} is drawn`).toContain(name);
    for (const r of rows) {
        expect(r.rowIsFlex, `${r.name}: its row is a flex row`).toBe(true);
        expect(r.rowGap, `${r.name}: its row has a gap before the switch`).toBe(true);
        expect(r.wordsMinW0, `${r.name}: its words wrap inside the room left`).toBe(true);
        expect(r.switchShrinks, `${r.name}: the switch is not squeezed`).toBe(false);
    }
}

describe('Settings: the words beside a switch leave a gap before it', () => {
    it('the menu: Modern Map Pins, Holiday Mode and Show me as a connection in common', async () => {
        renderSettings();
        await screen.findByTestId('show-as-connection');
        expectGapBeforeEverySwitch(['Modern Map Pins', 'Holiday Mode', 'Show me as a connection in common']);
    });

    it("Notification Preferences: Direct Messages, Marketplace Activity and Held in Trust & System, the phone's names (and every other switch drawn there)", async () => {
        renderSettings();
        fireEvent.click(await screen.findByText('Notification Preferences'));
        await waitFor(() => expect(api.getNotificationPreferences).toHaveBeenCalled());
        await screen.findByText('Direct Messages');
        expectGapBeforeEverySwitch(['Direct messages notifications', 'Marketplace activity notifications', 'Held in trust and system notifications']);
    });
});

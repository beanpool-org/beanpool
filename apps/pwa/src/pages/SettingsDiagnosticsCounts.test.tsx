/**
 * Settings → Database Health & Stats on a node whose owners share no counts (Share Member Count off, #3292): a count the
 * node left out for this reader (a suspended member, a visitor's row) has no tile, never a 0. A member's counts are drawn
 * as given. In light and in dark.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './SettingsPage';
import * as api from '../lib/api';
import { LanguageRoot } from '../words-w3.test-support';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return {
        ...actual,
        getNotificationPreferences: vi.fn(async () => ({ notify_chat: 'true', notify_marketplace: 'true', notify_escrow: 'false' })),
        getMemberPreferences: vi.fn(async () => ({ holiday_mode: 'false', show_as_connection_in_common: 'true' })),
        getMemberProfile: vi.fn(async () => ({ publicKey: 'me-pk', callsign: 'Kim', avatar: null, bio: '', contact: null })),
        updateMemberProfile: vi.fn(async () => ({ success: true, profile: null })),
        checkMembership: vi.fn(async () => ({ isMember: true, callsign: 'Kim' })),
        getNodeStats: vi.fn(),
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
const stats = vi.mocked(api.getNodeStats);

beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    stats.mockReset();
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    document.documentElement.classList.remove('dark');
});

async function openDiagnostics() {
    render(
        <LanguageRoot draw={() => (
            <SettingsPage identity={identity} onIdentityUpdated={() => {}} onBack={() => {}} themePreference="system" onThemePreferenceChange={() => {}}
                onReRunSetup={() => {}} nodeVersion="1.4.7" />
        )} />,
    );
    fireEvent.click(await screen.findByText('Database Health & Stats'));
    return (await screen.findByText('Messages')).closest('.grid') as HTMLElement;
}

for (const theme of ['light', 'dark'] as const) {
    describe(`Database Health & Stats, in ${theme}`, () => {
        beforeEach(() => { if (theme === 'dark') document.documentElement.classList.add('dark'); });

        it('a node that left the counts out: no Members, Active Posts or Ledger Deals tile, and no 0 for them', async () => {
            stats.mockResolvedValue({ members: null, posts: null, transactions: null });
            const grid = await openDiagnostics();
            expect(within(grid).queryByText('Community Members')).toBeNull();
            expect(within(grid).queryByText('Active Posts')).toBeNull();
            expect(within(grid).queryByText('Ledger Deals')).toBeNull();
            expect(screen.queryByTestId('diagnostics-members')).toBeNull();
            expect(screen.queryByTestId('diagnostics-posts')).toBeNull();
            expect(screen.queryByTestId('diagnostics-transactions')).toBeNull();
            // Messages is this browser's own tile, drawn as before.
            expect(grid.children).toHaveLength(1);
        });

        it("a member's counts: every tile, as the node gave them, 0 included", async () => {
            stats.mockResolvedValue({ members: 14, posts: 0, transactions: 9 });
            const grid = await openDiagnostics();
            expect(within(screen.getByTestId('diagnostics-members')).getByText('14')).toBeInTheDocument();
            expect(within(screen.getByTestId('diagnostics-posts')).getByText('0')).toBeInTheDocument();
            expect(within(screen.getByTestId('diagnostics-transactions')).getByText('9')).toBeInTheDocument();
            expect(grid.children).toHaveLength(4);
        });

        it('one count left out, the others shared: only that tile goes', async () => {
            stats.mockResolvedValue({ members: null, posts: 30, transactions: 9 });
            await openDiagnostics();
            expect(screen.queryByTestId('diagnostics-members')).toBeNull();
            expect(within(screen.getByTestId('diagnostics-posts')).getByText('30')).toBeInTheDocument();
        });
    });
}

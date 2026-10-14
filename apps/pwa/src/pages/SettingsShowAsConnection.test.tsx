/**
 * Settings → Legal & Privacy → "Show me as a connection in common" (docs/trust-profile-and-trade-safety.md §2): on unless
 * turned off, read from and saved to the member's own preferences; a save the community didn't take is undone and said.
 * The node's routes are mocked at lib/api; the server side is apps/server/src/test-trust-mutuals.ts T10.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SettingsPage } from './SettingsPage';
import * as api from '../lib/api';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return {
        ...actual,
        getNotificationPreferences: vi.fn(async () => ({})),
        getMemberPreferences: vi.fn(async () => ({})),
        updateNotificationPreferences: vi.fn(async () => ({ success: true })),
        getMemberProfile: vi.fn(async () => ({})),
        getNodeStats: vi.fn(async () => null),
        getCommunityHealth: vi.fn(async () => ({})),
    };
});

const identity: any = { publicKey: 'a1'.repeat(32), privateKey: 'priv', callsign: 'Me' };
const open = () => render(<SettingsPage identity={identity} onIdentityUpdated={() => {}} onBack={() => {}} themePreference="system" onThemePreferenceChange={() => {}} />);
const toggle = () => screen.findByRole('switch', { name: 'Show me as a connection in common' });

beforeEach(() => {
    vi.mocked(api.getMemberPreferences).mockReset().mockResolvedValue({ show_as_connection_in_common: 'true' });
    vi.mocked(api.updateNotificationPreferences).mockReset().mockResolvedValue({ success: true });
});
afterEach(() => vi.restoreAllMocks());

describe('Settings → Show me as a connection in common', () => {
    it('is on unless turned off, and turning it off saves false', async () => {
        open();
        const sw = await toggle();
        expect(sw).toHaveAttribute('aria-checked', 'true');
        fireEvent.click(sw);
        await waitFor(() => expect(api.updateNotificationPreferences).toHaveBeenCalledWith('a1'.repeat(32), { show_as_connection_in_common: false }));
        expect(sw).toHaveAttribute('aria-checked', 'false');
    });

    it('shows off when the member turned it off', async () => {
        vi.mocked(api.getMemberPreferences).mockResolvedValue({ show_as_connection_in_common: 'false' });
        open();
        expect(await toggle()).toHaveAttribute('aria-checked', 'false');
    });

    it('a save the community refused is undone and said', async () => {
        vi.mocked(api.updateNotificationPreferences).mockRejectedValue(new Error('Only a member of this community shows as a connection in common.'));
        open();
        const sw = await toggle();
        fireEvent.click(sw);
        expect(await screen.findByText('Only a member of this community shows as a connection in common.')).toBeInTheDocument();
        expect(sw).toHaveAttribute('aria-checked', 'true');
    });

    it('an older community that never says has no row', async () => {
        vi.mocked(api.getMemberPreferences).mockResolvedValue({ holiday_mode: 'false' });
        open();
        await waitFor(() => expect(api.getMemberPreferences).toHaveBeenCalled());
        expect(screen.queryByRole('switch', { name: 'Show me as a connection in common' })).toBeNull();
    });
});

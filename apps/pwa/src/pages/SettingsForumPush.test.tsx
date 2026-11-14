/**
 * Settings → Notification Preferences → Forum (slice F5, scratch/fable-design/DESIGN-forums-fable.md §9): on until the
 * member turns it off, saved as `notify_forum`, and shown only where the community says `forumNotices` (core
 * forumNoticesOn). A community from before it refuses the key, so the web, which saves every switch at once, never sends
 * it there. The phone's row is the same switch (apps/native app/(tabs)/settings.tsx, testID settings-notify-forum).
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SettingsPage } from './SettingsPage';
import * as api from '../lib/api';
import * as features from '../lib/features';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return {
        ...actual,
        getNotificationPreferences: vi.fn(async () => ({})),
        updateNotificationPreferences: vi.fn(async () => ({ success: true })),
        getMemberPreferences: vi.fn(async () => ({})),
        getMemberProfile: vi.fn(async () => ({})),
        getNodeStats: vi.fn(async () => null),
        getCommunityHealth: vi.fn(async () => ({})),
    };
});
vi.mock('../lib/features', async () => {
    const actual = await vi.importActual<typeof import('../lib/features')>('../lib/features');
    return { ...actual, useCommunityInfo: vi.fn() };
});

const identity: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me' };
const SWITCH = 'Forum';

async function openNotifications(forumNotices: boolean, prefs: Record<string, unknown> = {}) {
    vi.mocked(features.useCommunityInfo).mockReturnValue({ profile: 'local', features: { beans: true, forum: true, ...(forumNotices ? { forumNotices: true } : {}) } } as any);
    vi.mocked(api.getNotificationPreferences).mockResolvedValue(prefs as any);
    render(<SettingsPage identity={identity} onIdentityUpdated={() => {}} onBack={() => {}} themePreference="system" onThemePreferenceChange={() => {}} />);
    fireEvent.click(screen.getByText('Notification Preferences'));
    await screen.findByText('Event reminders');
}

beforeEach(() => {
    vi.mocked(api.updateNotificationPreferences).mockReset().mockResolvedValue({ success: true } as any);
    vi.mocked(api.getNotificationPreferences).mockReset().mockResolvedValue({} as any);
});

describe('Settings → Notifications → Forum (slice F5)', () => {
    it('where the community says forumNotices: the switch and its line, on by default; a tap saves notify_forum off with the rest', async () => {
        await openNotifications(true);
        expect(screen.getByTestId('settings-notify-forum')).toBeInTheDocument();
        expect(screen.getByText('Replies in topics you follow, mentions, and first topics')).toBeInTheDocument();
        const toggle = screen.getByLabelText(SWITCH);
        expect(toggle).toHaveAttribute('aria-checked', 'true');
        fireEvent.click(toggle);
        await waitFor(() => expect(api.updateNotificationPreferences).toHaveBeenCalledWith('me-pk', expect.objectContaining({ notify_forum: false, notify_chat: true })));
        expect(screen.getByLabelText(SWITCH)).toHaveAttribute('aria-checked', 'false');
    });

    it('a member who turned it off reads it off', async () => {
        await openNotifications(true, { notify_forum: 'false' });
        await waitFor(() => expect(screen.getByLabelText(SWITCH)).toHaveAttribute('aria-checked', 'false'));
    });

    it('where the community says nothing of it (no forum, or a server from before F5): no switch, and another switch saves without the key', async () => {
        await openNotifications(false);
        expect(screen.queryByTestId('settings-notify-forum')).toBeNull();
        fireEvent.click(screen.getByLabelText('Direct messages notifications'));
        await waitFor(() => expect(api.updateNotificationPreferences).toHaveBeenCalled());
        expect(vi.mocked(api.updateNotificationPreferences).mock.calls[0][1]).not.toHaveProperty('notify_forum');
    });
});

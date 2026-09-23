import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SettingsPage } from './SettingsPage';
import * as api from '../lib/api';

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

const identity: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me' };

/** Settings → Notification Preferences, with the preferences the node holds today. */
async function openNotifications(prefs: Record<string, unknown> = {}) {
    vi.mocked(api.getNotificationPreferences).mockResolvedValue(prefs as any);
    render(<SettingsPage identity={identity} themePreference="system" onThemePreferenceChange={() => {}} />);
    fireEvent.click(screen.getByText('Notification Preferences'));
    await screen.findByText('Event reminders');
}

beforeEach(() => {
    vi.mocked(api.updateNotificationPreferences).mockReset().mockResolvedValue({ success: true } as any);
    vi.mocked(api.getNotificationPreferences).mockReset().mockResolvedValue({} as any);
});

describe('Settings → Notifications → Event reminders (decision 2)', () => {
    it('offers exactly the five the node accepts, plus Off', async () => {
        await openNotifications();
        for (const label of ['1 week before', '1 day before', '2 hours before', '1 hour before', '30 minutes before', 'Off']) {
            expect(screen.getByLabelText(label)).toBeInTheDocument();
        }
    });

    it('starts on the day before for a member who has never chosen', async () => {
        await openNotifications();
        expect(screen.getByLabelText('1 day before')).toBeChecked();
        expect(screen.getByLabelText('Off')).not.toBeChecked();
        expect(screen.getByLabelText('2 hours before')).not.toBeChecked();
    });

    it('reads back what the member chose before, however the node stored it', async () => {
        await openNotifications({ eventReminderOffsets: '[10080,120]' });
        expect(screen.getByLabelText('1 week before')).toBeChecked();
        expect(screen.getByLabelText('2 hours before')).toBeChecked();
        expect(screen.getByLabelText('1 day before')).not.toBeChecked();
    });

    it('writes the offsets, largest first, as soon as a tick changes', async () => {
        await openNotifications();
        fireEvent.click(screen.getByLabelText('2 hours before'));
        await waitFor(() => expect(api.updateNotificationPreferences).toHaveBeenCalledWith('me-pk', { eventReminderOffsets: [1440, 120] }));

        fireEvent.click(screen.getByLabelText('1 day before'));
        await waitFor(() => expect(api.updateNotificationPreferences).toHaveBeenLastCalledWith('me-pk', { eventReminderOffsets: [120] }));
    });

    it('Off writes an empty list, and unticks everything else', async () => {
        await openNotifications({ eventReminderOffsets: [1440, 30] });
        fireEvent.click(screen.getByLabelText('Off'));
        await waitFor(() => expect(api.updateNotificationPreferences).toHaveBeenCalledWith('me-pk', { eventReminderOffsets: [] }));
        expect(screen.getByLabelText('Off')).toBeChecked();
        expect(screen.getByLabelText('1 day before')).not.toBeChecked();
        expect(screen.getByLabelText('30 minutes before')).not.toBeChecked();
    });

    it('ticking a time again comes back off Off', async () => {
        await openNotifications({ eventReminderOffsets: [] });
        expect(screen.getByLabelText('Off')).toBeChecked();
        fireEvent.click(screen.getByLabelText('1 hour before'));
        await waitFor(() => expect(api.updateNotificationPreferences).toHaveBeenCalledWith('me-pk', { eventReminderOffsets: [60] }));
        expect(screen.getByLabelText('Off')).not.toBeChecked();
    });

    it('leaves the other notification switches alone when a reminder is saved', async () => {
        await openNotifications();
        fireEvent.click(screen.getByLabelText('1 week before'));
        await waitFor(() => expect(api.updateNotificationPreferences).toHaveBeenCalled());
        expect(Object.keys(vi.mocked(api.updateNotificationPreferences).mock.calls[0][1])).toEqual(['eventReminderOffsets']);
    });
});

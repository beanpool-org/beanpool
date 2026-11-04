/**
 * Settings shows the web's copy on request (Profile S4, components/CopyPhotoHere.tsx) beside "Re-run Setup", and only while this
 * browser keeps a photo from another community that can be copied into this one. Showing it sends nothing.
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SettingsPage } from './SettingsPage';
import * as api from '../lib/api';
import { rememberLastPhoto } from '../lib/last-photo';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return {
        ...actual,
        getNotificationPreferences: vi.fn(async () => ({})),
        getMemberPreferences: vi.fn(async () => ({})),
        updateNotificationPreferences: vi.fn(async () => ({ success: true })),
        getMemberProfile: vi.fn(async () => ({})),
        updateMemberProfile: vi.fn(async () => ({ success: true, profile: {} })),
        getNodeStats: vi.fn(async () => null),
        getCommunityHealth: vi.fn(async () => ({})),
    };
});

const HERE = 'https://second.example.test';
const FIRST = 'https://first.example.test';
const LAST_PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
const identity: any = { publicKey: 'a1'.repeat(32), privateKey: 'priv', callsign: 'Me' };
const open = () => render(<SettingsPage identity={identity} onIdentityUpdated={() => {}} onBack={() => {}} themePreference="system" onThemePreferenceChange={() => {}} onReRunSetup={() => {}} />);

beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('bp_node_url', HERE);
    vi.mocked(api.updateMemberProfile).mockClear();
});

describe('Settings → the web\'s copy on request', () => {
    it('shows beside Re-run Setup while a photo from another community is kept, and sends nothing by showing it', async () => {
        rememberLastPhoto(LAST_PHOTO, FIRST);
        open();
        expect(await screen.findByText('Re-run Setup')).toBeInTheDocument();
        expect(screen.getByTestId('copy-photo-here')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Use this photo here' })).toBeInTheDocument();
        expect(api.updateMemberProfile).not.toHaveBeenCalled();
    });

    it('shows nothing when no photo from another community is kept', async () => {
        open();
        expect(await screen.findByText('Re-run Setup')).toBeInTheDocument();
        expect(screen.queryByTestId('copy-photo-here')).toBeNull();
    });

    it('shows nothing when the kept photo was set in this very community', async () => {
        rememberLastPhoto(LAST_PHOTO, HERE);
        open();
        expect(await screen.findByText('Re-run Setup')).toBeInTheDocument();
        expect(screen.queryByTestId('copy-photo-here')).toBeNull();
    });
});

/**
 * Settings → Advanced → the web app's own node address (Marty, board card signin-two-names, 15 Oct: "Keep refusing, hide
 * the setting"). The account-move QR (#1983) refuses a second address, so a member must never end up on an address their
 * phone doesn't know: the editor shows only in a development build. A browser that already has an address stored still
 * says which one it uses and can reset it (never strand someone who set it before).
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SettingsPage } from './SettingsPage';

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
const openAdvanced = () => render(<SettingsPage identity={identity} onIdentityUpdated={() => {}} onBack={() => {}} themePreference="system" onThemePreferenceChange={() => {}} initialMode="advanced" />);
const editor = () => screen.queryByPlaceholderText(/Node API URL/);
const resetButton = () => screen.queryByRole('button', { name: 'Reset to this page’s community' });

beforeEach(() => localStorage.removeItem('bp_node_url'));
afterEach(() => {
    vi.unstubAllEnvs();
    localStorage.removeItem('bp_node_url');
    vi.restoreAllMocks();
});

describe('Settings → Advanced → the node address', () => {
    it('a member with no stored address sees no node address setting in a production build', async () => {
        vi.stubEnv('DEV', false);
        openAdvanced();
        expect(await screen.findByText('🔑 Raw Private Key')).toBeInTheDocument();
        expect(editor()).toBeNull();
        expect(screen.queryByText(/Sovereign Node Connection/)).toBeNull();
        expect(screen.queryByText('Community address')).toBeNull();
        expect(resetButton()).toBeNull();
    });

    it('a stored address is said, with a Reset that clears it, and no editor, in a production build', async () => {
        vi.stubEnv('DEV', false);
        localStorage.setItem('bp_node_url', 'https://elsewhere.example');
        openAdvanced();
        expect(await screen.findByText('Community address')).toBeInTheDocument();
        expect(screen.getByText('This browser is set to use the community at https://elsewhere.example.')).toBeInTheDocument();
        expect(editor()).toBeNull();
        fireEvent.click(resetButton()!);
        expect(localStorage.getItem('bp_node_url')).toBeNull();
    });

    it('a development build shows the editor', async () => {
        vi.stubEnv('DEV', true);
        openAdvanced();
        expect(await screen.findByText(/Sovereign Node Connection/)).toBeInTheDocument();
        expect(editor()).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Save & Connect/ })).toBeInTheDocument();
        expect(resetButton()).toBeNull();
    });

    it('a development build with a stored address shows the editor and the Reset', async () => {
        vi.stubEnv('DEV', true);
        localStorage.setItem('bp_node_url', 'https://elsewhere.example');
        openAdvanced();
        expect(await screen.findByText(/Sovereign Node Connection/)).toBeInTheDocument();
        expect(editor()).toHaveValue('https://elsewhere.example');
        expect(resetButton()).toBeInTheDocument();
    });
});

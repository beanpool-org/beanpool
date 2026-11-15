/**
 * Settings → Account & Identity on the web: Refresh (recovery without a typed name, slice S4). The node's own status says
 * which sign-ins' copies it can't find from the sign-in alone yet (api.ts getSignInsToRefresh, by core's signInsToRefresh,
 * the phone's rule too); each gets one Refresh under the sign-in line, which runs the ordinary Connect (lib/link-signin.ts
 * "Refresh", tested there), and a failed one is said in words, before the trip beside the button and after it in the
 * result line. The server's half, with every kind of copy through the real route, is apps/server/src/test-recovery-findable.ts.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIGN_IN_REFRESH_WORDS, signInsToRefresh } from '@beanpool/core';
import { SettingsPage } from './SettingsPage';
import * as api from '../lib/api';
import { SignInRecoveryLine } from '../components/SignInRecoveryLine';
import { generateIdentity, type BeanPoolIdentity } from '../lib/identity';
import { loadPendingLink } from '../lib/link-signin';
import { resetCommunityInfoOnce } from '../lib/visitor-lobby-gate';

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
        getSignInsToRefresh: vi.fn(async () => []),
        getCommunityInfo: vi.fn(async () => { throw new Error('not asked'); }),
    };
});

const WORDS = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'];
const identity: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me', mnemonic: WORDS };
const LINE = "This sign-in's copy was made before your community's server could find your account from a sign-in alone. Refresh it once, so it keeps bringing your account back.";

function renderSettings(linkResult: any = null, who: any = identity) {
    render(<SettingsPage identity={who} onIdentityUpdated={() => {}} onBack={() => {}} themePreference="system" onThemePreferenceChange={() => {}} linkResult={linkResult} />);
}

beforeEach(() => {
    localStorage.clear();
    resetCommunityInfoOnce();
});
afterEach(() => {
    vi.mocked(api.getSignInRecovery).mockReset();
    vi.mocked(api.getSignInsToRefresh).mockReset();
    vi.mocked(api.getSignInsToRefresh).mockImplementation(async () => []);
    vi.unstubAllGlobals();
    cleanup();
});

describe('Settings: Refresh, closed over every kind of copy', () => {
    // The status each kind of copy gets from a server with S4 (test-recovery-findable.ts proves these answers), and one from
    // a server without it, through the same rule the page's reader uses.
    it.each([
        ['made before S0', { enrolledSso: ['google'], findableSso: [] }, true],
        ['made after S0', { enrolledSso: ['google'], findableSso: ['google'] }, false],
        ['healed by the scan', { enrolledSso: ['google'], findableSso: ['google'] }, false],
        ['refreshed', { enrolledSso: ['google'], findableSso: ['google'] }, false],
        ['at a server from before S4 (no findableSso)', { enrolledSso: ['google'] }, false],
    ])('a copy %s: Refresh %s', async (_kind, status, shown) => {
        vi.mocked(api.getSignInRecovery).mockResolvedValue(status.enrolledSso);
        vi.mocked(api.getSignInsToRefresh).mockResolvedValue(signInsToRefresh(status));
        renderSettings();
        await screen.findByTestId('signin-recovery');
        await waitFor(() => expect(api.getSignInsToRefresh).toHaveBeenCalledTimes(1));
        if (shown) expect(await screen.findAllByTestId('refresh-sign-in-google-start')).toHaveLength(1);
        else expect(screen.queryByTestId('refresh-sign-in-google-start')).toBeNull();
        expect(screen.queryAllByText(LINE)).toHaveLength(shown ? 1 : 0);
    });
});

describe('Settings: the Refresh row', () => {
    it('is shown once, under the sign-in line, in the words both apps share', async () => {
        expect(SIGN_IN_REFRESH_WORDS.line).toBe(LINE);
        vi.mocked(api.getSignInRecovery).mockResolvedValue(['google', 'facebook']);
        vi.mocked(api.getSignInsToRefresh).mockResolvedValue(['google']);
        renderSettings();
        const button = await screen.findByTestId('refresh-sign-in-google-start');
        expect(screen.getAllByRole('button', { name: 'Refresh your Google copy' })).toHaveLength(1);
        expect(button).toHaveTextContent('Refresh');
        expect(screen.getByTestId('signin-recovery')).toContainElement(button);
        expect(screen.queryByTestId('refresh-sign-in-facebook-start')).toBeNull();
    });

    it('is not asked for when the node names no sign-in', async () => {
        vi.mocked(api.getSignInRecovery).mockResolvedValue([]);
        renderSettings();
        await screen.findByTestId('signin-recovery');
        expect(api.getSignInsToRefresh).not.toHaveBeenCalled();
        expect(screen.queryByText(LINE)).toBeNull();
    });

    it("a nonce the community refuses is said beside the button, and nothing leaves the page", async () => {
        vi.mocked(api.getSignInRecovery).mockResolvedValue(['google']);
        vi.mocked(api.getSignInsToRefresh).mockResolvedValue(['google']);
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/api/recovery/sso-nonce')
            ? new Response(JSON.stringify({ error: "This community keeps no copies of members' accounts.", code: 'no_copies_here' }), { status: 409, headers: { 'Content-Type': 'application/json' } })
            : new Response('{}', { status: 404 })));
        // A key that signs: the request goes out, and the community's answer comes back.
        renderSettings(null, await generateIdentity('Bea'));
        fireEvent.click(await screen.findByTestId('refresh-sign-in-google-start'));
        expect(await screen.findByTestId('refresh-sign-in-problem')).toHaveTextContent("This community keeps no copies of members' accounts.");
        expect(loadPendingLink()).toBeNull();
    });

    it('back from a Refresh: the result line says it was refreshed, or why not', async () => {
        vi.mocked(api.getSignInRecovery).mockResolvedValue(['google']);
        renderSettings({ kind: 'refreshed', provider: 'google' });
        expect(await screen.findByTestId('link-result')).toHaveTextContent('Google is refreshed. Signing in with it brings this account back, with nothing to type.');
        cleanup();
        renderSettings({ kind: 'failed', provider: 'google', message: "Couldn't refresh Google, so nothing changed. Try again in a minute." });
        expect(await screen.findByTestId('link-result')).toHaveTextContent("Couldn't refresh Google, so nothing changed. Try again in a minute.");
    });
});

describe('the Refresh button leaves for the ordinary Connect', () => {
    let member: BeanPoolIdentity;
    beforeEach(async () => { member = await generateIdentity('Bea'); });

    it("asks the Connect's nonce and leaves for the provider, keeping that the trip is a Refresh", async () => {
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/api/recovery/sso-nonce')
            ? new Response(JSON.stringify({ nonce: 'refresh-n', expiresInSeconds: 600, providers: ['google'], clientIds: { google: 'web-client' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
            : new Response('{}', { status: 404 })));
        const navigate = vi.fn();
        render(<SignInRecoveryLine enrolled={['google']} hasWords refresh={['google']} identity={member} navigate={navigate} origin="https://riverside.example" />);
        fireEvent.click(screen.getByTestId('refresh-sign-in-google-start'));
        await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
        expect(new URL(navigate.mock.calls[0][0]).searchParams.get('nonce')).toBe('refresh-n');
        expect(loadPendingLink()).toMatchObject({ publicKey: member.publicKey, provider: 'google', nonce: 'refresh-n', purpose: 'refresh' });
    });

    it('offers nothing without the page\'s identity, for a sign-in the node does not list, or one a browser cannot use', () => {
        render(<SignInRecoveryLine enrolled={['google']} hasWords refresh={['google']} />);
        expect(screen.queryByTestId('refresh-sign-in-google-start')).toBeNull();
        cleanup();
        render(<SignInRecoveryLine enrolled={['facebook']} hasWords refresh={['google', 'github']} identity={member} />);
        expect(screen.queryByText(LINE)).toBeNull();
    });
});

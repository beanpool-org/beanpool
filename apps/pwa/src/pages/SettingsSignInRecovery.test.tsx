/**
 * Settings → Account & Identity: whether a sign-in also brings this account back (G11-c), read from the node's own
 * list. Both states, and the case where the node could not be asked, which draws nothing rather than a guess. A browser
 * restored from a copy without words has no `mnemonic`: it is never told to rely on its 12 words.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './SettingsPage';
import * as api from '../lib/api';
import { SIGN_IN_COPY_OPENERS, SIGN_IN_COPY_WORDS_ONLY } from '../components/SignInRecoveryLine';

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
    };
});

const WORDS = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'];
const identity: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me', mnemonic: WORDS };
// Restored from a copy that carried no words, or whose words did not re-derive the key (web-restore.ts
// openRestoredAccount): saved without `mnemonic`, and the node still lists the sign-in.
const noWordsIdentity: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me' };

function renderSettings(who: any = identity) {
    render(<SettingsPage identity={who} onIdentityUpdated={() => {}} onBack={() => {}} themePreference="system" onThemePreferenceChange={() => {}} />);
}

beforeEach(() => {
    localStorage.clear();
});
afterEach(() => {
    vi.mocked(api.getSignInRecovery).mockReset();
});

describe('Settings: sign-in recovery', () => {
    it('connected: says which sign-in, and the words banner no longer says they are the only way', async () => {
        vi.mocked(api.getSignInRecovery).mockResolvedValue(['google']);
        renderSettings();
        const line = await screen.findByTestId('signin-recovery');
        expect(line).toHaveTextContent('Sign-in recovery: connected (Google)');
        expect(line).toHaveTextContent('Signing in with Google also brings this account back, as your 12 words do.');
        // Recovery seal S3 (card sso-copy-lock, D-2 = a): who can open the copy, under the connected sign-in.
        expect(SIGN_IN_COPY_OPENERS).toBe("The people who run your community's server can open the copy of your account kept for your sign-in, because their server checks your sign-in. A stolen copy of the server's database can't.");
        expect(SIGN_IN_COPY_WORDS_ONLY).toBe('If you would rather nobody but you could get in, use only your 12 words.');
        expect(screen.getByTestId('signin-recovery-openers').textContent).toBe("The people who run your community's server can open the copy of your account kept for your sign-in, because their server checks your sign-in. A stolen copy of the server's database can't. If you would rather nobody but you could get in, use only your 12 words.");
        expect(line).toContainElement(screen.getByTestId('signin-recovery-openers'));
        expect(screen.getByText(/and so does signing in with Google\./)).toBeInTheDocument();
        expect(screen.queryByText('only', { selector: 'strong' })).toBeNull();
    });

    it('connected, but this browser has no 12 words: who can open the copy, and never "use only your 12 words"', async () => {
        vi.mocked(api.getSignInRecovery).mockResolvedValue(['google']);
        renderSettings(noWordsIdentity);
        const line = await screen.findByTestId('signin-recovery');
        expect(line).toHaveTextContent('Sign-in recovery: connected (Google)');
        expect(screen.getByTestId('signin-recovery-openers').textContent).toBe(SIGN_IN_COPY_OPENERS);
        expect(line).not.toHaveTextContent(/12 words\./);
        expect(line).not.toHaveTextContent(/use only your/);
    });

    it('two sign-ins (a phone connected another): both named', async () => {
        vi.mocked(api.getSignInRecovery).mockResolvedValue(['google', 'github']);
        renderSettings();
        expect(await screen.findByTestId('signin-recovery')).toHaveTextContent('Sign-in recovery: connected (Google and GitHub)');
    });

    it('not connected: says so, and the words are the way back', async () => {
        vi.mocked(api.getSignInRecovery).mockResolvedValue([]);
        renderSettings();
        const line = await screen.findByTestId('signin-recovery');
        expect(line).toHaveTextContent('Sign-in recovery: not connected');
        expect(line).toHaveTextContent('Your 12 words are the way back to this account.');
        expect(screen.queryByTestId('signin-recovery-openers')).toBeNull();
        expect(line).not.toHaveTextContent(/can open the copy/);
        expect(screen.getByText('only', { selector: 'strong' })).toBeInTheDocument();
    });

    it('the node could not be asked: no line at all, and the banner as it was', async () => {
        vi.mocked(api.getSignInRecovery).mockResolvedValue(null);
        renderSettings();
        await screen.findByText('View Recovery Phrase');
        await vi.waitFor(() => expect(api.getSignInRecovery).toHaveBeenCalled());
        expect(screen.queryByTestId('signin-recovery')).toBeNull();
        expect(screen.getByText('only', { selector: 'strong' })).toBeInTheDocument();
    });
});

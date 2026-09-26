/**
 * Settings → Account & Identity: whether a sign-in also brings this account back (G11-c), read from the node's own
 * list. Both states, and the case where the node could not be asked, which draws nothing rather than a guess. A browser
 * restored from a copy without words has no `mnemonic`: it is never told to rely on, save or view its 12 words, and
 * each place that promised them (the sign-in line, the banner, View Recovery Phrase, signing out) says what is true.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './SettingsPage';
import * as api from '../lib/api';
import { NO_WORDS_HERE, SIGN_IN_COPY_OPENERS, SIGN_IN_COPY_WORDS_ONLY, waysBackWithoutWords } from '../components/SignInRecoveryLine';

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
        // What is true: the sign-in brings it back, the words aren't here, and written down they still work.
        expect(screen.getByTestId('signin-recovery-way-back').textContent).toBe(
            "Signing in with Google brings this account back. Your 12 words aren't saved in this browser. If you have them written down, they do too.");
        expect(line).not.toHaveTextContent(/as your 12 words do/);
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

    it('with the words: the banner, View Recovery Phrase and signing out say what they always said', async () => {
        vi.mocked(api.getSignInRecovery).mockResolvedValue(['google']);
        renderSettings();
        await screen.findByTestId('signin-recovery');
        expect(screen.getByText(/You haven't saved your recovery phrase yet/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /View & Save Recovery Phrase/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /View Recovery Phrase.*View your 12-word backup seed/ })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /Account Deletion & Sign Out/ }));
        expect(screen.getByTestId('sign-out-device-way-back').textContent).toBe('Signs out and clears local browser storage. Your account and listings remain safely stored on the community node and can be restored anytime with your 12-word recovery phrase.');
        fireEvent.click(screen.getByRole('button', { name: 'Sign Out (Device Only)' }));
        expect(screen.getByTestId('sign-out-device-confirm').textContent).toBe('Are you sure you want to remove your account from this device? Ensure you have written down your 12-word recovery phrase if you plan to sign in again later.');
    });

    it('with the words, the words screen shows them and says to write them down', async () => {
        vi.mocked(api.getSignInRecovery).mockResolvedValue(['google']);
        renderSettings();
        await screen.findByTestId('signin-recovery');
        fireEvent.click(screen.getByRole('button', { name: /View Recovery Phrase.*View your 12-word backup seed/ }));
        expect(await screen.findByText('abandon')).toBeInTheDocument();
        expect(screen.getByText(/Write these words on paper/)).toBeInTheDocument();
        expect(screen.queryByTestId('seed-not-here')).toBeNull();
    });

    describe('a browser without its 12 words', () => {
        it('connected: no "save your recovery phrase" banner, and View Recovery Phrase says they are not here', async () => {
            vi.mocked(api.getSignInRecovery).mockResolvedValue(['google']);
            renderSettings(noWordsIdentity);
            await screen.findByTestId('signin-recovery');
            expect(screen.queryByText(/You haven't saved your recovery phrase yet/)).toBeNull();
            expect(screen.queryByRole('button', { name: /View & Save Recovery Phrase/ })).toBeNull();
            expect(screen.queryByText(/View your 12-word backup seed/)).toBeNull();
            expect(screen.getByRole('button', { name: /View Recovery Phrase.*Not saved in this browser/ })).toBeInTheDocument();
        });

        it('not connected: the line says the words are not here, and what is left', async () => {
            vi.mocked(api.getSignInRecovery).mockResolvedValue([]);
            renderSettings(noWordsIdentity);
            const line = await screen.findByTestId('signin-recovery');
            expect(line).toHaveTextContent('Sign-in recovery: not connected');
            expect(screen.getByTestId('signin-recovery-way-back').textContent).toBe(
                "Your 12 words aren't saved in this browser. If you have them written down, they bring your account back. If you don't, only a phone that has this account can.");
            expect(line).not.toHaveTextContent(/are the way back to this account/);
            expect(screen.queryByText(/You haven't saved your recovery phrase yet/)).toBeNull();
            expect(screen.queryByText('only', { selector: 'strong' })).toBeNull();
        });

        it('the node could not be asked: no line, no banner, and View Recovery Phrase still says they are not here', async () => {
            vi.mocked(api.getSignInRecovery).mockResolvedValue(null);
            renderSettings(noWordsIdentity);
            await screen.findByText('View Recovery Phrase');
            await vi.waitFor(() => expect(api.getSignInRecovery).toHaveBeenCalled());
            expect(screen.queryByTestId('signin-recovery')).toBeNull();
            expect(screen.queryByText(/You haven't saved your recovery phrase yet/)).toBeNull();
            expect(screen.getByRole('button', { name: /View Recovery Phrase.*Not saved in this browser/ })).toBeInTheDocument();
        });

        it.each([
            ['connected', ['google'], "If you have them written down, they bring your account back. If you don't, signing in with Google does."],
            ['not connected', [], "If you have them written down, they bring your account back. If you don't, only a phone that has this account can."],
            ['not known', null, 'If you have them written down, they bring your account back, and so does any sign-in connected to it.'],
        ] as const)('%s: the words screen says they can\'t be shown and what brings the account back, and asks to write down nothing', async (_, enrolled, wayBack) => {
            vi.mocked(api.getSignInRecovery).mockResolvedValue(enrolled as string[] | null);
            renderSettings(noWordsIdentity);
            await vi.waitFor(() => expect(api.getSignInRecovery).toHaveBeenCalled());
            // The node's answer lands before the screen is opened.
            await new Promise(r => setTimeout(r, 0));
            fireEvent.click(screen.getByRole('button', { name: /View Recovery Phrase/ }));
            const box = await screen.findByTestId('seed-not-here');
            expect(waysBackWithoutWords(enrolled as string[] | null)).toBe(wayBack);
            expect(box).toHaveTextContent("Your 12 words aren't saved in this browser, so they can't be shown here.");
            expect(box).toHaveTextContent(wayBack);
            expect(screen.queryByText(/generated without seed phrase storage/)).toBeNull();
            expect(screen.queryByText(/Write these words on paper/)).toBeNull();
            expect(screen.queryByRole('button', { name: /Copy All Words/ })).toBeNull();
        });

        it('signing out of this device says the words are not here, and what brings the account back', async () => {
            vi.mocked(api.getSignInRecovery).mockResolvedValue(['google']);
            renderSettings(noWordsIdentity);
            await screen.findByTestId('signin-recovery');
            fireEvent.click(screen.getByRole('button', { name: /Account Deletion & Sign Out/ }));
            const option = screen.getByTestId('sign-out-device-way-back');
            expect(option.textContent).toBe(`Signs out and clears local browser storage. Your account and listings remain safely stored on the community node. ${NO_WORDS_HERE} If you have them written down, they bring your account back. If you don't, signing in with Google does.`);
            expect(option).not.toHaveTextContent(/restored anytime with your 12-word/);
            fireEvent.click(within(option.parentElement!).getByRole('button', { name: 'Sign Out (Device Only)' }));
            const confirm = screen.getByTestId('sign-out-device-confirm');
            expect(confirm.textContent).toBe(`Are you sure you want to remove your account from this device? ${NO_WORDS_HERE} If you have them written down, they bring your account back. If you don't, signing in with Google does.`);
            expect(confirm).not.toHaveTextContent(/Ensure you have written down/);
        });
    });
});

/**
 * Settings → "Where your account can be brought back from", the web app's rows (vault rethink VR1, design §5.1;
 * components/WaysBackSection.tsx): the 12 words in this browser, this community's server's copies from its own list with
 * Remove (the signed delete the phone sends), and the honest line that BeanPool's key vault is managed in the phone app.
 * Removing the server's last copy asks about the 12 words first; "removed" is said only on the server's own answer.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './SettingsPage';
import * as api from '../lib/api';
import { WAYS_BACK_WEB } from '../components/WaysBackSection';
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
        removeSignInCopy: vi.fn(async () => true),
        getCommunityInfo: vi.fn(async () => { throw new Error('not asked'); }),
    };
});

const WORDS = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'];
const identity: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me', mnemonic: WORDS };
const noWordsIdentity: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me' };

function renderSettings(who: any = identity) {
    render(<SettingsPage identity={who} onIdentityUpdated={() => {}} onBack={() => {}} themePreference="system" onThemePreferenceChange={() => {}} />);
}

async function openSection() {
    fireEvent.click(await screen.findByRole('button', { name: /Where your account can be brought back from/ }));
    return screen.getByTestId('ways-back');
}

beforeEach(() => {
    localStorage.clear();
    resetCommunityInfoOnce();
});
afterEach(() => {
    cleanup();
    vi.mocked(api.getSignInRecovery).mockReset();
    vi.mocked(api.getSignInRecovery).mockImplementation(async () => null);
    vi.mocked(api.removeSignInCopy).mockReset();
    vi.mocked(api.removeSignInCopy).mockImplementation(async () => true);
});

describe("Settings: where your account can be brought back from (the web app's rows)", () => {
    it("lists this server's copies with Remove, the 12 words here, and says the key vault is managed in the phone app", async () => {
        vi.mocked(api.getSignInRecovery).mockResolvedValue(['google', 'apple']);
        renderSettings();
        await screen.findByTestId('signin-recovery');
        const section = await openSection();
        expect(section).toHaveTextContent('Every place a copy of your account is kept, as far as this browser can ask.');
        expect(section).toHaveTextContent('Your 12 words');
        expect(section).toHaveTextContent('In this browser.');
        const server = within(section).getByTestId('ways-back-server');
        expect(server).toHaveTextContent("This community's server");
        expect(within(server).getByRole('button', { name: "Remove the Google copy at this community's server" })).toBeInTheDocument();
        expect(within(server).getByRole('button', { name: "Remove the Apple copy at this community's server" })).toBeInTheDocument();
        // The web app never asks the vault: it says where those copies are managed, and lists nothing there.
        expect(WAYS_BACK_WEB.vaultInApp).toBe("Copies in BeanPool's key vault are managed in the phone app.");
        expect(within(section).getByTestId('ways-back-vault').textContent).toBe(WAYS_BACK_WEB.vaultInApp);
        expect(section).not.toHaveTextContent(/Iceland|since/);
    });

    it('one of two copies: an ordinary confirm, the signed delete, then "Removed" and the list read again', async () => {
        vi.mocked(api.getSignInRecovery).mockResolvedValueOnce(['google', 'apple']).mockResolvedValue(['apple']);
        renderSettings();
        const section = await openSection();
        await within(section).findByRole('button', { name: "Remove the Google copy at this community's server" });
        fireEvent.click(within(section).getByRole('button', { name: "Remove the Google copy at this community's server" }));
        const box = within(section).getByTestId('ways-back-confirm');
        expect(box).toHaveTextContent('Remove your Google copy?');
        expect(box).toHaveTextContent("This community's server deletes it. Copies already in that server's backups stay there.");
        expect(within(box).queryByTestId('ways-back-words-first')).toBeNull();
        fireEvent.click(within(box).getByRole('button', { name: 'Remove' }));
        await waitFor(() => expect(within(section).getByTestId('ways-back-result')).toHaveTextContent("Removed from this community's server."));
        expect(api.removeSignInCopy).toHaveBeenCalledWith('google');
        await waitFor(() => expect(within(section).queryByRole('button', { name: "Remove the Google copy at this community's server" })).toBeNull());
        expect(api.getSignInRecovery).toHaveBeenCalledTimes(2);
    });

    it('the last copy, with the words in this browser: the 12 words first, and Show my 12 words opens them', async () => {
        vi.mocked(api.getSignInRecovery).mockResolvedValue(['google']);
        renderSettings();
        const section = await openSection();
        fireEvent.click(await within(section).findByRole('button', { name: "Remove the Google copy at this community's server" }));
        const box = within(section).getByTestId('ways-back-confirm');
        expect(within(box).getByTestId('ways-back-words-first').textContent)
            .toBe('After this, nothing this browser can see brings your account back but your 12 words. Show them first, and write them down.');
        expect(within(box).getByRole('button', { name: 'Remove anyway' })).toBeInTheDocument();
        fireEvent.click(within(box).getByRole('button', { name: 'Show my 12 words' }));
        expect(await screen.findByText('🔑 Recovery Phrase')).toBeInTheDocument();
        expect(api.removeSignInCopy).not.toHaveBeenCalled();
    });

    it('the last copy, with no words in this browser: what is then left, plainly; Keep it removes nothing', async () => {
        vi.mocked(api.getSignInRecovery).mockResolvedValue(['google']);
        renderSettings(noWordsIdentity);
        const section = await openSection();
        expect(section).toHaveTextContent('Not saved in this browser.');
        fireEvent.click(await within(section).findByRole('button', { name: "Remove the Google copy at this community's server" }));
        const box = within(section).getByTestId('ways-back-confirm');
        expect(within(box).getByTestId('ways-back-words-first')).toHaveTextContent(/This browser has no 12 words\. Unless you have them written down, or a phone with this account/);
        expect(within(box).queryByRole('button', { name: 'Show my 12 words' })).toBeNull();
        fireEvent.click(within(box).getByRole('button', { name: 'Keep it' }));
        expect(within(section).queryByTestId('ways-back-confirm')).toBeNull();
        expect(api.removeSignInCopy).not.toHaveBeenCalled();
    });

    it('a delete the server does not confirm is "Not removed", never "Removed"', async () => {
        vi.mocked(api.getSignInRecovery).mockResolvedValue(['google', 'facebook']);
        vi.mocked(api.removeSignInCopy).mockResolvedValue(false);
        renderSettings();
        const section = await openSection();
        fireEvent.click(await within(section).findByRole('button', { name: "Remove the Facebook copy at this community's server" }));
        fireEvent.click(within(within(section).getByTestId('ways-back-confirm')).getByRole('button', { name: 'Remove' }));
        await waitFor(() => expect(within(section).getByTestId('ways-back-result'))
            .toHaveTextContent("Not removed: this community's server didn't answer. Try again."));
        expect(section).not.toHaveTextContent("Removed from this community's server.");
    });

    it("a server that couldn't be asked: said so, nothing listed as kept or gone, no Remove", async () => {
        vi.mocked(api.getSignInRecovery).mockResolvedValue(null);
        renderSettings();
        const section = await openSection();
        await waitFor(() => expect(within(section).getByTestId('ways-back-server')).toHaveTextContent("Didn't answer, so what it keeps can't be listed here."));
        expect(within(section).queryByRole('button', { name: /^Remove/ })).toBeNull();
        expect(section).not.toHaveTextContent('Keeps no copy of your account.');
    });

    it('a server that keeps none: "Keeps no copy of your account."', async () => {
        vi.mocked(api.getSignInRecovery).mockResolvedValue([]);
        renderSettings();
        const section = await openSection();
        await waitFor(() => expect(within(section).getByTestId('ways-back-server')).toHaveTextContent('Keeps no copy of your account.'));
    });
});

/**
 * The web app's Copy of the 12 words (Settings → View Recovery Phrase, lib/words-clipboard.ts): cleared from the
 * clipboard a minute later, only when the page can tell it still holds exactly the words. Best effort: nothing throws,
 * nothing is shown, and something the member copied since is never wiped.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', async () => {
    const actual = await vi.importActual('./api');
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

import { SettingsPage } from '../pages/SettingsPage';
import type { BeanPoolIdentity } from './identity';

const WORDS = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'];
const TEXT = WORDS.join(' ');

const browser = {
    clip: '',
    focused: true,
    readPermission: 'prompt' as PermissionState | 'unsupported',
};
const writeText = vi.fn(async (text: string) => { browser.clip = text; });
const readText = vi.fn(async () => browser.clip);

async function helper() {
    vi.resetModules();
    return import('./words-clipboard');
}

beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    browser.clip = '';
    browser.focused = true;
    browser.readPermission = 'prompt';
    writeText.mockReset().mockImplementation(async (text: string) => { browser.clip = text; });
    readText.mockReset().mockImplementation(async () => browser.clip);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText, readText } });
    Object.defineProperty(navigator, 'permissions', {
        configurable: true,
        value: {
            query: vi.fn(async () => {
                if (browser.readPermission === 'unsupported') throw new TypeError("'clipboard-read' is not a valid permission name");
                return { state: browser.readPermission };
            }),
        },
    });
    vi.spyOn(document, 'hasFocus').mockImplementation(() => browser.focused);
    localStorage.clear();
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('the minute', () => {
    it('staying on the words screen, the page focused, nothing else copied: cleared after a minute', async () => {
        const { copyWordsForAMinute } = await helper();
        expect(await copyWordsForAMinute(TEXT)).toBe(true);
        expect(browser.clip).toBe(TEXT);
        await vi.advanceTimersByTimeAsync(59_000);
        expect(browser.clip).toBe(TEXT);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(browser.clip).toBe('');
        expect(readText).not.toHaveBeenCalled();
    });

    it('the page lost focus: without leave to read, nothing is wiped (the member may have copied something elsewhere)', async () => {
        const { copyWordsForAMinute } = await helper();
        await copyWordsForAMinute(TEXT);
        window.dispatchEvent(new Event('blur'));
        browser.clip = 'something from another app';
        await vi.advanceTimersByTimeAsync(60_000);
        expect(browser.clip).toBe('something from another app');
        expect(readText).not.toHaveBeenCalled();
    });

    it('a copy or cut on the page, or leaving the words screen: nothing is wiped without a read', async () => {
        const { copyWordsForAMinute, leftTheWordsScreen } = await helper();
        await copyWordsForAMinute(TEXT);
        document.dispatchEvent(new Event('copy'));
        await vi.advanceTimersByTimeAsync(60_000);
        expect(writeText).toHaveBeenCalledTimes(1);

        await copyWordsForAMinute(TEXT);
        document.dispatchEvent(new Event('cut'));
        await vi.advanceTimersByTimeAsync(60_000);
        expect(writeText).toHaveBeenCalledTimes(2);

        await copyWordsForAMinute(TEXT);
        leftTheWordsScreen();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(writeText).toHaveBeenCalledTimes(3);
        expect(browser.clip).toBe(TEXT);
    });

    it('with leave to read already given: cleared only if the clipboard is exactly the words', async () => {
        browser.readPermission = 'granted';
        const { copyWordsForAMinute, leftTheWordsScreen } = await helper();
        await copyWordsForAMinute(TEXT);
        leftTheWordsScreen();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(browser.clip).toBe('');

        await copyWordsForAMinute(TEXT);
        browser.clip = `${TEXT} `;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(browser.clip).toBe(`${TEXT} `);
    });

    it('a page without focus when the minute ends waits for the member to come back, then only a read can clear', async () => {
        browser.readPermission = 'granted';
        const { copyWordsForAMinute } = await helper();
        await copyWordsForAMinute(TEXT);
        browser.focused = false;
        window.dispatchEvent(new Event('blur'));
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(browser.clip).toBe(TEXT);
        expect(readText).not.toHaveBeenCalled();

        browser.focused = true;
        window.dispatchEvent(new Event('focus'));
        await vi.advanceTimersByTimeAsync(0);
        expect(browser.clip).toBe('');
    });

    it('a browser that says no, or knows no such permission, never throws and shows nothing', async () => {
        browser.readPermission = 'unsupported';
        const { copyWordsForAMinute } = await helper();
        await copyWordsForAMinute(TEXT);
        writeText.mockRejectedValueOnce(new DOMException('Document is not focused.', 'NotAllowedError'));
        await vi.advanceTimersByTimeAsync(60_000);
        expect(writeText).toHaveBeenCalledTimes(2);

        writeText.mockRejectedValueOnce(new DOMException('Write permission denied.', 'NotAllowedError'));
        expect(await copyWordsForAMinute(TEXT)).toBe(false);
    });

    it('a newer copy takes over: the minute runs from it', async () => {
        const { copyWordsForAMinute } = await helper();
        await copyWordsForAMinute(TEXT);
        await vi.advanceTimersByTimeAsync(30_000);
        await copyWordsForAMinute(TEXT);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(browser.clip).toBe(TEXT);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(browser.clip).toBe('');
    });
});

describe('Settings → View Recovery Phrase', () => {
    it('Copy All Words copies them, says the copy clears, and clears it a minute later', async () => {
        const identity = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me', createdAt: '', mnemonic: WORDS } as BeanPoolIdentity;
        render(<SettingsPage identity={identity} onIdentityUpdated={() => {}} onBack={() => {}} themePreference="system" onThemePreferenceChange={() => {}} initialMode="seed" />);
        const { WEB_COPY_CLEARS_LINE } = await import('./words-clipboard');
        expect(await screen.findByTestId('seed-copy-clears')).toHaveTextContent(WEB_COPY_CLEARS_LINE);
        expect(WEB_COPY_CLEARS_LINE).toBe('The copy clears from your clipboard after a minute if you stay on this screen. Once you leave it, your browser may not let the app clear it.');

        await screen.findByText('accident');
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Copy All Words/ })); });
        expect(writeText).toHaveBeenCalledWith(TEXT);
        expect(await screen.findByText(/Copied to Clipboard/)).toBeInTheDocument();

        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(browser.clip).toBe('');
    });
});

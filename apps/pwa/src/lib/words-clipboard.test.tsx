/**
 * The web app's Copy of the 12 words (Settings → View Recovery Phrase, lib/words-clipboard.ts): cleared from the
 * clipboard a minute later, only when nothing else can have been copied since, and without ever reading the clipboard.
 * Best effort: nothing throws, nothing is shown, and something the member copied since is never wiped.
 *
 * Two kinds of browser (PR #1284 review 4124179538):
 * - Chrome and the other Chromium browsers let the page in front write at any time: cleared on the minute.
 * - Safari (every iPhone browser) and Firefox refuse a write outside a tap or key press: cleared at the first one after
 *   the minute. `browser.needsGesture` stands in for them, refusing any write not made inside a dispatched tap or key.
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
    /** Safari and Firefox: a write outside a tap or key press is refused. */
    needsGesture: false,
    /** Inside a tap or key press the browser counts as one. */
    inGesture: false,
    /** Which events this browser counts as a tap or key press. */
    counts: new Set(['pointerup', 'touchend', 'click', 'keydown']),
};
const writeText = vi.fn(async (text: string) => {
    // An async body runs up to its first await at the call: this is the moment the browser checks.
    if (browser.needsGesture && !browser.inGesture) throw new DOMException('The request is not allowed by the user agent.', 'NotAllowedError');
    browser.clip = text;
});
const readText = vi.fn(async () => browser.clip);
const permissionsQuery = vi.fn(async () => ({ state: 'granted' as PermissionState }));

async function helper() {
    vi.resetModules();
    return import('./words-clipboard');
}

/** The member's tap or key press on the page, as the browser sees it. */
function gesture(type: string, init: KeyboardEventInit = {}, target: EventTarget = document.body): void {
    browser.inGesture = browser.counts.has(type);
    try {
        target.dispatchEvent(type === 'keydown' ? new KeyboardEvent('keydown', { bubbles: true, ...init }) : new Event(type, { bubbles: true }));
    } finally {
        browser.inGesture = false;
    }
}
function tap(target: EventTarget = document.body): void {
    for (const type of ['pointerup', 'touchend', 'click']) gesture(type, {}, target);
}

/** The Copy button's tap: the copy itself is made inside it. */
async function copyByTap(copyWordsForAMinute: (words: string) => Promise<boolean>): Promise<boolean> {
    browser.inGesture = true;
    const copied = copyWordsForAMinute(TEXT);
    browser.inGesture = false;
    return copied;
}

beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    browser.clip = '';
    browser.focused = true;
    browser.needsGesture = false;
    browser.inGesture = false;
    browser.counts = new Set(['pointerup', 'touchend', 'click', 'keydown']);
    writeText.mockClear();
    readText.mockClear();
    permissionsQuery.mockClear();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText, readText } });
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query: permissionsQuery } });
    vi.spyOn(document, 'hasFocus').mockImplementation(() => browser.focused);
    localStorage.clear();
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, 'visibilityState');
});

describe('Chrome and the other Chromium browsers: cleared on the minute', () => {
    it('staying on the words screen, the page in front, nothing else copied: cleared after a minute, never read', async () => {
        const { copyWordsForAMinute } = await helper();
        expect(await copyWordsForAMinute(TEXT)).toBe(true);
        expect(browser.clip).toBe(TEXT);
        await vi.advanceTimersByTimeAsync(59_000);
        expect(browser.clip).toBe(TEXT);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(browser.clip).toBe('');
        expect(readText).not.toHaveBeenCalled();
    });

    it('the page lost focus: nothing is wiped (the member may have copied something in another app)', async () => {
        const { copyWordsForAMinute } = await helper();
        await copyWordsForAMinute(TEXT);
        window.dispatchEvent(new Event('blur'));
        browser.clip = 'something from another app';
        await vi.advanceTimersByTimeAsync(60_000);
        expect(browser.clip).toBe('something from another app');
        expect(readText).not.toHaveBeenCalled();
    });

    it('a copy or cut on the page, or leaving the words screen: nothing is wiped', async () => {
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

    it('never reads the clipboard, nor asks leave to: even a browser that would allow it has it left alone once unsure', async () => {
        const { copyWordsForAMinute, leftTheWordsScreen } = await helper();
        await copyWordsForAMinute(TEXT);
        leftTheWordsScreen();
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(browser.clip).toBe(TEXT);
        expect(readText).not.toHaveBeenCalled();
        expect(permissionsQuery).not.toHaveBeenCalled();
    });

    it('the page hidden (another tab) or not in front when the copy lands: nothing is wiped', async () => {
        const { copyWordsForAMinute } = await helper();
        await copyWordsForAMinute(TEXT);
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(60_000);
        expect(browser.clip).toBe(TEXT);
        Reflect.deleteProperty(document, 'visibilityState');

        browser.focused = false;
        await copyWordsForAMinute(TEXT);
        browser.focused = true;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(browser.clip).toBe(TEXT);
        expect(writeText).not.toHaveBeenCalledWith('');
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

    it('a browser that refuses the copy itself: false, nothing thrown, nothing shown', async () => {
        const { copyWordsForAMinute } = await helper();
        writeText.mockRejectedValueOnce(new DOMException('Write permission denied.', 'NotAllowedError'));
        expect(await copyWordsForAMinute(TEXT)).toBe(false);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(writeText).toHaveBeenCalledTimes(1);
    });
});

describe('Safari (every iPhone browser) and Firefox: cleared at the first tap or key press after the minute', () => {
    beforeEach(() => { browser.needsGesture = true; });

    it('the write on the minute is refused; a tap before the minute does nothing; the first tap after it clears', async () => {
        const { copyWordsForAMinute } = await helper();
        expect(await copyByTap(copyWordsForAMinute)).toBe(true);
        expect(browser.clip).toBe(TEXT);

        await vi.advanceTimersByTimeAsync(30_000);
        tap();
        await vi.advanceTimersByTimeAsync(0);
        expect(browser.clip).toBe(TEXT);

        await vi.advanceTimersByTimeAsync(30_000);
        expect(writeText).toHaveBeenLastCalledWith('');
        expect(browser.clip).toBe(TEXT);

        tap();
        await vi.advanceTimersByTimeAsync(0);
        expect(browser.clip).toBe('');
        expect(readText).not.toHaveBeenCalled();
    });

    it('a plain key press clears too; one with Ctrl, Cmd or Alt does not (it may be a copy starting)', async () => {
        const { copyWordsForAMinute } = await helper();
        await copyByTap(copyWordsForAMinute);
        await vi.advanceTimersByTimeAsync(60_000);
        const writes = writeText.mock.calls.length;

        gesture('keydown', { key: 'c', metaKey: true });
        gesture('keydown', { key: 'c', ctrlKey: true });
        gesture('keydown', { key: 'c', altKey: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(writeText.mock.calls.length).toBe(writes);
        expect(browser.clip).toBe(TEXT);

        gesture('keydown', { key: 'Tab' });
        await vi.advanceTimersByTimeAsync(0);
        expect(browser.clip).toBe('');
    });

    it('a copy or cut on the page after the minute: the next tap leaves the clipboard alone', async () => {
        for (const event of ['copy', 'cut']) {
            const { copyWordsForAMinute } = await helper();
            await copyByTap(copyWordsForAMinute);
            await vi.advanceTimersByTimeAsync(60_000);
            document.dispatchEvent(new Event(event));
            browser.clip = 'something the member copied on the page';
            tap();
            gesture('keydown', { key: 'Enter' });
            await vi.advanceTimersByTimeAsync(0);
            expect(browser.clip).toBe('something the member copied on the page');
        }
    });

    it('leaving the words screen, or switching app or tab, before the tap: later taps leave it alone', async () => {
        const leave: [string, () => void][] = [
            ['left the words screen', () => { /* set per run below */ }],
            ['switched app', () => window.dispatchEvent(new Event('blur'))],
            ['switched tab', () => {
                Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
                document.dispatchEvent(new Event('visibilitychange'));
                Reflect.deleteProperty(document, 'visibilityState');
            }],
        ];
        for (const [name, go] of leave) {
            const { copyWordsForAMinute, leftTheWordsScreen } = await helper();
            await copyByTap(copyWordsForAMinute);
            await vi.advanceTimersByTimeAsync(60_000);
            if (name === 'left the words screen') leftTheWordsScreen(); else go();
            browser.clip = `copied after: ${name}`;
            tap();
            await vi.advanceTimersByTimeAsync(0);
            expect(browser.clip).toBe(`copied after: ${name}`);
        }
    });

    it('an event the browser doesn\'t count as a tap is refused silently, and the next one clears', async () => {
        browser.counts = new Set(['click']);
        const { copyWordsForAMinute } = await helper();
        await copyByTap(copyWordsForAMinute);
        await vi.advanceTimersByTimeAsync(60_000);

        gesture('pointerup');
        gesture('touchend');
        await vi.advanceTimersByTimeAsync(0);
        expect(browser.clip).toBe(TEXT);

        gesture('click');
        await vi.advanceTimersByTimeAsync(0);
        expect(browser.clip).toBe('');

        const writes = writeText.mock.calls.length;
        tap();
        gesture('keydown', { key: 'a' });
        await vi.advanceTimersByTimeAsync(0);
        expect(writeText.mock.calls.length).toBe(writes);
    });

    it('nothing throws and nothing is left unhandled when every write is refused', async () => {
        browser.counts = new Set();
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        try {
            const { copyWordsForAMinute } = await helper();
            await copyByTap(copyWordsForAMinute);
            await vi.advanceTimersByTimeAsync(60_000);
            expect(() => { tap(); gesture('keydown', { key: 'a' }); }).not.toThrow();
            await vi.advanceTimersByTimeAsync(0);
            expect(browser.clip).toBe(TEXT);
            expect(unhandled).not.toHaveBeenCalled();
        } finally {
            process.off('unhandledRejection', unhandled);
        }
    });
});

describe('Settings → View Recovery Phrase', () => {
    const identity = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me', createdAt: '', mnemonic: WORDS } as BeanPoolIdentity;
    const page = () => render(<SettingsPage identity={identity} onIdentityUpdated={() => {}} onBack={() => {}} themePreference="system" onThemePreferenceChange={() => {}} initialMode="seed" />);

    it('the line next to Copy says what each kind of browser does', async () => {
        page();
        const { WEB_COPY_CLEARS_LINE } = await import('./words-clipboard');
        expect(await screen.findByTestId('seed-copy-clears')).toHaveTextContent(WEB_COPY_CLEARS_LINE);
        expect(WEB_COPY_CLEARS_LINE).toBe('If you stay on this screen, the copy clears from your clipboard after a minute. On an iPhone or iPad, in Safari or in Firefox, it clears at your first tap or key press after that minute. If you leave this screen or switch to another app or tab first, it stays: copy something else over it.');
    });

    it('Chrome: Copy All Words copies them and clears them a minute later', async () => {
        page();
        await screen.findByText('accident');
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Copy All Words/ })); });
        expect(writeText).toHaveBeenCalledWith(TEXT);
        expect(await screen.findByText(/Copied to Clipboard/)).toBeInTheDocument();

        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(browser.clip).toBe('');
    });

    it('Safari: the first tap on the screen after the minute clears them', async () => {
        browser.needsGesture = true;
        page();
        await screen.findByText('accident');
        const button = screen.getByRole('button', { name: /Copy All Words/ });
        browser.inGesture = true;
        await act(async () => { fireEvent.click(button); });
        browser.inGesture = false;
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(browser.clip).toBe(TEXT);

        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(browser.clip).toBe(TEXT);

        await act(async () => { tap(screen.getByText('accident')); await vi.advanceTimersByTimeAsync(0); });
        expect(browser.clip).toBe('');
    });

    it('Chrome: the Public Key copied after the words is still there after the minute', async () => {
        vi.spyOn(window, 'alert').mockImplementation(() => {});
        page();
        await screen.findByText('accident');
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Copy All Words/ })); });
        await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
        await act(async () => { fireEvent.click(screen.getByTitle('Copy Public Key')); });
        expect(browser.clip).toBe('me-pk');
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(browser.clip).toBe('me-pk');
    });

    it('Safari: the Public Key copied after the words survives the minute and the next tap', async () => {
        vi.spyOn(window, 'alert').mockImplementation(() => {});
        browser.needsGesture = true;
        page();
        await screen.findByText('accident');
        browser.inGesture = true;
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Copy All Words/ })); });
        await act(async () => { fireEvent.click(screen.getByTitle('Copy Public Key')); });
        browser.inGesture = false;
        expect(browser.clip).toBe('me-pk');
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        await act(async () => { tap(screen.getByText('accident')); await vi.advanceTimersByTimeAsync(0); });
        expect(browser.clip).toBe('me-pk');
    });

    it('leaving the words screen ends the clear: the words stay after the minute and a tap', async () => {
        browser.needsGesture = true;
        const view = page();
        await screen.findByText('accident');
        browser.inGesture = true;
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Copy All Words/ })); });
        browser.inGesture = false;
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(browser.clip).toBe(TEXT);
        view.unmount();
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        await act(async () => { tap(document.body); await vi.advanceTimersByTimeAsync(0); });
        expect(browser.clip).toBe(TEXT);
    });
});

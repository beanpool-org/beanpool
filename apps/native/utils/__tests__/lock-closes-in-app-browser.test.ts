/**
 * As App Lock's lock screen goes up, the iPhone's in-app browser is closed (utils/app-lock-browser.ts, app/_layout.tsx).
 *
 * Found by the deciding review of #1413, 2026-10-01 (BLOCKING): "Manage <community>" opens node Settings, signed in, in
 * an SFSafariViewController, which an iPhone presents above everything the app draws, the lock screen included. A member
 * with App Lock on who opened Manage, left, and put the phone down handed the admin console to whoever cancelled the
 * Face ID prompt. Now the lock screen closes it as it goes up; the plain cover (a short switch away) does not.
 *
 * Android: dismissBrowser is iOS-only and resolves to undefined there, so calling `.catch` on it would throw. Nothing is
 * called; the Custom Tab is outside BeanPool's reach and the guide says so.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const platform = vi.hoisted(() => ({ OS: 'ios' as string }));
const browser = vi.hoisted(() => ({ dismissBrowser: vi.fn() }));

vi.mock('react-native', () => ({ Platform: platform }));
vi.mock('expo-web-browser', () => browser);

import { closeInAppBrowserForLock } from '../app-lock-browser';

beforeEach(() => {
    browser.dismissBrowser.mockReset();
});

describe('closeInAppBrowserForLock', () => {
    it('iPhone: closes the in-app browser', async () => {
        platform.OS = 'ios';
        browser.dismissBrowser.mockResolvedValue({ type: 'dismiss' });
        closeInAppBrowserForLock();
        expect(browser.dismissBrowser).toHaveBeenCalledTimes(1);
    });

    it('iPhone with nothing open: the refusal is swallowed, nothing throws or goes unhandled', async () => {
        platform.OS = 'ios';
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        try {
            browser.dismissBrowser.mockRejectedValue(new Error('No browser is open'));
            expect(() => closeInAppBrowserForLock()).not.toThrow();
            browser.dismissBrowser.mockImplementation(() => { throw new Error('no native module'); });
            expect(() => closeInAppBrowserForLock()).not.toThrow();
            await new Promise((r) => setTimeout(r, 0));
            expect(unhandled).not.toHaveBeenCalled();
        } finally {
            process.off('unhandledRejection', unhandled);
        }
    });

    it('Android: nothing is called (dismissBrowser is iOS-only and resolves to undefined there)', () => {
        platform.OS = 'android';
        browser.dismissBrowser.mockReturnValue(undefined);
        expect(() => closeInAppBrowserForLock()).not.toThrow();
        expect(browser.dismissBrowser).not.toHaveBeenCalled();
    });
});

describe('app/_layout.tsx', () => {
    const layout = () => fs.readFileSync(path.resolve(__dirname, '../../app/_layout.tsx'), 'utf-8');

    it("closes it as the lock screen goes up, in the 'lock' effect only, never for the cover", () => {
        const s = layout();
        expect(s).toMatch(/if \(lockScreen !== 'lock'\) return;\s*closeInAppBrowserForLock\(\);/);
        // Called in that one place: nothing on the cover's path closes a page the member is still using.
        expect(s.match(/closeInAppBrowserForLock\(\)/g)).toHaveLength(1);
    });
});

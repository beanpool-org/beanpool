/**
 * Settings → Notifications' "On this device" row, by platform (DESIGN-web-notifications-fable.md §2.4, slice W3; Marty's
 * Decision 3): on a phone's browser where notifications can't reach it, the app's store link comes first and the words
 * second; an iPhone in Safari is told the Home Screen way, ending with Turn on (this row's button, not the waiting page's
 * Tell me); once on, the row says how long this browser can be told. Found by feature tests (lib/web-push.ts pushPlace).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { WebPushRow, WEB_PUSH_ROW_WORDS } from './WebPushRow';
import { TELL_ME_WORDS, type PushEnv } from '../lib/web-push';
import { APP_STORE_URL, PLAY_URL } from '../lib/peek';

vi.mock('../lib/api', () => ({ signedFetchAt: vi.fn(), sendSignedAt: vi.fn(), getNodeApiUrl: vi.fn(() => ''), getPushNoticeDetails: vi.fn() }));

const MEMBER = 'ab'.repeat(32);
const identity = { publicKey: MEMBER, privateKey: '00'.repeat(48) } as any;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const env = (over: Partial<PushEnv>): PushEnv => ({
    userAgent: CHROME, maxTouchPoints: 0, secure: true, serviceWorker: true, pushManager: true, notification: true,
    permission: 'default', standalone: false, brave: false, ...over,
});
/** The browser's own user agent too: the store link is read from it (lib/web-push.ts cannotLines). */
function browserIs(ua: string): void {
    Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
}
/** What the row shows, top to bottom, of the test ids that matter here. */
const order = () => Array.from(document.querySelectorAll('[data-testid]')).map(el => el.getAttribute('data-testid'))
    .filter(id => ['web-push-get-app', 'web-push-why', 'web-push-told'].includes(id!));

afterEach(() => {
    cleanup();
    localStorage.clear();
    browserIs(CHROME);
});

describe('"On this device" by platform (web push W3)', () => {
    it('an iPhone in Safari: Get the app (the App Store) first, then the Home Screen words ending with Turn on, and no button', () => {
        browserIs(IPHONE);
        render(createElement(WebPushRow, { identity, env: env({ userAgent: IPHONE, maxTouchPoints: 5, pushManager: false }) }));
        expect(screen.getByTestId('web-push-row').getAttribute('data-state')).toBe('cannot');
        expect(order()).toEqual(['web-push-get-app', 'web-push-why']);
        expect(screen.getByTestId('web-push-get-app').getAttribute('href')).toBe(APP_STORE_URL);
        expect(screen.getByTestId('web-push-get-app').textContent).toBe('Get the app');
        expect(screen.getByTestId('web-push-why').textContent).toBe(WEB_PUSH_ROW_WORDS.homeScreen);
        expect(WEB_PUSH_ROW_WORDS.homeScreen).toMatch(/tap Turn on again\.$/);
        expect(screen.queryByRole('button')).toBeNull();
    });

    it('an iPhone opened from the Home Screen: the ordinary Turn on, no store link', () => {
        browserIs(IPHONE);
        render(createElement(WebPushRow, { identity, env: env({ userAgent: IPHONE, maxTouchPoints: 5, standalone: true }) }));
        expect(screen.getByTestId('web-push-row').getAttribute('data-state')).toBe('off');
        expect(screen.getByRole('button', { name: 'Turn on' })).toBeTruthy();
        expect(screen.queryByTestId('web-push-get-app')).toBeNull();
    });

    it('an Android browser that blocked notifications: Get the app (Google Play) first, then how to allow them', () => {
        browserIs(ANDROID);
        render(createElement(WebPushRow, { identity, env: env({ userAgent: ANDROID, permission: 'denied' }) }));
        expect(screen.getByTestId('web-push-row').getAttribute('data-state')).toBe('blocked');
        expect(order()).toEqual(['web-push-get-app', 'web-push-why']);
        expect(screen.getByTestId('web-push-get-app').getAttribute('href')).toBe(PLAY_URL);
        expect(screen.getByTestId('web-push-why').textContent).toBe(TELL_ME_WORDS.blocked);
    });

    it('a phone browser with no push (a private window): Get the app first, then the bell line', () => {
        browserIs(ANDROID);
        render(createElement(WebPushRow, { identity, env: env({ userAgent: ANDROID, pushManager: false }) }));
        expect(order()).toEqual(['web-push-get-app', 'web-push-why']);
        expect(screen.getByTestId('web-push-why').textContent).toBe(WEB_PUSH_ROW_WORDS.cannot);
    });

    it('a computer with no push (a page over http): the bell line, and no store link', () => {
        render(createElement(WebPushRow, { identity, env: env({ secure: false }) }));
        expect(screen.getByTestId('web-push-row').getAttribute('data-state')).toBe('cannot');
        expect(order()).toEqual(['web-push-why']);
        expect(screen.getByTestId('web-push-why').textContent).toBe(WEB_PUSH_ROW_WORDS.cannot);
    });

    it('once on, it says how long this browser is told: while Chrome runs on a computer, with the browser closed on a phone', () => {
        const pinned = () => localStorage.setItem('beanpool_web_push', JSON.stringify([
            { origin: window.location.origin, publicKey: MEMBER, subId: 'e'.repeat(64), pushKey: 'ab', vapidKey: 'BAAA', for: 'member' }]));
        pinned();
        render(createElement(WebPushRow, { identity, env: env({ permission: 'granted' }) }));
        expect(screen.getByTestId('web-push-row').getAttribute('data-state')).toBe('on');
        expect(screen.getByTestId('web-push-told').textContent).toBe("We'll tell you here while Chrome is running.");
        cleanup();
        browserIs(ANDROID);
        render(createElement(WebPushRow, { identity, env: env({ userAgent: ANDROID, permission: 'granted' }) }));
        expect(screen.getByTestId('web-push-told').textContent).toBe("We'll tell you on this phone, even with the browser closed.");
        expect(screen.queryByTestId('web-push-get-app')).toBeNull();
    });
});

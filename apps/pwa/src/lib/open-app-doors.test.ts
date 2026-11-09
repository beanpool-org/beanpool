/**
 * The app's plain "open it" link from a phone's browser (openAppDoors in lib/peek.ts): `beanpool://foreground`, the app's
 * no-op link that only brings it to the front (apps/native/app/+native-intent.ts). On Android by intent, with Google Play as
 * its own fallback when the app isn't installed; on an iPhone by the scheme, with the App Store beside it (a scheme link to
 * no app opens nothing); on a computer, none.
 */
import { describe, it, expect } from 'vitest';
import { ANDROID_PACKAGE, APP_STORE_URL, PLAY_URL, openAppDoors } from './peek';

const ANDROID = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

describe('openAppDoors', () => {
    it('on Android: an intent for the app, falling back to Google Play by itself', () => {
        const doors = openAppDoors(ANDROID);
        expect(doors).toEqual({
            app: `intent://foreground#Intent;scheme=beanpool;package=${ANDROID_PACKAGE};S.browser_fallback_url=${encodeURIComponent(PLAY_URL)};end`,
            store: PLAY_URL,
        });
    });

    it('on an iPhone: the app by its scheme, and the App Store for a phone without it', () => {
        expect(openAppDoors(IPHONE)).toEqual({ app: 'beanpool://foreground', store: APP_STORE_URL });
    });

    it('on a computer, or with no user agent: none', () => {
        expect(openAppDoors(MAC)).toBeNull();
        expect(openAppDoors('')).toBeNull();
    });

    it('carries nothing but the app and a public store listing: no key, no node, no ticket', () => {
        for (const ua of [ANDROID, IPHONE]) {
            const doors = openAppDoors(ua)!;
            expect(doors.app).not.toMatch(/node=|peek=|post=|invite|code=|key/i);
            expect(doors.app).not.toContain('beanpool.org');
        }
    });
});

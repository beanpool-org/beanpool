// @vitest-environment jsdom
/**
 * ListPhoto (card-photo-retry, Marty 4 Nov 2026: "there is one card on global that is missing a photo in the list. When I
 * click on it, it shows the photo"): the picture on a small card (Home's rows, the deals list, a profile's listings, a chat's
 * listing, a shop's tiles, an event's photo) draws the photo's small copy, then the photo's own URL, then the card's
 * fallback, each step once, never an empty slot. expo-image's Image is an <img> that carries its URL, its other props and its
 * onError, so the test makes it fail as a phone does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const progress = vi.hoisted(() => ({ last: null as null | (() => void), start: null as null | (() => void) }));
vi.mock('expo-image', () => ({
    Image: ({ source, onError, onLoad, onLoadStart, onProgress, accessibilityLabel, style }: { source?: { uri?: string }; onError?: () => void; onLoad?: () => void; onLoadStart?: () => void; onProgress?: () => void; accessibilityLabel?: string; style?: unknown }) => {
        progress.last = onProgress ?? null;
        progress.start = onLoadStart ?? null;
        return createElement('img', { 'data-src': source?.uri, 'aria-label': accessibilityLabel, 'data-style': JSON.stringify(style), onError, onLoad });
    },
}));

import { ListPhoto } from '../../components/ListPhoto';
import { LIST_PHOTO_LONGEST_MS, LIST_PHOTO_QUEUED_MS, LIST_PHOTO_WAIT_MS } from '@beanpool/core';

const NODE = 'https://global.example';
const PHOTO = `${NODE}/api/marketplace/posts/p1/photos/0?v=17&k=KEY0`;
const PHOTO_2 = `${NODE}/api/marketplace/posts/p1/photos/0?v=18&k=KEY9`;
const BANNER = `${NODE}/api/shops/s1/photo?v=17&k=KEY0`;
const fallback = createElement('span', { 'data-testid': 'the-fallback' }, 'fallback');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const show = async (photo: string | null | undefined) => {
    await act(async () => { root.render(createElement(ListPhoto as any, { photo, fallback, style: { width: 48 }, accessibilityLabel: 'Loaf' }) as any); });
};
const img = () => host.querySelector<HTMLImageElement>('img[data-src]');
const drawn = () => host.querySelector('[data-testid="the-fallback"]');
const fail = async () => { expect(img()).not.toBeNull(); await act(async () => { img()!.dispatchEvent(new Event('error')); }); };

const load = async () => { expect(img()).not.toBeNull(); await act(async () => { img()!.dispatchEvent(new Event('load')); }); };

describe('ListPhoto', () => {
    it("draws the small copy, asks it once more past every cache, then the photo's own URL, then the fallback", async () => {
        await show(PHOTO);
        expect(img()?.getAttribute('data-src')).toBe(`${PHOTO}&size=thumb2`);
        await fail();
        expect(img()?.getAttribute('data-src')).toBe(`${PHOTO}&size=thumb2&retry=1`);
        await fail();
        expect(img()?.getAttribute('data-src')).toBe(PHOTO);
        await fail();
        expect(img()).toBeNull();
        expect(drawn()).not.toBeNull();
    });

    it('hands its other props to the picture, and its own style once it has drawn', async () => {
        await show(PHOTO);
        expect(img()?.getAttribute('aria-label')).toBe('Loaf');
        expect(img()?.getAttribute('data-style')).toBe('{"width":48,"position":"absolute","opacity":0}');
        await load();
        expect(img()?.getAttribute('data-style')).toBe('{"width":48}');
    });

    it('draws the fallback for no photo at all', async () => {
        for (const photo of [null, undefined, '']) {
            await show(photo);
            expect(img()).toBeNull();
            expect(drawn()).not.toBeNull();
        }
    });

    it('a picture with no small copy (a banner) goes straight to the fallback on its first failure', async () => {
        await show(BANNER);
        expect(img()?.getAttribute('data-src')).toBe(BANNER);
        await fail();
        expect(img()).toBeNull();
        expect(drawn()).not.toBeNull();
    });

    it('does not loop, and a new URL the next read brings starts again from its small copy', async () => {
        await show(PHOTO);
        await fail();
        await fail();
        await fail();
        await show(PHOTO);
        expect(img()).toBeNull();
        expect(drawn()).not.toBeNull();
        await show(PHOTO_2);
        expect(img()?.getAttribute('data-src')).toBe(`${PHOTO_2}&size=thumb2`);
    });
});

// card-photo-blank (Marty, 4 Nov 2026): on global a card showed an empty slot, no photo and no tile, through two restarts,
// while its small copy was served fine; expo-image sent neither onLoad nor onError.
describe('ListPhoto: never an empty slot while the photo loads', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('draws the fallback in the slot until the photo has drawn, then the photo alone', async () => {
        await show(PHOTO);
        expect(drawn()).not.toBeNull();
        expect(img()).not.toBeNull();
        await load();
        expect(drawn()).toBeNull();
        expect(img()?.getAttribute('data-src')).toBe(`${PHOTO}&size=thumb2`);
    });

    it('draws the fallback again while each step down loads', async () => {
        await show(PHOTO);
        await fail();
        expect(drawn()).not.toBeNull();
        await fail();
        expect(drawn()).not.toBeNull();
        await load();
        expect(drawn()).toBeNull();
        expect(img()?.getAttribute('data-src')).toBe(PHOTO);
    });

    // expo-image's onLoadStart: the Image has handed its URL to Glide (Android) or SDWebImage (iOS). onProgress: bytes.
    const start = async () => { expect(progress.start).not.toBeNull(); await act(async () => { progress.start?.(); }); };
    const bytes = async () => { expect(progress.last).not.toBeNull(); await act(async () => { progress.last?.(); }); };
    const after = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); };
    const src = () => img()?.getAttribute('data-src');

    // Review of #2853, finding 3: a request waiting in OkHttp's queue (5 at once to one host) gets no event, so a wait
    // that counted from when the card was shown cut it off with no bytes, though it would have loaded.
    it('a load with no start event is never stepped down by the wait (a new URL would wait the same way)', async () => {
        vi.useFakeTimers();
        await show(PHOTO);
        await after(LIST_PHOTO_WAIT_MS);
        expect(src()).toBe(`${PHOTO}&size=thumb2`);
        await after(LIST_PHOTO_QUEUED_MS * 3);
        expect(src()).toBe(`${PHOTO}&size=thumb2`);
        expect(drawn()).not.toBeNull();
    });

    it('a started load with no bytes yet waits LIST_PHOTO_QUEUED_MS, not LIST_PHOTO_WAIT_MS (it may be in the queue), then steps down, at each step', async () => {
        vi.useFakeTimers();
        await show(PHOTO);
        await start();
        await after(LIST_PHOTO_WAIT_MS);
        expect(src()).toBe(`${PHOTO}&size=thumb2`);
        await after(LIST_PHOTO_QUEUED_MS - LIST_PHOTO_WAIT_MS - 1);
        expect(src()).toBe(`${PHOTO}&size=thumb2`);
        await after(1);
        expect(src()).toBe(`${PHOTO}&size=thumb2&retry=1`);
        expect(drawn()).not.toBeNull();
        // Each step is a new load: nothing is waited on until it starts too.
        await after(LIST_PHOTO_QUEUED_MS * 2);
        expect(src()).toBe(`${PHOTO}&size=thumb2&retry=1`);
        await start();
        await after(LIST_PHOTO_QUEUED_MS);
        expect(src()).toBe(PHOTO);
        await start();
        await after(LIST_PHOTO_QUEUED_MS);
        expect(img()).toBeNull();
        expect(drawn()).not.toBeNull();
    });

    it('a started load whose bytes stop for LIST_PHOTO_WAIT_MS counts as failed and steps down', async () => {
        vi.useFakeTimers();
        await show(PHOTO);
        await start();
        await bytes();
        await after(LIST_PHOTO_WAIT_MS - 1);
        expect(src()).toBe(`${PHOTO}&size=thumb2`);
        await after(1);
        expect(src()).toBe(`${PHOTO}&size=thumb2&retry=1`);
        expect(drawn()).not.toBeNull();
    });

    it('bytes still arriving start the wait again, so a slow phone is not cut off', async () => {
        vi.useFakeTimers();
        await show(PHOTO);
        await start();
        await bytes();
        await after(LIST_PHOTO_WAIT_MS - 1000);
        await bytes();
        await after(LIST_PHOTO_WAIT_MS - 1000);
        expect(src()).toBe(`${PHOTO}&size=thumb2`);
        await after(1000);
        expect(src()).toBe(`${PHOTO}&size=thumb2&retry=1`);
    });

    // expo-image on Android sends onProgress on every read of the response (react-native ProgressResponseBody.kt read(),
    // passed on by expo-image's OkHttpProgressListener whenever the length is known), so a response that sends a byte
    // every few seconds would start the wait again for ever (card-photo-blank).
    const trickle = async (ms: number) => {
        for (let t = 0; t < ms; t += 5000) {
            await after(Math.min(5000, ms - t));
            await bytes();
        }
    };
    it('bytes that trickle in for ever still count as failed by LIST_PHOTO_LONGEST_MS from the first, at each step', async () => {
        vi.useFakeTimers();
        await show(PHOTO);
        await start();
        await bytes();
        await trickle(LIST_PHOTO_LONGEST_MS - 5000);
        expect(src()).toBe(`${PHOTO}&size=thumb2`);
        await after(5000);
        expect(src()).toBe(`${PHOTO}&size=thumb2&retry=1`);
        expect(drawn()).not.toBeNull();
        await start();
        await bytes();
        await trickle(LIST_PHOTO_LONGEST_MS - 5000);
        expect(src()).toBe(`${PHOTO}&size=thumb2&retry=1`);
        await after(5000);
        expect(src()).toBe(PHOTO);
        await start();
        await bytes();
        await trickle(LIST_PHOTO_LONGEST_MS - 5000);
        await after(5000);
        expect(img()).toBeNull();
        expect(drawn()).not.toBeNull();
    });

    it('the longest wait counts from the first bytes: a load that waited its turn in the queue still gets all of it', async () => {
        vi.useFakeTimers();
        await show(PHOTO);
        await start();
        await after(LIST_PHOTO_QUEUED_MS - 1000);
        await bytes();
        await trickle(LIST_PHOTO_LONGEST_MS - 5000);
        expect(src()).toBe(`${PHOTO}&size=thumb2`);
        await after(5000);
        expect(src()).toBe(`${PHOTO}&size=thumb2&retry=1`);
    });

    it('a photo that has drawn is never stepped down by the wait', async () => {
        vi.useFakeTimers();
        await show(PHOTO);
        await load();
        await act(async () => { vi.advanceTimersByTime(LIST_PHOTO_WAIT_MS * 5); });
        expect(img()?.getAttribute('data-src')).toBe(`${PHOTO}&size=thumb2`);
        expect(drawn()).toBeNull();
    });

    it('no step leaves the slot empty: until a photo has drawn, every step shows the fallback', async () => {
        await show(PHOTO);
        expect(drawn()).not.toBeNull();
        for (let i = 0; i < 4; i++) {
            if (img()) await fail();
            expect(drawn()).not.toBeNull();
        }
        expect(img()).toBeNull();
    });
});

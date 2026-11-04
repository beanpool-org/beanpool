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

vi.mock('expo-image', () => ({
    Image: ({ source, onError, accessibilityLabel, style }: { source?: { uri?: string }; onError?: () => void; accessibilityLabel?: string; style?: unknown }) =>
        createElement('img', { 'data-src': source?.uri, 'aria-label': accessibilityLabel, 'data-style': JSON.stringify(style), onError }),
}));

import { ListPhoto } from '../../components/ListPhoto';

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

describe('ListPhoto', () => {
    it('draws the small copy, then the photo\'s own URL, then the fallback', async () => {
        await show(PHOTO);
        expect(img()?.getAttribute('data-src')).toBe(`${PHOTO}&size=thumb2`);
        expect(drawn()).toBeNull();
        await fail();
        expect(img()?.getAttribute('data-src')).toBe(PHOTO);
        expect(drawn()).toBeNull();
        await fail();
        expect(img()).toBeNull();
        expect(drawn()).not.toBeNull();
    });

    it('hands its other props to the picture', async () => {
        await show(PHOTO);
        expect(img()?.getAttribute('aria-label')).toBe('Loaf');
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
        await show(PHOTO);
        expect(img()).toBeNull();
        expect(drawn()).not.toBeNull();
        await show(PHOTO_2);
        expect(img()?.getAttribute('data-src')).toBe(`${PHOTO_2}&size=thumb2`);
        expect(drawn()).toBeNull();
    });
});

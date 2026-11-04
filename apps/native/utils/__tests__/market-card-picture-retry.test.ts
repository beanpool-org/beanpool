// @vitest-environment jsdom
/**
 * A list card whose small photo will not load tries the photo's own URL, then draws the category tile, never an empty slot
 * (card-photo-retry, Marty 4 Nov 2026: "there is one card on global that is missing a photo in the list. When I click on it,
 * it shows the photo"). MarketCardPicture rendered for real: expo-image's Image is an <img> that carries its URL and its
 * onError, so the test makes it fail as a phone does. Each step happens once per card, and a listing's own photo still has
 * its listing read again (utils/photo-refresh.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => function Host({ children, testID }: Record<string, any>) {
        return createElement(tag, testID ? { 'data-testid': testID } : {}, children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => s },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('expo-image', () => ({
    Image: ({ source, onError }: { source?: { uri?: string }; onError?: () => void }) => createElement('img', { 'data-src': source?.uri, onError }),
}));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});
const healed = vi.hoisted(() => ({ calls: [] as Array<[string | null | undefined, string | null | undefined]> }));
vi.mock('../photo-refresh', () => ({
    refreshListingAfterPhotoError: (postId: string | null | undefined, url: string | null | undefined) => { healed.calls.push([postId, url]); return true; },
}));

import { MarketCardPicture } from '../../components/MarketCardPicture';

const NODE = 'https://global.example';
const COVER = `${NODE}/api/marketplace/posts/p-jam/photos/0?v=1791608803169&k=AbCdEf`;
const COVER_2 = `${NODE}/api/marketplace/posts/p-jam/photos/0?v=1791608809999&k=ZzZzZz`;
const BANNER = `${NODE}/api/shops/shop-1/photo?v=ref1&k=Yqpu8qmgAGQ`;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    healed.calls.length = 0;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const picture = (cover: string | null, pic: string | null = cover) => createElement(MarketCardPicture, {
    postId: 'p-jam', cover, picture: pic, category: 'food', kind: 'listing', size: 'thumb', imageStyle: {},
});
const show = async (cover: string | null, pic: string | null = cover) => { await act(async () => { root.render(picture(cover, pic)); }); };
const img = () => host.querySelector<HTMLImageElement>('img[data-src]');
const tile = () => host.querySelector('[data-testid="category-tile"]');
const fail = async () => { expect(img()).not.toBeNull(); await act(async () => { img()!.dispatchEvent(new Event('error')); }); };

describe("MarketCardPicture: a listing's own photo that will not load steps down", () => {
    it('draws the small copy, then the full photo once it fails, then the tile once that fails too', async () => {
        await show(COVER);
        expect(img()?.getAttribute('data-src')).toBe(`${COVER}&size=thumb2`);
        expect(tile()).toBeNull();

        await fail();
        expect(img()?.getAttribute('data-src')).toBe(COVER);
        expect(img()?.getAttribute('data-src')).not.toContain('size=thumb2');
        expect(tile()).toBeNull();

        await fail();
        expect(img()).toBeNull();
        expect(tile()).not.toBeNull();
    });

    it("still has the listing read again, from the photo's own URL, as before", async () => {
        await show(COVER);
        await fail();
        expect(healed.calls[0]).toEqual(['p-jam', COVER]);
        await fail();
        expect(healed.calls.every((c) => c[0] === 'p-jam' && c[1] === COVER)).toBe(true);
    });

    it('does not loop: the tile stays, and a card that has given up draws nothing more', async () => {
        await show(COVER);
        await fail();
        await fail();
        await show(COVER);
        expect(img()).toBeNull();
        expect(tile()).not.toBeNull();
    });

    it('tries a new URL the next read brings, from the small copy again', async () => {
        await show(COVER);
        await fail();
        await fail();
        expect(tile()).not.toBeNull();
        await show(COVER_2);
        expect(img()?.getAttribute('data-src')).toBe(`${COVER_2}&size=thumb2`);
        expect(tile()).toBeNull();
    });

    it('when the read brings a new URL after the small copy failed, that URL starts from its small copy', async () => {
        await show(COVER);
        await fail();
        expect(img()?.getAttribute('data-src')).toBe(COVER);
        await show(COVER_2);
        expect(img()?.getAttribute('data-src')).toBe(`${COVER_2}&size=thumb2`);
    });
});

describe('MarketCardPicture: a shop banner has no small copy, so it goes straight to the tile', () => {
    it('draws the banner, then the tile on its first failure, and nothing is read again', async () => {
        await show(null, BANNER);
        expect(img()?.getAttribute('data-src')).toBe(BANNER);
        await fail();
        expect(img()).toBeNull();
        expect(tile()).not.toBeNull();
        expect(healed.calls).toEqual([]);
    });
});

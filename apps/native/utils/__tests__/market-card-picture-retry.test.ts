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
const events = vi.hoisted(() => ({ start: null as null | (() => void), progress: null as null | (() => void) }));
vi.mock('expo-image', () => ({
    Image: ({ source, onError, onLoad, onLoadStart, onProgress, transition }: { source?: { uri?: string }; onError?: () => void; onLoad?: () => void; onLoadStart?: () => void; onProgress?: () => void; transition?: unknown }) => {
        events.start = onLoadStart ?? null;
        events.progress = onProgress ?? null;
        return createElement('img', { 'data-src': source?.uri, 'data-transition': JSON.stringify(transition ?? null), onError, onLoad });
    },
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
import { LIST_PHOTO_QUEUED_MS, LIST_PHOTO_WAIT_MS } from '@beanpool/core';

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
const show = async (cover: string | null, pic: string | null = cover) => { await act(async () => { root.render(picture(cover, pic) as any); }); };
const img = () => host.querySelector<HTMLImageElement>('img[data-src]');
const tile = () => host.querySelector('[data-testid="category-tile"]');
const fail = async () => { expect(img()).not.toBeNull(); await act(async () => { img()!.dispatchEvent(new Event('error')); }); };
const load = async () => { expect(img()).not.toBeNull(); await act(async () => { img()!.dispatchEvent(new Event('load')); }); };

describe("MarketCardPicture: a listing's own photo that will not load steps down", () => {
    it('draws the small copy, asks it once more past every cache, then the full photo, then the tile once that fails too', async () => {
        await show(COVER);
        expect(img()?.getAttribute('data-src')).toBe(`${COVER}&size=thumb2`);

        await fail();
        expect(img()?.getAttribute('data-src')).toBe(`${COVER}&size=thumb2&retry=1`);

        await fail();
        expect(img()?.getAttribute('data-src')).toBe(COVER);
        expect(img()?.getAttribute('data-src')).not.toContain('size=thumb2');

        await fail();
        expect(img()).toBeNull();
        expect(tile()).not.toBeNull();
    });

    it("still has the listing read again, from the photo's own URL, as before", async () => {
        await show(COVER);
        await fail();
        expect(healed.calls[0]).toEqual(['p-jam', COVER]);
        await fail();
        await fail();
        expect(healed.calls.every((c) => c[0] === 'p-jam' && c[1] === COVER)).toBe(true);
    });

    it('does not loop: the tile stays, and a card that has given up draws nothing more', async () => {
        await show(COVER);
        await fail();
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
        await fail();
        expect(tile()).not.toBeNull();
        await show(COVER_2);
        expect(img()?.getAttribute('data-src')).toBe(`${COVER_2}&size=thumb2`);
        await load();
        expect(tile()).toBeNull();
    });

    it('when the read brings a new URL after the small copy failed, that URL starts from its small copy', async () => {
        await show(COVER);
        await fail();
        await fail();
        expect(img()?.getAttribute('data-src')).toBe(COVER);
        await show(COVER_2);
        expect(img()?.getAttribute('data-src')).toBe(`${COVER_2}&size=thumb2`);
    });
});

// card-photo-blank (Marty, 4 Nov 2026): GLOBAL's "Apples needed" showed an empty ~160 px slot, no photo and no tile,
// through two restarts, while its small copy was served fine (200, 18,127 B); expo-image sent neither onLoad nor onError.
describe('MarketCardPicture: never an empty slot while the photo loads', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('draws the tile until the photo has drawn, then the photo alone', async () => {
        await show(COVER);
        expect(tile()).not.toBeNull();
        expect(img()).not.toBeNull();
        await load();
        expect(tile()).toBeNull();
        expect(img()?.getAttribute('data-src')).toBe(`${COVER}&size=thumb2`);
    });

    // expo-image's onLoadStart (the URL is handed to Glide), then bytes (onProgress) that stop.
    const startedThenStalled = async () => {
        await act(async () => { events.start?.(); });
        await act(async () => { events.progress?.(); });
        await act(async () => { vi.advanceTimersByTime(LIST_PHOTO_WAIT_MS); });
    };

    it('a photo whose bytes stop counts as failed: the small copy again past every cache, then the full photo, then the tile', async () => {
        vi.useFakeTimers();
        await show(COVER);
        await startedThenStalled();
        expect(img()?.getAttribute('data-src')).toBe(`${COVER}&size=thumb2&retry=1`);
        expect(tile()).not.toBeNull();
        expect(healed.calls[0]).toEqual(['p-jam', COVER]);
        await startedThenStalled();
        expect(img()?.getAttribute('data-src')).toBe(COVER);
        await startedThenStalled();
        expect(img()).toBeNull();
        expect(tile()).not.toBeNull();
    });

    // Review of #2853, finding 3: the Market's later cards wait in OkHttp's queue (5 at once to one node) with no event.
    it('a load that has not started is never stepped down; a started one with no bytes waits LIST_PHOTO_QUEUED_MS', async () => {
        vi.useFakeTimers();
        await show(COVER);
        await act(async () => { vi.advanceTimersByTime(LIST_PHOTO_QUEUED_MS * 2); });
        expect(img()?.getAttribute('data-src')).toBe(`${COVER}&size=thumb2`);
        expect(healed.calls).toEqual([]);
        await act(async () => { events.start?.(); });
        await act(async () => { vi.advanceTimersByTime(LIST_PHOTO_QUEUED_MS - 1); });
        expect(img()?.getAttribute('data-src')).toBe(`${COVER}&size=thumb2`);
        expect(tile()).not.toBeNull();
        await act(async () => { vi.advanceTimersByTime(1); });
        expect(img()?.getAttribute('data-src')).toBe(`${COVER}&size=thumb2&retry=1`);
        expect(healed.calls[0]).toEqual(['p-jam', COVER]);
    });

    it('a photo that has drawn is never stepped down by the wait', async () => {
        vi.useFakeTimers();
        await show(COVER);
        await load();
        await act(async () => { vi.advanceTimersByTime(LIST_PHOTO_WAIT_MS * 5); });
        expect(img()?.getAttribute('data-src')).toBe(`${COVER}&size=thumb2`);
        expect(tile()).toBeNull();
        expect(healed.calls).toEqual([]);
    });
});

// photo-white (Marty, 5 Nov 2026, 1.2.100 on a Pixel 9 Pro: "the images would appear for a moment and then go white"). Every
// card photo loads twice: hidden at the tile's 80 x 80, then again once it has drawn and stretches to the card's height. A
// card below the first screen gets both loads while Android has it detached (the FlatList's removeClippedSubviews), and
// expo-image's cross-fade then leaves its two image views both cleared when the card scrolls in: measured on the emulator,
// every card photo below the first screen was an empty white slot with a 150 ms fade, and none with no fade. So the photo
// is never cross-faded; the tile gives way to it as soon as it has drawn.
const fades = () => {
    const t = JSON.parse(img()?.getAttribute('data-transition') ?? 'null');
    return typeof t === 'number' ? t > 0 : !!(t && typeof t === 'object' && (t as { duration?: number }).duration! > 0);
};

describe('MarketCardPicture: the photo never cross-fades, so a card that scrolls in keeps its photo', () => {
    it('has no fade while it loads, once it has drawn, and on every step down', async () => {
        await show(COVER);
        expect(img()).not.toBeNull();
        expect(fades()).toBe(false);
        await load();
        expect(tile()).toBeNull();
        expect(fades()).toBe(false);
        await show(COVER_2);
        await fail();
        expect(img()?.getAttribute('data-src')).toBe(`${COVER_2}&size=thumb2&retry=1`);
        expect(fades()).toBe(false);
        await fail();
        expect(img()?.getAttribute('data-src')).toBe(COVER_2);
        expect(fades()).toBe(false);
    });

    it('a shop banner has no fade either', async () => {
        await show(null, BANNER);
        expect(fades()).toBe(false);
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

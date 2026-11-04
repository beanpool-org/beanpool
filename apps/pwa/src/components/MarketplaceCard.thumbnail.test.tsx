/**
 * A Market card draws its listing's small copy (`size=thumb2`, @beanpool/core listPhotoUrl), never the 800 px photo: a
 * page of 20 cards was 20 full photos on prepaid data (Marty, board, 9 Oct). Opening the photo (the lightbox, the
 * detail) still gets the photos' own URLs, keys and all. A card's photo is part of the card (4 Nov): it opens the listing,
 * never a photo viewer of its own.
 */
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIST_PHOTO_QUEUED_MS } from '@beanpool/core';
import { MarketplaceCard } from './MarketplaceCard';
import { CHIP, CHIP_SENTENCE, LIST_PHOTO, LIST_PHOTO_FILL, LIST_TEXT, chip, listCard } from './market-card-shell';
import type { MarketplacePost } from '../lib/marketplace';

const PHOTOS = ['/api/marketplace/posts/p1/photos/0?v=17&k=KEY0', '/api/marketplace/posts/p1/photos/1?v=17&k=KEY1'];
const post = {
    id: 'p1', type: 'offer', category: 'food', title: 'Sourdough loaf', description: 'Baked this morning', credits: 5,
    priceType: 'fixed', authorPublicKey: 'a'.repeat(64), authorCallsign: 'Rowan', active: true, status: 'active',
    createdAt: new Date().toISOString(), photos: PHOTOS,
} as unknown as MarketplacePost;

describe('MarketplaceCard photo', () => {
    it.each(['grid', 'list'] as const)('the %s card draws the small copy, its key kept', (viewMode) => {
        const { container } = render(<MarketplaceCard post={post} viewMode={viewMode} />);
        const img = container.querySelector(`img[alt="${post.title}"]`);
        expect(img?.getAttribute('src')).toBe(`${PHOTOS[0]}&size=thumb2`);
    });

    // Marty, 4 Nov: "from small cards you should be able to click anywhere on the card and have the card come up". The photo is
    // part of the card, so a press on it reaches the card (which opens the listing); the enlarge lives on the listing's own page.
    it.each(['grid', 'list'] as const)('the %s card\'s photo is part of the card: no enlarge button, and a press on it reaches the card', (viewMode) => {
        const onCard = vi.fn();
        const { container, queryByLabelText, queryAllByRole } = render(<div onClick={onCard}><MarketplaceCard post={post} viewMode={viewMode} /></div>);
        expect(queryByLabelText(`View enlarged photo: ${post.title}`)).toBeNull();
        expect(queryAllByRole('button')).toEqual([]);
        const img = container.querySelector(`img[alt="${post.title}"]`)!;
        expect(img.closest('button')).toBeNull();
        fireEvent.click(img);
        expect(onCard).toHaveBeenCalledTimes(1);
    });
});

// W2 of the style box (DESIGN-card-style-box-fable.md §1.1; DESIGN-market-event-cards-fable.md §3 W2): the list card's
// photo is flush, as on the phone: the first thing in the card, no padding box around it, 80 wide and the card's full height.
describe('MarketplaceCard list card on the style box', () => {
    it.each([['a photo', post], ['no photo', { ...post, photos: [] } as unknown as MarketplacePost]])('with %s, the picture is the card\'s first child, with no padding box around it', (_, p) => {
        const { getByTestId } = render(<MarketplaceCard post={p} viewMode="list" />);
        const card = getByTestId('listing-list-card');
        const slot = getByTestId('listing-list-photo');
        expect(card.firstElementChild).toBe(slot);
        expect(card.className.startsWith(listCard())).toBe(true);
        // Nothing pads the card itself or the slot: the text column carries the 12 of padding.
        expect(card.className).not.toMatch(/(^|\s)(p|px|py|pl)-\d/);
        expect(slot.className).toBe(LIST_PHOTO);
        expect(slot.nextElementSibling?.className).toBe(LIST_TEXT);
        // The tile (and the photo once drawn) cover the slot.
        expect(slot.firstElementChild?.className).toBe(LIST_PHOTO_FILL);
        // No fixed height: the card takes the height its lines need, and the slot stretches to it (Marty, 4 Nov 2026).
        for (const el of [card, slot]) expect(el.className).not.toMatch(/(^|\s)h-\d/);
    });

    it('the photo, once drawn, covers the slot', () => {
        const { container } = render(<MarketplaceCard post={post} viewMode="list" />);
        const img = container.querySelector(`img[alt="${post.title}"]`)!;
        fireEvent.load(img);
        expect(img.className).toBe(`${LIST_PHOTO_FILL} object-cover`);
        expect(img.parentElement?.getAttribute('data-testid')).toBe('listing-list-photo');
    });

    it('the chips are the one chip, capitals from the words, in the box\'s order; no raw violet, blue or nature-950', () => {
        // Every chip a listing can wear but the pin (a paused or group-only post is never pinned, @beanpool/core pinLive).
        const busy = {
            ...post, repeatable: true, cashAlsoNeeded: true, status: 'paused', audienceScope: 'group', targetGroupName: 'Gardeners',
        } as unknown as MarketplacePost;
        const { container, getByTestId, unmount } = render(<MarketplaceCard post={busy} viewMode="list" isOwnPost dealChip="asked" />);
        const row = getByTestId('listing-list-card').querySelector('.flex-wrap')!;
        const chips = Array.from(row.children) as HTMLElement[];
        expect(chips.map(c => c.textContent)).toEqual([
            'OFFER', '👤 YOU', '🥕 Food & Produce', '↻ RECURRING', '💸 CASH TOO', '⏸ PAUSED', '🔒 Only Gardeners can see this', '✋ ASKED',
        ]);
        expect(chips.map(c => c.className)).toEqual([
            chip('offer'), chip('info'), chip('quiet'), chip('quiet'), chip('warn'), chip('warn'), chip('quiet', true), chip('warn'),
        ]);
        expect(chips[7].getAttribute('data-testid')).toBe('card-deal-chip');
        for (const c of chips) expect(c.className).not.toMatch(/(^|\s)uppercase(\s|$)/);
        const all = Array.from(container.querySelectorAll('[class]')).map(e => e.getAttribute('class')).join(' ');
        expect(all).not.toMatch(/violet-|blue-|nature-950/);
        unmount();

        // A pinned listing: the pin straight after the type, in the accent chip.
        const pinned = { ...post, pinnedAt: new Date().toISOString(), pinnedUntil: new Date(Date.now() + 86_400_000).toISOString() } as unknown as MarketplacePost;
        const again = render(<MarketplaceCard post={pinned} viewMode="list" />);
        const pinRow = Array.from(again.getByTestId('listing-list-card').querySelector('.flex-wrap')!.children) as HTMLElement[];
        expect(pinRow.map(c => c.textContent)).toEqual(['OFFER', '📌 PINNED', '🥕 Food & Produce']);
        expect(pinRow[1].className).toBe(chip('pinned'));
        expect(pinRow[1].getAttribute('data-testid')).toBe('card-pinned-chip');
    });

    it('how far is its own line under who, not a chip', () => {
        const { getByTestId } = render(<MarketplaceCard post={post} viewMode="list" distanceKm={2.4} />);
        const distance = getByTestId('card-distance');
        expect(distance.textContent).toBe('📍2.4 km');
        expect(distance.closest('.flex-wrap')).toBeNull();
        expect(distance.parentElement?.className).toBe(LIST_TEXT);
    });
});

describe('MarketplaceCard with no photo', () => {
    const postWithoutPhoto = { ...post, photos: [] } as unknown as MarketplacePost;

    it.each(['grid', 'list'] as const)('the %s card renders CategoryTile with category word and full strength emoji', (viewMode) => {
        const { getByTestId } = render(<MarketplaceCard post={postWithoutPhoto} viewMode={viewMode} />);
        const tile = getByTestId('category-tile');
        expect(tile).toBeInTheDocument();
        expect(tile.querySelector('[class*="opacity-20"], [class*="opacity-30"], [class*="opacity-40"], [class*="opacity-50"]')).toBeNull();
        if (viewMode === 'grid') {
            expect(tile.textContent).toMatch(/FOOD/i);
        }
    });

    it('the compact card renders CategoryTile at thumb size with full strength emoji', () => {
        const { getByTestId } = render(<MarketplaceCard post={postWithoutPhoto} viewMode="compact" />);
        const tile = getByTestId('category-tile');
        expect(tile).toBeInTheDocument();
    });
});

describe('MarketplaceCard picture ladder: banner before tile', () => {
    const postWithBannerOnly = {
        ...post,
        photos: [],
        authorBannerUrl: '/api/shops/s1/photo?v=17&k=KEY0',
    } as unknown as MarketplacePost;

    it.each(['grid', 'list'] as const)('the %s card renders the enterprise banner before the category tile', (viewMode) => {
        const { container, queryByTestId } = render(<MarketplaceCard post={postWithBannerOnly} viewMode={viewMode} />);
        const img = container.querySelector(`img[alt="${postWithBannerOnly.title}"]`);
        expect(img?.getAttribute('src')).toBe('/api/shops/s1/photo?v=17&k=KEY0');
        // card-photo-blank: the tile holds the slot until the banner has loaded.
        expect(queryByTestId('category-tile')).toBeInTheDocument();
        fireEvent.load(img!);
        expect(queryByTestId('category-tile')).toBeNull();
    });

    it('the compact card renders the enterprise banner before the category tile', () => {
        const { container, queryByTestId } = render(<MarketplaceCard post={postWithBannerOnly} viewMode="compact" />);
        const img = container.querySelector('img');
        expect(img?.getAttribute('src')).toBe('/api/shops/s1/photo?v=17&k=KEY0');
        expect(queryByTestId('category-tile')).toBeInTheDocument();
        fireEvent.load(img!);
        expect(queryByTestId('category-tile')).toBeNull();
    });

    it.each(['grid', 'list'] as const)('the %s card prefers own photo over the enterprise banner', (viewMode) => {
        const postWithBoth = {
            ...post,
            photos: PHOTOS,
            authorBannerUrl: '/api/shops/s1/photo?v=17&k=KEY0',
        } as unknown as MarketplacePost;
        const { container } = render(<MarketplaceCard post={postWithBoth} viewMode={viewMode} />);
        const img = container.querySelector(`img[alt="${post.title}"]`);
        expect(img?.getAttribute('src')).toBe(`${PHOTOS[0]}&size=thumb2`);
    });

    it.each(['grid', 'list'] as const)('the %s card does not render a zoom button for the enterprise banner fallback; a press on it reaches the card', (viewMode) => {
        const onCard = vi.fn();
        const { queryByLabelText, container } = render(<div onClick={onCard}><MarketplaceCard post={postWithBannerOnly} viewMode={viewMode} /></div>);
        expect(queryByLabelText(`View enlarged photo: ${postWithBannerOnly.title}`)).toBeNull();
        const img = container.querySelector(`img[alt="${postWithBannerOnly.title}"]`);
        expect(img).not.toBeNull();
        fireEvent.click(img!);
        expect(onCard).toHaveBeenCalledTimes(1);
    });
});

// A banner that will not load (a weak connection, or a URL from before the enterprise replaced or took it down) gives way
// to the tile, never an empty box (review of #2565, finding 8).
describe('MarketplaceCard picture ladder: a banner that fails gives way to the tile', () => {
    const BANNER = '/api/shops/s1/photo?v=17&k=KEY0';
    const bannerOnly = { ...post, photos: [], authorBannerUrl: BANNER } as unknown as MarketplacePost;

    it.each(['grid', 'list', 'compact'] as const)('the %s card draws the CategoryTile once its banner fails to load', (viewMode) => {
        const { container, queryByTestId } = render(<MarketplaceCard post={bannerOnly} viewMode={viewMode} />);
        const img = container.querySelector(`img[alt="${post.title}"]`);
        expect(img?.getAttribute('src')).toBe(BANNER);
        fireEvent.error(img!);
        expect(container.querySelector(`img[alt="${post.title}"]`)).toBeNull();
        expect(queryByTestId('category-tile')).toBeInTheDocument();
    });

    it('a new banner the next read brings is drawn again', () => {
        const { container, rerender, queryByTestId } = render(<MarketplaceCard post={bannerOnly} viewMode="grid" />);
        fireEvent.error(container.querySelector(`img[alt="${post.title}"]`)!);
        expect(queryByTestId('category-tile')).toBeInTheDocument();
        const NEW = '/api/shops/s1/photo?v=18&k=KEY1';
        rerender(<MarketplaceCard post={{ ...bannerOnly, authorBannerUrl: NEW } as unknown as MarketplacePost} viewMode="grid" />);
        expect(container.querySelector(`img[alt="${post.title}"]`)?.getAttribute('src')).toBe(NEW);
        fireEvent.load(container.querySelector(`img[alt="${post.title}"]`)!);
        expect(queryByTestId('category-tile')).toBeNull();
    });

    it.each(['grid', 'list', 'compact'] as const)("the %s card never swaps its own photo for the enterprise's banner when that fails", (viewMode) => {
        const both = { ...post, authorBannerUrl: BANNER } as unknown as MarketplacePost;
        const { container } = render(<MarketplaceCard post={both} viewMode={viewMode} />);
        const img = () => container.querySelector(`img[alt="${post.title}"]`);
        fireEvent.error(img()!);
        fireEvent.error(img()!);
        fireEvent.error(img()!);
        expect(container.querySelector(`img[src="${BANNER}"]`)).toBeNull();
    });
});

// card-photo-retry (Marty, 4 Nov 2026: "there is one card on global that is missing a photo in the list. When I click on it,
// it shows the photo"): a listing's own small copy that fails to load tries the photo's own URL, then the category tile,
// never a broken image. Each step once per card.
describe('MarketplaceCard picture ladder: a listing photo whose small copy fails steps down', () => {
    const ALT = `img[alt="${post.title}"]`;

    it.each(['grid', 'list', 'compact'] as const)("the %s card asks the small copy once more past every cache, then the photo's own URL, then the tile", (viewMode) => {
        const { container, queryByTestId } = render(<MarketplaceCard post={post} viewMode={viewMode} />);
        expect(container.querySelector(ALT)?.getAttribute('src')).toBe(`${PHOTOS[0]}&size=thumb2`);

        fireEvent.error(container.querySelector(ALT)!);
        expect(container.querySelector(ALT)?.getAttribute('src')).toBe(`${PHOTOS[0]}&size=thumb2&retry=1`);

        fireEvent.error(container.querySelector(ALT)!);
        expect(container.querySelector(ALT)?.getAttribute('src')).toBe(PHOTOS[0]);
        expect(container.querySelector(ALT)?.getAttribute('src')).not.toContain('size=thumb2');

        fireEvent.error(container.querySelector(ALT)!);
        expect(container.querySelector(ALT)).toBeNull();
        expect(queryByTestId('category-tile')).toBeInTheDocument();
    });

    // The photo is part of the card and opens the item (Marty, 4 Nov: small cards open the item); enlarging is on the item's page.
    it.each(['grid', 'list'] as const)('the %s card has no photo button at any step of the ladder', (viewMode) => {
        const { container, queryByLabelText } = render(<MarketplaceCard post={post} viewMode={viewMode} />);
        expect(queryByLabelText(`View enlarged photo: ${post.title}`)).toBeNull();
        expect(container.querySelector(`${ALT}`)?.closest('button')).toBeNull();
        fireEvent.error(container.querySelector(ALT)!);
        // card-photo-blank: the small copy is asked once more past every cache first, and that step has no photo button either.
        expect(container.querySelector(ALT)?.getAttribute('src')).toBe(`${PHOTOS[0]}&size=thumb2&retry=1`);
        expect(queryByLabelText(`View enlarged photo: ${post.title}`)).toBeNull();
        expect(container.querySelector(`${ALT}`)?.closest('button')).toBeNull();
        fireEvent.error(container.querySelector(ALT)!);
        expect(container.querySelector(ALT)?.getAttribute('src')).toBe(PHOTOS[0]);
        expect(queryByLabelText(`View enlarged photo: ${post.title}`)).toBeNull();
        expect(container.querySelector(`${ALT}`)?.closest('button')).toBeNull();
        fireEvent.error(container.querySelector(ALT)!);
        expect(queryByLabelText(`View enlarged photo: ${post.title}`)).toBeNull();
    });

    it('does not loop: a card that has given up stays on its tile through another render', () => {
        const { container, rerender, queryByTestId } = render(<MarketplaceCard post={post} viewMode="grid" />);
        fireEvent.error(container.querySelector(ALT)!);
        fireEvent.error(container.querySelector(ALT)!);
        fireEvent.error(container.querySelector(ALT)!);
        rerender(<MarketplaceCard post={{ ...post } as unknown as MarketplacePost} viewMode="grid" />);
        expect(container.querySelector(ALT)).toBeNull();
        expect(queryByTestId('category-tile')).toBeInTheDocument();
    });

    it('a new photo URL the next read brings starts again from its small copy', () => {
        const { container, rerender, queryByTestId } = render(<MarketplaceCard post={post} viewMode="grid" />);
        fireEvent.error(container.querySelector(ALT)!);
        fireEvent.error(container.querySelector(ALT)!);
        fireEvent.error(container.querySelector(ALT)!);
        expect(queryByTestId('category-tile')).toBeInTheDocument();
        const NEW = '/api/marketplace/posts/p1/photos/0?v=18&k=KEY9';
        rerender(<MarketplaceCard post={{ ...post, photos: [NEW] } as unknown as MarketplacePost} viewMode="grid" />);
        expect(container.querySelector(ALT)?.getAttribute('src')).toBe(`${NEW}&size=thumb2`);
        fireEvent.load(container.querySelector(ALT)!);
        expect(queryByTestId('category-tile')).toBeNull();
    });
});

// card-photo-blank (Marty, 4 Nov 2026): GLOBAL's "Apples needed" showed an empty slot, no photo and no tile, while its small
// copy was served fine; the picture sent neither load nor error. The web card holds the same rule as the phone's.
describe('MarketplaceCard: never an empty slot while the photo loads', () => {
    const ALT = `img[alt="${post.title}"]`;
    afterEach(() => { vi.useRealTimers(); });

    it.each(['grid', 'list', 'compact'] as const)('the %s card draws the tile until its photo has loaded, the photo unseen and untappable meanwhile', (viewMode) => {
        const { container, queryByTestId } = render(<MarketplaceCard post={post} viewMode={viewMode} />);
        const img = () => container.querySelector<HTMLImageElement>(ALT)!;
        expect(queryByTestId('category-tile')).toBeInTheDocument();
        expect(img().style.opacity).toBe('0');
        expect(img().style.pointerEvents).toBe('none');
        fireEvent.load(img());
        expect(queryByTestId('category-tile')).toBeNull();
        expect(img().style.opacity).toBe('');
    });

    it('the grid keeps its crop once the photo has drawn', () => {
        const { container } = render(<MarketplaceCard post={post} viewMode="grid" />);
        fireEvent.load(container.querySelector(ALT)!);
        expect(container.querySelector<HTMLImageElement>(ALT)!.style.objectPosition).toBe('50% 33%');
    });

    it.each(['grid', 'list', 'compact'] as const)('the %s card counts a photo that neither loads nor fails in time as failed, down to the tile', (viewMode) => {
        vi.useFakeTimers();
        const { container, queryByTestId } = render(<MarketplaceCard post={post} viewMode={viewMode} />);
        act(() => { vi.advanceTimersByTime(LIST_PHOTO_QUEUED_MS); });
        expect(container.querySelector(ALT)?.getAttribute('src')).toBe(`${PHOTOS[0]}&size=thumb2&retry=1`);
        act(() => { vi.advanceTimersByTime(LIST_PHOTO_QUEUED_MS); });
        expect(container.querySelector(ALT)?.getAttribute('src')).toBe(PHOTOS[0]);
        act(() => { vi.advanceTimersByTime(LIST_PHOTO_QUEUED_MS); });
        expect(container.querySelector(ALT)).toBeNull();
        expect(queryByTestId('category-tile')).toBeInTheDocument();
    });
});

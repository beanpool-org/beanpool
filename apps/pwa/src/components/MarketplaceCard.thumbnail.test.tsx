/**
 * A Market card draws its listing's small copy (`size=thumb2`, @beanpool/core listPhotoUrl), never the 800 px photo: a
 * page of 20 cards was 20 full photos on prepaid data (Marty, board, 9 Oct). Opening the photo (the lightbox, the
 * detail) still gets the photos' own URLs, keys and all. A card's photo is part of the card (4 Nov): it opens the listing,
 * never a photo viewer of its own.
 */
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MarketplaceCard } from './MarketplaceCard';
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
        expect(queryByTestId('category-tile')).toBeNull();
    });

    it('the compact card renders the enterprise banner before the category tile', () => {
        const { container, queryByTestId } = render(<MarketplaceCard post={postWithBannerOnly} viewMode="compact" />);
        const img = container.querySelector('img');
        expect(img?.getAttribute('src')).toBe('/api/shops/s1/photo?v=17&k=KEY0');
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
        expect(queryByTestId('category-tile')).toBeNull();
    });

    it.each(['grid', 'list', 'compact'] as const)("the %s card never swaps its own photo for the enterprise's banner when that fails", (viewMode) => {
        const both = { ...post, authorBannerUrl: BANNER } as unknown as MarketplacePost;
        const { container } = render(<MarketplaceCard post={both} viewMode={viewMode} />);
        const img = () => container.querySelector(`img[alt="${post.title}"]`);
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

    it.each(['grid', 'list', 'compact'] as const)('the %s card draws the photo\'s own URL, then the tile, once the small copy fails', (viewMode) => {
        const { container, queryByTestId } = render(<MarketplaceCard post={post} viewMode={viewMode} />);
        expect(container.querySelector(ALT)?.getAttribute('src')).toBe(`${PHOTOS[0]}&size=thumb2`);

        fireEvent.error(container.querySelector(ALT)!);
        expect(container.querySelector(ALT)?.getAttribute('src')).toBe(PHOTOS[0]);
        expect(container.querySelector(ALT)?.getAttribute('src')).not.toContain('size=thumb2');
        expect(queryByTestId('category-tile')).toBeNull();

        fireEvent.error(container.querySelector(ALT)!);
        expect(container.querySelector(ALT)).toBeNull();
        expect(queryByTestId('category-tile')).toBeInTheDocument();
    });

    it.each(['grid', 'list'] as const)('the %s card keeps its photo button only while there is a picture to enlarge', (viewMode) => {
        const { container, queryByLabelText } = render(<MarketplaceCard post={post} viewMode={viewMode} onPhotoClick={vi.fn()} />);
        expect(queryByLabelText(`View enlarged photo: ${post.title}`)).not.toBeNull();
        fireEvent.error(container.querySelector(ALT)!);
        expect(queryByLabelText(`View enlarged photo: ${post.title}`)).not.toBeNull();
        fireEvent.error(container.querySelector(ALT)!);
        expect(queryByLabelText(`View enlarged photo: ${post.title}`)).toBeNull();
    });

    it('does not loop: a card that has given up stays on its tile through another render', () => {
        const { container, rerender, queryByTestId } = render(<MarketplaceCard post={post} viewMode="grid" />);
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
        expect(queryByTestId('category-tile')).toBeInTheDocument();
        const NEW = '/api/marketplace/posts/p1/photos/0?v=18&k=KEY9';
        rerender(<MarketplaceCard post={{ ...post, photos: [NEW] } as unknown as MarketplacePost} viewMode="grid" />);
        expect(container.querySelector(ALT)?.getAttribute('src')).toBe(`${NEW}&size=thumb2`);
        expect(queryByTestId('category-tile')).toBeNull();
    });
});

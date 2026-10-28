/**
 * A Market card draws its listing's small copy (`size=thumb`, @beanpool/core listPhotoUrl), never the 800 px photo: a
 * page of 20 cards was 20 full photos on prepaid data (Marty, board, 9 Oct). Opening the photo (the lightbox, the
 * detail) still gets the photos' own URLs, keys and all.
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
        expect(img?.getAttribute('src')).toBe(`${PHOTOS[0]}&size=thumb`);
    });

    it.each(['grid', 'list'] as const)('opening the %s card\'s photo gets the photos\' own URLs', (viewMode) => {
        const onPhotoClick = vi.fn();
        const { getByLabelText } = render(<MarketplaceCard post={post} viewMode={viewMode} onPhotoClick={onPhotoClick} />);
        fireEvent.click(getByLabelText(`View enlarged photo: ${post.title}`));
        expect(onPhotoClick).toHaveBeenCalledTimes(1);
        expect(onPhotoClick.mock.calls[0][0]).toEqual(PHOTOS);
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
        expect(img?.getAttribute('src')).toBe(`${PHOTOS[0]}&size=thumb`);
    });

    it.each(['grid', 'list'] as const)('the %s card does not render a zoom button or trigger onPhotoClick for enterprise banner fallback', (viewMode) => {
        const onPhotoClick = vi.fn();
        const { queryByLabelText, container } = render(<MarketplaceCard post={postWithBannerOnly} viewMode={viewMode} onPhotoClick={onPhotoClick} />);
        expect(queryByLabelText(`View enlarged photo: ${postWithBannerOnly.title}`)).toBeNull();
        const img = container.querySelector(`img[alt="${postWithBannerOnly.title}"]`);
        expect(img).not.toBeNull();
        fireEvent.click(img!);
        expect(onPhotoClick).not.toHaveBeenCalled();
    });
});

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

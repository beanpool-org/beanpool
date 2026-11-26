/**
 * A card crops a listing's photo at the focus its author picked (Marty, 26 Nov 2026: part of a first post's photo was cut off
 * on its card), and with no focus exactly as it always did: the grid card's MARKET_GRID_CROP (50% across, 33% down) and the
 * list photo centred. utils/photo-focus.ts; core photo-focus.ts holds the rules.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('react-native', () => ({ View: () => null, StyleSheet: { create: (s: unknown) => s } }));
vi.mock('../photo-refresh', () => ({ refreshListingAfterPhotoError: () => {} }));
vi.mock('../../components/useListPhotoSteps', () => ({ LIST_PHOTO_TRANSITION: 0, styleUntilDrawn: (s: unknown) => s, useListPhotoSteps: () => ({}) }));
vi.mock('../../components/CategoryTile', () => ({ CategoryTile: () => null }));

import { cardContentPosition, focusContentPosition, postPhotoFocus } from '../photo-focus';
import { MARKET_GRID_CROP } from '../../components/MarketCardPicture';
import { MARKET_TILE_CROP } from '../../components/home/market-tile-styles';

const COVER = 'https://riverside.example/api/marketplace/posts/p1/photos/0?v=1';
const BANNER = 'https://riverside.example/banner.jpg';

describe('photo focus on the phone\'s cards', () => {
    it('no focus: the grid keeps MARKET_GRID_CROP and the list stays centred, exactly as before', () => {
        for (const post of [{}, { photos: [COVER] }, { photoFocus: [] }, { photo_focus: null }, { photo_focus: 'not json' }, { photoFocus: [null] }]) {
            expect(cardContentPosition(post, COVER, COVER, MARKET_GRID_CROP)).toBe(MARKET_GRID_CROP);
            expect(cardContentPosition(post, COVER, COVER)).toBeUndefined();
        }
        expect(MARKET_GRID_CROP).toEqual({ top: '33%', left: '50%' });
        expect(MARKET_TILE_CROP).toEqual({ top: '33%', left: '50%' });
    });

    const FOCUSED: Array<[string, Record<string, unknown>]> = [
        ['the node\'s photoFocus list', { photoFocus: [{ x: 0.25, y: 0.9 }] }],
        ['this phone\'s photo_focus column', { photo_focus: '[{"x":0.25,"y":0.9}]' }],
    ];
    it.each(FOCUSED)('a focus from %s crops the card there, grid and list alike', (_name, post) => {
        expect(cardContentPosition(post, COVER, COVER, MARKET_GRID_CROP)).toEqual({ left: '25%', top: '90%' });
        expect(cardContentPosition(post, COVER, COVER)).toEqual({ left: '25%', top: '90%' });
        expect(postPhotoFocus(post, 0)).toEqual({ x: 0.25, y: 0.9 });
    });

    it('a picture that is not the listing\'s own photo (its enterprise\'s banner) ignores the focus', () => {
        const post = { photoFocus: [{ x: 0, y: 0 }] };
        expect(cardContentPosition(post, BANNER, null, MARKET_GRID_CROP)).toBe(MARKET_GRID_CROP);
        expect(cardContentPosition(post, null, null, MARKET_GRID_CROP)).toBe(MARKET_GRID_CROP);
    });

    it('only the first photo\'s focus crops a card; a bad stored entry is none', () => {
        expect(cardContentPosition({ photoFocus: [null, { x: 1, y: 1 }] }, COVER, COVER, MARKET_GRID_CROP)).toBe(MARKET_GRID_CROP);
        expect(postPhotoFocus({ photoFocus: [null, { x: 1, y: 1 }] }, 1)).toEqual({ x: 1, y: 1 });
        expect(postPhotoFocus({ photo_focus: '[{"x":7,"y":0}]' }, 0)).toBeNull();
        expect(postPhotoFocus(null)).toBeNull();
    });

    it('focusContentPosition: a focus as percentages, none as the fallback or the grid default', () => {
        expect(focusContentPosition({ x: 0.5, y: 0.33 })).toEqual({ left: '50%', top: '33%' });
        expect(focusContentPosition(null)).toEqual({ left: '50%', top: '33%' });
        expect(focusContentPosition(null, MARKET_TILE_CROP)).toBe(MARKET_TILE_CROP);
    });
});

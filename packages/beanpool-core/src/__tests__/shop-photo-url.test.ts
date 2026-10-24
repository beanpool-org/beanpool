import { describe, it, expect, afterEach } from 'vitest';
import {
    configureShopPhotoKeys,
    isSelfAvatarUrl,
    isSelfGroupPictureUrl,
    shopOfPhotoUrl,
    shopPhotoUrlOf,
} from '../avatar-url.js';

describe("a shop's banner URL (DESIGN-shops-round3-enterprise-shopfront-fable.md §0 row 4)", () => {
    afterEach(() => configureShopPhotoKeys(null));

    it('is made from the reference alone: none, or the route with its version and key', () => {
        expect(shopPhotoUrlOf('s-1', null)).toBeNull();
        expect(shopPhotoUrlOf('s-1', '')).toBeNull();
        expect(shopPhotoUrlOf('s-1', 'a1b2c3d4')).toBe('/api/shops/s-1/photo?v=a1b2c3d4');
        configureShopPhotoKeys((id, version) => `key-${id}-${version}`);
        expect(shopPhotoUrlOf('s-1', 'a1b2c3d4')).toBe('/api/shops/s-1/photo?v=a1b2c3d4&k=key-s-1-a1b2c3d4');
        expect(shopPhotoUrlOf('s 1/x', 'a1b2c3d4')).toBe('/api/shops/s%201%2Fx/photo?v=a1b2c3d4&k=key-s 1/x-a1b2c3d4');
    });

    it('names its shop when an editor sends it back, and nothing else does', () => {
        for (const own of [
            '/api/shops/s-1/photo?v=a1b2c3d4&k=AAAAAAAAAAAAAAAAAAAAAA',
            '/api/shops/s-1/photo',
            'https://other.example/api/shops/s-1/photo?v=a1b2c3d4',
            '  /api/shops/s-1/photo?v=a1b2c3d4  ',
        ]) expect(shopOfPhotoUrl(own), own).toBe('s-1');
        expect(shopOfPhotoUrl('/api/shops/s%201/photo?v=1')).toBe('s 1');
        for (const other of [
            'data:image/jpeg;base64,QUJD', 'bundled://leaf', '/api/shops/s-1', '/api/shops/mine', '/api/shops/s-1/photo/more',
            '/api/groups/s-1/picture?v=a1b2c3d4', '/api/avatar/abc?size=thumb&v=a1b2c3d4', '//evil/api/shops/s-1/photo', null, 42,
        ]) expect(shopOfPhotoUrl(other), String(other)).toBeNull();
        expect(isSelfAvatarUrl('/api/shops/s-1/photo?v=a1b2c3d4')).toBe(false);
        expect(isSelfGroupPictureUrl('/api/shops/s-1/photo?v=a1b2c3d4')).toBe(false);
    });
});

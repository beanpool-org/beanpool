import { describe, expect, it } from 'vitest';
import { listPhotoUrl } from '../list-photo-url.js';

describe('listPhotoUrl', () => {
    it("asks for a listing photo's small copy, its key kept", () => {
        expect(listPhotoUrl('/api/marketplace/posts/abc/photos/0?v=17&k=KEY')).toBe('/api/marketplace/posts/abc/photos/0?v=17&k=KEY&size=thumb');
        expect(listPhotoUrl('https://mullum.example.org/api/marketplace/posts/abc/photos/2?v=1'))
            .toBe('https://mullum.example.org/api/marketplace/posts/abc/photos/2?v=1&size=thumb');
        expect(listPhotoUrl('/api/marketplace/posts/abc/photos/0')).toBe('/api/marketplace/posts/abc/photos/0?size=thumb');
        expect(listPhotoUrl('/api/marketplace/posts/abc/photos/0?v=1#x')).toBe('/api/marketplace/posts/abc/photos/0?v=1&size=thumb#x');
    });
    it('leaves anything else as it was', () => {
        for (const url of ['data:image/jpeg;base64,AAAA', '/api/avatar/abc', 'https://example.org/a.jpg', '',
            '/api/marketplace/posts/abc/photos/0?v=1&size=thumb', '/api/marketplace/posts/abc/photos/x']) {
            expect(listPhotoUrl(url)).toBe(url);
        }
        expect(listPhotoUrl(null)).toBe(null);
        expect(listPhotoUrl(undefined)).toBe(undefined);
    });
});

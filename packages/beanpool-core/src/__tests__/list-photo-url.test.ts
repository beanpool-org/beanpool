import { describe, expect, it } from 'vitest';
import { listPhotoUrl, nextListPhotoUrl } from '../list-photo-url.js';

describe('listPhotoUrl', () => {
    it("asks for a listing photo's small copy, its key kept", () => {
        expect(listPhotoUrl('/api/marketplace/posts/abc/photos/0?v=17&k=KEY')).toBe('/api/marketplace/posts/abc/photos/0?v=17&k=KEY&size=thumb2');
        expect(listPhotoUrl('https://mullum.example.org/api/marketplace/posts/abc/photos/2?v=1'))
            .toBe('https://mullum.example.org/api/marketplace/posts/abc/photos/2?v=1&size=thumb2');
        expect(listPhotoUrl('/api/marketplace/posts/abc/photos/0')).toBe('/api/marketplace/posts/abc/photos/0?size=thumb2');
        expect(listPhotoUrl('/api/marketplace/posts/abc/photos/0?v=1#x')).toBe('/api/marketplace/posts/abc/photos/0?v=1&size=thumb2#x');
    });
    it('leaves anything else as it was', () => {
        for (const url of ['data:image/jpeg;base64,AAAA', '/api/avatar/abc', 'https://example.org/a.jpg', '',
            '/api/marketplace/posts/abc/photos/0?v=1&size=thumb',
            '/api/marketplace/posts/abc/photos/0?v=1&size=thumb2',
            '/api/marketplace/posts/abc/photos/x']) {
            expect(listPhotoUrl(url)).toBe(url);
        }
        expect(listPhotoUrl(null)).toBe(null);
        expect(listPhotoUrl(undefined)).toBe(undefined);
    });
});

describe('nextListPhotoUrl', () => {
    const PHOTO = '/api/marketplace/posts/abc/photos/0?v=17&k=KEY';
    it("asks a failed small copy once more past every cache, then the photo's own URL, then nothing (the tile)", () => {
        const small = listPhotoUrl(PHOTO);
        expect(small).toBe(`${PHOTO}&size=thumb2`);
        // card-photo-blank (Marty, 4 Nov 2026): a bad copy a cache keeps under the small copy's address (the header says
        // immutable, a year) is not asked for again under that address; the retry is a new address, asked once.
        const again = nextListPhotoUrl(PHOTO, small);
        expect(again).toBe(`${PHOTO}&size=thumb2&retry=1`);
        expect(nextListPhotoUrl(PHOTO, again)).toBe(PHOTO);
        expect(nextListPhotoUrl(PHOTO, PHOTO)).toBeNull();
    });
    it('keeps a #fragment after the retry mark', () => {
        expect(nextListPhotoUrl(`${PHOTO}#x`, `${PHOTO}&size=thumb2#x`)).toBe(`${PHOTO}&size=thumb2&retry=1#x`);
    });
    it('goes straight to nothing for a URL that has no small copy, so a card cannot loop', () => {
        for (const url of ['data:image/jpeg;base64,AAAA', '/api/shops/s1/photo?v=1&k=K', '/api/marketplace/posts/abc/photos/0?v=1&size=thumb2']) {
            expect(nextListPhotoUrl(url, listPhotoUrl(url))).toBeNull();
        }
    });
    it('goes to nothing for anything it was not drawing', () => {
        expect(nextListPhotoUrl(PHOTO, null)).toBeNull();
        expect(nextListPhotoUrl(PHOTO, undefined)).toBeNull();
        expect(nextListPhotoUrl(PHOTO, '/api/marketplace/posts/other/photos/0?size=thumb2')).toBeNull();
    });
});

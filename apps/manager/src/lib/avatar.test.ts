import { describe, it, expect } from 'vitest';
import { resolveAvatarUrl } from './avatar';

describe('resolveAvatarUrl', () => {
    it('returns null for null, undefined, or empty string', () => {
        expect(resolveAvatarUrl(null)).toBeNull();
        expect(resolveAvatarUrl(undefined)).toBeNull();
        expect(resolveAvatarUrl('')).toBeNull();
    });

    describe('bundled protocol', () => {
        it('resolves valid bundled keys to correct avatar paths', () => {
            expect(resolveAvatarUrl('bundled://bean-green')).toBe('/avatars/avatar_bean_green.jpg');
            expect(resolveAvatarUrl('bundled://sun')).toBe('/avatars/avatar_sun.jpg');
            expect(resolveAvatarUrl('bundled://crystal')).toBe('/avatars/avatar_crystal.jpg');
        });

        it('ignores query parameters in bundled urls', () => {
            expect(resolveAvatarUrl('bundled://wave?v=123')).toBe('/avatars/avatar_wave.jpg');
        });

        it('returns null for unknown bundled keys', () => {
            expect(resolveAvatarUrl('bundled://unknown-key')).toBeNull();
        });
    });

    describe('allowed sources', () => {
        it('allows absolute paths', () => {
            expect(resolveAvatarUrl('/images/avatar.jpg')).toBe('/images/avatar.jpg');
        });

        it('allows https urls', () => {
            expect(resolveAvatarUrl('https://example.com/avatar.png')).toBe('https://example.com/avatar.png');
        });

        it('allows http urls', () => {
            expect(resolveAvatarUrl('http://example.com/avatar.jpg')).toBe('http://example.com/avatar.jpg');
        });

        it('allows valid data URIs', () => {
            const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
            expect(resolveAvatarUrl(dataUri)).toBe(dataUri);
        });
    });

    describe('disallowed sources', () => {
        it('returns null for non-whitelisted protocols', () => {
            expect(resolveAvatarUrl('ftp://example.com/avatar.jpg')).toBeNull();
            expect(resolveAvatarUrl('javascript:alert(1)')).toBeNull();
            expect(resolveAvatarUrl('file:///etc/passwd')).toBeNull();
        });
    });

    describe('suspicious characters', () => {
        it('returns null if url contains quotes', () => {
            expect(resolveAvatarUrl('https://example.com/av"atar.jpg')).toBeNull();
            expect(resolveAvatarUrl("https://example.com/av'atar.jpg")).toBeNull();
        });

        it('returns null if url contains parentheses', () => {
            expect(resolveAvatarUrl('https://example.com/av(atar).jpg')).toBeNull();
        });

        it('returns null if url contains backslash', () => {
            expect(resolveAvatarUrl('https://example.com/av\\atar.jpg')).toBeNull();
        });

        it('returns null if url contains whitespace', () => {
            expect(resolveAvatarUrl('https://example.com/av atar.jpg')).toBeNull();
            expect(resolveAvatarUrl('https://example.com/avatar.jpg\n')).toBeNull();
            expect(resolveAvatarUrl('\thttps://example.com/avatar.jpg')).toBeNull();
        });

        it('returns null if url contains angle brackets', () => {
            expect(resolveAvatarUrl('https://example.com/<script>')).toBeNull();
        });
    });
});

import { describe, it, expect } from 'vitest';
import { resolveAvatarUrl } from './avatar';

describe('resolveAvatarUrl', () => {
    it('should return null for empty, null, or undefined url', () => {
        expect(resolveAvatarUrl(null)).toBeNull();
        expect(resolveAvatarUrl(undefined)).toBeNull();
        expect(resolveAvatarUrl('')).toBeNull();
    });

    it('should resolve bundled:// URLs correctly', () => {
        expect(resolveAvatarUrl('bundled://bean-green')).toBe('/avatars/avatar_bean_green.jpg');
        expect(resolveAvatarUrl('bundled://fire')).toBe('/avatars/avatar_fire.jpg');
    });

    it('should strip query parameters from bundled:// URLs', () => {
        expect(resolveAvatarUrl('bundled://sun?size=large')).toBe('/avatars/avatar_sun.jpg');
    });

    it('should return null for unknown bundled URLs', () => {
        expect(resolveAvatarUrl('bundled://unknown')).toBeNull();
    });

    it('should allow valid http/https URLs', () => {
        expect(resolveAvatarUrl('https://example.com/avatar.jpg')).toBe('https://example.com/avatar.jpg');
        expect(resolveAvatarUrl('http://example.com/avatar.jpg')).toBe('http://example.com/avatar.jpg');
    });

    it('should allow valid absolute paths', () => {
        expect(resolveAvatarUrl('/images/avatar.jpg')).toBe('/images/avatar.jpg');
    });

    it('should allow valid data URIs', () => {
        const validDataUri = 'data:image/png;base64,iVBORw0KGgo=';
        expect(resolveAvatarUrl(validDataUri)).toBe(validDataUri);
    });

    it('should return null for disallowed sources (e.g. javascript:)', () => {
        expect(resolveAvatarUrl('javascript:alert(1)')).toBeNull();
        expect(resolveAvatarUrl('ftp://example.com/avatar.jpg')).toBeNull();
        expect(resolveAvatarUrl('file:///etc/passwd')).toBeNull();
    });

    it('should return null if url contains invalid characters', () => {
        // Disallowed: /["'()\\\s<>]/
        expect(resolveAvatarUrl('https://example.com/"img.jpg')).toBeNull();
        expect(resolveAvatarUrl("https://example.com/'img.jpg")).toBeNull();
        expect(resolveAvatarUrl('https://example.com/(img).jpg')).toBeNull();
        expect(resolveAvatarUrl('https://example.com/img\\.jpg')).toBeNull();
        expect(resolveAvatarUrl('https://example.com/img .jpg')).toBeNull();
        expect(resolveAvatarUrl('https://example.com/<img.jpg>')).toBeNull();
    });
});

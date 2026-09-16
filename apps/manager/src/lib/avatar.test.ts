import { describe, it, expect } from 'vitest';
import { resolveAvatarUrl, isShortEmoji } from './avatar';

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
            expect(resolveAvatarUrl('bundled://rocket')).toBe('/avatars/avatar_rocket.jpg');
            expect(resolveAvatarUrl('bundled://solartree')).toBe('/avatars/avatar_solartree.jpg');
            expect(resolveAvatarUrl('bundled://sunflower')).toBe('/avatars/avatar_sunflower.jpg');
            expect(resolveAvatarUrl('bundled://portal')).toBe('/avatars/avatar_portal.jpg');
        });

        it('resolves bare bundled key to correct avatar path', () => {
            expect(resolveAvatarUrl('sprout')).toBe('/avatars/avatar_sprout.jpg');
            expect(resolveAvatarUrl('bean-green')).toBe('/avatars/avatar_bean_green.jpg');
        });

        it('ignores query parameters in bundled urls', () => {
            expect(resolveAvatarUrl('bundled://wave?v=123')).toBe('/avatars/avatar_wave.jpg');
            expect(resolveAvatarUrl('bundled://rocket?v=123')).toBe('/avatars/avatar_rocket.jpg');
        });

        it('returns null for unknown bundled keys', () => {
            expect(resolveAvatarUrl('bundled://unknown-key')).toBeNull();
        });
    });

    describe('allowed sources', () => {
        it('allows absolute paths', () => {
            expect(resolveAvatarUrl('/images/avatar.jpg')).toBe('/images/avatar.jpg');
            expect(resolveAvatarUrl('/api/avatar/7d566ff87a5fd0dc35a81214388bfcca78a91406284f5dfc165dd20d9383ff46?size=thumb')).toBe('/api/avatar/7d566ff87a5fd0dc35a81214388bfcca78a91406284f5dfc165dd20d9383ff46?size=thumb');
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

describe('isShortEmoji', () => {
    it('returns true for common single and double emojis', () => {
        expect(isShortEmoji('🌾')).toBe(true);
        expect(isShortEmoji('🛠️')).toBe(true);
        expect(isShortEmoji('🚜')).toBe(true);
        expect(isShortEmoji('🥚')).toBe(true);
        expect(isShortEmoji('🏛️')).toBe(true);
        expect(isShortEmoji('⚡')).toBe(true);
        expect(isShortEmoji('🎫')).toBe(true);
    });

    it('returns false for URLs and bundled protocols', () => {
        expect(isShortEmoji('bundled://sprout')).toBe(false);
        expect(isShortEmoji('/api/avatar/123')).toBe(false);
        expect(isShortEmoji('https://example.com/avatar.jpg')).toBe(false);
        expect(isShortEmoji('http://example.com')).toBe(false);
        expect(isShortEmoji('data:image/png;base64,...')).toBe(false);
    });

    it('returns false for alphanumeric strings or words', () => {
        expect(isShortEmoji('sprout')).toBe(false);
        expect(isShortEmoji('Community Eggs')).toBe(false);
        expect(isShortEmoji('1234')).toBe(false);
        expect(isShortEmoji('a')).toBe(false);
    });

    it('returns false for null, undefined, empty, or whitespace-only strings', () => {
        expect(isShortEmoji(null)).toBe(false);
        expect(isShortEmoji(undefined)).toBe(false);
        expect(isShortEmoji('')).toBe(false);
        expect(isShortEmoji('   ')).toBe(false);
    });

    it('returns false for emoji combined with words', () => {
        expect(isShortEmoji('🌾 Farm')).toBe(false);
        expect(isShortEmoji('Eggs 🥚')).toBe(false);
    });
});

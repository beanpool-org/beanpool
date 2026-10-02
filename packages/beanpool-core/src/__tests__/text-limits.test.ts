import { describe, it, expect } from 'vitest';
import {
    GROUP_DESCRIPTION_LIMIT,
    GROUP_DESCRIPTION_TOO_LONG,
    LIST_PREVIEW_CHARS,
    fitsTextLimit,
    isPreviewed,
    previewText,
    utf8ByteLength,
} from '../text-limits.js';

describe('text limits (#1493)', () => {
    it('counts UTF-8 bytes as Node and TextEncoder write them, lone surrogates included', () => {
        for (const text of ['', 'abc', 'é', '组织', '🌱', 'a🌱b', '\ud83c', 'x\udf31y', '\ud83c\ud83c']) {
            expect(utf8ByteLength(text)).toBe(Buffer.byteLength(text, 'utf8'));
            expect(utf8ByteLength(text)).toBe(new TextEncoder().encode(text).length);
        }
    });

    it("a group's description: 2,000 characters as the apps' fields count them, 6,000 bytes, and any script fits", () => {
        expect(GROUP_DESCRIPTION_LIMIT).toEqual({ chars: 2_000, bytes: 6_000 });
        expect(fitsTextLimit('a'.repeat(2_000), GROUP_DESCRIPTION_LIMIT)).toBe(true);
        expect(fitsTextLimit('组'.repeat(2_000), GROUP_DESCRIPTION_LIMIT)).toBe(true);
        expect(fitsTextLimit('🌱'.repeat(1_000), GROUP_DESCRIPTION_LIMIT)).toBe(true);
        expect(fitsTextLimit('a'.repeat(2_001), GROUP_DESCRIPTION_LIMIT)).toBe(false);
        expect(fitsTextLimit('组'.repeat(2_001), GROUP_DESCRIPTION_LIMIT)).toBe(false);
        // Bytes are checked too: a limit whose bytes are fewer than three a character refuses multi-byte text past them.
        expect(fitsTextLimit('组'.repeat(10), { chars: 10, bytes: 29 })).toBe(false);
        expect(GROUP_DESCRIPTION_TOO_LONG).toBe("A group's description can be at most 2,000 characters. Please shorten it.");
    });

    it('a preview cuts only text past its length, never half an emoji, and says so', () => {
        expect(LIST_PREVIEW_CHARS).toBe(300);
        const form = 'x'.repeat(300);
        expect(previewText(form)).toBe(form);
        expect(isPreviewed(form)).toBe(false);
        expect(previewText('y'.repeat(301))).toBe(`${'y'.repeat(300)}…`);
        expect(isPreviewed('y'.repeat(301))).toBe(true);
        expect(previewText('ab cd   ef', 5)).toBe('ab cd…');
        expect(previewText('ab   cdef', 5)).toBe('ab…');
        expect(previewText(`a${'🌱'.repeat(5)}`, 4)).toBe('a🌱…');
        expect(isPreviewed(null)).toBe(false);
    });
});

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { AVATAR_PRESETS } from '@beanpool/core';
import { BUNDLED_AVATARS, resolveBundledAvatar } from '../bundled-avatars';

describe('bundled-avatars (phone ready-made pictures)', () => {
    it('contains all 24 presets from core', () => {
        expect(BUNDLED_AVATARS.length).toBe(24);
        expect(AVATAR_PRESETS.length).toBe(24);
        for (const preset of AVATAR_PRESETS) {
            const bundled = BUNDLED_AVATARS.find((b) => b.id === preset.id);
            expect(bundled).toBeDefined();
            expect(bundled?.source).toBeDefined();
        }
    });

    it('resolves bundled:// references and raw preset ids to bundled sources', () => {
        expect(resolveBundledAvatar('bundled://leaf')).toBeDefined();
        expect(resolveBundledAvatar('leaf')).toBeDefined();
        expect(resolveBundledAvatar(null)).toBeNull();
        expect(resolveBundledAvatar(undefined)).toBeNull();
        expect(resolveBundledAvatar('unknown-id')).toBeNull();
    });

    it('every preset id resolves to a file that exists and is under 40 KB', () => {
        const assetsDir = path.resolve(__dirname, '../../assets/images/avatars');
        for (const preset of AVATAR_PRESETS) {
            const fileName = `avatar_${preset.id.replace(/-/g, '_')}.webp`;
            const filePath = path.join(assetsDir, fileName);

            expect(fs.existsSync(filePath)).toBe(true);

            const stats = fs.statSync(filePath);
            expect(stats.size).toBeLessThan(40 * 1024);
        }
    });
});

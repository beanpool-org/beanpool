import { describe, it, expect } from 'vitest';
import { AVATAR_PRESETS, findAvatarPreset, isBundledAvatar } from '../index.js';

describe('avatar-presets', () => {
    it('defines the 24 organic community avatar presets', () => {
        expect(AVATAR_PRESETS).toHaveLength(24);
        const ids = AVATAR_PRESETS.map(p => p.id);
        expect(ids).toContain('leaf');
        expect(ids).toContain('sprout');
        expect(ids).toContain('sun');
        expect(ids).toContain('moon');
        expect(ids).toContain('crystal');
        expect(ids).toContain('sunflower');
        expect(ids).toContain('cybereye');
    });

    it('each preset has a non-empty word key label', () => {
        for (const preset of AVATAR_PRESETS) {
            expect(preset.id).toBeTruthy();
            expect(preset.label).toBeTruthy();
            expect(typeof preset.label).toBe('string');
        }
    });

    it('findAvatarPreset resolves both raw id and bundled:// URI', () => {
        const fromId = findAvatarPreset('leaf');
        expect(fromId?.id).toBe('leaf');

        const fromUri = findAvatarPreset('bundled://leaf');
        expect(fromUri?.id).toBe('leaf');

        const withQuery = findAvatarPreset('bundled://leaf?v=123');
        expect(withQuery?.id).toBe('leaf');

        expect(findAvatarPreset('nonexistent')).toBeNull();
        expect(findAvatarPreset(null)).toBeNull();
    });

    it('all preset URIs satisfy isBundledAvatar', () => {
        for (const preset of AVATAR_PRESETS) {
            expect(isBundledAvatar(`bundled://${preset.id}`)).toBe(true);
        }
    });
});

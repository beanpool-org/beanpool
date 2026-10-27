import { describe, it, expect } from 'vitest';
import {
    AVATAR_PRESETS,
    findAvatarPreset,
    isBundledAvatar,
    avatarPresetForPubkey,
    bundledAvatarForPubkey,
    defaultGroupEmblem,
    bundledGroupEmblem,
} from '../index.js';

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

    it('deterministic key -> preset function is stable and spreads over all 24 ids', () => {
        const keyA = 'a'.repeat(64);
        const keyB = 'b'.repeat(64);
        // Stability: same key always gives the same preset
        expect(avatarPresetForPubkey(keyA)).toBe(avatarPresetForPubkey(keyA));
        expect(avatarPresetForPubkey(keyB)).toBe(avatarPresetForPubkey(keyB));
        expect(bundledAvatarForPubkey(keyA)).toBe(`bundled://${avatarPresetForPubkey(keyA)}`);

        // Empty/null fallback
        expect(avatarPresetForPubkey(null)).toBeTruthy();
        expect(avatarPresetForPubkey(undefined)).toBeTruthy();
        expect(avatarPresetForPubkey('')).toBeTruthy();

        // Spreading: across 500 distinct keys, all 24 presets should appear
        const seenPresets = new Set<string>();
        for (let i = 0; i < 500; i++) {
            const pk = `pk_test_${i}_${(i * 7919).toString(16)}`;
            seenPresets.add(avatarPresetForPubkey(pk));
        }
        expect(seenPresets.size).toBe(24);
        for (const preset of AVATAR_PRESETS) {
            expect(seenPresets.has(preset.id)).toBe(true);
        }
    });

    it('defaultGroupEmblem maps each group category to its assigned emblem', () => {
        expect(defaultGroupEmblem('social')).toBe('sunflower');
        expect(bundledGroupEmblem('social')).toBe('bundled://sunflower');

        expect(defaultGroupEmblem('general')).toBe('bean-green');
        expect(bundledGroupEmblem('general')).toBe('bundled://bean-green');

        expect(defaultGroupEmblem('working_group')).toBe('solartree');
        expect(bundledGroupEmblem('working_group')).toBe('bundled://solartree');

        expect(defaultGroupEmblem('guild')).toBe('crystal');
        expect(bundledGroupEmblem('guild')).toBe('bundled://crystal');

        // Fallbacks
        expect(defaultGroupEmblem(null)).toBe('bean-green');
        expect(defaultGroupEmblem(undefined)).toBe('bean-green');
        expect(defaultGroupEmblem('unknown_category')).toBe('bean-green');
    });
});

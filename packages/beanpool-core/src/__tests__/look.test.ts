/**
 * The look a member picks (look.ts): one function resolves it on both apps. These are the rules the brief of 12 Nov 2026
 * states: Classic is the default; Same as phone is Light on a light device and Classic on a dark one; a stored value is
 * kept; a value nobody knows is Classic; the list is exactly four.
 */
import { describe, expect, it } from 'vitest';
import { BRAND_SETS, brandScheme, brandSwatch, DEFAULT_BRAND_SET } from '../brand-colours.js';
import { DEFAULT_LOOK, LOOK_CHOICES, lookSwatchSets, parseLook, resolveLook } from '../look.js';

describe('the list', () => {
    it('is exactly Same as phone, Classic, Light, Dark -- stored as system, dark, light, night', () => {
        expect([...LOOK_CHOICES]).toEqual(['system', 'dark', 'light', 'night']);
    });

    it('names no fifth look: every set the library has is on the list, and nothing else is', () => {
        expect([...LOOK_CHOICES].filter(c => c !== 'system').sort()).toEqual([...BRAND_SETS].sort());
        for (const gone of ['dusk', 'ember', 'night-light']) expect(parseLook(gone)).toBeNull();
    });
});

describe('the default', () => {
    it('is Classic: the colour set the library calls dark', () => {
        expect(DEFAULT_LOOK).toBe('dark');
        expect(DEFAULT_LOOK).toBe(DEFAULT_BRAND_SET);
        expect(resolveLook(null, false)).toBe('dark');
        expect(resolveLook(undefined, true)).toBe('dark');
    });

    it('is Classic whether the device is light or dark: the default does not follow the device', () => {
        expect(resolveLook(null, true)).toBe('dark');
        expect(resolveLook(null, false)).toBe('dark');
    });
});

describe('Same as phone', () => {
    it('is Light when the device is light', () => expect(resolveLook('system', false)).toBe('light'));
    it('is Classic when the device is dark', () => expect(resolveLook('system', true)).toBe('dark'));
});

describe('a stored value is kept, on a light device and a dark one', () => {
    it.each([
        ['light', 'light'],
        ['dark', 'dark'],
        ['night', 'night'],
    ] as const)('%s draws the %s set', (stored, set) => {
        expect(resolveLook(stored, false)).toBe(set);
        expect(resolveLook(stored, true)).toBe(set);
    });

    it('a stored dark, which meant Classic before this file, is still Classic (nothing is converted)', () => {
        expect(resolveLook('dark', false)).toBe('dark');
        expect(brandScheme(resolveLook('dark', false))).toBe('dark');
    });

    it('Dark is always dark, and Light is always light', () => {
        expect(brandScheme(resolveLook('night', false))).toBe('dark');
        expect(brandScheme(resolveLook('light', true))).toBe('light');
    });
});

describe('a value this build does not know is Classic', () => {
    it.each(['dusk', 'ember', 'Dark', 'LIGHT', '', ' light', 'true', 'sepia'])('%j', (junk) => {
        expect(parseLook(junk)).toBeNull();
        expect(resolveLook(junk, false)).toBe('dark');
        expect(resolveLook(junk, true)).toBe('dark');
    });

    it.each([null, undefined, 0, 1, true, false, {}, [], ['light']])('%j (not a string)', (junk) => {
        expect(parseLook(junk)).toBeNull();
        expect(resolveLook(junk, false)).toBe('dark');
    });
});

describe('the swatch of a row', () => {
    it('Same as phone shows the light page and the dark page; every other row its own set', () => {
        expect(lookSwatchSets('system')).toEqual(['light', 'dark']);
        expect(lookSwatchSets('dark')).toEqual(['dark']);
        expect(lookSwatchSets('light')).toEqual(['light']);
        expect(lookSwatchSets('night')).toEqual(['night']);
    });

    it('is read from the library, so a row can only show a colour that exists', () => {
        for (const choice of LOOK_CHOICES) {
            for (const set of lookSwatchSets(choice)) {
                for (const app of ['phone', 'web'] as const) {
                    const dots = brandSwatch(set, app);
                    expect(dots.page).toMatch(/^#[0-9a-f]{6}$/);
                    expect(dots.card).toMatch(/^#[0-9a-f]{6}$/);
                    expect(dots.accent).toMatch(/^#[0-9a-f]{6}$/);
                }
            }
        }
    });
});

import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { SyntheticEvent } from 'react';
import { GATED_FOCUS, GATED_LOOK, gatedProps, guardGated } from './gated-control';

/**
 * The shades `tailwind.config.js` defines, read from the config itself. A Tailwind colour utility
 * naming a shade the config does not define emits no CSS whatsoever — silently. So a test that only
 * matches the class NAME passes just as happily on a ring that does not exist.
 *
 * Read as text rather than imported: the config is a `.js` outside this app's `tsconfig` `include`,
 * and `allowJs` is off, so importing it would not typecheck. Found by walking up from the working
 * directory, so it does not matter which directory the suite is started from.
 */
function tailwindConfigPath(): string {
    let dir = process.cwd();
    for (;;) {
        const candidate = resolve(dir, 'tailwind.config.js');
        if (existsSync(candidate)) return candidate;
        const parent = dirname(dir);
        if (parent === dir) throw new Error('tailwind.config.js not found above ' + process.cwd());
        dir = parent;
    }
}

function definedShades(): Map<string, Set<string>> {
    const source = readFileSync(tailwindConfigPath(), 'utf8');
    const palettes = new Map<string, Set<string>>();
    for (const [, name, body] of source.matchAll(/(\w+):\s*\{([^{}]*?)\}/g)) {
        const shades = new Set([...body.matchAll(/(\d+):\s*['"]#[0-9a-fA-F]{3,8}['"]/g)].map((m) => m[1]));
        if (shades.size) palettes.set(name, shades);
    }
    return palettes;
}

const event = () => ({ preventDefault: vi.fn() }) as unknown as SyntheticEvent & { preventDefault: ReturnType<typeof vi.fn> };

describe('gatedProps', () => {
    it('says nothing when the viewer is allowed to use the control', () => {
        expect(gatedProps(false, 'why')).toEqual({});
    });

    it('marks a blocked control unavailable and points at its reason', () => {
        expect(gatedProps(true, 'why')).toEqual({ 'aria-disabled': true, 'aria-describedby': 'why' });
    });

    it('points at every reason that applies at once', () => {
        expect(gatedProps(true, 'one two')['aria-describedby']).toBe('one two');
    });

    it('leaves aria-describedby off rather than pointing at nothing', () => {
        expect(gatedProps(true, '   ')).toEqual({ 'aria-disabled': true });
    });
});

describe('guardGated', () => {
    it('runs the handler when the control is not blocked', () => {
        const run = vi.fn();
        const e = event();
        guardGated(false, run)(e);
        expect(run).toHaveBeenCalledTimes(1);
        expect(e.preventDefault).not.toHaveBeenCalled();
    });

    it('does nothing at all when the control is blocked', () => {
        const run = vi.fn();
        const e = event();
        guardGated(true, run)(e);
        expect(run).not.toHaveBeenCalled();
        expect(e.preventDefault).toHaveBeenCalledTimes(1);
    });

    it('blocks with no handler, for a radio that must not tick', () => {
        const e = event();
        expect(() => guardGated(true)(e)).not.toThrow();
        expect(e.preventDefault).toHaveBeenCalledTimes(1);
    });
});

describe('the gated look', () => {
    it('keeps a focus ring, because a gated control is still focusable', () => {
        expect(GATED_FOCUS).toMatch(/focus-visible:outline/);
        expect(GATED_LOOK).toContain(GATED_FOCUS);
    });

    it('dims the control without taking it out of reach', () => {
        expect(GATED_LOOK).toMatch(/opacity-50/);
        expect(GATED_LOOK).not.toMatch(/pointer-events-none/);
    });

    it('colours the ring with a shade the Tailwind config actually defines', () => {
        const palettes = definedShades();
        // Guard the parser itself: if the config is restructured, fail here rather than pass vacuously.
        expect(palettes.get('nature')).toContain('500');

        // `outline-offset-2` is a distance, not a colour; every other `outline-<word>-<n>` is one.
        const colours = [...GATED_LOOK.matchAll(/outline-(?!offset-)([a-z]+)-(\d+)\b/g)];
        expect(colours.length).toBeGreaterThan(0);
        for (const [, palette, shade] of colours) {
            expect(palettes.has(palette), `tailwind.config.js defines no '${palette}' palette`).toBe(true);
            expect(
                [...(palettes.get(palette) ?? [])],
                `outline-${palette}-${shade} emits no CSS: the ring would fall back to currentColor`,
            ).toContain(shade);
        }
    });
});

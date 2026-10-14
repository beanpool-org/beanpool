/**
 * A class that names a shade the app's own palette lacks makes no CSS at all, so the colour silently falls back to
 * whatever is behind it. Rehearsal 14 Oct (S4): the composer's selected "🌍 Everyone (Public)" was `bg-nature-850`
 * (nature stops at 800/900/950 in tailwind.config.js), so its white words sat on the white card, 1.01:1.
 *
 * This reads every class-like word in the source and fails on one that names a shade of the app's own scales
 * (nature, oat, terra) that tailwind.config.js does not define.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC = path.resolve(__dirname);
const SCALES = ['nature', 'oat', 'terra'] as const;

function files(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return files(p);
        return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts') ? [p] : [];
    });
}

/** `bg-nature-850`, `dark:hover:text-oat-150/80` → the scale and the shade it names. */
const SHADE = new RegExp(`(?<![\\w-])(?:[a-z0-9-]+:)*!?[a-z]+(?:-[a-z]+)?-(${SCALES.join('|')})-(\\d{2,3})(?![\\d])`, 'g');

export function missingShades(text: string, palette: Record<string, Record<string, string>>): string[] {
    const out: string[] = [];
    for (const m of text.matchAll(SHADE)) {
        if (!(m[2] in (palette[m[1]] ?? {}))) out.push(m[0]);
    }
    return out;
}

describe("classes name only shades the app's palette has", () => {
    it('no nature / oat / terra shade outside tailwind.config.js', async () => {
        const { default: config } = await import(/* @vite-ignore */ pathToFileURL(path.resolve(SRC, '../tailwind.config.js')).href);
        const palette = config.theme.extend.colors as Record<string, Record<string, string>>;
        for (const scale of SCALES) expect(Object.keys(palette[scale] ?? {}).length, scale).toBeGreaterThan(3);
        const found: string[] = [];
        for (const file of files(SRC)) {
            const rel = path.relative(SRC, file);
            for (const cls of missingShades(fs.readFileSync(file, 'utf8'), palette)) found.push(`${rel}: ${cls}`);
        }
        expect(found).toEqual([]);
    });

    it('catches what it is for', () => {
        const palette = { nature: { 800: '#434e43', 900: '#384038' }, oat: {}, terra: {} };
        expect(missingShades("'bg-nature-850 dark:bg-white text-white'", palette)).toEqual(['bg-nature-850']);
        expect(missingShades("'dark:hover:text-nature-850/80'", palette)).toEqual(['dark:hover:text-nature-850']);
        expect(missingShades("'bg-nature-900 border-nature-800'", palette)).toEqual([]);
    });
});

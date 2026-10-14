/**
 * One colour for Offers (rehearsal 14 Oct S14): the tour, the tips, the Market filter ("🟢 Offers") and the map's pins
 * say green, while How it works said "offers (blue)" and the composer, the listing badge and the edit toggle showed
 * "🔵 Offer" on a blue fill. Offers are the Market's green everywhere now, and the web composer's selected Offer is
 * the library's commit fill under its own words (docs/brand-colours.md), not a raw blue.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { brandColours, contrastRatio, TOUR_WORDS } from '@beanpool/core';

function walk(dir: string, out: { file: string; src: string }[] = []) {
    for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) {
            if (name !== 'node_modules' && name !== '__tests__') walk(p, out);
        } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
            out.push({ file: path.relative(path.resolve(__dirname, '../..'), p), src: fs.readFileSync(p, 'utf8') });
        }
    }
    return out;
}

const SOURCES = [
    ...walk(path.resolve(__dirname)),
    ...walk(path.resolve(__dirname, '../../native/app')),
    ...walk(path.resolve(__dirname, '../../native/components')),
];

describe('Offers are one colour, green', () => {
    it('no screen calls an Offer blue', () => {
        const blue = SOURCES.flatMap(({ file, src }) =>
            src.split('\n').flatMap((line, i) => (/🔵|offers \(blue\)/i.test(line) ? [`${file}:${i + 1}`] : [])));
        expect(blue).toEqual([]);
    });

    it('the web composer and edit toggle fill a selected Offer with the commit role, not a raw blue', () => {
        const toggles = SOURCES.filter(s => /pages\/(MapPage|MarketplacePage)\.tsx$/.test(s.file))
            .flatMap(({ file, src }) => (src.match(/t === 'offer' \? 'bg-[^']*'/g) ?? []).map(c => `${file}: ${c}`));
        expect(toggles.length).toBeGreaterThanOrEqual(2);
        for (const t of toggles) {
            expect(t).toContain('bg-bp-commit-fill');
            expect(t).toContain('text-bp-commit-on');
            expect(t).not.toMatch(/blue-\d00/);
        }
        for (const theme of ['light', 'dark'] as const) {
            const c = brandColours(theme).commit;
            expect(contrastRatio(c.on, c.fill)).toBeGreaterThanOrEqual(4.5);
        }
    });

    it('agrees with the tour', () => {
        expect(TOUR_WORDS.map).toMatch(/green pins are Offers/);
    });
});

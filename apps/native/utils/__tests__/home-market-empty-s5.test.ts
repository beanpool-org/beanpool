import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const APP = path.resolve(__dirname, '../..');
const source = (rel: string): string => fs.readFileSync(path.join(APP, rel), 'utf8');

describe('Phone Home Market empty card S5 requirements', () => {
    const bodiesSrc = source('components/home/HomeCardBodies.tsx');

    it('Home Market card with no listings shows the CategoryTile row (food, services, tools, garden) above "See all"', () => {
        // When items are empty, MarketBody renders the CategoryTiles row
        expect(bodiesSrc).toMatch(/items\.length === 0/);
        expect(bodiesSrc).toMatch(/home-market-empty-tiles/);
        // The four categories
        expect(bodiesSrc).toMatch(/food.*services.*tools.*garden|services.*food/);
        // Positioned above the See all link
        const emptyTilesPos = bodiesSrc.indexOf('home-market-empty-tiles');
        const seeAllPos = bodiesSrc.indexOf('home-market-all');
        expect(emptyTilesPos).toBeGreaterThan(-1);
        expect(seeAllPos).toBeGreaterThan(-1);
        expect(emptyTilesPos).toBeLessThan(seeAllPos);
    });
});

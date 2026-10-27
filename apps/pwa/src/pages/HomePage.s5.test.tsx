import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Web Home Market empty card S5 requirements (HomePage.tsx)', () => {
    const homeSrc = fs.readFileSync(path.resolve(__dirname, 'HomePage.tsx'), 'utf8');

    it('Home Market card with no listings shows the CategoryTile row (food, services, tools, garden) above "See all"', () => {
        expect(homeSrc).toMatch(/items\.length === 0/);
        expect(homeSrc).toMatch(/home-market-empty-tiles/);
        expect(homeSrc).toMatch(/food.*services.*tools.*garden|services.*food/);
        const emptyTilesPos = homeSrc.indexOf('home-market-empty-tiles');
        const seeAllPos = homeSrc.indexOf('See all of the Market');
        expect(emptyTilesPos).toBeGreaterThan(-1);
        expect(seeAllPos).toBeGreaterThan(-1);
        expect(emptyTilesPos).toBeLessThan(seeAllPos);
    });
});

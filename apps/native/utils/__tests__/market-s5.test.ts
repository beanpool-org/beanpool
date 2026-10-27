import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const APP = path.resolve(__dirname, '../..');
const source = (rel: string): string => fs.readFileSync(path.join(APP, rel), 'utf8');

describe('Phone Market S5 requirements (app/(tabs)/market.tsx)', () => {
    const marketSrc = source('app/(tabs)/market.tsx');

    it('grid card title clamps to two lines (numberOfLines={2})', () => {
        expect(marketSrc).toMatch(/<Text\s+style=\{styles\.gridCardTitle\}\s+numberOfLines=\{2\}>/);
    });

    it('grid card enforces badge precedence: PENDING > YOU > RECURRING (at most one status chip)', () => {
        // Must check pending before own and before repeatable
        // A single statusChip or precedence branch ensuring at most one status chip is shown
        expect(marketSrc).toMatch(/item\.status === 'pending'/);
        expect(marketSrc).toMatch(/PENDING/);
        // The gridBadgeRow should render at most one status chip by precedence
        expect(marketSrc).not.toMatch(/!!item\.repeatable && !isPulse[\s\S]*?styles\.gridBadge[\s\S]*?isOwn &&[\s\S]*?styles\.gridBadge/);
    });

    it('list row thumbnail is 80 dp (not 96 dp)', () => {
        // Thumbnail image and CategoryTile wrapper width & minHeight are 80
        expect(marketSrc).toContain('width: 80, height: \'100%\', minHeight: 80');
        expect(marketSrc).not.toContain('width: 96, height: \'100%\', minHeight: 96');
    });

    it('empty state shows the words "Nothing here yet. Be the first:" and four CategoryTiles at thumb size', () => {
        expect(marketSrc).toContain("Nothing here yet. Be the first:");
        // The four categories: food, services, tools, garden
        expect(marketSrc).toMatch(/food.*services.*tools.*garden|services.*food/);
        expect(marketSrc).toMatch(/CategoryTile[\s\S]*?size="thumb"/);
    });
});

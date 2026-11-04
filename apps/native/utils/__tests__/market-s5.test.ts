import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MARKET_CARD_SHELL } from '@beanpool/core';

const APP = path.resolve(__dirname, '../..');
const source = (rel: string): string => fs.readFileSync(path.join(APP, rel), 'utf8');

describe('Phone Market S5 requirements (app/(tabs)/market.tsx)', () => {
    const marketSrc = source('app/(tabs)/market.tsx');
    const shellSrc = source('components/market-card-shell.ts');

    it('grid card title clamps to two lines (numberOfLines={2})', () => {
        // Its style is the box's since PG2 (components/market-card-shell.ts gridTitle), inside the four-row text block.
        expect(marketSrc).toMatch(/<Text\s+style=\{shell\.gridTitle\}\s+numberOfLines=\{2\}>/);
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
        // Thumbnail image and CategoryTile wrapper width & minHeight are 80. The height is the row's (alignSelf: 'stretch'),
        // not `height: '100%'`, which this assertion used to pin: Yoga read that against the whole list and a lone card
        // filled the screen (market-card-height-layout.test.ts measures it).
        // The slot is the style box's (components/market-card-shell.ts, slice P2): the list row draws it, the box holds the
        // numbers, core's photo.list.width the 80.
        expect(marketSrc).toContain('imageStyle={shell.listPhoto}');
        expect(marketSrc).toContain('tileBox={shell.listPhotoBox}');
        expect(shellSrc).toMatch(/width: SLOT,\s*minHeight: SLOT,\s*alignSelf: 'stretch' as const/);
        expect(shellSrc).toContain('const SLOT = SHELL.photo.list.width;');
        expect(MARKET_CARD_SHELL.photo.list.width).toBe(80);
        for (const src of [marketSrc, shellSrc]) {
            expect(src).not.toContain('width: 96, minHeight: 96');
            expect(src).not.toContain('width: 80, height: \'100%\'');
        }
    });

    it('EventCard list thumbnail is the same 80 dp slot (not 96 dp), from the style box', () => {
        const eventCardSrc = source('components/EventCard.tsx');
        expect(eventCardSrc).toContain('imageStyle={shell.listPhoto}');
        expect(eventCardSrc).toContain('tileBox={shell.listPhotoBox}');
        expect(eventCardSrc).not.toMatch(/width:\s*96/);
    });

    it('truly empty Market (feed branch) shows the words "Nothing here yet. Be the first:" and four CategoryTiles at thumb size', () => {
        // Must be in emptyState.kind === 'feed'
        const feedBranch = marketSrc.split("emptyState.kind === 'feed'")[1]?.split(/:\s*\(/)[0] || '';
        expect(feedBranch).toContain("Nothing here yet. Be the first:");
        expect(feedBranch).toMatch(/food.*services.*tools.*garden|services.*food/);
        expect(feedBranch).toMatch(/CategoryTile[\s\S]*?size="thumb"/);
        expect(feedBranch).toContain('ADD POST');
    });

    it('filtered no-matches branch shows main\'s state with Clear All Filters and no tiles', () => {
        const noMatchesBranch = marketSrc.split("emptyState.kind === 'feed'")[1]?.split(/:\s*\(/)[1] || '';
        expect(noMatchesBranch).toContain('No items found');
        expect(noMatchesBranch).toContain('Clear All Filters');
        expect(noMatchesBranch).toContain('+ Post a Deal');
        expect(noMatchesBranch).not.toContain('market-empty-tiles');
        expect(noMatchesBranch).not.toContain('Nothing here yet. Be the first:');
    });

    it('translates ⏳ PENDING across all 24 native words catalogs', () => {
        const wordsDir = path.resolve(APP, 'words');
        const catalogs = fs.readdirSync(wordsDir).filter(f => f.endsWith('.json'));
        expect(catalogs.length).toBe(24);
        for (const cat of catalogs) {
            const data = JSON.parse(fs.readFileSync(path.join(wordsDir, cat), 'utf8'));
            expect(data['⏳ PENDING']).toBeDefined();
            expect(typeof data['⏳ PENDING']).toBe('string');
            expect(data['⏳ PENDING'].length).toBeGreaterThan(0);
        }
    });

    it('market-see-elsewhere button has at least 48 dp minHeight for accessibility', () => {
        expect(marketSrc).toMatch(/<Pressable[^<]{0,400}?minHeight:\s*48[^<]{0,400}?testID="market-see-elsewhere"/);
    });

    it('grid card picture wrapper has 4:3 aspect ratio (aspectRatio: 4 / 3), not square (market-card-43)', () => {
        // The frame is the style box's since P3' (components/market-card-shell.ts), so the event tile draws the listing's own:
        // core's 4 by 3, read in the box, and both tiles draw their picture in it.
        expect(MARKET_CARD_SHELL.photo.grid.aspectWidth / MARKET_CARD_SHELL.photo.grid.aspectHeight).toBe(4 / 3);
        expect(shellSrc).toMatch(/gridImageWrapper:\s*\{[^}]*aspectRatio:\s*GRID_PHOTO\.aspectWidth\s*\/\s*GRID_PHOTO\.aspectHeight[^}]*\}/);
        expect(shellSrc).toContain('const GRID_PHOTO = SHELL.photo.grid;');
        for (const src of [marketSrc, source('components/EventCard.tsx')]) {
            expect(src).toContain('<View style={shell.gridImageWrapper}>');
            expect(src).not.toMatch(/gridImageWrapper:\s*\{/);
        }
        expect(shellSrc).not.toMatch(/gridImageWrapper:\s*\{[^}]*aspectRatio:\s*1[, \t\r\n\}]/);
    });

    it('only the grid card anchors its crop towards the top third; the 32 and 80 dp thumbnails stay centred, as on the web (market-card-43)', () => {
        const picSrc = source('components/MarketCardPicture.tsx');
        expect(picSrc).toMatch(/contentPosition=\{\s*contentPosition\s*\}/);
        expect(picSrc).toMatch(/MARKET_GRID_CROP[^=]*=\s*\{\s*top:\s*['"]33%['"],\s*left:\s*['"]50%['"]\s*\}/);
        expect(picSrc).not.toMatch(/contentPosition\s*=\s*\{\s*top/);
        const crops = marketSrc.match(/contentPosition=\{MARKET_GRID_CROP\}/g) ?? [];
        expect(crops.length).toBe(1);
        expect(marketSrc).toMatch(/size="grid"\s+contentPosition=\{MARKET_GRID_CROP\}/);
    });

    it('grid card moves RECURRING under the picture into the text block (market-card-43; the four-row block since PG2)', () => {
        const gridBadgeRowBlock = marketSrc.split('testID="grid-badge-row"')[1]?.split('</View>')[0] || '';
        expect(gridBadgeRowBlock).not.toContain('RECURRING');

        const gridTextBlock = marketSrc.split('style={gridBlock.block}')[1]?.split('</Pressable>')[0] || '';
        expect(gridTextBlock).toContain('RECURRING');
    });
});

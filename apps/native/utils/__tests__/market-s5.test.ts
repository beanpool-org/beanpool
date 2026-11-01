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
        // Thumbnail image and CategoryTile wrapper width & minHeight are 80. The height is the row's (alignSelf: 'stretch'),
        // not `height: '100%'`, which this assertion used to pin: Yoga read that against the whole list and a lone card
        // filled the screen (market-card-height-layout.test.ts measures it).
        expect(marketSrc).toContain('width: 80, minHeight: 80, alignSelf: \'stretch\'');
        expect(marketSrc).not.toContain('width: 96, minHeight: 96');
        expect(marketSrc).not.toContain('width: 80, height: \'100%\'');
    });

    it('EventCard list thumbnail is 80 dp (not 96 dp)', () => {
        const eventCardSrc = source('components/EventCard.tsx');
        expect(eventCardSrc).toMatch(/photo:\s*\{[\s\S]*?width:\s*80,[\s\S]*?height:\s*80/);
        expect(eventCardSrc).not.toMatch(/photo:\s*\{[\s\S]*?width:\s*96,[\s\S]*?height:\s*96/);
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
        expect(marketSrc).toMatch(/gridImageWrapper:\s*\{[^}]*aspectRatio:\s*4\s*\/\s*3[^}]*\}/);
        expect(marketSrc).not.toMatch(/gridImageWrapper:\s*\{[^}]*aspectRatio:\s*1[, \t\r\n\}]/);
    });

    it('MarketCardPicture anchors crop towards the top third ({ top: "33%", left: "50%" }) (market-card-43)', () => {
        const picSrc = source('components/MarketCardPicture.tsx');
        expect(picSrc).toMatch(/contentPosition=\{\s*contentPosition\s*\}/);
        expect(picSrc).toMatch(/contentPosition\s*=\s*\{\s*top:\s*['"]33%['"],\s*left:\s*['"]50%['"]\s*\}/);
    });

    it('grid card moves RECURRING under the picture into gridTextContent (market-card-43)', () => {
        const gridBadgeRowBlock = marketSrc.split('testID="grid-badge-row"')[1]?.split('</View>')[0] || '';
        expect(gridBadgeRowBlock).not.toContain('RECURRING');

        const gridTextBlock = marketSrc.split('styles.gridTextContent')[1]?.split('</Pressable>')[0] || '';
        expect(gridTextBlock).toContain('RECURRING');
    });
});

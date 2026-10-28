import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const APP = path.resolve(__dirname, '../..');
const source = (rel: string): string => fs.readFileSync(path.join(APP, rel), 'utf8');

// Which picture a card gets from the phone's own copy (the default list) is checked on real rows in
// market-banner-cache.test.ts (marketCardPicture over getPosts). This file checks that the screen draws that picture.
describe('Phone Market card ladder (Pictures S6)', () => {
    const marketSrc = source('app/(tabs)/market.tsx');
    const renderItemBlock = marketSrc.split('const renderItem =')[1] || '';

    it('each card takes its picture from marketCardPicture: own photo, then the enterprise banner, then the tile', () => {
        expect(renderItemBlock).toMatch(/const \{ cover: coverImage, picture \} = marketCardPicture\(item\);/);
    });

    it('grid card draws that picture before falling back to CategoryTile', () => {
        const gridBlock = renderItemBlock.split("if (viewMode === 'grid')")[1]?.split("if (viewMode === 'compact')")[0] || '';
        expect(gridBlock).toMatch(/\{picture \? \(\s*<Image source=\{\{ uri: listPhotoUrl\(picture\) \}\}[\s\S]*?\) : \(\s*<CategoryTile/);
    });

    it('compact row draws that picture before falling back to CategoryTile', () => {
        const compactBlock = marketSrc.split("if (viewMode === 'compact')")[1]?.split('// List View')[0] || '';
        expect(compactBlock).toMatch(/\{picture \? \(\s*<Image source=\{\{ uri: listPhotoUrl\(picture\) \}\}[\s\S]*?\) : \(\s*<CategoryTile/);
    });

    it('list row draws that picture before falling back to CategoryTile', () => {
        const listBlock = marketSrc.split('// List View')[1] || '';
        expect(listBlock).toMatch(/\{picture \? \(\s*<Image source=\{\{ uri: listPhotoUrl\(picture\) \}\}[\s\S]*?\) : \(\s*<View[^>]*>\s*<CategoryTile/);
    });

    it('Home MarketRow falls back to enterprise banner before CategoryTile', () => {
        const homeBodiesSrc = source('components/home/HomeCardBodies.tsx');
        expect(homeBodiesSrc).toMatch(/p\.photoUrl \|\| p\.bannerUrl/);
    });

    it('sets absolute banner URL directly to prevent relative paths resolving on native', () => {
        expect(marketSrc).toMatch(/author_banner_url:\s*absoluteBannerUrl/);
        expect(marketSrc).toMatch(/authorBannerUrl:\s*absoluteBannerUrl/);
        expect(marketSrc).not.toMatch(/authorBannerUrl:\s*p\.authorBannerUrl\s*\?\?\s*absoluteBannerUrl/);
    });

    it('onError only heals listings with actual coverImage photos', () => {
        expect(marketSrc.match(/if \(coverImage\) \{\s*refreshListingAfterPhotoError\(item\.id, coverImage\);/g)?.length).toBe(2);
    });
});

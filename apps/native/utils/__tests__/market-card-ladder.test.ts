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

    // Each view draws that picture through MarketCardPicture: the picture, else the CategoryTile, and the tile in place of
    // a banner that will not load. Drawn and failed for real in market-banner-fallback-render.test.ts.
    const drawsThePicture = /<MarketCardPicture\s+postId=\{item\.id\}\s+cover=\{coverImage\}\s+picture=\{picture\}/;
    const pictureSrc = source('components/MarketCardPicture.tsx');

    it('grid card draws that picture before falling back to CategoryTile', () => {
        const gridBlock = renderItemBlock.split("if (viewMode === 'grid')")[1]?.split("if (viewMode === 'compact')")[0] || '';
        expect(gridBlock).toMatch(drawsThePicture);
        expect(gridBlock).not.toMatch(/<Image\b/);
    });

    it('compact row draws that picture before falling back to CategoryTile', () => {
        const compactBlock = marketSrc.split("if (viewMode === 'compact')")[1]?.split('// List View')[0] || '';
        expect(compactBlock).toMatch(drawsThePicture);
        expect(compactBlock).not.toMatch(/<Image\b/);
    });

    it('list row draws that picture before falling back to CategoryTile', () => {
        const listBlock = marketSrc.split('// List View')[1] || '';
        expect(listBlock).toMatch(drawsThePicture);
        expect(listBlock).not.toMatch(/<Image\b/);
    });

    it('MarketCardPicture draws the picture while it loads, and the CategoryTile when there is none or the banner failed', () => {
        expect(pictureSrc).toMatch(/if \(picture && picture !== failed\) \{\s*return \(\s*<Image\s+source=\{\{ uri: listPhotoUrl\(picture\) \}\}/);
        expect(pictureSrc).toMatch(/const tile = <CategoryTile /);
    });

    it('Home MarketRow falls back to enterprise banner before CategoryTile', () => {
        const homeBodiesSrc = source('components/home/HomeCardBodies.tsx');
        expect(homeBodiesSrc).toMatch(/p\.photoUrl \|\| p\.bannerUrl/);
    });

    it('sets absolute banner URL directly to prevent relative paths resolving on native', () => {
        // The row normaliser the server search and the fill both read through (utils/market-fill.ts), which the screen calls.
        const normaliserSrc = source('utils/market-fill.ts');
        expect(marketSrc).toMatch(/normalizeServerPosts\(data, anchorUrl\)/);
        expect(normaliserSrc).toMatch(/author_banner_url:\s*absoluteBannerUrl/);
        expect(normaliserSrc).toMatch(/authorBannerUrl:\s*absoluteBannerUrl/);
        expect(normaliserSrc).not.toMatch(/authorBannerUrl:\s*p\.authorBannerUrl\s*\?\?\s*absoluteBannerUrl/);
        expect(marketSrc).not.toMatch(/authorBannerUrl:\s*p\.authorBannerUrl\s*\?\?\s*absoluteBannerUrl/);
    });

    it('onError only heals listings with actual coverImage photos', () => {
        // A banner that fails is never sent to the listing-photo heal: it gives way to the tile instead.
        expect(pictureSrc).toMatch(/onError=\{\(\) => \(cover \? refreshListingAfterPhotoError\(postId, cover\) : setFailed\(picture\)\)\}/);
        expect(marketSrc).not.toMatch(/refreshListingAfterPhotoError/);
    });
});

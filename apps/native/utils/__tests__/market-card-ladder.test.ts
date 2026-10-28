import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const APP = path.resolve(__dirname, '../..');
const source = (rel: string): string => fs.readFileSync(path.join(APP, rel), 'utf8');

describe('Phone Market card ladder (Pictures S6)', () => {
    const marketSrc = source('app/(tabs)/market.tsx');

    it('checks enterprise banner on the listing item when own photo is absent', () => {
        expect(marketSrc).toMatch(/(?:item\.authorBannerUrl|item\.author_banner_url|coverImage)/);
        // Must inspect authorBannerUrl or author_banner_url in addition to photos
        expect(marketSrc).toMatch(/authorBannerUrl|author_banner_url/);
    });

    it('grid card displays enterprise banner before CategoryTile when photoless', () => {
        // Grid image wrapper in renderItem must check for banner URL before falling back to CategoryTile
        const renderItemBlock = marketSrc.split('const renderItem =')[1] || '';
        const gridBlock = renderItemBlock.split("if (viewMode === 'grid')")[1]?.split("if (viewMode === 'compact')")[0] || '';
        expect(gridBlock).toMatch(/authorBannerUrl|author_banner_url/);
    });

    it('compact row displays enterprise banner before CategoryTile when photoless', () => {
        const compactBlock = marketSrc.split("if (viewMode === 'compact')")[1]?.split('// List View')[0] || '';
        expect(compactBlock).toMatch(/authorBannerUrl|author_banner_url/);
    });

    it('list row displays enterprise banner before CategoryTile when photoless', () => {
        const listBlock = marketSrc.split('// List View')[1] || '';
        expect(listBlock).toMatch(/authorBannerUrl|author_banner_url/);
    });

    it('Home MarketRow falls back to enterprise banner before CategoryTile', () => {
        const homeBodiesSrc = source('components/home/HomeCardBodies.tsx');
        expect(homeBodiesSrc).toMatch(/p\.photoUrl \|\| p\.bannerUrl/);
    });
});

/**
 * The phone's lists draw a listing photo's small copy (`size=thumb`, @beanpool/core listPhotoUrl); its detail screens
 * draw the 800 px photo (Marty, board, 9 Oct: "~200 px / ~10 KB copy for lists"). Screens don't load outside a device
 * (vitest.config.ts), so this reads their source: every list row's listing photo goes through listPhotoUrl, and no
 * detail screen calls it. The URL itself is checked as the phone builds it, on its node's address.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listPhotoUrl } from '@beanpool/core';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = (rel: string): string => fs.readFileSync(path.join(APP, rel), 'utf8');

/** Each list, and how its listing photo is drawn now. */
const LISTS: [string, string[], RegExp[]][] = [
    // The Market's three views draw their picture through MarketCardPicture (its banner that fails gives way to the tile),
    // and none draws one itself.
    ['app/(tabs)/market.tsx', ['<MarketCardPicture'], [/uri: (coverImage|picture)\s*}/, /<Image\b/]],
    ['components/MarketCardPicture.tsx', ['source={{ uri: listPhotoUrl(picture) }}'], [/uri: (cover|picture)\s*}/]],
    ['components/home/HomeCardBodies.tsx', ['<Thumb uri={listPhotoUrl(onNode(nodeUrl, p.photoUrl || p.bannerUrl))}'], [/<Thumb uri=\{onNode\(/]],
    ['components/EventCard.tsx', ['source={{ uri: listPhotoUrl(photo) }}'], [/uri: photo\s*}/]],
    ['components/MyDealsSheet.tsx', ['uri: listPhotoUrl(item.coverImage) }}', 'uri: listPhotoUrl(coverImage) }}'], [/uri: (item\.)?coverImage\s*}/]],
    ['app/public-profile.tsx', ['uri: listPhotoUrl(coverImage) }} style={styles.dealThumb}'], [/uri: coverImage\s*}/]],
    ['app/(tabs)/chats.tsx', ['uri: listPhotoUrl(item.postPhoto) }}'], [/uri: item\.postPhoto\s*}/]],
];
/** The screens that show a listing's photos at their size. */
const DETAILS = ['app/post/[id].tsx', 'components/PhotoCarousel.tsx', 'components/EventDetail.tsx'];

describe("the phone's lists draw the small copy", () => {
    it.each(LISTS)('%s', (file, wants, notAgain) => {
        const src = source(file);
        for (const want of wants) expect(src).toContain(want);
        for (const old of notAgain) expect(src).not.toMatch(old);
    });

    it("a Market row that fails to load still heals by the photo's own URL", () => {
        // Each of the three views hands its listing and its own photo to the picture, which heals by that URL (drawn and
        // failed for real in market-banner-fallback-render.test.ts).
        const src = source('app/(tabs)/market.tsx');
        expect(src.match(/<MarketCardPicture\s+postId=\{item\.id\}\s+cover=\{coverImage\}/g)?.length).toBe(3);
        expect(source('components/MarketCardPicture.tsx')).toContain('refreshListingAfterPhotoError(postId, cover)');
    });

    it.each(DETAILS)('%s draws the photo itself', (file) => {
        expect(source(file)).not.toContain('listPhotoUrl');
    });

    it("asks the phone's node for the small copy, the photo's key kept", () => {
        const url = 'https://mullum.example.org/api/marketplace/posts/9f1c/photos/0?v=1791608803169&k=Yqpu8qmgAGQ';
        expect(listPhotoUrl(url)).toBe(`${url}&size=thumb`);
        expect(listPhotoUrl('file:///data/user/0/photo.jpg')).toBe('file:///data/user/0/photo.jpg');
        expect(listPhotoUrl(null)).toBe(null);
    });
});

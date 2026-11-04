import React, { useState } from 'react';
import { View, type ImageStyle, type StyleProp, type ViewStyle } from 'react-native';
import { Image, type ImageContentPosition } from 'expo-image';
import { listPhotoUrl, nextListPhotoUrl } from '@beanpool/core';
import { CategoryTile, type CategoryTileKind, type CategoryTileSize } from './CategoryTile';
import { refreshListingAfterPhotoError } from '../utils/photo-refresh';

/** Grid cards only: the 32 and 80 dp thumbnails stay centred, as they are on the web. */
export const MARKET_GRID_CROP: ImageContentPosition = { top: '33%', left: '50%' };

/**
 * A Market card's picture (Pictures S6, DESIGN-pictures-fable §3.1), as utils/market-card-picture.ts chose it: `picture`
 * the listing's own first photo (`cover`) or else its enterprise's shop banner, and the CategoryTile when it has neither.
 *
 * A picture that will not load steps down, each step once, and never leaves an empty slot (review of #2565, finding 8;
 * card-photo-retry, Marty 4 Nov 2026: a card on global missed its photo in the list and showed it when opened): a listing
 * photo's small copy (`size=thumb2`) gives way to the photo's own URL, which the detail screen draws, and that gives way
 * to the tile (@beanpool/core nextListPhotoUrl). A banner has no small copy, so it goes straight to the tile: a weak
 * connection, or a URL from before the enterprise changed it. A photo of its own that fails also has its listing read
 * again (refreshListingAfterPhotoError), as it always did. The URL that failed is kept beside its step, not a flag, so a
 * new URL the next sync brings starts again from its small copy.
 *
 * The grid's 4:3 frame passes MARKET_GRID_CROP, so upright photos anchor towards the top third so heads/jar tops stay in (market-card-43).
 *
 * `imageStyle` sizes the photo; the tile is drawn with `tileStyle`, inside a box of `tileBox` where the card sizes it
 * from outside.
 */
export function MarketCardPicture({ postId, cover, picture, category, kind, size, accessibilityLabel, imageStyle, tileStyle, tileBox, contentPosition }: {
    postId: string;
    cover: string | null;
    picture: string | null;
    category?: string | null;
    kind: CategoryTileKind;
    size: CategoryTileSize;
    accessibilityLabel?: string;
    imageStyle: StyleProp<ImageStyle>;
    tileStyle?: StyleProp<ViewStyle>;
    tileBox?: StyleProp<ViewStyle>;
    contentPosition?: ImageContentPosition;
}) {
    // The step this `picture` has come down to: the URL now drawn, or null for the tile. Set only after a failure.
    const [steppedDown, setSteppedDown] = useState<{ photo: string; shown: string | null } | null>(null);
    const shown = !picture ? null : steppedDown?.photo === picture ? steppedDown.shown : listPhotoUrl(picture);
    if (picture && shown) {
        return (
            <Image
                source={{ uri: shown }}
                style={imageStyle}
                accessibilityLabel={accessibilityLabel}
                contentFit="cover"
                contentPosition={contentPosition}
                cachePolicy="memory-disk"
                transition={150}
                onError={() => {
                    if (cover) refreshListingAfterPhotoError(postId, cover);
                    setSteppedDown({ photo: picture, shown: nextListPhotoUrl(picture, shown) });
                }}
            />
        );
    }
    const tile = <CategoryTile category={category} kind={kind} size={size} style={tileStyle} />;
    return tileBox ? <View style={tileBox}>{tile}</View> : tile;
}

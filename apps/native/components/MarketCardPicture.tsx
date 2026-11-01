import React, { useState } from 'react';
import { View, type ImageStyle, type StyleProp, type ViewStyle } from 'react-native';
import { Image, type ImageContentPosition } from 'expo-image';
import { listPhotoUrl } from '@beanpool/core';
import { CategoryTile, type CategoryTileKind, type CategoryTileSize } from './CategoryTile';
import { refreshListingAfterPhotoError } from '../utils/photo-refresh';

/**
 * A Market card's picture (Pictures S6, DESIGN-pictures-fable §3.1), as utils/market-card-picture.ts chose it: `picture`
 * the listing's own first photo (`cover`) or else its enterprise's shop banner, and the CategoryTile when it has neither.
 * A photo of its own that will not load has its listing read again (refreshListingAfterPhotoError), as it always did. A
 * banner that will not load draws the tile instead, never an empty slot (review of #2565, finding 8): a weak connection,
 * or a URL from before the enterprise changed it. The URL that failed is kept, not a flag, so a new banner the next sync
 * brings is tried.
 *
 * In 4:3 frame, upright photos anchor towards the top third ({ top: '33%', left: '50%' }) so heads/jar tops stay in (market-card-43).
 *
 * `imageStyle` sizes the photo; the tile is drawn with `tileStyle`, inside a box of `tileBox` where the card sizes it
 * from outside.
 */
export function MarketCardPicture({ postId, cover, picture, category, kind, size, accessibilityLabel, imageStyle, tileStyle, tileBox, contentPosition = { top: '33%', left: '50%' } }: {
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
    const [failed, setFailed] = useState<string | null>(null);
    if (picture && picture !== failed) {
        return (
            <Image
                source={{ uri: listPhotoUrl(picture) }}
                style={imageStyle}
                accessibilityLabel={accessibilityLabel}
                contentFit="cover"
                contentPosition={contentPosition}
                cachePolicy="memory-disk"
                transition={150}
                onError={() => (cover ? refreshListingAfterPhotoError(postId, cover) : setFailed(picture))}
            />
        );
    }
    const tile = <CategoryTile category={category} kind={kind} size={size} style={tileStyle} />;
    return tileBox ? <View style={tileBox}>{tile}</View> : tile;
}

import React from 'react';
import { View, type ImageStyle, type StyleProp, type ViewStyle } from 'react-native';
import { Image, type ImageContentPosition } from 'expo-image';
import { CategoryTile, type CategoryTileKind, type CategoryTileSize } from './CategoryTile';
import { refreshListingAfterPhotoError } from '../utils/photo-refresh';
import { styleUntilDrawn, useListPhotoSteps } from './useListPhotoSteps';

/** Grid cards only: the 32 and 80 dp thumbnails stay centred, as they are on the web. */
export const MARKET_GRID_CROP: ImageContentPosition = { top: '33%', left: '50%' };

/**
 * A Market card's picture (Pictures S6, DESIGN-pictures-fable §3.1), as utils/market-card-picture.ts chose it: `picture`
 * the listing's own first photo (`cover`) or else its enterprise's shop banner, and the CategoryTile when it has neither.
 *
 * A picture that will not load steps down, each step once, and never leaves an empty slot (review of #2565, finding 8;
 * card-photo-retry, Marty 4 Nov 2026: a card on global missed its photo in the list and showed it when opened): a listing
 * photo's small copy (`size=thumb2`) is asked once more past every cache, then gives way to the photo's own URL, which
 * the detail screen draws, and that gives way to the tile (@beanpool/core nextListPhotoUrl). A banner has no small copy,
 * so it goes straight to the tile: a weak connection, or a URL from before the enterprise changed it. A photo of its own
 * that fails also has its listing read again (refreshListingAfterPhotoError), as it always did.
 *
 * Never an empty slot while it loads either (card-photo-blank, Marty 4 Nov 2026: the same card showed an empty slot, no
 * photo and no tile, through two restarts): the tile holds the slot until the photo has actually drawn (onLoad), and a
 * photo that neither draws nor fails in time counts as failed (useListPhotoSteps). The Image is mounted from the start,
 * out of the layout and unseen, so it loads, and takes the slot once it has drawn.
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
    const steps = useListPhotoSteps(picture, () => { if (cover) refreshListingAfterPhotoError(postId, cover); });
    const tileOnly = <CategoryTile category={category} kind={kind} size={size} style={tileStyle} />;
    const tile = tileBox ? <View style={tileBox}>{tileOnly}</View> : tileOnly;
    if (!picture || !steps.shown) return tile;
    return (
        <>
            {steps.drawn ? null : tile}
            <Image
                source={{ uri: steps.shown }}
                style={styleUntilDrawn(imageStyle, steps.drawn)}
                accessibilityLabel={accessibilityLabel}
                importantForAccessibility={steps.drawn ? 'auto' : 'no-hide-descendants'}
                accessibilityElementsHidden={!steps.drawn}
                contentFit="cover"
                contentPosition={contentPosition}
                cachePolicy="memory-disk"
                transition={150}
                onLoad={steps.onLoad}
                onError={steps.onError}
                onLoadStart={steps.onLoadStart}
                onProgress={steps.onProgress}
            />
        </>
    );
}

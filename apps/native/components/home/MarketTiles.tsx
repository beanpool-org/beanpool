import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { router } from 'expo-router';
import type { AppColors } from '../../constants/colors';
import { categoryLabel } from '../../constants/categories';
import { CategoryTile } from '../CategoryTile';
import { ListPhoto } from '../ListPhoto';
import { formatDistance } from '../../utils/events';
import { beansAmount, sentence, withPin, type HomeMarketItem } from '../../utils/home-cards';
import { copyPriceLine, eventCopyOf, freePriceWords, isHundredths, perItemLine, perItemOf, t } from '@beanpool/core';
import { homeStyles, onNode } from './HomeParts';
import { MARKET_TILE_CROP, marketTileStyles as tiles } from './market-tile-styles';

/**
 * "New in the Market" as picture tiles (DESIGN-onboarding-home-landing-fable.md §4.1 item 5, §4.4, slice S8): two tiles a
 * row, each the listing's photo at 4:3 with its OFFER or NEED on the corner, then its title in two lines and its price in
 * the brand's ink. The Market's own grid tile is the standard (core market-card-shell.ts: the 4:3 photo cropped towards its
 * top third, the grid's title and price type), so Home's tile reads as the Market's does. The node sends at most four
 * (three to a visitor), so the card is two rows at most. A listing with no photo, or one that will not load, shows its
 * category's tile in the tile colours (CategoryTile, from the central tokens), never a broken picture or an empty box:
 * ListPhoto's steps, as the row had, the small copy first (no bigger copy). A tap anywhere on a tile opens the listing
 * (small-cards-open-the-item). Where there is no price or distance to say, the tile has no second line: fewer words.
 */

/** What a Market listing says on Home, tile or row: its facts line ("12 Beans · 2 km"), or none, and its screen-reader sentence. */
export function marketItemWords(p: HomeMarketItem, showsBeans: boolean): { facts: string; a11y: string; category: string } {
    // A listing priced at 0 reads Free, as on the Market's card (core listing-price.ts); a price never sent draws nothing.
    // An Offer priced for each one says so in words, with how many are left and the price for all of them while it is on offer (core
    // per-item.ts perItemLine, DESIGN-per-item-price-fable.md §2.1): "300 Beans each · 20 left · or all for 5,500", "Free · 20 left".
    const copy = eventCopyOf(p);
    const each = showsBeans && !copy ? perItemOf(p) : null;
    const price = each ? perItemLine(each) : showsBeans && isHundredths(p.price_c) ? (freePriceWords(p.price_c, p.type) ?? beansAmount(p.price_c)) : null;
    const far = formatDistance(p.distanceKm);
    const facts = [copy ? copyPriceLine(copy) : price, far].filter(Boolean).join(' · ');
    const category = categoryLabel(p.category);
    const values = { title: sentence(p.title), facts, category };
    const a11y = p.type === 'need'
        ? (facts ? t('Need: {title} {facts}. {category}. Opens the listing.', values) : t('Need: {title} {category}. Opens the listing.', values))
        : (facts ? t('Offer: {title} {facts}. {category}. Opens the listing.', values) : t('Offer: {title} {category}. Opens the listing.', values));
    return { facts, a11y, category };
}

/** The listings two a row; a lone last one keeps half the width (an empty cell beside it), so every tile is the same size. */
function inPairs<T>(items: readonly T[]): T[][] {
    const rows: T[][] = [];
    for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
    return rows;
}

export function MarketTiles({ items, nodeUrl, showsBeans, colors }: {
    items: HomeMarketItem[];
    nodeUrl: string | null;
    showsBeans: boolean;
    colors: AppColors;
}) {
    if (!items.length) return null;
    return (
        <View style={tiles.grid} testID="home-market-tiles">
            {inPairs(items).map(pair => (
                <View key={pair[0].id} style={tiles.row}>
                    {pair.map(p => <MarketTile key={p.id} p={p} nodeUrl={nodeUrl} showsBeans={showsBeans} colors={colors} testID={`home-market-${p.id}`} />)}
                    {pair.length === 1 && <View style={tiles.cell} importantForAccessibility="no" />}
                </View>
            ))}
        </View>
    );
}

function MarketTile({ p, nodeUrl, showsBeans, colors, testID }: { p: HomeMarketItem; nodeUrl: string | null; showsBeans: boolean; colors: AppColors; testID: string }) {
    const s = homeStyles(colors);
    const type = p.type === 'need' ? colors.market.need : colors.market.offer;
    const word = p.type === 'need' ? t('NEED') : t('OFFER');
    const { facts, a11y } = marketItemWords(p, showsBeans);
    return (
        <Pressable
            onPress={() => router.push({ pathname: '/post/[id]', params: { id: p.id } })}
            style={({ pressed }) => [tiles.cell, tiles.tile, pressed && s.pressed]}
            accessibilityRole="button"
            accessibilityLabel={a11y}
            testID={testID}
        >
            <View style={[tiles.photo, { backgroundColor: colors.surface.subtle }]} testID="home-market-tile-photo">
                {/* The listing's own photo (its small copy first), else its enterprise's banner; neither, or one that fails: the tile. */}
                <ListPhoto
                    photo={onNode(nodeUrl, p.photoUrl || p.bannerUrl)}
                    style={tiles.fill}
                    contentFit="cover"
                    contentPosition={MARKET_TILE_CROP}
                    accessibilityIgnoresInvertColors
                    fallback={<CategoryTile category={p.category} kind="listing" size="grid" />}
                />
                <View style={[s.badge, tiles.chip, { backgroundColor: type.bg }]}>
                    <Text style={[s.badgeText, { color: type.fg }]} maxFontSizeMultiplier={1.2}>{word}</Text>
                </View>
            </View>
            <Text style={[tiles.title, { color: colors.text.heading }]} numberOfLines={2}>{withPin(p.title, p)}</Text>
            {/* A per-item price runs to three lines at 320dp and 1.3x ("300 Beans each · 20 left · or all for 5,500"); the
                screen reader hears it whole either way. */}
            {!!facts && <Text style={[tiles.facts, { color: colors.brand.primary }]} numberOfLines={3}>{facts}</Text>}
        </Pressable>
    );
}

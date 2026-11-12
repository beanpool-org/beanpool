import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { perItemCard } from '@beanpool/core';
import { BeansText } from './BeansText';
import { useCardShell } from './market-card-shell';

interface Props {
    /** The listing itself (the phone's cached row, or a post). Nothing is drawn for one not priced for each one. */
    listing: unknown;
}

/**
 * The one line under the title of an Offer priced for each one (core per-item.ts, DESIGN-per-item-price-fable.md §2.1): "20 left ·
 * or all for 5,500 🫘". Two whole phrases side by side while they fit and the second under the first when they do not, never a
 * phrase cut in the middle and never an ellipsis. The list card and the map's preview card draw it; the price itself stays at the
 * end of the card's first row (ListingPrice). Its words are the style box's distance line (`shell.distance`), which both cards
 * already drew it in, so it takes no style of its own.
 */
export function ListingEachLine({ listing }: Props) {
    const shell = useCardShell();
    const each = perItemCard(listing);
    if (!each) return null;
    const size = StyleSheet.flatten(shell.distance)?.fontSize ?? 12;
    return (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 4 }} testID="listing-each-line">
            <Text style={shell.distance} testID="listing-each-stock">{each.orAll ? `${each.stock} ·` : each.stock}</Text>
            {!!each.orAll && <Text style={shell.distance} testID="listing-each-all"><BeansText text={each.orAll} size={size} /></Text>}
        </View>
    );
}

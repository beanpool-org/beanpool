import React from 'react';
import { StyleProp, Text, TextStyle, View } from 'react-native';
import { perItemCard } from '@beanpool/core';
import { BeansText } from './BeansText';

interface Props {
    /** The listing itself (the phone's cached row, or a post). Nothing is drawn for one not priced for each one. */
    listing: unknown;
    style?: StyleProp<TextStyle>;
}

/**
 * The one line under the title of an Offer priced for each one (core per-item.ts, DESIGN-per-item-price-fable.md §2.1): "20 left ·
 * or all for 5,500 🫘". Two whole phrases side by side while they fit and the second under the first when they do not, never a
 * phrase cut in the middle and never an ellipsis. The list card and the map's preview card draw it; the price itself stays at the
 * end of the card's first row (ListingPrice).
 */
export function ListingEachLine({ listing, style }: Props) {
    const each = perItemCard(listing);
    if (!each) return null;
    return (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 4 }} testID="listing-each-line">
            <Text style={style} testID="listing-each-stock">{each.orAll ? `${each.stock} ·` : each.stock}</Text>
            {!!each.orAll && <BeansText text={each.orAll} style={style} testID="listing-each-all" />}
        </View>
    );
}

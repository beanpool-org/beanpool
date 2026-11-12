import React from 'react';
import { StyleProp, StyleSheet, Text, TextStyle, View } from 'react-native';
import { formatHundredths, freePriceWords, perItemCard } from '@beanpool/core';
import { CurrencyDisplay } from './CurrencyDisplay';
import { BeansText } from './BeansText';

interface Props {
    /**
     * The listing's price, whole hundredths of a Bean (`price_c`): none sent (undefined) reads "?" as it always did, and a
     * figure that isn't whole hundredths (null on the phone's copy) reads "—", never a number.
     */
    price_c: number | null | undefined;
    /** 'offer' or 'need'. */
    type: string | null | undefined;
    /** The unit written after a priced amount ("/Hr"); a free listing draws none. */
    unit?: string;
    style?: StyleProp<TextStyle>;
    /**
     * The listing itself (the phone's cached row, or a post): an Offer priced for each one then draws "300 🫘 each" in place of the
     * amount and unit (core per-item.ts, DESIGN-per-item-price-fable.md §2.1). Any other listing is drawn as it always was.
     */
    listing?: unknown;
    /** With `listing`: the price for all of them ("all 5,500 🫘") on a quiet line under the price, while it is on offer. The grid's pill and the compact row's end. */
    showAll?: boolean;
}

/**
 * A listing's price on a card, a row or a map card (the Market's grid, compact and list cards and the map's preview card): the
 * amount with the Beans sign and its unit, or "Free" for a listing priced at 0 (core listing-price.ts, the one rule both apps
 * read). Free is words and nothing else: no Beans sign, no unit, and a screen reader reads "Free", not "0".
 */
export function ListingPrice({ price_c, type, unit = '', style, listing, showAll = false }: Props) {
    const free = freePriceWords(price_c, type, 'short');
    if (free) {
        return (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={style} numberOfLines={1} testID="listing-price-free">{free}</Text>
            </View>
        );
    }
    const each = listing === undefined ? null : perItemCard(listing);
    if (each?.price) {
        // Never cut with an ellipsis: a price that does not fit on a line wraps, whole phrases staying whole.
        const fontSize = StyleSheet.flatten(style)?.fontSize ?? 14;
        return (
            <View style={{ alignItems: 'flex-end', flexShrink: 1 }} testID="listing-price-each">
                <BeansText text={each.price} style={[style, { textAlign: 'right' }]} accessibilityLabel={each.label} />
                {showAll && !!each.allShort && (
                    <BeansText
                        text={each.allShort}
                        testID="listing-price-all"
                        style={[style, { fontSize: Math.max(10, Math.round(fontSize * 0.8)), fontWeight: '500', textAlign: 'right' }]}
                    />
                )}
            </View>
        );
    }
    return <CurrencyDisplay amount={`${price_c === undefined ? '?' : formatHundredths(price_c)}${unit}`} style={style} asView={true} />;
}

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
    const each = free || listing === undefined ? null : perItemCard(listing);
    if (free || each?.price) {
        // One Text carries the caller's style (the style box's own, which the contrast check reads at the call). Free is one line;
        // a price for each one is never cut with an ellipsis (a price that does not fit on a line wraps, whole phrases staying
        // whole) and puts the price for all on a second line of the same Text, a nested Text with no colour of its own so it keeps
        // the caller's.
        const fontSize = StyleSheet.flatten(style)?.fontSize ?? 14;
        const allSize = Math.max(10, Math.round(fontSize * 0.8));
        return (
            <View style={each ? { alignItems: 'flex-end', flexShrink: 1 } : { flexDirection: 'row', alignItems: 'center' }} testID={each ? 'listing-price-each' : undefined}>
                <Text style={[style, { textAlign: 'right' }]} numberOfLines={each ? undefined : 1} accessibilityLabel={each?.label} testID={each ? undefined : 'listing-price-free'}>
                    {each ? <BeansText text={each.price!} size={fontSize} /> : free}
                    {!!each && showAll && !!each.allShort && (
                        <Text style={{ fontSize: allSize, fontWeight: '500' }} testID="listing-price-all">
                            {'\n'}<BeansText text={each.allShort} size={allSize} />
                        </Text>
                    )}
                </Text>
            </View>
        );
    }
    return <CurrencyDisplay amount={`${price_c === undefined ? '?' : formatHundredths(price_c)}${unit}`} style={style} asView={true} />;
}

import React from 'react';
import { StyleProp, Text, TextStyle, View } from 'react-native';
import { freePriceWords } from '@beanpool/core';
import { CurrencyDisplay } from './CurrencyDisplay';

interface Props {
    /** The listing's price in Beans; none sent reads "?" as it always did. */
    credits: number | string | null | undefined;
    /** 'offer' or 'need'. */
    type: string | null | undefined;
    /** The unit written after a priced amount ("/Hr"); a free listing draws none. */
    unit?: string;
    style?: StyleProp<TextStyle>;
}

/**
 * A listing's price on a card, a row or a map card (the Market's grid, compact and list cards and the map's preview card): the
 * amount with the Beans sign and its unit, or "Free" for a listing priced at 0 (core listing-price.ts, the one rule both apps
 * read). Free is words and nothing else: no Beans sign, no unit, and a screen reader reads "Free", not "0".
 */
export function ListingPrice({ credits, type, unit = '', style }: Props) {
    const free = freePriceWords(credits, type, 'short');
    if (free) {
        return (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={style} numberOfLines={1} testID="listing-price-free">{free}</Text>
            </View>
        );
    }
    return <CurrencyDisplay amount={`${credits !== undefined && credits !== null ? credits : '?'}${unit}`} style={style} asView={true} />;
}

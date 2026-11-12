import React from 'react';
import { Image, StyleProp, StyleSheet, Text, TextStyle } from 'react-native';
import { splitBeansSign } from '@beanpool/core';

interface Props {
    /** A line of card words that writes the Beans sign (🫘), such as "300 🫘 each". */
    text: string;
    style?: StyleProp<TextStyle>;
    /** The line in plain words for a screen reader ("300 Beans each"): the picture is hidden from it. */
    accessibilityLabel?: string;
    testID?: string;
    numberOfLines?: number;
}

/**
 * A line of card words with the Beans picture where the words write the Beans sign: "300 🫘 each" is drawn "300 [bean] each", as
 * every price on a card is, because an old Android has no glyph for the emoji and a card never shows an empty box. The picture
 * sits inside the text, so the line wraps as one piece; a line without the sign is drawn as it is. Used by the cards of a listing
 * priced for each one (DESIGN-per-item-price-fable.md §2.1, slice P2).
 */
export function BeansText({ text, style, accessibilityLabel, testID, numberOfLines }: Props) {
    const fontSize = StyleSheet.flatten(style)?.fontSize ?? 14;
    const side = Math.round(fontSize * 1.05);
    const parts = splitBeansSign(text);
    return (
        <Text style={style} accessibilityLabel={accessibilityLabel} testID={testID} numberOfLines={numberOfLines}>
            {parts.map((part, i) => (
                <React.Fragment key={i}>
                    {i > 0 && (
                        <Image
                            source={require('../assets/images/bean.png')}
                            accessibilityElementsHidden={true}
                            importantForAccessibility="no-hide-descendants"
                            style={{ width: side, height: side, resizeMode: 'contain' }}
                        />
                    )}
                    {part}
                </React.Fragment>
            ))}
        </Text>
    );
}

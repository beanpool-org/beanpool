import React from 'react';
import { Image } from 'react-native';
import { splitBeansSign } from '@beanpool/core';

interface Props {
    /** A line of card words that carries the bean emoji (🫘), such as "300 🫘 each". */
    text: string;
    /** The size of the words round it, in dp: the picture is drawn a little larger than a letter of that size. */
    size?: number;
}

/**
 * The words of a card line with the Beans picture where the words carry the bean emoji: "300 🫘 each" is drawn "300 [bean] each", as
 * every price on a card is, because an old Android has no glyph for the emoji and a card never shows an empty box. It is the
 * INSIDE of a line, so it goes in the Text the card already styles (`<Text style={shell.price}><BeansText text=... size={16} /></Text>`):
 * the picture sits inside that text, the line wraps as one piece, and the words keep that Text's colour and size from the style
 * box (a style handed through a prop here would be one more that the contrast check cannot read). A line without the emoji is
 * drawn as it is. The picture is hidden from a screen reader, so the Text round it carries the whole line in words
 * (`accessibilityLabel`). Used by the cards of a listing priced for each one (DESIGN-per-item-price-fable.md §2.1, slice P2).
 */
export function BeansText({ text, size = 14 }: Props) {
    const side = Math.round(size * 1.05);
    const parts = splitBeansSign(text);
    return (
        <>
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
        </>
    );
}

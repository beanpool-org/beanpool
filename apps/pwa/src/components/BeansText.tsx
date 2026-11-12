/**
 * A line of card words with the Beans picture where the words write the Beans sign (🫘): "300 🫘 each" is drawn
 * "300 [bean] each", as every price on a card is, because an old phone has no glyph for the emoji and a card never shows
 * an empty box. The picture is hidden from a screen reader, so put the whole line in words on the element round it
 * (`aria-label`). A line without the sign is drawn as it is. Used by the cards of a listing priced for each one
 * (DESIGN-per-item-price-fable.md §2.1, slice P2).
 */
import { Fragment } from 'react';
import { splitBeansSign, t } from '@beanpool/core';

export function BeansText({ text, px = 12, className }: { text: string; px?: number; className?: string }) {
    const parts = splitBeansSign(text);
    return (
        <span className={className}>
            {parts.map((part, i) => (
                <Fragment key={i}>
                    {i > 0 && (
                        <img
                            src="/assets/bean.png"
                            alt={t('B', undefined, 'the Beans sign')}
                            style={{ display: 'inline-block', width: `${px}px`, height: `${px}px`, verticalAlign: 'text-bottom', flexShrink: 0 }}
                        />
                    )}
                    {part}
                </Fragment>
            ))}
        </span>
    );
}

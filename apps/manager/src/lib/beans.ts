/**
 * Beans in the owner console (scratch/fable-design/DESIGN-atomic-beans-fable.md; Marty, 10 Nov 2026). Every money figure the
 * node sends, and every one it takes, is a whole number of hundredths of a Bean: 1 Bean is 100, so 4925 is 49.25 Beans. This
 * is where the console turns a figure into words and typed text into a figure, through @beanpool/core's hundredths.ts and
 * nothing else: never toFixed, never `* 100`, never a float on its way to the node.
 *
 * Settings is English for launch (lib/fresh-proof.ts `t`), so a figure is written and read the English way.
 */
import {
    amountRefusalWords,
    formatHundredths,
    hundredthsAsDecimalText,
    isHundredths,
    parseHundredths,
    type AmountRefusal,
    type ParsedHundredths,
} from '@beanpool/core';

/**
 * A figure in the console's words: 1 → "0.01", 4925 → "49.25", 100000 → "1,000", −982 → "−9.82" (a true minus). Anything
 * that isn't whole hundredths (a float, a string, a missing field) is "—", never a number.
 */
export function beansFigure(c: unknown): string {
    return formatHundredths(c, 'en');
}

/** The same with its unit: "49.25 Beans", "— Beans" for a figure the node didn't send whole. */
export function beansText(c: unknown): string {
    return `${beansFigure(c)} Beans`;
}

/** What an amount box starts from: plain digits and a dot, never grouped ("1000", "12.50"); empty for anything else. */
export function beansInputText(c: unknown): string {
    return isHundredths(c) ? hundredthsAsDecimalText(c) : '';
}

/**
 * Beans as an owner types them, as whole hundredths: "12.50" → 1250, "1000" → 100000. Refused, never rounded: more than two
 * decimals, a thousands separator, two decimal marks, a minus, letters, nothing typed.
 */
export function parseBeans(text: string): ParsedHundredths {
    return parseHundredths(typeof text === 'string' ? text : '', 'en');
}

/** Typed Beans as whole hundredths, or null when they aren't an amount (parseBeans says why). */
export function typedHundredths(text: string): number | null {
    const p = parseBeans(text);
    return p.ok ? p.value : null;
}

/** Why typed Beans were refused, in words ("Type at most 2 decimals, like 12.5."). */
export function beansRefusalText(refusal: AmountRefusal): string {
    return amountRefusalWords(refusal, 2);
}

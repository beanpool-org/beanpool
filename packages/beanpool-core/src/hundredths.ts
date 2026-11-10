/**
 * BEANS AS WHOLE HUNDREDTHS (scratch/fable-design/DESIGN-atomic-beans-fable.md; Marty, 10 Nov 2026).
 *
 * Every balance, amount, fee, price, floor, cap, budget, vouch and room gift is a whole number of hundredths of a Bean:
 * 1 Bean = 100. The node's columns are INTEGER `*_c`, the wire carries integer `*_c` fields, signed bodies carry the
 * integer, and this is the ONE module that makes a money figure from anything else (a whole-Bean constant, typed text),
 * turns one into words, or takes a share of one. Everyone else adds and subtracts with `+` and `-`, compares with `<`
 * and `===`, and never multiplies a money figure except through `shareOf`.
 *
 * WHY. Beans were IEEE-754 floats: `0.1 + 0.2` is not `0.3`, a 1.5 % fee of a whole amount is rarely a whole
 * hundredth, and the node carried a dust sweep, 4-decimal rounding and a 0.01 audit slack to paper over the gap. A JS
 * number holds integers exactly to 2^53 (90 trillion Beans) and SQLite's INTEGER is 64-bit and sums exactly, so with
 * whole hundredths every move is three integers that sum to zero, and the audit asks `===`.
 *
 * ONE ROUNDING RULE. A rate-based charge (the Commons fee, the cross-node fee, circulation) is truncated to whole
 * hundredths ONCE, by `shareOf`, and the value is passed down, never recomputed. The half-hundredth stays with the
 * member it would have come from (the seller's receipt on a deal, the holder's balance on circulation), never with the
 * Commons. A split (`halves`) truncates every share but the last, which takes the remainder.
 *
 * Pure: no I/O, no Node built-ins (the barrel is bundled for the phone, barrel-is-universal.test.ts).
 */

import { currentLanguage, numberTextIn, type UiLang } from './words.js';
import { lexAmount, type AmountRefusal } from './amount-input.js';

/** A whole number of hundredths of a Bean. A plain number at runtime; `isHundredths` is the check every boundary asks. */
export type Hundredths = number;

/** Hundredths in one Bean. */
export const HUNDREDTHS_PER_BEAN = 100;

/**
 * Is this a money figure: a safe integer (any sign; a balance can be negative)? Every boundary asks it (a request body, a
 * row read back, an import, a node's answer) and refuses anything else: a float, a numeric string, NaN, Infinity.
 */
export function isHundredths(x: unknown): x is Hundredths {
    return typeof x === 'number' && Number.isSafeInteger(x);
}

/** A money figure a move may carry: whole hundredths, 0 or more. */
export function isMoveAmount(x: unknown): x is Hundredths {
    return isHundredths(x) && x >= 0;
}

/**
 * Whole Beans to hundredths, for constants only (`beans(500)` is 50000). Throws unless `n` is a safe integer and the
 * result is one: a constant that is not whole Beans is a bug to find at load, not a figure to round.
 */
export function beans(n: number): Hundredths {
    if (!Number.isSafeInteger(n)) throw new RangeError(`beans(): ${String(n)} is not a whole number of Beans`);
    const c = n * HUNDREDTHS_PER_BEAN;
    if (!Number.isSafeInteger(c)) throw new RangeError(`beans(): ${String(n)} Beans is too large`);
    return c;
}

/**
 * THE rounding function: `amount × num / den`, in exact integer arithmetic, rounded toward zero. Non-negative inputs
 * only (a share of a debt is not a thing here); throws otherwise, and on an intermediate past 2^53.
 */
export function shareOf(amount: Hundredths, num: number, den: number): Hundredths {
    if (!isMoveAmount(amount)) throw new RangeError(`shareOf(): ${String(amount)} is not whole hundredths ≥ 0`);
    if (!Number.isSafeInteger(num) || num < 0) throw new RangeError(`shareOf(): numerator ${String(num)} is not a whole number ≥ 0`);
    if (!Number.isSafeInteger(den) || den <= 0) throw new RangeError(`shareOf(): denominator ${String(den)} is not a whole number > 0`);
    const p = amount * num;
    if (!Number.isSafeInteger(p)) throw new RangeError('shareOf(): the product is too large to be exact');
    return (p - (p % den)) / den;
}

/** The Commons fee on a deal: 1.5 %, as FEE_NUM / FEE_DEN, read only by feeOf. */
export const FEE_NUM = 15;
export const FEE_DEN = 1000;

/**
 * The fee on `amount`, truncated: 1 Bean (100) → 1, 66 → 0, 67 → 1, 6667 → 100. Computed once per move; the payee gets
 * `amount − feeOf(amount)`, so the half-hundredth stays with them, never with the Commons.
 */
export function feeOf(amount: Hundredths): Hundredths {
    return shareOf(amount, FEE_NUM, FEE_DEN);
}

/**
 * A total split in two: the first share truncated, the second the rest, so the two always sum to the total.
 * 1235 → [617, 618]; 1 → [0, 1]. Any other split takes the same shape: truncated shares, the last takes the remainder.
 */
export function halves(total: Hundredths): [Hundredths, Hundredths] {
    if (!isMoveAmount(total)) throw new RangeError(`halves(): ${String(total)} is not whole hundredths ≥ 0`);
    const first = (total - (total % 2)) / 2;
    return [first, total - first];
}

export type ParsedHundredths = { ok: true; value: Hundredths } | { ok: false; refusal: AmountRefusal };

/**
 * An amount a member types, in `lang` (the device's language when absent), as whole hundredths, or why it is refused.
 * The same reading as parseAmount (the language's decimal mark, its own digits, nothing that could mean two numbers),
 * at most two decimals (the one rule everywhere), and the figure made by string work, never `Number("49.25")`:
 * "49.25" → 4925, "0.5" → 50, "12" → 1200. Never throws; 0 is a figure (each door checks above 0 itself).
 */
export function parseHundredths(text: string, lang?: UiLang): ParsedHundredths {
    const lexed = lexAmount(text, lang, 2);
    if (!lexed.ok) return lexed;
    if (lexed.negative) return { ok: false, refusal: 'negative' };
    const whole = (lexed.whole.replace(/^0+(?=\d)/, '') || '0');
    const fraction = lexed.fraction.padEnd(2, '0');
    // Past 2^53 hundredths no figure is exact: refused as not a number rather than rounded.
    if (whole.length > 15) return { ok: false, refusal: 'not-a-number' };
    const value = Number(whole) * HUNDREDTHS_PER_BEAN + Number(fraction);
    if (!Number.isSafeInteger(value)) return { ok: false, refusal: 'not-a-number' };
    return { ok: true, value };
}

/** U+2212, the true minus a balance below zero is written with. */
export const MINUS_SIGN = '−';

/**
 * A money figure in words: "0.01", "1", "49.25", "−9.82", "500", "1,234.56" (en) / "1234,56" (fr). No decimals when
 * whole, always two otherwise ("49.50"), a true minus, thousands grouped the way formatCount groups them (English
 * only), the language's decimal mark and digits. Never a number for something that is not whole hundredths: "—".
 */
export function formatHundredths(c: unknown, lang?: UiLang): string {
    if (!isHundredths(c)) return '—';
    const l = lang ?? currentLanguage();
    const abs = Math.abs(c);
    const fraction = abs % HUNDREDTHS_PER_BEAN;
    const whole = (abs - fraction) / HUNDREDTHS_PER_BEAN;
    const wholeText = l === 'en' ? String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : String(whole);
    const ascii = fraction === 0 ? wholeText : `${wholeText}.${String(fraction).padStart(2, '0')}`;
    return `${c < 0 ? MINUS_SIGN : ''}${numberTextIn(ascii, l)}`;
}

/**
 * A money figure as plain ASCII for machine text (a CSV export, a log line): "49.25", "-9.82", "500". Not for a person
 * to read in their language: formatHundredths is.
 */
export function hundredthsAsDecimalText(c: Hundredths): string {
    if (!isHundredths(c)) throw new RangeError(`hundredthsAsDecimalText(): ${String(c)} is not whole hundredths`);
    const abs = Math.abs(c);
    const fraction = abs % HUNDREDTHS_PER_BEAN;
    const whole = (abs - fraction) / HUNDREDTHS_PER_BEAN;
    return `${c < 0 ? '-' : ''}${whole}${fraction === 0 ? '' : `.${String(fraction).padStart(2, '0')}`}`;
}

/** The whole Beans in a figure, rounded toward zero: for a count shown beside a figure (a tier's "200"), never for money moved. */
export function wholeBeansOf(c: Hundredths): number {
    if (!isHundredths(c)) return 0;
    return Math.trunc(c / HUNDREDTHS_PER_BEAN);
}

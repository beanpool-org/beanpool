/**
 * Money in a request body (DESIGN-atomic-beans-fable.md §1 "Wire"): whole hundredths of a Bean, a JSON integer, in a field
 * named `*_c` (`{ to, amount_c: 2000, memo }`). Never a decimal string, never a float. A body that carries anything else
 * for it (the old `amount`, 20.5, "2000", 0, a negative) is answered 400 `amount_c_required`, before anything is read or
 * moved, so an app from before whole hundredths is told plainly rather than sending a figure 100 times too small.
 */
import { isHundredths } from '@beanpool/core';
import { word } from '@beanpool/core';

/** The refusal's code, for the apps to recognise (`{ error, code }`). */
export const AMOUNT_C_REQUIRED = 'amount_c_required';

/** The refusal's words: what an app from before whole hundredths, or a bad figure, gets. */
export const AMOUNT_C_REQUIRED_TEXT = word('The amount must be a whole number of hundredths of a Bean above 0. Update the app and try again.');

/** The field as whole hundredths above 0, or null when it is not one (missing, a float, a string, 0, a negative). */
export function positiveHundredthsOf(body: unknown, key = 'amount_c'): number | null {
    const v = body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;
    return isHundredths(v) && v > 0 ? v : null;
}

/**
 * The field as whole hundredths above 0, or, when it is not one, the 400 answer set on `ctx` and null: the caller returns.
 */
export function requirePositiveHundredths(ctx: { status: number; body: unknown }, body: unknown, key = 'amount_c'): number | null {
    const c = positiveHundredthsOf(body, key);
    if (c === null) {
        ctx.status = 400;
        ctx.body = { error: AMOUNT_C_REQUIRED_TEXT, code: AMOUNT_C_REQUIRED };
    }
    return c;
}

/**
 * An optional money field (a goal, a ceiling): absent or null is "none" (undefined / null as sent); otherwise whole
 * hundredths, 0 or more. Returns `{ ok: false }` for anything else, which the caller answers 400 amount_c_required.
 */
export function optionalHundredthsOf(body: unknown, key: string): { ok: true; value: number | null | undefined } | { ok: false } {
    const v = body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;
    if (v === undefined || v === null) return { ok: true, value: v as null | undefined };
    return isHundredths(v) && v >= 0 ? { ok: true, value: v } : { ok: false };
}

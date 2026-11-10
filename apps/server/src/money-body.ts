/**
 * Money in a request body (DESIGN-atomic-beans-fable.md §1 "Wire"): whole hundredths of a Bean, a JSON integer, in a field
 * named `*_c` (`{ to, amount_c: 2000, memo }`). Never a decimal string, never a float. A body that carries anything else
 * for it (the old `amount`, 20.5, "2000", 0, a negative) is answered 400 `amount_c_required`, before anything is read or
 * moved, so an app from before whole hundredths is told plainly rather than sending a figure 100 times too small.
 */
import { hundredthsAsDecimalText, isHundredths, parseHundredths } from '@beanpool/core';
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

/**
 * Whether a body carries a money field under its name from before whole hundredths (`goalAmount` for `goalAmount_c`,
 * `amount` for `amount_c`): an app from before them, whose figure in Beans would otherwise be read as ABSENT, which on an
 * optional field means something else entirely (no goal, a ceiling cleared, a whole pledge released). The caller answers
 * 400 amount_c_required before reading anything, as for any figure that isn't whole hundredths.
 */
export function carriesOldMoneyKey(body: unknown, oldKeys: readonly string[]): boolean {
    return !!body && typeof body === 'object' && oldKeys.some((k) => Object.prototype.hasOwnProperty.call(body, k));
}

/**
 * A price an owner's AI assistant gives in Beans (its tools speak Beans, agent/owner-posts.ts): a JSON number, 0 or more,
 * read as whole hundredths by the same string work a member's typed amount is (core parseHundredths), so 12.5 is 1250 and
 * a figure finer than a cent (0.1 + 0.2) is refused, never rounded. Null for anything else.
 */
export function hundredthsFromAssistantBeans(v: unknown): number | null {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
    const read = parseHundredths(String(v), 'en');
    return read.ok ? read.value : null;
}

/** A price as an owner's AI assistant reads it back: Beans, a JSON number (hundredthsAsDecimalText: "49.25" is 49.25). */
export function assistantBeansOf(c: unknown): number | null {
    return isHundredths(c) ? Number(hundredthsAsDecimalText(c)) : null;
}

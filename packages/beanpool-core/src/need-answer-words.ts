/**
 * "I can do this": the button and the confirm on a Need, on the phone and the web (cold start N4;
 * scratch/fable-design/DESIGN-cold-start-trades-fable.md §2.1, "The Need's screen").
 *
 *   [ I can do this ]
 *   You'd do it for 40 Beans. Sam agrees, you do it, Sam confirms, and the Beans are yours.
 *
 * It replaces "Offer to Fulfill" on a Need only: an Offer keeps "Accept this Offer?", a loan "Ask to borrow this?". The
 * sentence says the plain thing a helper wants to know before they tap: what they would be paid, who has to agree, and when
 * the Beans are theirs. The 1.5% circulation fee is not on this screen any more; it stays where the deal is, on the helper's
 * request card ("You have requested to earn … net after 1.5% transaction fee") and on the Payee's line once it is agreed
 * ("You are the Payee … minus 1.5% transaction fee"), so nothing was taken out of the member's sight, only moved to the
 * deal's own detail.
 *
 * One function for both apps, so the two cannot drift. The amount is the deal's own total in Beans (a price per hour is the
 * price times the hours typed), and the name is the one the Need already shows. With no name the sentence says "the person
 * who asked" instead of making one up; with nothing to pay it says so rather than "0 Beans".
 */
import { t, word } from './words.js';
import { beansPriceWords } from './event-copy.js';

export const NEED_ANSWER_WORDS = {
    /** The button that opens the confirm; the hand is the Need's mark, as on "✋ Fulfillment Requests". */
    button: word('✋ I can do this'),
    /** The confirm's heading. */
    title: word('I can do this'),
    paid: word("You'd do it for {price}. {name} agrees, you do it, {name} confirms, and the Beans are yours."),
    paidNameless: word('You\'d do it for {price}. The person who asked agrees, you do it, they confirm, and the Beans are yours.'),
    free: word("You'd do it for free. {name} agrees, you do it, and {name} confirms."),
    freeNameless: word("You'd do it for free. The person who asked agrees, you do it, and they confirm."),
} as const;

/**
 * The sentence under "I can do this". `total` is what the deal would pay in Beans (the Need's price times the quantity the
 * helper typed, if it is priced by the hour, day, week or month); `name` is the one who asked, as the Need shows them.
 * Rounded to two decimals as every other Beans amount is on these screens. Not a finite positive number reads as free.
 */
export function needAnswerLine(total: number, name?: string | null): string {
    const beans = Number.isFinite(total) && total > 0 ? Math.round(total * 100) / 100 : 0;
    const who = typeof name === 'string' ? name.trim() : '';
    if (!beans) return who ? t(NEED_ANSWER_WORDS.free, { name: who }) : t(NEED_ANSWER_WORDS.freeNameless);
    const price = beansPriceWords({ beans, per: 'fixed' });
    return who ? t(NEED_ANSWER_WORDS.paid, { price, name: who }) : t(NEED_ANSWER_WORDS.paidNameless, { price });
}

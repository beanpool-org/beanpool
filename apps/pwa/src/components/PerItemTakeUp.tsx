/**
 * The buyer's "How many would you like?" for an Offer priced for each one, inside the item page's confirm box
 * (pages/MarketplacePage.tsx; DESIGN-per-item-price-fable.md §2.2, slice P3): Choose how many, with a stepper (− and + are 48 px,
 * the count a box between them) and "300 Beans each · 20 left"; "All 20 for 5,500 Beans" while the price for all shows; the total
 * and what goes into trust; and why Confirm can't go yet. The phone's components/PerItemTakeUp.tsx is the same, and every line
 * and rule is @beanpool/core per-item-deal.ts (itemTakeUpBox), which both read; what Confirm sends is its `send`.
 *
 * Neutral greys, the commit green for the ticked choice and the form's own error ink only, so dark mode comes with them.
 */
import { useId } from 'react';
import { itemBoxPick, itemBoxStep, itemBoxTyped, type ItemBoxState, type ItemTakeUpBox } from '@beanpool/core';

export interface PerItemTakeUpProps {
    /** The listing as the page holds it (core perItemOf reads the web's post). */
    listing: unknown;
    /** core itemTakeUpBox(listing, state, seller): every line the box shows. */
    box: ItemTakeUpBox;
    state: ItemBoxState;
    onState: (next: ItemBoxState) => void;
    /** The node's refusal of the last Confirm (core itemTakeUpRefusalIn), said until the count is changed. */
    nodeRefusal?: string | null;
    disabled?: boolean;
}

const STEP = 'w-12 h-12 shrink-0 rounded-lg border border-nature-300 dark:border-nature-600 bg-white dark:bg-nature-900 text-nature-900 dark:text-white text-xl font-extrabold disabled:opacity-40 disabled:cursor-not-allowed';
const CHOICE = 'flex items-start gap-3 py-2 min-h-[48px] w-full text-left cursor-pointer';
const NOTE = 'block text-[13px] leading-snug text-nature-600 dark:text-nature-300 mt-0.5';

/**
 * A choice's ring, drawn (the browser's own radio is a solid white disc in dark, which reads as ticked): a grey ring, or the
 * commit green with its dot when ticked, as the phone draws it. The real radio beside it is kept for the keyboard and screen readers.
 */
function Ring({ on }: { on: boolean }) {
    return (
        <span aria-hidden="true" className={`mt-0.5 h-5 w-5 shrink-0 rounded-full border-2 flex items-center justify-center peer-focus-visible:ring-2 peer-focus-visible:ring-terra-500 ${on ? 'border-bp-commit-fill' : 'border-nature-500 dark:border-nature-300'}`}>
            {on && <span className="h-2.5 w-2.5 rounded-full bg-bp-commit-fill" />}
        </span>
    );
}

export function PerItemTakeUp({ listing, box, state, onState, nodeRefusal = null, disabled = false }: PerItemTakeUpProps) {
    const id = useId();
    const each = box.option === 'each';
    const off = disabled || box.max === 0;
    const refusal = nodeRefusal ?? box.refusal;
    return (
        <div data-testid="each-take-up" role="radiogroup" aria-label={box.title} className="mb-3">
            <label className={CHOICE} data-testid="each-choose">
                <input type="radio" name={`${id}-way`} className="peer sr-only" checked={each} disabled={off}
                    onChange={() => onState(itemBoxPick(listing, state, 'each'))} />
                <Ring on={each} />
                <span className="min-w-0">
                    <span className="block text-[15px] font-bold text-nature-900 dark:text-white">{box.chooseLabel}</span>
                    <span className={NOTE} data-testid="each-line">{box.eachLine}</span>
                </span>
            </label>
            <div className="flex items-center gap-2 mt-1 ml-8">
                <button type="button" data-testid="each-less" className={STEP} disabled={off || !box.canLess} onClick={() => onState(itemBoxStep(listing, state, -1))}>−</button>
                <input data-testid="each-count" aria-label={box.chooseLabel} type="text" inputMode="numeric" maxLength={4} disabled={off} value={box.count}
                    onChange={(e) => onState(itemBoxTyped(listing, e.target.value))}
                    className="w-20 h-12 min-w-0 rounded-lg border border-nature-300 dark:border-nature-600 bg-white dark:bg-nature-900 text-nature-900 dark:text-white text-lg font-extrabold text-center focus:outline-none focus:ring-2 focus:ring-terra-500" />
                <button type="button" data-testid="each-more" className={STEP} disabled={off || !box.canMore} onClick={() => onState(itemBoxStep(listing, state, 1))}>+</button>
            </div>
            {box.lot && (
                <label className={`${CHOICE} mt-1`} data-testid="each-all">
                    <input type="radio" name={`${id}-way`} className="peer sr-only" checked={!each} disabled={off}
                        onChange={() => onState(itemBoxPick(listing, state, 'lot'))} />
                    <Ring on={!each} />
                    <span className="min-w-0">
                        <span className="block text-[15px] font-bold text-nature-900 dark:text-white">{box.lot.label}</span>
                        {box.lot.saving && <span className={NOTE}>{box.lot.saving}</span>}
                    </span>
                </label>
            )}
            {box.total && <p data-testid="each-total" className="m-0 mt-2 text-base font-extrabold text-nature-900 dark:text-white break-words">{box.total}</p>}
            {box.trust && <p data-testid="each-trust" className="m-0 mt-1 text-[13px] leading-snug text-nature-600 dark:text-nature-300 break-words">{box.trust}</p>}
            {refusal && <p data-testid="each-refusal" role="alert" className="m-0 mt-2 text-[13px] leading-snug text-bp-ink-danger font-semibold break-words">{refusal}</p>}
        </div>
    );
}

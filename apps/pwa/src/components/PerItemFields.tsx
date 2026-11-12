/**
 * The seller's two extra boxes for a listing priced for each one, on the web's create form (pages/MapPage.tsx) and its edit
 * form (pages/MarketplacePage.tsx): HOW MANY DO YOU HAVE?, and OR ALL OF THEM FOR (OPTIONAL) with its one live line
 * (DESIGN-per-item-price-fable.md §2.4, §2.5, slice P4). The price for one is the form's own price box, which on Each reads
 * PRICE FOR ONE. The phone's components/PerItemFields.tsx is the same, and every sentence and rule is @beanpool/core
 * per-item-form.ts, which both read, so the two say and send the same.
 *
 * Neutral greys and the form's own error classes only (no brand shade on a control), so dark mode comes with them.
 */
import { useId, type CSSProperties } from 'react';
import {
    perItemLines, perItemLotHint, perItemIsFree, upperCase,
    type PerItemField, type PerItemFormText,
} from '@beanpool/core';

export interface PerItemFieldsProps {
    text: PerItemFormText;
    onCount: (v: string) => void;
    onLot: (v: string) => void;
    /** The create form asks "HOW MANY DO YOU HAVE?"; the edit form "HOW MANY DO YOU HAVE LEFT?". */
    edit?: boolean;
    /** The box a refusal is about, marked, and its sentence under it. */
    refusal?: { field: PerItemField; text: string } | null;
    /** Edit: "3 are held for buyers now. They are not counted here." */
    heldNote?: string | null;
    /** Edit: "Your price for all of them was for 20. There are 17 left, so it is not showing. …" */
    lotForOtherLine?: string | null;
    /** The create form's inputs and the edit form's differ in their dark ground (the edit's are styled by its own variables). */
    variant?: 'create' | 'edit';
    /** The edit form's own input style (its dark-aware variables), applied inline as its other boxes are. */
    inputStyle?: CSSProperties;
}

const BASE = 'w-full py-3 px-4 rounded-xl border text-[15px] font-bold focus:outline-none focus:ring-2 focus:ring-terra-500 shadow-sm transition-all';
const CREATE_INPUT = `${BASE} bg-white dark:bg-nature-800 text-nature-900 dark:text-white`;
const EDIT_INPUT = `${BASE} bg-white text-nature-900 dark:bg-bg-input dark:text-text-primary`;
const OK_BORDER = { create: 'border-nature-200 dark:border-nature-700', edit: 'border-nature-200 dark:border-nature-500' };
const BAD_BORDER = 'border-red-400 bg-red-50 ring-1 ring-red-400';

export function PerItemFields({ text, onCount, onLot, edit = false, refusal = null, heldNote = null, lotForOtherLine = null, variant = 'create', inputStyle }: PerItemFieldsProps) {
    const id = useId();
    const inputClass = variant === 'edit' ? EDIT_INPUT : CREATE_INPUT;
    const free = perItemIsFree(text);
    const bad = (field: PerItemField) => refusal?.field === field;
    // A refusal on this box says what the live line would (not less than one by one): said once, in red, under the box.
    // A price for all that was set for another number says so in its place (§2.5) rather than "leave this empty to sell one by one".
    const staleLine = lotForOtherLine && text.lot.trim() === '' ? lotForOtherLine : null;
    const hint = free || bad('lot') || staleLine ? null : perItemLotHint(text);
    const label = 'block text-xs font-bold text-nature-500 dark:text-nature-300 uppercase tracking-widest mb-1 mt-2';
    const line = 'text-[13px] leading-snug text-nature-600 dark:text-nature-300 mt-1';
    return (
        <div className="mb-3" data-testid="per-item-fields">
            <label htmlFor={`${id}-count`} className={label}>
                {upperCase(edit ? perItemLines.howManyLeft() : perItemLines.howManyHave())} <span className="text-bp-ink-danger">*</span>
            </label>
            <input
                id={`${id}-count`}
                data-testid="per-item-count"
                type="text"
                inputMode="numeric"
                maxLength={4}
                placeholder="20"
                value={text.count}
                onChange={e => onCount(e.target.value)}
                aria-invalid={bad('count') || undefined}
                className={`${inputClass} ${bad('count') ? BAD_BORDER : OK_BORDER[variant]}`}
                style={inputStyle}
            />
            {bad('count') ? <p role="alert" data-testid="per-item-refusal" className="text-[13px] leading-snug text-bp-ink-danger font-semibold mt-1">{refusal!.text}</p> : null}
            {heldNote ? <p data-testid="per-item-held" className={line}>{heldNote}</p> : null}

            {/* A Free listing has no price for all of them, so its box is not drawn. */}
            {!free ? (<>
                <label htmlFor={`${id}-lot`} className={label}>{upperCase(perItemLines.orAllOfThemFor())}</label>
                <input
                    id={`${id}-lot`}
                    data-testid="per-item-lot"
                    type="text"
                    inputMode="decimal"
                    maxLength={10}
                    placeholder="5500"
                    value={text.lot}
                    onChange={e => onLot(e.target.value)}
                    aria-invalid={bad('lot') || undefined}
                    className={`${inputClass} ${bad('lot') ? BAD_BORDER : OK_BORDER[variant]}`}
                    style={inputStyle}
                />
                {bad('lot') ? <p role="alert" data-testid="per-item-refusal" className="text-[13px] leading-snug text-bp-ink-danger font-semibold mt-1">{refusal!.text}</p> : null}
                {staleLine ? <p data-testid="per-item-lot-other" className={line}>{staleLine}</p> : null}
                {hint ? <p data-testid="per-item-hint" className={line}>{hint.text}</p> : null}
            </>) : null}
        </div>
    );
}

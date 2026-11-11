/**
 * "Vouch for them: None · 25 · 50 · 75 · 100" on the invite screen, for someone who can vouch and nobody else
 * (core VOUCH_PRESETS; InvitePage owns the choice, and None is what it holds each time the screen opens).
 *
 * Shows:
 *   - "From your budget: 550 of 1,000 left" under it
 *   - A preset above what is left is greyed ("Not enough budget left")
 *   - A raise (`raiseFrom`, slice I6): "Raise to: 200 · 500", the totals above what you vouched for this person already
 *     (core raiseTargetsFor, up to your most), no None; a choice is greyed only when the difference it draws is more than the
 *     budget has left
 *   - Nothing left: "No budget left. Ask an owner for more."
 *   - An owner (`noLimit`, Marty 9 Nov): 200 and 500 too, none greyed for budget, and "From your budget: No limit"
 *
 * Accessible radios, wrapping cleanly at 320 px with 1.3x text; each choice >= 44 px tall.
 */
import { useId } from 'react';
import { formatHundredths, t, vouchPresetsFor, raiseTargetsFor, vouchPresets, wholeBeansOf } from '@beanpool/core';

/** Every figure here is whole hundredths of a Bean: core's presets and caps, the node's budget (GET /api/vouchers/me). */
export interface VouchPresetChoiceProps {
    value: number | null;
    onChange: (value: number | null) => void;
    budgetLeft: number;
    budgetTotal: number;
    /**
     * What you have vouched for this person already (the node's figure), above 0 on a raise: the choices are then the totals
     * the vouch can be raised TO, with no None, and a choice draws only the difference (so it is greyed on that, not on its total).
     */
    raiseFrom?: number;
    /**
     * The node's `noLimit` for the signer (GET /api/vouchers/me): an owner vouches with no budget limit (Marty, 9 Nov), so
     * the presets are core's six (200 and 500 too), none greyed for budget, 500 for one person, and "From your budget: No limit".
     */
    noLimit?: boolean;
}

export function VouchPresetChoice({ value, onChange, budgetLeft, budgetTotal, raiseFrom, noLimit = false }: VouchPresetChoiceProps) {
    const id = useId();
    const raising = raiseFrom !== undefined && raiseFrom > 0;
    const noneLeft = !noLimit && budgetLeft <= 0;
    const subtitle = noLimit
        ? t(vouchPresets.fromBudgetNoLimit)
        : noneLeft
            ? t(vouchPresets.noneLeft)
            : t(vouchPresets.fromBudget, { left: formatHundredths(budgetLeft), total: formatHundredths(budgetTotal) });

    const picks = raising ? raiseTargetsFor(noLimit, raiseFrom) : vouchPresetsFor(noLimit);
    const choices: { amount: number | null; label: string; ariaLabel: string; disabled: boolean; why?: string }[] = [
        ...(raising ? [] : [{ amount: null, label: t(vouchPresets.none), ariaLabel: t(vouchPresets.none), disabled: false }]),
        ...picks.map((p) => {
            // A raise draws the difference from the budget, a first vouch its whole amount.
            const notEnoughBudget = !noLimit && (raising ? p - raiseFrom : p) > budgetLeft;
            return {
                amount: p,
                label: formatHundredths(p),
                ariaLabel: t(vouchPresets.beans, { amount: formatHundredths(p) }),
                disabled: notEnoughBudget,
                why: notEnoughBudget ? t(vouchPresets.notEnough) : undefined,
            };
        }),
    ];

    return (
        <fieldset className="mb-4 border-0 p-0 m-0 min-w-0" data-testid="invite-vouch">
            <legend className="p-0 mb-1 text-[14px] font-bold text-nature-950 dark:text-white">
                {raising ? t(vouchPresets.raiseTo) : t(vouchPresets.label)}
            </legend>
            <p className="m-0 mb-2 text-xs text-nature-500 dark:text-nature-400">
                {subtitle}
            </p>
            <div className="flex flex-wrap gap-2">
                {choices.map(({ amount, label, ariaLabel, disabled, why }) => {
                    const checked = amount === value;
                    return (
                        <label
                            key={String(amount)}
                            className={`relative flex-auto min-w-[52px] ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                            title={disabled ? why : undefined}
                        >
                            <input
                                type="radio"
                                name={`invite-vouch-${id}`}
                                className="peer sr-only"
                                checked={checked}
                                disabled={disabled}
                                onChange={() => { if (!disabled) onChange(amount); }}
                                aria-label={ariaLabel}
                                aria-disabled={disabled}
                                data-testid={`invite-vouch-${amount === null ? 'none' : wholeBeansOf(amount)}`}
                            />
                            <span
                                className={`flex min-h-[44px] items-center justify-center rounded-xl border px-2 py-2 text-[14px] font-bold transition-colors ${
                                    checked
                                        ? 'border-transparent bg-bp-commit-fill text-bp-commit-on'
                                        : disabled
                                            ? 'border-nature-200 dark:border-nature-800 bg-bp-chip-quiet-tint text-bp-chip-quiet-ink'
                                            : 'border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-900 text-nature-950 dark:text-white hover:border-nature-300 dark:hover:border-nature-600'
                                } peer-focus-visible:ring-2 peer-focus-visible:ring-emerald-500`}
                            >
                                {label}
                            </span>
                        </label>
                    );
                })}
            </div>
        </fieldset>
    );
}

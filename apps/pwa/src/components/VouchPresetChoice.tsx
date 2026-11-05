/**
 * "Vouch for them: None · 25 · 50 · 75 · 100" on the invite screen, for someone who can vouch and nobody else
 * (core VOUCH_PRESETS; InvitePage owns the choice, and None is what it holds each time the screen opens).
 *
 * Shows:
 *   - "From your budget: 550 of 1,000 left" under it
 *   - A preset above what is left is greyed ("Not enough budget left")
 *   - Nothing left: "No budget left. Ask an owner for more."
 *
 * Accessible radios, wrapping cleanly at 320 px with 1.3x text; each choice >= 44 px tall.
 */
import { formatNumber, t, VOUCH_PRESETS, vouchPresets } from '@beanpool/core';

export interface VouchPresetChoiceProps {
    value: number | null;
    onChange: (value: number | null) => void;
    budgetLeft: number;
    budgetTotal: number;
}

export function VouchPresetChoice({ value, onChange, budgetLeft, budgetTotal }: VouchPresetChoiceProps) {
    const noneLeft = budgetLeft <= 0;
    const subtitle = noneLeft
        ? t(vouchPresets.noneLeft)
        : t(vouchPresets.fromBudget, { left: formatNumber(budgetLeft), total: formatNumber(budgetTotal) });

    const choices: { amount: number | null; label: string; ariaLabel: string; disabled: boolean }[] = [
        { amount: null, label: t(vouchPresets.none), ariaLabel: t(vouchPresets.none), disabled: false },
        ...VOUCH_PRESETS.map((p) => ({
            amount: p,
            label: String(p),
            ariaLabel: t(vouchPresets.beans, { amount: p }),
            disabled: p > budgetLeft,
        })),
    ];

    return (
        <fieldset className="mb-4 border-0 p-0 m-0 min-w-0" data-testid="invite-vouch">
            <legend className="p-0 mb-1 text-[14px] font-bold text-nature-950 dark:text-white">
                {t(vouchPresets.label)}
            </legend>
            <p className="m-0 mb-2 text-xs text-nature-500 dark:text-nature-400">
                {subtitle}
            </p>
            <div className="flex flex-wrap gap-2">
                {choices.map(({ amount, label, ariaLabel, disabled }) => {
                    const checked = amount === value;
                    return (
                        <label
                            key={String(amount)}
                            className={`relative flex-auto min-w-[52px] ${disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`}
                            title={disabled ? t(vouchPresets.notEnough) : undefined}
                        >
                            <input
                                type="radio"
                                name="invite-vouch"
                                className="peer sr-only"
                                checked={checked}
                                disabled={disabled}
                                onChange={() => { if (!disabled) onChange(amount); }}
                                aria-label={ariaLabel}
                                aria-disabled={disabled}
                                data-testid={`invite-vouch-${amount ?? 'none'}`}
                            />
                            <span
                                className={`flex min-h-[44px] items-center justify-center rounded-xl border px-2 py-2 text-[14px] font-bold transition-colors ${
                                    checked
                                        ? 'border-transparent bg-bp-commit-fill text-bp-commit-on'
                                        : disabled
                                            ? 'border-nature-200 dark:border-nature-800 bg-nature-100 dark:bg-nature-900 text-nature-400 dark:text-nature-500'
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

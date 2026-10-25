/**
 * "Put this in your shop" on the web (parity with apps/native/components/shop/ShopToggle.tsx):
 * one checkbox row on an Offer's edit screen and composer tools.
 */
import { t } from '@beanpool/core';
import type { ShopToggleState } from '../../lib/shop';
export { shopIdForEdit, shopTakesOffers, shopToggleState, type ShopToggleState } from '../../lib/shop';

export function ShopToggle({
    state,
    on,
    onChange,
    testId = 'edit-post-shop',
}: {
    state: ShopToggleState;
    on: boolean;
    onChange: (on: boolean) => void;
    testId?: string;
}) {
    if (state.kind === 'hidden') return null;
    if (state.kind === 'paused' && !state.inShop) {
        return (
            <p className="m-0 text-sm text-nature-600 dark:text-nature-300 break-words" data-testid={`${testId}-paused`}>
                {t('Your shop is closed for now, so this stays out of it.')}
            </p>
        );
    }

    const where = state.kind === 'none' ? t('Your shop opens with it.') : state.title;

    return (
        <div className="flex flex-col gap-1.5 min-w-0">
            <button
                type="button"
                role="checkbox"
                aria-checked={on}
                aria-label={t('Put this in your shop: {where}', { where })}
                onClick={() => onChange(!on)}
                data-testid={testId}
                className="flex items-center gap-3 p-3 rounded-xl border border-nature-300 dark:border-nature-700 bg-white dark:bg-nature-900 hover:bg-nature-50 dark:hover:bg-nature-800 text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-brand min-w-0 min-h-[48px]"
            >
                <span
                    aria-hidden="true"
                    className={`w-6 h-6 rounded-md border flex items-center justify-center font-bold text-sm shrink-0 ${
                        on
                            ? 'bg-bp-commit-fill border-transparent text-bp-commit-on'
                            : 'border-nature-400 dark:border-nature-600 bg-white dark:bg-nature-950'
                    }`}
                >
                    {on ? '✓' : null}
                </span>
                <span className="min-w-0 flex-1">
                    <span className="block text-sm font-bold text-nature-900 dark:text-white break-words">
                        {t('Put this in your shop')}
                    </span>
                    <span
                        data-testid={state.kind === 'none' ? `${testId}-opens` : undefined}
                        className="block text-xs text-nature-600 dark:text-nature-300 break-words line-clamp-2"
                    >
                        {where}
                    </span>
                </span>
            </button>
            {state.kind === 'paused' ? (
                <p className="m-0 text-xs text-nature-600 dark:text-nature-300 break-words" data-testid={`${testId}-closed`}>
                    {t('Your shop is closed for now. Taken out, this stays out.')}
                </p>
            ) : null}
        </div>
    );
}

/**
 * CreditBarUnread (web): the credit card's place on the Ledger before the member's own balance is in (round 2 of #3134).
 * Nothing is drawn from an answer that isn't there: an empty answer reads as "no credit line yet", which is untrue for most
 * members, so the card waits for the real one (never a false state: onboarding-no-hard-gates).
 *
 * - Reading: the card's shape only (two quiet bars where the sentences go, the rainbow faded with no dot, no figure, no
 *   mark), and "Loading…" for a screen reader.
 * - Couldn't be read: core's one sentence (CREDIT_STANDING_WORDS.unread) and Try again.
 *
 * The phone's twin is apps/native/components/CreditBarUnread.tsx.
 */
import { CREDIT_STANDING_WORDS, t } from '@beanpool/core';
import { RAINBOW } from './CreditBar';

interface Props {
    /** The read failed: say so, with Try again. Otherwise it is still being read. */
    failed: boolean;
    /** Reads the balance again. */
    onRetry?: () => void;
}

export function CreditBarUnread({ failed, onRetry }: Props) {
    if (failed) {
        return (
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2" data-testid="credit-card-unread">
                <p role="alert" className="m-0 min-w-0 flex-1 basis-48 text-[0.84375rem] leading-snug text-nature-700 dark:text-nature-200">{t(CREDIT_STANDING_WORDS.unread)}</p>
                {onRetry && (
                    <button
                        type="button"
                        onClick={onRetry}
                        className="min-h-[44px] px-4 rounded-xl border-0 bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on text-sm font-bold cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                    >
                        {t('Try again')}
                    </button>
                )}
            </div>
        );
    }
    return (
        <div role="status" aria-busy="true" className="block" data-testid="credit-card-reading">
            <span className="sr-only">{t('Loading…')}</span>
            <span aria-hidden="true" className="block h-4 w-2/5 rounded bg-nature-100 dark:bg-nature-800" />
            <span aria-hidden="true" className="block mt-2 h-3 w-4/5 rounded bg-nature-100 dark:bg-nature-800" />
            <span aria-hidden="true" className="block mt-2 pt-7">
                <span className="block h-[15px] rounded-[9px] opacity-40" style={{ background: RAINBOW }} />
                <span className="block mt-[17px] h-3 w-full rounded bg-nature-100 dark:bg-nature-800" />
            </span>
        </div>
    );
}

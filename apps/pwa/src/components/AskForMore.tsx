/**
 * Ask for more (DESIGN-credit-list-amend-fable.md §3.6): a voucher's one tap, in three places (beside the budget line over the
 * People list's chips, on the Ledger's budget panel, and under the node's "You have … of budget left" refusal on the Give
 * credit sheet). No text field and no amount: an owner or the credit committee picks the level (5 Nov §10). The node says
 * whether they may ask and when they asked (`GET /api/vouchers/me` → `ask`): this never works that out; it draws the node's
 * answer, and after a tap it reads that answer again.
 *
 * States, in the node's words: ready · "Asked on 12 Nov · an owner or the credit committee will see it." · "You asked on 12 Nov.
 * You can ask again on 19 Nov." · frozen · paused. An owner (no budget, `ask` null) is shown nothing.
 */
import { useEffect, useState } from 'react';
import { t } from '@beanpool/core';
import { getMyVouching } from '../lib/api';
import { CREDIT_LIST_WORDS as W, askForMore, dayWords, refusalText, type AskState } from '../lib/credit-sight';

export interface AskForMoreProps {
    /** The node's state when the caller already read it (the Ledger's budget panel); read here when absent. */
    ask?: AskState | null;
    /** Called after a tap that landed, with the node's fresh state, so a caller that holds the state follows it. */
    onAsked?: (ask: AskState | null) => void;
}

export function AskForMore({ ask: given, onAsked }: AskForMoreProps) {
    const [ask, setAsk] = useState<AskState | null | undefined>(given);
    const [busy, setBusy] = useState(false);
    const [refusal, setRefusal] = useState<string | null>(null);
    useEffect(() => { if (given !== undefined) setAsk(given); }, [given]);
    useEffect(() => {
        if (given !== undefined) return;
        let alive = true;
        getMyVouching().then((v) => { if (alive) setAsk(v?.ask ?? null); }).catch(() => { if (alive) setAsk(null); });
        return () => { alive = false; };
    }, [given]);

    if (!ask) return null;

    async function tap() {
        setBusy(true);
        setRefusal(null);
        try {
            await askForMore();
            const fresh = (await getMyVouching().catch(() => null))?.ask ?? null;
            setAsk(fresh);
            onAsked?.(fresh);
        } catch (e) {
            // The node's own sentence ("You asked on 12 Nov. You can ask again on 19 Nov."), then its state again.
            setRefusal(refusalText(e, t('Could not ask just now.')));
            const fresh = (await getMyVouching().catch(() => null))?.ask ?? null;
            if (fresh) setAsk(fresh);
        } finally {
            setBusy(false);
        }
    }

    const note = 'm-0 text-[12px] leading-relaxed text-nature-700 dark:text-nature-300 break-words';
    let body;
    if (ask.blocked === 'frozen') body = <p className={note} data-testid="ask-blocked">{t(W.askFrozen)}</p>;
    else if (ask.blocked === 'paused') body = <p className={note} data-testid="ask-blocked">{t(W.askPaused)}</p>;
    else if (ask.askedAt) body = <p className={note} data-testid="ask-asked">{t(W.asked, { day: dayWords(ask.askedAt) })}</p>;
    else if (ask.lastAskedAt && ask.askAgainAt) {
        body = <p className={note} data-testid="ask-week">{t(W.askedWeek, { asked: dayWords(ask.lastAskedAt), again: dayWords(ask.askAgainAt) })}</p>;
    } else {
        body = (
            <button
                type="button"
                disabled={busy}
                onClick={tap}
                className="min-h-[44px] px-4 rounded-xl border border-bp-accent-fill bg-transparent text-text-primary text-sm font-bold cursor-pointer disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-bp-accent-fill"
                data-testid="ask-for-more"
            >
                {t(W.ask)}
            </button>
        );
    }
    return (
        <div data-testid="ask-for-more-box" aria-live="polite">
            {body}
            {refusal && <p role="alert" className={`${note} mt-2`} data-testid="ask-refusal">{refusal}</p>}
        </div>
    );
}

/**
 * "What people who give credit see" on the member's own Ledger (DESIGN-credit-list-amend-fable.md §5.4 with amendment 2 §0 item
 * 20; slice C6): exactly the answer a plain voucher gets about this member, read from `GET /api/credit/me` and drawn line for
 * line from core's `creditMeCard` (the phone draws the same card from the same function), so the two apps cannot say two things:
 *
 *   What people who give credit see
 *   Credit line 1,300 · can use all of it now
 *   Balance −420 · using 420 of 1,300
 *   ✓ Credit risk: low
 *   New here: no completed trade yet.  ·  An owner or admin can say more.
 *   People who give credit here (the owners, admins and vouchers) can see your balance and your credit line, and each look is recorded.
 *
 * As the profile card (CreditCard.tsx): the NODE decides what is said (a node with Beans off, or the worldwide community, is not
 * asked, and answers 404 if it were); NOTHING IS KEPT (the answer lives in this component's state while the Ledger is open:
 * not localStorage, IndexedDB or the service worker's cache, amendment 1 §5.1); no reason is composed here (each is core's
 * riskReasonSentence over the node's figures). The reasons are all said, with nothing to open: a mark a member must click to
 * read is half a hidden score. A read that fails draws nothing, never a half-card.
 */
import { useEffect, useState } from 'react';
import { creditMeCard, type CreditMeCard } from '@beanpool/core';
import { getCreditMe, nodeTakesCredit } from '../lib/credit-sight';
import { RiskWord } from './CreditLines';

export interface CreditSeenByGiversProps {
    /** Whose card: another member's is never drawn for this one while it is read (an account switch). */
    memberKey: string;
    /** Changes when the member's own balance may have: the card is read again, and the one on screen stays until the new answer lands. */
    reread?: unknown;
}

export function CreditSeenByGivers({ memberKey, reread }: CreditSeenByGiversProps) {
    const [read, setRead] = useState<{ who: string; card: CreditMeCard } | null>(null);

    useEffect(() => {
        let alive = true;
        (async () => {
            let card: CreditMeCard | null = null;
            try {
                // Only where credit lives (creditOnNode: Beans on, never the global node); elsewhere nothing is asked.
                if (await nodeTakesCredit()) {
                    const answer = await getCreditMe();
                    if (answer?.me) card = creditMeCard(answer.me);
                }
            } catch {
                // Not a member, Beans off, or offline: the card is not drawn. The node's refusal is the answer.
            }
            if (alive) setRead(card ? { who: memberKey, card } : null);
        })();
        return () => { alive = false; };
    }, [memberKey, reread]);

    if (!read || read.who !== memberKey) return null;
    const c = read.card;
    return (
        <section
            className="p-4 rounded-2xl bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 shadow-sm space-y-2"
            data-testid="credit-seen-by-givers"
            aria-labelledby="credit-seen-title"
        >
            <h3 id="credit-seen-title" className="m-0 text-base font-extrabold text-nature-950 dark:text-white">{c.title}</h3>
            <p className="m-0 text-[13px] font-medium text-nature-900 dark:text-nature-100 break-words" data-testid="credit-seen-line">{c.credit}</p>
            {c.liveOffers && (
                <p className="m-0 text-[12px] text-nature-700 dark:text-nature-300" data-testid="credit-seen-offers">{c.liveOffers}</p>
            )}
            <p className="m-0 text-[13px] text-nature-800 dark:text-nature-200 break-words" data-testid="credit-seen-balance">
                <span aria-hidden="true">{c.balance}</span>
                <span className="sr-only">{c.balanceSpoken}</span>
            </p>
            {c.paused && (
                // On its own line, so at 320 px with large text it never wraps in under the balance with a stray indent.
                <div>
                    <span className="inline-block rounded-lg px-2 py-0.5 text-[11px] font-bold bg-bp-chip-danger-tint text-bp-chip-danger-ink" data-testid="credit-seen-paused">
                        <span aria-hidden="true">✕ </span>{c.paused}
                    </span>
                </div>
            )}
            <div><RiskWord level={c.level} /></div>
            {c.reasons.length > 0 && (
                <ul className="m-0 mt-1 pl-4 list-disc text-[12px] leading-snug text-nature-700 dark:text-nature-300 break-words" data-testid="credit-seen-reasons">
                    {c.reasons.map((line, i) => <li key={i}>{line}</li>)}
                </ul>
            )}
            <p className="m-0 pt-2 border-t border-nature-200 dark:border-nature-800 text-[12px] leading-snug text-nature-600 dark:text-nature-300 break-words" data-testid="credit-seen-told">{c.told}</p>
        </section>
    );
}

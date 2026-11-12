/**
 * The credit card on a profile (DESIGN-credit-list-fable.md §3.4 with amendment 1 §3.4), above "Add to the names list" and the
 * Vouch box, for the same people: owners, admins and vouchers. Read from the node when the profile opens (one logged look a
 * day per viewer and person); a plain member's profile makes no credit request at all, and shows nothing.
 *
 *   Credit · only people who can give credit see this · each look is recorded
 *   Credit line 1,300 Beans · can use all of it now · 1 live Offer
 *   Balance −420 · using 420 of 1,300
 *   Made of: known floor 1,000 · vouched 200 (@marty 100, @olive 100) · earned 100      <- owners, admins
 *   Credit risk: low ›  (the reasons, each core's sentence)
 *   Looked at by: @jane 12 Nov · @marty 11 Nov                                          <- owners, admins (the Inspect list)
 *
 * A voucher's card is every line but "Made of" and "Looked at by", plus "You vouched 50" where they did. The node builds each
 * answer for its reader; this draws what it was sent and trims nothing. Nothing is kept: the card lives in state while the
 * profile is open.
 */
import { useEffect, useState } from 'react';
import { CREDIT_SIGHT_WORDS, formatHundredths, t } from '@beanpool/core';
import { request } from '../lib/api';
import { readInviteRole } from '../lib/node-invites';
import {
    CREDIT_LIST_WORDS as W, dayWords, getCreditLooks, getCreditPerson, isOwnerOrAdmin, type CreditPerson, type LookLine,
} from '../lib/credit-sight';
import type { MyVouching } from '../lib/api';
import { CreditLines } from './CreditLines';

export interface CreditCardProps {
    memberPubkey: string;
    /** What the profile already read about the viewer's own budget (a voucher holds one); not read twice. */
    myVouching: MyVouching | null;
}

export function CreditCard({ memberPubkey, myVouching }: CreditCardProps) {
    const [person, setPerson] = useState<CreditPerson | null>(null);
    const [full, setFull] = useState(false);
    const [looks, setLooks] = useState<LookLine[]>([]);

    useEffect(() => {
        let alive = true;
        setPerson(null);
        setLooks([]);
        (async () => {
            // Who may see it is the node's word: a voucher's own budget is already read, the role is asked of the node once.
            const owner = await request<{ role?: unknown }>('GET', '/api/node-admin/me').then((b) => isOwnerOrAdmin(readInviteRole(b?.role))).catch(() => false);
            if (!owner && myVouching?.voucher !== true) return;
            try {
                const card = await getCreditPerson(memberPubkey);
                if (!alive) return;
                setPerson(card.person);
                setFull(card.sight === 'owner' || card.sight === 'admin');
                if (owner && (card.sight === 'owner' || card.sight === 'admin')) {
                    // Who looked at this person: not itself logged (it shows no balance).
                    const l = await getCreditLooks({ member: memberPubkey, limit: 5 }).catch(() => null);
                    if (alive && l?.looks) setLooks(l.looks);
                }
            } catch {
                // Not listed, not a giver (any more), or offline: no card. The node's refusal is the answer.
            }
        })();
        return () => { alive = false; };
    }, [memberPubkey, myVouching?.voucher]);

    if (!person || person.own) return null;

    const p = person;
    const cap = p.parts?.cap_c ?? 0;
    const who = p.standsBehind?.vouchedBy.length
        ? ` (${p.standsBehind.vouchedBy.map((v) => `@${v.callsign} ${formatHundredths(v.amount_c)}`).join(', ')})`
        : '';
    const seen = looks.filter((l, i) => looks.findIndex((x) => x.actorPubkey === l.actorPubkey && x.day === l.day) === i);

    return (
        <section className="mx-4 mt-4 p-4 rounded-2xl bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 shadow-sm space-y-2" data-testid="credit-card" aria-labelledby={`credit-card-${memberPubkey.slice(0, 8)}`}>
            <h3 id={`credit-card-${memberPubkey.slice(0, 8)}`} className="m-0 text-base font-extrabold text-nature-950 dark:text-white">{t(W.cardTitle)}</h3>
            <p className="m-0 text-[12px] text-nature-600 dark:text-nature-300 break-words">{t(CREDIT_SIGHT_WORDS.onlyGivers)}</p>
            <CreditLines person={p} reasons="all" />
            {full && p.parts && (
                <p className="m-0 text-[12px] text-nature-700 dark:text-nature-300 break-words" data-testid="credit-made-of">
                    {t(W.madeOf, { known: formatHundredths(p.parts.known_c), vouched: formatHundredths(p.parts.room_c), who, earned: formatHundredths(p.parts.earned_c) })}
                    {p.parts.granted_c > 0 ? ` · ${t(W.madeOfGranted, { granted: formatHundredths(p.parts.granted_c) })}` : ''}
                </p>
            )}
            {cap > 0 && p.line_c >= cap && (
                <p className="m-0 text-[12px] text-nature-700 dark:text-nature-300 break-words" data-testid="credit-capped">{t(W.capped, { cap: formatHundredths(cap) })}</p>
            )}
            {!full && (p.youVouched_c ?? 0) > 0 && (
                <p className="m-0 text-[12px] font-bold text-nature-800 dark:text-nature-200" data-testid="credit-you-vouched">{t(W.youVouched, { amount: formatHundredths(p.youVouched_c) })}</p>
            )}
            {full && seen.length > 0 && (
                <p className="m-0 text-[12px] text-nature-700 dark:text-nature-300 break-words" data-testid="credit-looked-at-by">
                    {t(W.lookedAtBy)}: {seen.map((l) => `@${l.actorCallsign} ${dayWords(l.day)}`).join(' · ')}
                </p>
            )}
        </section>
    );
}

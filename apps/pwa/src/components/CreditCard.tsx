/**
 * The credit card on a profile (DESIGN-credit-list-fable.md §3.4 with amendment 1 §3.4), above "Add to the names list" and the
 * Vouch box, for the same people: owners, admins and vouchers. Read from the node when the profile opens (one logged look a
 * day per viewer and person); a plain member's profile makes no credit request at all, and shows nothing.
 *
 *   Credit · only people who can give credit see this · each look is recorded
 *   Credit line 1,300 · can use all of it now · 1 live Offer
 *   Balance −420 · using 420 of 1,300
 *   Made of: known floor 1,000 · vouched 200 · earned 100          <- owners, admins (a part of 0 is left out)
 *   Confirmed by @marty · Vouched by @marty 100, @olive 100        <- owners, admins: who stands behind the person
 *   Credit risk: low  (the reasons, each core's sentence)
 *   Looked at by: @jane 12 Nov · @marty 11 Nov                     <- owners, admins (the Inspect list)
 *
 * The order and the words are the phone's (components/CreditCard.tsx there), which splits the design's one "Made of" line
 * into three so each part is translated once.
 * A voucher's card is every line but "Made of", "Confirmed by", "Vouched by" and "Looked at by", plus "You vouched 50" where they did. The node builds each
 * answer for its reader; this draws what it was sent and trims nothing. Nothing is kept: the card lives in state while the
 * profile is open.
 */
import { useEffect, useState } from 'react';
import { CREDIT_SIGHT_WORDS, formatCount, formatHundredths, t, tn } from '@beanpool/core';
import { request } from '../lib/api';
import { readInviteRole } from '../lib/node-invites';
import {
    CREDIT_LIST_WORDS as W, dayWords, getCreditLooks, getCreditPerson, isOwnerOrAdmin, nodeTakesCredit, type CreditPerson, type LookLine,
} from '../lib/credit-sight';
import type { MyVouching } from '../lib/api';
import { BalanceLine, RiskReasons, RiskWord, creditSentenceOf } from './CreditLines';

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
            try {
                // Only where credit lives (creditOnNode: Beans on, never the global node); elsewhere nothing is asked.
                if (!(await nodeTakesCredit()) || !alive) return;
                // Who may see it is the node's word: a voucher's own budget is already read, the role is asked of the node once.
                const owner = await request<{ role?: unknown }>('GET', '/api/node-admin/me').then((b) => isOwnerOrAdmin(readInviteRole(b?.role))).catch(() => false);
                if (!owner && myVouching?.voucher !== true) return;
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
    const parts = p.parts;
    const cap = parts?.cap_c ?? 0;
    // What the line is made of: a part of 0 is left out, so a person with no credit yet reads no "Made of" line at all.
    const made = parts ? [
        parts.known_c > 0 && t(W.partKnown, { amount: formatHundredths(parts.known_c) }),
        parts.room_c > 0 && t(W.partVouched, { amount: formatHundredths(parts.room_c) }),
        parts.earned_c > 0 && t(W.partEarned, { amount: formatHundredths(parts.earned_c) }),
        parts.granted_c > 0 && t(W.partGranted, { amount: formatHundredths(parts.granted_c) }),
    ].filter((x): x is string => !!x) : [];
    const confirmer = p.standsBehind?.confirmedBy ?? null;
    const vouchers = p.standsBehind?.vouchedBy ?? [];
    // Over the cap: the parts add up to more than the community allows (the line is then the cap).
    const overCap = !!parts && cap > 0 && parts.known_c + parts.room_c + parts.earned_c + parts.granted_c > cap;
    const seen = looks.filter((l, i) => looks.findIndex((x) => x.actorPubkey === l.actorPubkey && x.day === l.day) === i);

    return (
        <section className="mx-4 mt-4 p-4 rounded-2xl bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 shadow-sm space-y-2" data-testid="credit-card" aria-labelledby={`credit-card-${memberPubkey.slice(0, 8)}`}>
            <h3 id={`credit-card-${memberPubkey.slice(0, 8)}`} className="m-0 text-base font-extrabold text-nature-950 dark:text-white">{t(W.cardTitle)}</h3>
            <p className="m-0 text-[12px] text-nature-600 dark:text-nature-300 break-words">{t(CREDIT_SIGHT_WORDS.onlyGivers)}</p>
            <p className="m-0 text-[13px] font-medium text-nature-900 dark:text-nature-100 break-words" data-testid="credit-sentence">{creditSentenceOf(p)}</p>
            {p.line_c > 0 && typeof p.liveOffers === 'number' && (
                <p className="m-0 text-[12px] text-nature-700 dark:text-nature-300" data-testid="credit-live-offers">
                    {tn(p.liveOffers, '{n} live Offer', '{n} live Offers', { n: formatCount(p.liveOffers) })}
                </p>
            )}
            <BalanceLine person={p} />
            {full && made.length > 0 && (
                <p className="m-0 text-[12px] text-nature-700 dark:text-nature-300 break-words" data-testid="credit-made-of">{t(W.madeOf, { parts: made.join(' · ') })}</p>
            )}
            {full && confirmer && (
                <p className="m-0 text-[12px] text-nature-700 dark:text-nature-300 break-words" data-testid="credit-confirmed-by">{t(W.confirmedBy, { name: confirmer.callsign })}</p>
            )}
            {full && vouchers.length > 0 && (
                <p className="m-0 text-[12px] text-nature-700 dark:text-nature-300 break-words" data-testid="credit-vouched-by">
                    {t(W.vouchedBy, { list: vouchers.map((v) => `@${v.callsign} ${formatHundredths(v.amount_c)}`).join(', ') })}
                </p>
            )}
            {overCap && (
                <p className="m-0 text-[12px] text-nature-700 dark:text-nature-300 break-words" data-testid="credit-capped">{t(W.capped, { cap: formatHundredths(cap) })}</p>
            )}
            {!full && (p.youVouched_c ?? 0) > 0 && (
                <p className="m-0 text-[12px] font-bold text-nature-800 dark:text-nature-200" data-testid="credit-you-vouched">{t(W.youVouched, { amount: formatHundredths(p.youVouched_c) })}</p>
            )}
            <div><RiskWord level={p.risk.level} /></div>
            <RiskReasons person={p} always />
            {full && seen.length > 0 && (
                <p className="m-0 text-[12px] text-nature-700 dark:text-nature-300 break-words" data-testid="credit-looked-at-by">
                    {t(W.lookedAtBy, { who: seen.map((l) => `@${l.actorCallsign} ${dayWords(l.day)}`).join(' · ') })}
                </p>
            )}
        </section>
    );
}

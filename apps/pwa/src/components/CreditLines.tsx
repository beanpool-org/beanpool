/**
 * What a giver reads about one person, in lines (DESIGN-credit-list-fable.md §3.2 with amendment 1 §3.2 and amendment 2): the
 * credit sentence, the balance beside the line, the credit risk as a word with a shape, and under a medium or high word the
 * reasons. Every sentence is core's: creditLineSentence, balanceSentence, riskLevelSentence, riskReasonSentence. This file
 * never composes a reason from its figures (amendment 2 §8), so the web, the phone and the node say one thing.
 *
 * Text wraps to as many lines as it needs and is never cut with "…" (§3.2). The risk is a word with a shape (○ ✓ ! ✕), never
 * colour alone; chip colours come from the central tokens, light and dark. A balance is read aloud with its sign ("minus 420
 * Beans"), the visible text hidden from a screen reader so it is not read twice.
 */
import {
    CREDIT_SIGHT_WORDS, RISK_SHAPES, balanceSentence, balanceSpoken, creditLineSentence, position, riskLevelSentence,
    riskReasonSentence, t, type RiskLevel,
} from '@beanpool/core';
import type { CreditPerson } from '../lib/credit-sight';

/** The word's chip, from the central tokens: quiet for "not known yet", ok for low, warn for medium, danger for high. */
const LEVEL_CHIP: Readonly<Record<RiskLevel, string>> = {
    not_known: 'bg-bp-chip-quiet-tint text-bp-chip-quiet-ink',
    low: 'bg-bp-chip-ok-tint text-bp-chip-ok-ink',
    medium: 'bg-bp-chip-warn-tint text-bp-chip-warn-ink',
    high: 'bg-bp-chip-danger-tint text-bp-chip-danger-ink',
};

/** The credit sentence for a person: frozen is the owners' and admins' answer, "can't be given" a voucher's. */
export function creditSentenceOf(p: CreditPerson): string {
    const frozen = !!p.frozen && (p.frozen.credit || p.frozen.known);
    return creditLineSentence({
        line_c: p.line_c, usable_c: p.usable_c, liveOffers: p.liveOffers,
        frozen, cantGive: !p.canGive && !p.own && !frozen,
    });
}

/** "✓ Credit risk: low": the word with its shape. */
export function RiskWord({ level }: { level: RiskLevel }) {
    return (
        <span className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-0.5 text-[12px] font-bold ${LEVEL_CHIP[level]}`} data-testid="credit-risk-word" data-level={level}>
            <span aria-hidden="true">{RISK_SHAPES[level]}</span>
            <span>{riskLevelSentence(level)}</span>
        </span>
    );
}

/** The reasons under a word, each core's sentence; "An owner or admin can say more." where an admins' reason moved a voucher's word. */
export function RiskReasons({ person, always = false }: { person: CreditPerson; always?: boolean }) {
    const { level, reasons, more } = person.risk;
    const lines = reasons.map((r) => riskReasonSentence(r)).filter((s): s is string => !!s);
    // On a row only the warnings are said (medium, high); the card and the sheet say every reason.
    const show = always || level === 'medium' || level === 'high';
    if (!show && !more) return null;
    return (
        <ul className="m-0 mt-1 pl-4 list-disc text-[12px] leading-snug text-nature-700 dark:text-nature-300 break-words" data-testid="credit-risk-reasons">
            {show && lines.map((s, i) => <li key={i}>{s}</li>)}
            {more && <li>{t(CREDIT_SIGHT_WORDS.adminsSayMore)}</li>}
        </ul>
    );
}

/** The balance with its line beside it (never alone, amendment §4.3 item 6), and the paused mark when they owe more than their Offers unlock. */
export function BalanceLine({ person }: { person: CreditPerson }) {
    const pos = position(person.balance_c, person.line_c, person.usable_c);
    return (
        <p className="m-0 text-[13px] text-nature-800 dark:text-nature-200 break-words" data-testid="credit-balance">
            <span aria-hidden="true">{balanceSentence(pos)}</span>
            <span className="sr-only">{balanceSpoken(pos)}</span>
            {pos.paused && (
                <span className="ml-2 inline-block rounded-lg px-2 py-0.5 text-[11px] font-bold bg-bp-chip-danger-tint text-bp-chip-danger-ink">
                    <span aria-hidden="true">✕ </span>{t(CREDIT_SIGHT_WORDS.spendingPaused)}
                </span>
            )}
        </p>
    );
}

/** The three lines of a row: the credit sentence, the balance, the risk word (and the reasons of a warning). */
export function CreditLines({ person, reasons = 'warnings' }: { person: CreditPerson; reasons?: 'warnings' | 'all' }) {
    return (
        <div className="space-y-1 min-w-0" data-testid="credit-lines">
            <p className="m-0 text-[13px] font-medium text-nature-900 dark:text-nature-100 break-words" data-testid="credit-sentence">{creditSentenceOf(person)}</p>
            <BalanceLine person={person} />
            <div><RiskWord level={person.risk.level} /></div>
            <RiskReasons person={person} always={reasons === 'all'} />
        </div>
    );
}

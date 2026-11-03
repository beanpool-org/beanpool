/**
 * A known community's rule as both apps read it: the node sends numbers and dates, the sentences are here and in
 * community-shape-card.ts, so the phone and the web app can't differ. Marty, 2 Nov: the rule is a sentence on the join screen
 * and the rules page, and nothing more: no tick, nothing to tap, no notice to a member.
 *
 * - {@link readKnownRule}: GET /api/community/known-rule, public, null from a node older than the rule (it draws nothing)
 *   or a community that doesn't confirm its members.
 * - {@link ruleStartsLine}: the admins' line for the rule's first 14 days.
 */
import { formatDate, t, word } from './words.js';

/** A known community's rule: the lines as the owner set them, and when a tightened one applies while it waits. */
export interface KnownRule {
    knownFloor: number;
    debtLinePct: number;
    quietDays: number;
    debtLineFrom: string | null;
    quietDaysFrom: string | null;
}

export const KNOWN_RULE_WORDS = {
    /** The community's admins, on the rule's first 14 days. */
    ruleStarts: word('The rule starts on {date}. Until then, only members confirmed since the notice began are listed.'),
};

const isDate = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const orNull = (v: unknown): string | null => (isDate(v) ? v : null);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A whole answer from a known community, or null: an older node's 404, `{ known: false }`, or an answer that isn't one. */
export function readKnownRule(v: unknown): KnownRule | null {
    const o = v as Partial<KnownRule> & { known?: unknown } | null;
    if (!o || o.known !== true || !num(o.knownFloor) || !num(o.debtLinePct) || !num(o.quietDays)) return null;
    return {
        knownFloor: o.knownFloor, debtLinePct: o.debtLinePct, quietDays: o.quietDays,
        debtLineFrom: orNull(o.debtLineFrom), quietDaysFrom: orNull(o.quietDaysFrom),
    };
}

/** The panels' line for the rule's first 14 days, or null once it has started or the date can't be read. */
export function ruleStartsLine(rule: { from?: unknown; started?: unknown } | null | undefined): string | null {
    if (!rule || rule.started !== false || !isDate(rule.from)) return null;
    return t(KNOWN_RULE_WORDS.ruleStarts, { date: formatDate(new Date(rule.from), 'day-month', { width: 'long' }) });
}

/**
 * What a member's app says about a known community's rule (scratch/fable-design/DESIGN-balance-rule-fable.md §1 to §4),
 * shared by the phone and the web app so the two can't differ: the node sends numbers and dates, the words are here.
 *
 * - {@link readKnownRule}: GET /api/community/known-rule, public, null from a node older than the rule (it draws nothing)
 *   or a community that doesn't confirm its members.
 * - {@link readMemberStanding}: `confirmed` and `confirmedAt` from GET /api/community/me.
 * - {@link ruleCardFor}: which of Home's two cards this account has yet to see. One at a time, never both.
 * - {@link stepBackAnswer}: POST /api/names/step-back's answer as the sheet says it, never a success the node didn't give.
 */
import { formatCount, formatDate, t, word } from './words.js';

/** A known community's rule: the lines as the owner set them, and when a tightened line or the rule itself applies. */
export interface KnownRule {
    knownFloor: number;
    debtLinePct: number;
    quietDays: number;
    ruleFrom: string | null;
    debtLineFrom: string | null;
    quietDaysFrom: string | null;
}

/** Whether the rule reaches this account, and since when. A new `confirmedAt` is a new confirmation. */
export interface MemberStanding {
    confirmed: boolean;
    confirmedAt: string | null;
}

/** What this account last put away with OK, per community: kept by each app. */
export interface RuleSeen {
    confirmedAt: string | null;
    ruleKey: string | null;
}

export type RuleCard =
    /** Confirmed since this account last looked: said once, and again after a re-confirmation. */
    | { kind: 'confirmed' }
    /** The rule reaches a member already confirmed on `on`: its first notice (`first`), or a tightened line. */
    | { kind: 'rule-changes'; on: string; first: boolean };

/** Apps/server config/balance-rule.ts RULE_NOTICE_DAYS: a member confirmed more than this before the start is on notice. */
export const RULE_NOTICE_DAYS = 14;

export const KNOWN_RULE_WORDS = {
    confirmedTitle: word("You're confirmed."),
    confirmedBody: word('An admin confirmed you as a member they know. Your credit line can now go to {amount} Beans.'),
    guideLine: word('The guide says what else an admin can see.'),
    changesTitle: word("Your community's rule on what the admins can see changes on {date}."),
    replacesEarlier: word('This replaces anything you agreed to before. There is nothing to withdraw now.'),
    stayOut: word("To stay out of it, step back from being confirmed in Settings before then. If you owe more than the ordinary credit line allows, the admins can see your balance until you're back within it."),
    ok: word('OK'),
    stayUnconfirmed: word("I'd rather stay unconfirmed"),
    sheetTitle: word('Step back from being confirmed?'),
    sheetBody: word("You keep the ordinary credit line and the admins don't see your balance. If you owe more than that line allows when you step back, they can see it until you're back within it. An admin can confirm you again later."),
    stepBack: word('Step back'),
    keepIt: word('Keep it'),
    steppingBack: word('Stepping back…'),
    settingsRow: word('Confirmed by an admin · step back'),
    steppedBack: word("You've stepped back. You have the ordinary credit line now."),
    steppedBackOwing: word("You've stepped back. You owe more than the ordinary credit line allows, so you can't borrow more for now, and the admins can see your balance until you're back within it."),
    notReached: word('Not saved: the community could not be reached.'),
    tryLater: word('Not saved. Try again later.'),
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
        ruleFrom: orNull(o.ruleFrom), debtLineFrom: orNull(o.debtLineFrom), quietDaysFrom: orNull(o.quietDaysFrom),
    };
}

/** The member's standing from /api/community/me, or null from a node older than the rule, which doesn't say. */
export function readMemberStanding(v: unknown): MemberStanding | null {
    const o = v as { confirmed?: unknown; confirmedAt?: unknown } | null;
    if (!o || typeof o.confirmed !== 'boolean') return null;
    return { confirmed: o.confirmed, confirmedAt: orNull(o.confirmedAt) };
}

/** Whether this member is still on the 14 days' notice: the rule hasn't started and they were confirmed before it was announced. */
function onNotice(me: MemberStanding, rule: KnownRule, now: number): boolean {
    if (!rule.ruleFrom || !me.confirmedAt) return false;
    const from = Date.parse(rule.ruleFrom);
    return now < from && Date.parse(me.confirmedAt) <= from - RULE_NOTICE_DAYS * 86_400_000;
}

/**
 * What is waiting to reach this member. Keyed on the two lines' dates, never the shape's version, which moves on every
 * community setting; and on the start date while they are on notice. All empty: nothing to tell.
 */
function ruleKeyFor(me: MemberStanding, rule: KnownRule, now: number): string {
    return [onNotice(me, rule, now) ? rule.ruleFrom : '', rule.debtLineFrom ?? '', rule.quietDaysFrom ?? ''].join('|');
}

const NOTHING_WAITING = '||';

/**
 * The card Home owes this account, or null. Not confirmed, or an answer missing: none. Newly confirmed: the confirmed card,
 * unless they are on notice, when that card's "the admins can see" isn't true yet and the notice says when it will be.
 * Otherwise the change they haven't seen. A member on notice is told the start date; a tightened line, its first date.
 */
export function ruleCardFor(me: MemberStanding | null, rule: KnownRule | null, seen: RuleSeen | null, now: number = Date.now()): RuleCard | null {
    if (!me?.confirmed || !me.confirmedAt || !rule) return null;
    const notice = onNotice(me, rule, now);
    if (seen?.confirmedAt !== me.confirmedAt && !notice) return { kind: 'confirmed' };
    const key = ruleKeyFor(me, rule, now);
    if (key === NOTHING_WAITING || seen?.ruleKey === key) return null;
    if (notice) return { kind: 'rule-changes', on: rule.ruleFrom as string, first: true };
    const waiting = [rule.debtLineFrom, rule.quietDaysFrom].filter(isDate).sort((a, b) => Date.parse(a) - Date.parse(b));
    return { kind: 'rule-changes', on: waiting[0], first: false };
}

/** What OK on either card puts away: the confirmation and whatever is waiting, which both cards state in today's numbers. */
export function ruleSeenNow(me: MemberStanding, rule: KnownRule, now: number = Date.now()): RuleSeen {
    return { confirmedAt: me.confirmedAt, ruleKey: ruleKeyFor(me, rule, now) };
}

/** A kept value read back, or null: anything that isn't one is as if nothing was seen, and the card shows again. */
export function readRuleSeen(v: unknown): RuleSeen | null {
    const o = v as Partial<RuleSeen> | null;
    if (!o || typeof o !== 'object') return null;
    return { confirmedAt: typeof o.confirmedAt === 'string' ? o.confirmedAt : null, ruleKey: typeof o.ruleKey === 'string' ? o.ruleKey : null };
}

/** The confirmed card's sentence about the floor. */
export function confirmedBody(rule: KnownRule): string {
    return t(KNOWN_RULE_WORDS.confirmedBody, { amount: formatCount(rule.knownFloor) });
}

/** The rule-changes card's heading, with its date in the member's language. */
export function ruleChangesTitle(on: string): string {
    return t(KNOWN_RULE_WORDS.changesTitle, { date: formatDate(new Date(on), 'day-month', { width: 'long' }) });
}

/** The panels' line for the rule's first 14 days, or null once it has started or the date can't be read. */
export function ruleStartsLine(rule: { from?: unknown; started?: unknown } | null | undefined): string | null {
    if (!rule || rule.started !== false || !isDate(rule.from)) return null;
    return t(KNOWN_RULE_WORDS.ruleStarts, { date: formatDate(new Date(rule.from), 'day-month', { width: 'long' }) });
}

export type StepBackAnswer = { ok: true; owing: boolean } | { ok: false; error: string };

/**
 * The step-back as the sheet says it. `post` answers the node's JSON and throws on a refusal with the node's own words, or
 * with "Request failed…" where it gave none (both apps' signed request). Only the node's `revoked` is a success: a 2xx
 * page from a proxy or a captive portal is not.
 */
export async function stepBackAnswer(post: () => Promise<unknown>): Promise<StepBackAnswer> {
    let answer: unknown;
    try {
        answer = await post();
    } catch (e) {
        if (e instanceof TypeError || !(e instanceof Error) || !e.message) return { ok: false, error: t(KNOWN_RULE_WORDS.notReached) };
        return { ok: false, error: e instanceof SyntaxError || /^Request failed/.test(e.message) ? t(KNOWN_RULE_WORDS.tryLater) : e.message };
    }
    const o = answer as { status?: unknown; owing?: unknown } | null;
    if (o?.status !== 'revoked') return { ok: false, error: t(KNOWN_RULE_WORDS.tryLater) };
    return { ok: true, owing: o.owing === true };
}

/** What the sheet says once the step-back is done. */
export function steppedBackLine(owing: boolean): string {
    return owing ? t(KNOWN_RULE_WORDS.steppedBackOwing) : t(KNOWN_RULE_WORDS.steppedBack);
}

/**
 * Community health on an admin's phone (community modes slice 6; apps/server engine/community-health.ts). The node
 * answers the exceptions by member key and names-list entry id, never a name: the name is overlaid here, from the
 * names list this phone has opened and decrypted. Every opening of the exceptions is in a log every admin can read.
 * The screen also shows the community's totals and, as a list of its own, every look at trades and alerts (#1608), as
 * packages/beanpool-guide/content/settings/what-the-admins-can-see.md promises.
 */
import type { OpenedEntry } from './names-list';

export type HealthReason = 'past_debt_line' | 'quiet_in_debit';

export interface HealthException {
    memberPubkey: string;
    entryId: string;
    balance: number;
    floor: number;
    reasons: HealthReason[];
}

/** An open debt a member left behind (#1597), by the entry id of their names-list entry. */
export interface DepartedDebt {
    id: string;
    entryId: string | null;
    amount: number;
    reason: 'removed' | 'account_deleted';
    removedAt: string;
    repaid: number;
    repaying: boolean;
}

export interface HealthExceptionsBody {
    settings: { debtLinePct: number; quietDays: number };
    exceptions: HealthException[];
    departed: DepartedDebt[];
}

export interface HealthLogLine {
    id: string;
    actor: string;
    actorCallsign: string | null;
    action: string;
    /** Whose balance, for a look while removing a member (offboard_preview, offboard_settled). */
    subject?: string | null;
    subjectCallsign?: string | null;
    /** Which trades a look at the disputes or the stuck escrows showed (#1608). */
    tradeIds?: string[] | null;
    at: string;
}

/** One row as the admin sees it: the name from the decrypted list, never from the node. */
export interface HealthRow {
    key: string;
    name: string;
    detail: string;
}

/** A name only this phone can give: the entry it opened, or a plain word where it couldn't open that entry. */
export function nameFor(entryId: string | null, entries: Pick<OpenedEntry, 'id' | 'text'>[]): string {
    const e = entryId ? entries.find((x) => x.id === entryId) : undefined;
    return e?.text?.name?.trim() || 'A name this phone can’t open';
}

const beans = (n: number) => `${Math.round(n * 100) / 100} Beans`;

export function reasonText(r: HealthReason, settings: HealthExceptionsBody['settings']): string {
    return r === 'past_debt_line'
        ? `past ${settings.debtLinePct}% of their floor`
        : `in debit with no sale for ${settings.quietDays} days`;
}

export function exceptionRows(body: HealthExceptionsBody, entries: Pick<OpenedEntry, 'id' | 'text'>[]): HealthRow[] {
    return body.exceptions.map((e) => ({
        key: e.memberPubkey,
        name: nameFor(e.entryId, entries),
        detail: `${beans(e.balance)} of a ${beans(e.floor)} floor · ${e.reasons.map((r) => reasonText(r, body.settings)).join(', and ')}`,
    }));
}

export function departedRows(body: HealthExceptionsBody, entries: Pick<OpenedEntry, 'id' | 'text'>[]): HealthRow[] {
    return body.departed.map((d) => ({
        key: d.id,
        name: nameFor(d.entryId, entries),
        detail: `left owing ${beans(d.amount - d.repaid)}${d.repaid > 0 ? ` (${beans(d.repaid)} repaid)` : ''}${d.repaying ? ' · repaying' : ''}`,
    }));
}

const whoOf = (l: HealthLogLine) => (l.actorCallsign ? `@${l.actorCallsign}` : 'An admin');
const whenOf = (l: HealthLogLine) => new Date(l.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** A look at a member's balance: opening the exceptions, or while removing a member. */
export function healthLogText(l: HealthLogLine): string {
    const who = whoOf(l);
    const when = whenOf(l);
    if (l.action === 'offboard_preview') return `${who} saw ${l.subjectCallsign ? `@${l.subjectCallsign}'s` : 'a member\'s'} balance while removing them · ${when}`;
    if (l.action === 'offboard_settled') return `${who} removed a member and saw the balance it settled · ${when}`;
    return `${who} opened the exceptions · ${when}`;
}

/**
 * A look at trades or alerts (#1608): the disputes, one dispute, the escrows a removal left stuck, the alerts that named a
 * member. The same words as the manager's Community health panel (apps/manager CommunityHealthPanel.tsx `logDid`).
 */
export function tradeLookText(l: HealthLogLine): string {
    const who = whoOf(l);
    const when = whenOf(l);
    if (l.action === 'disputes_listed') return `${who} opened the disputes list · ${when}`;
    if (l.action === 'dispute_opened') return `${who} opened a dispute · ${when}`;
    if (l.action === 'stranded_escrows_read') return `${who} opened the escrows a member’s removal left stuck · ${when}`;
    if (l.action === 'alerts_read') return `${who} read the alerts that named ${l.subjectCallsign ? `@${l.subjectCallsign}` : 'a member'} · ${when}`;
    return `${who} looked at trades · ${when}`;
}

/**
 * The community's totals (`GET /api/names/health`): public by rule, the same for every admin, in any community. A total
 * the node couldn't count is null: the Commons pot's row holding no number is NaN on the node (and so is the circulation,
 * which adds the pot in), and JSON sends NaN as null. Unknown, never 0.
 */
export interface HealthTotals {
    beansInCirculation: number | null;
    sumOfCredit: number | null;
    sumOfDebt: number | null;
    membersInDebit: number | null;
    commonsPot: number | null;
    tradesThisMonth: number | null;
}

const TOTAL_KEYS = ['beansInCirculation', 'sumOfCredit', 'sumOfDebt', 'membersInDebit', 'commonsPot', 'tradesThisMonth'] as const;

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The totals from the node's answer, each a number or null (not known), or null when it has none the phone can trust: an
 * older node, a bad answer (a total that is neither a number nor null), or not one number among them.
 */
export function readHealthTotals(v: unknown): HealthTotals | null {
    const t = (v as { totals?: unknown } | null)?.totals;
    if (!t || typeof t !== 'object') return null;
    const out = {} as HealthTotals;
    for (const k of TOTAL_KEYS) {
        const x = (t as Record<string, unknown>)[k];
        if (num(x)) out[k] = x;
        else if (x === null || x === undefined) out[k] = null;
        else return null;
    }
    return TOTAL_KEYS.some((k) => out[k] !== null) ? out : null;
}

const wholeBeans = (n: number | null) => (n === null ? HEALTH_COPY.totalUnknown : `${Math.round(n).toLocaleString('en')} Beans`);
const count = (n: number | null) => (n === null ? HEALTH_COPY.totalUnknown : n.toLocaleString('en'));

/** The totals as the screen lists them: the manager panel's labels, one label and value per line. */
export function totalsRows(t: HealthTotals): Array<{ label: string; value: string }> {
    return [
        { label: 'Beans in circulation', value: wholeBeans(t.beansInCirculation) },
        { label: 'Credit held (all balances above 0)', value: wholeBeans(t.sumOfCredit) },
        { label: 'Debt owed (all balances below 0)', value: wholeBeans(t.sumOfDebt) },
        { label: 'Members in debit', value: count(t.membersInDebit) },
        { label: 'Commons pot', value: wholeBeans(t.commonsPot) },
        { label: 'Trades this month', value: count(t.tradesThisMonth) },
    ];
}

/**
 * A node from before #1599 has no Community health routes: its answer is a 404 with no code, where every 404 of a current
 * node carries one (the global node's `feature_off`). A retry won't help there; the community's server needs an update.
 */
export function notOnThisNode(r: { ok: true } | { ok: false; status: number; code: string | null }): boolean {
    return !r.ok && r.status === 404 && !r.code;
}

/** One of the two access-log lists, as the screen shows it. */
export interface HealthLogSection {
    heading: string;
    hint: string;
    /** Shown when `lines` is empty. */
    empty: string;
    lines: Array<{ key: string; text: string }>;
}

export const HEALTH_COPY = {
    totalsHeading: 'THE WHOLE COMMUNITY',
    totalsHint: 'Any member may know these. Nobody’s own balance or trades are in them.',
    totalsMissing: 'The totals couldn’t be read just now.',
    totalsNotOnThisNode: 'This community’s server doesn’t give these totals yet: it needs an update.',
    /** One total the node couldn't count (finding 1 of #1610's review): never shown as 0. */
    totalUnknown: 'Not known just now',
    balanceHeading: 'WHO LOOKED AT A MEMBER’S BALANCE',
    /** A vote on removing a member shows their balance to its voters, and isn't logged: said here, so the list isn't read as complete. */
    balanceHint: 'Every opening of the exceptions above, and every look at a member’s balance while removing them. A vote on removing a member also shows their balance and any debt to everyone who can vote in it, and those looks are not in this list. Every admin and the owner can read this.',
    tradesHeading: 'WHO LOOKED AT TRADES AND ALERTS',
    tradesHint: 'Every look at the disputes, at one dispute or at the escrows a member’s removal left stuck, and each admin’s first look in 24 hours at the alerts that name a member. Every admin and the owner can read this.',
    /** Only where the node sent an empty list: this list watches the watchers, so a log the phone couldn't read is never "nobody". */
    nobodyYet: 'Nobody has looked yet.',
    logUnread: 'The log couldn’t be read just now.',
    logNotOnThisNode: 'This community’s server doesn’t keep this log yet: it needs an update.',
    /** A node from before #1608 answers no `tradeLog`: it doesn't log these looks, so "nobody" would be untrue. */
    tradesNotLogged: 'This community’s server doesn’t log these looks yet: it needs an update.',
} as const;

const isLine = (l: unknown): l is HealthLogLine =>
    !!l && typeof (l as HealthLogLine).id === 'string' && typeof (l as HealthLogLine).at === 'string' && typeof (l as HealthLogLine).actor === 'string';

/**
 * The node's `GET /api/names/health/log` answer as two lists, so a look at trades can't bury a look at a balance:
 * `log` (looks at a member's balance) and `tradeLog` (looks at trades and alerts, #1608). Newest first, as the node sends.
 * `answer` is null when the log couldn't be read (a lost connection, a standby): `unread` says why, for both lists.
 */
export function healthLogSections(
    answer: { log?: unknown; tradeLog?: unknown } | null,
    unread: 'unreadable' | 'not_on_this_node' = 'unreadable',
): { balance: HealthLogSection; trades: HealthLogSection } {
    const unreadText = unread === 'not_on_this_node' ? HEALTH_COPY.logNotOnThisNode : HEALTH_COPY.logUnread;
    // "Nobody" only for a list the node sent empty; lines this phone couldn't read are no proof that nobody looked.
    const emptyOf = (raw: unknown) => (Array.isArray(raw) && raw.length === 0 ? HEALTH_COPY.nobodyYet : unreadText);
    const balance = Array.isArray(answer?.log) ? answer.log.filter(isLine) : [];
    const trades = Array.isArray(answer?.tradeLog) ? answer.tradeLog.filter(isLine) : [];
    return {
        balance: {
            heading: HEALTH_COPY.balanceHeading, hint: HEALTH_COPY.balanceHint, empty: answer ? emptyOf(answer.log) : unreadText,
            lines: balance.map((l) => ({ key: l.id, text: healthLogText(l) })),
        },
        trades: {
            heading: HEALTH_COPY.tradesHeading, hint: HEALTH_COPY.tradesHint,
            empty: !answer ? unreadText : answer.tradeLog === undefined ? HEALTH_COPY.tradesNotLogged : emptyOf(answer.tradeLog),
            lines: trades.map((l) => ({ key: l.id, text: tradeLookText(l) })),
        },
    };
}

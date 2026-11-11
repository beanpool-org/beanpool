/**
 * Enterprise season & wind-up (docs/the-commons.md §2.2) — the decisions behind the native enterprise screen.
 *
 * Wording is ported from the web app (apps/pwa/src/pages/TreasuryDetailPage.tsx) so a member reads the same
 * sentence on either client. Visibility follows the server, not the web page: the web shows every lifecycle
 * button to anyone in its operator panel and lets the server refuse; here a member only sees what the server
 * will let them do (apps/server/src/routes/treasury.ts requireKeeperOrAdmin, state-engine initiateWindUp /
 * cancelWindUp / finaliseWindUp).
 *
 * Pure: no React Native imports, so it runs under the node test runner.
 */

import { formatDate, formatHundredths, isHundredths, keeperWords, t, tn, word, type WordKey } from '@beanpool/core';

const DAY_MS = 24 * 60 * 60 * 1000;
const PAUSE_DAYS = 90;
const GRACE_DAYS = 7;

// A closed enterprise refuses every lifecycle call (requireKeeperOrAdmin). Same list the web map-pin gate uses (#844).
const CLOSED_STATUSES = ['completed', 'disabled', 'suspended', 'pruned'];

/**
 * A money field of the enterprise's detail (GET /api/treasury/:id) or its ledger: whole hundredths of a Bean, or null when
 * it isn't one (never a guessed figure). Every figure here is hundredths, written by formatHundredths.
 */
const hundredthsOf = (v: unknown): number | null => (isHundredths(v) ? v : null);
/** The detail's balance, whole hundredths; 0 when it sent none. */
const balanceOf = (detail: any): number => hundredthsOf(detail?.balance_c) ?? 0;

const keeperKey = (k: any): string | undefined => k?.publicKey || k?.pubkey || k?.memberPubkey;
/**
 * A project says leader / collaborators, an enterprise lead keeper / keepers (group decisions pick 8). Each sentence is
 * written whole for each kind, never with the kind's word glued in, so a language can inflect it.
 */
const isProject = (detail: any): boolean => keeperWords(detail?.lifecycle).kind === 'project';

/** "17 December" — what the web's toLocaleDateString('en-GB', { day, month: 'long' }) prints, without relying on Intl. */
export function formatPauseDate(iso: string | null | undefined): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return formatDate(d, 'day-month', { width: 'long' });
}

/**
 * The credit floor a pause holds, whole hundredths of a Bean: the server's snapshot once paused, the current usable floor
 * before (the detail's `*_c` fields, the first of them that is whole hundredths).
 */
export function heldCredit(detail: any): number {
    const held = hundredthsOf(detail?.pausedFloorSnapshot_c) ?? hundredthsOf(detail?.usableFloor_c) ?? hundredthsOf(detail?.floor_c)
        ?? hundredthsOf(detail?.creditLine_c) ?? 0;
    return Math.abs(held);
}

/** tn()'s count and values for a figure: the plural form read from its Beans, `{n}` written as formatHundredths writes it. */
const heldValues = (held: number, more: Record<string, string> = {}): [number, Record<string, string>] => [held / 100, { n: formatHundredths(held), ...more }];

/** When the pause snapshot lapses: the server's date, else 90 days from pausedAt. */
export function pauseExpiresAt(detail: any): string | null {
    if (detail?.pauseExpiresAt) return detail.pauseExpiresAt;
    if (detail?.pausedAt) return new Date(new Date(detail.pausedAt).getTime() + PAUSE_DAYS * DAY_MS).toISOString();
    return null;
}

function windUpGraceEndsAt(detail: any): string | null {
    if (detail?.windUpGraceEndsAt) return detail.windUpGraceEndsAt;
    if (detail?.windUpInitiatedAt) return new Date(new Date(detail.windUpInitiatedAt).getTime() + GRACE_DAYS * DAY_MS).toISOString();
    return null;
}

export type SeasonBanner =
    | { kind: 'paused'; label: string; headline: string; body: string; warning: string | null }
    | { kind: 'winding_up'; label: string; headline: string; body: string; graceEndedNote: string | null }
    | { kind: 'completed'; label: string; headline: string; body: string };

/** The state banner every member sees, or null for an ordinary active enterprise. */
export function seasonBanner(detail: any, now: number = Date.now()): SeasonBanner | null {
    if (!detail) return null;
    const status = detail.status;
    const project = isProject(detail);

    if (status === 'completed') {
        return {
            kind: 'completed',
            label: t('Completed', undefined, 'enterprise state'),
            headline: t('Completed · Wound up'),
            body: project
                ? t('This project has completed its purpose and wound up permanently. Surplus was returned to the Commons, collaborators were released, and listings are closed.')
                : t('This enterprise has completed its purpose and wound up permanently. Surplus was returned to the Commons, keepers were released, and listings are closed.'),
        };
    }

    if (status === 'winding_up') {
        const endsAt = windUpGraceEndsAt(detail);
        const endsMs = endsAt ? new Date(endsAt).getTime() : NaN;
        // Capped at the grace period: right after starting, a phone clock slightly behind the server's made
        // Math.ceil read "8 days left" beside "the 7-day grace period".
        const daysLeft = isNaN(endsMs) ? 0 : Math.min(GRACE_DAYS, Math.max(0, Math.ceil((endsMs - now) / DAY_MS)));
        const graceEnded = !isNaN(endsMs) && now >= endsMs;
        const by = detail.windUpInitiatedBy as string | null | undefined;
        const initiator = Array.isArray(detail.keepers) ? detail.keepers.find((k: any) => keeperKey(k) === by) : undefined;
        // A member's name as they wrote it, or the start of their key (no words in it).
        const initiatorName = initiator?.callsign || (by ? `${by.slice(0, 8)}…` : null);
        return {
            kind: 'winding_up',
            label: t('Winding Up'),
            headline: initiatorName
                ? tn(daysLeft, 'Winding up ({n} day left · started by {name})', 'Winding up ({n} days left · started by {name})', { name: initiatorName })
                : project
                    ? tn(daysLeft, 'Winding up ({n} day left · started by a collaborator)', 'Winding up ({n} days left · started by a collaborator)')
                    : tn(daysLeft, 'Winding up ({n} day left · started by a keeper)', 'Winding up ({n} days left · started by a keeper)'),
            body: project
                ? t('This project is winding down. Listings are inactive and cannot be bought. Any collaborator can stop this during the 7-day grace period.')
                : t('This enterprise is winding down. Listings are inactive and cannot be bought. Any keeper can stop this during the 7-day grace period.'),
            graceEndedNote: graceEnded ? t('The 7-day grace period has elapsed. Ready to be finalised.') : null,
        };
    }

    if (detail.paused) {
        const until = formatPauseDate(pauseExpiresAt(detail));
        const daysRemaining = detail.pauseDaysRemaining;
        const [held, heldN] = heldValues(heldCredit(detail));
        // The node's own warning is shown as it sent it (words slice S4).
        const warning = detail.pauseWarning
            || (typeof daysRemaining === 'number' && daysRemaining <= 14
                ? (daysRemaining === 0
                    ? t('Pause credit floor snapshot has expired')
                    : tn(daysRemaining, 'Pause credit floor snapshot expires in {n} day', 'Pause credit floor snapshot expires in {n} days'))
                : null);
        return {
            kind: 'paused',
            label: t('Paused for the season'),
            headline: until
                ? tn(held, 'Paused for the season. Credit held at {n} beans until {date}.', 'Paused for the season. Credit held at {n} beans until {date}.', { ...heldN, date: until })
                : tn(held, 'Paused for the season. Credit held at {n} beans.', 'Paused for the season. Credit held at {n} beans.', heldN),
            body: t('Listings are paused and cannot be bought right now.'),
            warning,
        };
    }

    return null;
}

export interface SeasonControls {
    pause: boolean;
    resume: boolean;
    startWindUp: boolean;
    cancelWindUp: boolean;
    finaliseWindUp: boolean;
}

const NO_CONTROLS: SeasonControls = { pause: false, resume: false, startWindUp: false, cancelWindUp: false, finaliseWindUp: false };

export function anySeasonControl(c: SeasonControls): boolean {
    return c.pause || c.resume || c.startWindUp || c.cancelWindUp || c.finaliseWindUp;
}

/**
 * Which keeper controls this member sees. Mirrors the server:
 *  - pause / resume and cancel wind-up: any ACTIVE keeper of this enterprise, or an admin;
 *  - start and finalise wind-up: the lead keeper, a sole keeper or an admin (`isLeadOrSoleKeeperOrAdmin`,
 *    which the server computes for the signed-in viewer);
 *  - a suspended keeper sees none — the server refuses a keeper whose account or operator switch is off.
 *
 * "Active keeper" reads the keepers list's `suspended` flag, not `keeperOf`, which ignores account status (#844).
 */
export function seasonControls(detail: any, myPublicKey: string | null | undefined, now: number = Date.now()): SeasonControls {
    if (!detail || !myPublicKey) return NO_CONTROLS;
    if (CLOSED_STATUSES.includes(detail.status)) return NO_CONTROLS;

    const me = Array.isArray(detail.keepers) ? detail.keepers.find((k: any) => keeperKey(k) === myPublicKey) : undefined;
    if (me?.suspended) return NO_CONTROLS;

    const leadLevel = !!detail.isLeadOrSoleKeeperOrAdmin;
    const keeperLevel = !!me || leadLevel;
    const windingUp = detail.status === 'winding_up';
    const endsAt = windUpGraceEndsAt(detail);
    const graceEnded = !!endsAt && now >= new Date(endsAt).getTime();

    return {
        pause: keeperLevel && !windingUp && !detail.paused,
        resume: keeperLevel && !windingUp && !!detail.paused,
        startWindUp: leadLevel && !windingUp,
        cancelWindUp: keeperLevel && windingUp,
        finaliseWindUp: leadLevel && windingUp && graceEnded,
    };
}

/** Plain-words consequences, shown before the confirming tap. */
export function pauseConfirmText(detail: any): string {
    const until = formatPauseDate(pauseExpiresAt(detail));
    const [held, heldN] = heldValues(heldCredit(detail));
    if (isProject(detail)) {
        return until
            ? tn(held, 'Pausing for the season holds your credit floor at {n} beans until {date} and pauses active listings so members cannot buy. Any collaborator can resume at any time.', 'Pausing for the season holds your credit floor at {n} beans until {date} and pauses active listings so members cannot buy. Any collaborator can resume at any time.', { ...heldN, date: until })
            : tn(held, 'Pausing for the season holds your credit floor at {n} beans for up to 90 days and pauses active listings so members cannot buy. Any collaborator can resume at any time.', 'Pausing for the season holds your credit floor at {n} beans for up to 90 days and pauses active listings so members cannot buy. Any collaborator can resume at any time.', heldN);
    }
    return until
        ? tn(held, 'Pausing for the season holds your credit floor at {n} beans until {date} and pauses active listings so members cannot buy. Any keeper can resume at any time.', 'Pausing for the season holds your credit floor at {n} beans until {date} and pauses active listings so members cannot buy. Any keeper can resume at any time.', { ...heldN, date: until })
        : tn(held, 'Pausing for the season holds your credit floor at {n} beans for up to 90 days and pauses active listings so members cannot buy. Any keeper can resume at any time.', 'Pausing for the season holds your credit floor at {n} beans for up to 90 days and pauses active listings so members cannot buy. Any keeper can resume at any time.', heldN);
}

/** Marked here, translated where it is shown: t(RESUME_CONFIRM_TEXT). */
export const RESUME_CONFIRM_TEXT = word('Resuming reactivates all listings and restores the credit floor to normal daily calculation.');

function keeperCount(detail: any): number {
    return Array.isArray(detail?.keepers) && detail.keepers.length > 0 ? detail.keepers.length : 1;
}

export function windUpConfirmText(detail: any, name: string): string {
    const amount = formatHundredths(Math.max(0, balanceOf(detail)));
    const count = keeperCount(detail);
    return isProject(detail)
        ? tn(count, 'Winding up returns {amount} beans to the Commons, releases {n} collaborator, and closes {name} for good. Any collaborator can stop this for the next 7 days.', 'Winding up returns {amount} beans to the Commons, releases {n} collaborators, and closes {name} for good. Any collaborator can stop this for the next 7 days.', { amount, name })
        : tn(count, 'Winding up returns {amount} beans to the Commons, releases {n} keeper, and closes {name} for good. Any keeper can stop this for the next 7 days.', 'Winding up returns {amount} beans to the Commons, releases {n} keepers, and closes {name} for good. Any keeper can stop this for the next 7 days.', { amount, name });
}

/** Set when wind-up cannot start: the server refuses an enterprise in deficit. */
export function windUpDeficitText(detail: any): string | null {
    const balance = balanceOf(detail);
    if (balance >= 0) return null;
    // formatHundredths writes the deficit with its true minus ("−9.82").
    return isProject(detail)
        ? t('Cannot wind up a project in deficit ({amount} 🫘). Debt must be resolved or written off first.', { amount: formatHundredths(balance) })
        : t('Cannot wind up an enterprise in deficit ({amount} 🫘). Debt must be resolved or written off first.', { amount: formatHundredths(balance) });
}

export function cancelWindUpConfirmText(name: string, lifecycle?: string | null): string {
    return keeperWords(lifecycle).kind === 'project'
        ? t('Cancelling wind-up restores {name} to active status immediately. Collaborators remain appointed and listings can resume.', { name })
        : t('Cancelling wind-up restores {name} to active status immediately. Keepers remain appointed and listings can resume.', { name });
}

export function finaliseWindUpConfirmText(detail: any, name: string): string {
    const back = Math.max(0, balanceOf(detail));
    // {n} written from whole hundredths ("12.50", "12"); its plural form read from the Beans.
    const values = { n: formatHundredths(back), name };
    return isProject(detail)
        ? tn(back / 100, 'The 7-day grace period has elapsed. Finalising sweeps {n} beans to the Commons, releases all collaborators, and closes {name} for good.', 'The 7-day grace period has elapsed. Finalising sweeps {n} beans to the Commons, releases all collaborators, and closes {name} for good.', values)
        : tn(back / 100, 'The 7-day grace period has elapsed. Finalising sweeps {n} beans to the Commons, releases all keepers, and closes {name} for good.', 'The 7-day grace period has elapsed. Finalising sweeps {n} beans to the Commons, releases all keepers, and closes {name} for good.', values);
}

/** Posting new listings is refused while paused, winding up or completed; null when posting is open. */
export function postingBlockedText(detail: any): string | null {
    if (!detail) return null;
    if (detail.status === 'completed') return isProject(detail) ? t('Project closed permanently.') : t('Enterprise closed permanently.');
    if (detail.status === 'winding_up') return t('Winding up — posting new listings is disabled.');
    if (detail.paused) return t('Paused for the season — posting new listings is disabled.');
    return null;
}

// ---- P&L ledger ----------------------------------------------------------------------

export type LedgerPeriod = 'all' | '30d' | '90d' | '365d';

/** The period tabs, marked here and translated where they are shown: t(p.label), t(p.a11y). */
export const LEDGER_PERIODS: Array<{ key: LedgerPeriod; label: WordKey; a11y: WordKey }> = [
    { key: 'all', label: word('All time'), a11y: word('All time') },
    { key: '30d', label: word('30d'), a11y: word('Last 30 days') },
    { key: '90d', label: word('90d'), a11y: word('Last 90 days') },
    { key: '365d', label: word('1y'), a11y: word('Last year') },
];

/** The `since` the ledger route takes for a period; undefined for all time. */
export function ledgerSince(period: LedgerPeriod, now: number = Date.now()): string | undefined {
    const days = period === '30d' ? 30 : period === '90d' ? 90 : period === '365d' ? 365 : 0;
    return days ? new Date(now - days * DAY_MS).toISOString() : undefined;
}

/** "Came in" / "Went out" and who the other side was, for one ledger line. The name and the memo are as written. */
export function ledgerLineLabels(entry: { direction: 'income' | 'spend'; counterpartyName?: string; memo?: string }): { flow: string; with: string; what: string } {
    return {
        flow: entry.direction === 'income' ? t('Came in') : t('Went out'),
        with: entry.counterpartyName || t('Member'),
        what: entry.memo || t('Transfer'),
    };
}

/**
 * One ledger line's amount (whole hundredths, the entry's amount_c) with its direction: "+12.50 🫘" in, "−40 🫘" out (a true
 * minus, as every figure below zero is written). Not whole hundredths: "—", never a number.
 */
export function signedBeans(amount_c: number, direction: 'income' | 'spend'): string {
    if (!isHundredths(amount_c)) return `${formatHundredths(amount_c)} 🫘`;
    return `${direction === 'income' ? '+' : '−'}${formatHundredths(Math.abs(amount_c))} 🫘`;
}

/** A total (whole hundredths) with a sign, but never "−0" / "+0": nothing is plain "0". */
function signedTotal(c: number, sign: '+' | '−'): string {
    const abs = Math.abs(c);
    return abs === 0 ? `${formatHundredths(0)} 🫘` : `${sign}${formatHundredths(abs)} 🫘`;
}

export interface PlSummaryText {
    cameIn: string;
    wentOut: string;
    net: string;
    netIsPositive: boolean;
    /** Shown only when fees came off income, so the three totals add up. Same wording as the web. */
    feeNote: string | null;
}

/**
 * The P&L boxes on an enterprise page: "Came in", "Went out", "Net change" and the fee note. The summary's totals are whole
 * hundredths of a Bean (the node keeps their names: M1's listed deviations); one that isn't counts as 0.
 */
export function plSummaryText(summary: { totalIncome?: number; totalSpend?: number; netChange?: number } | null | undefined): PlSummaryText {
    const income = hundredthsOf(summary?.totalIncome) ?? 0;
    const spend = hundredthsOf(summary?.totalSpend) ?? 0;
    const net = hundredthsOf(summary?.netChange) ?? 0;
    // The node counts "came in" before the community fee, while net change is what the balance actually moved: in whole
    // hundredths the fees are exact.
    const fees = summary ? income - spend - net : 0;
    return {
        cameIn: signedTotal(income, '+'),
        wentOut: signedTotal(spend, '−'),
        net: signedTotal(net, net < 0 ? '−' : '+'),
        netIsPositive: net >= 0,
        feeNote: fees > 0 ? t('Came in is before fees: {amount} 🫘 in fees came off it.', { amount: formatHundredths(fees) }) : null,
    };
}

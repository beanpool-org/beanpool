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

const DAY_MS = 24 * 60 * 60 * 1000;
const PAUSE_DAYS = 90;
const GRACE_DAYS = 7;

// A closed enterprise refuses every lifecycle call (requireKeeperOrAdmin). Same list the web map-pin gate uses (#844).
const CLOSED_STATUSES = ['completed', 'disabled', 'suspended', 'pruned'];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

const keeperKey = (k: any): string | undefined => k?.publicKey || k?.pubkey || k?.memberPubkey;

/** "17 December" — what the web's toLocaleDateString('en-GB', { day, month: 'long' }) prints, without relying on Intl. */
export function formatPauseDate(iso: string | null | undefined): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** The credit floor a pause holds: the server's snapshot once paused, the current usable floor before. */
export function heldCredit(detail: any): number {
    return round2(Math.abs(Number(detail?.pausedFloorSnapshot ?? detail?.usableFloor ?? detail?.floor ?? detail?.creditLine ?? 0) || 0));
}

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

    if (status === 'completed') {
        return {
            kind: 'completed',
            label: 'Completed',
            headline: 'Completed · Wound up',
            body: 'This enterprise has completed its purpose and wound up permanently. Surplus was returned to the Commons, keepers were released, and listings are closed.',
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
        const initiatorName = initiator?.callsign || (by ? `${by.slice(0, 8)}…` : 'a keeper');
        return {
            kind: 'winding_up',
            label: 'Winding Up',
            headline: `Winding up (${plural(daysLeft, 'day')} left · started by ${initiatorName})`,
            body: 'This enterprise is winding down. Listings are inactive and cannot be bought. Any keeper can stop this during the 7-day grace period.',
            graceEndedNote: graceEnded ? 'The 7-day grace period has elapsed. Ready to be finalised.' : null,
        };
    }

    if (detail.paused) {
        const until = formatPauseDate(pauseExpiresAt(detail));
        const daysRemaining = detail.pauseDaysRemaining;
        const warning = detail.pauseWarning
            || (typeof daysRemaining === 'number' && daysRemaining <= 14
                ? (daysRemaining === 0
                    ? 'Pause credit floor snapshot has expired'
                    : `Pause credit floor snapshot expires in ${plural(daysRemaining, 'day')}`)
                : null);
        return {
            kind: 'paused',
            label: 'Paused for the season',
            headline: `Paused for the season. Credit held at ${heldCredit(detail)} beans${until ? ` until ${until}.` : '.'}`,
            body: 'Listings are paused and cannot be bought right now.',
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
    return `Pausing for the season holds your credit floor at ${heldCredit(detail)} beans${until ? ` until ${until}` : ' for up to 90 days'} and pauses active listings so members cannot buy. Any keeper can resume at any time.`;
}

export const RESUME_CONFIRM_TEXT = 'Resuming reactivates all listings and restores the credit floor to normal daily calculation.';

function keeperCount(detail: any): number {
    return Array.isArray(detail?.keepers) && detail.keepers.length > 0 ? detail.keepers.length : 1;
}

export function windUpConfirmText(detail: any, name: string): string {
    const back = Math.max(0, Number(detail?.balance) || 0).toFixed(2);
    return `Winding up returns ${back} beans to the Commons, releases ${plural(keeperCount(detail), 'keeper')}, and closes ${name} for good. Any keeper can stop this for the next 7 days.`;
}

/** Set when wind-up cannot start: the server refuses an enterprise in deficit. */
export function windUpDeficitText(detail: any): string | null {
    const balance = Number(detail?.balance) || 0;
    return balance < 0 ? `Cannot wind up an enterprise in deficit (${balance} 🫘). Debt must be resolved or written off first.` : null;
}

export function cancelWindUpConfirmText(name: string): string {
    return `Cancelling wind-up restores ${name} to active status immediately. Keepers remain appointed and listings can resume.`;
}

export function finaliseWindUpConfirmText(detail: any, name: string): string {
    const back = Math.max(0, Number(detail?.balance) || 0).toFixed(2);
    return `The 7-day grace period has elapsed. Finalising sweeps ${back} beans to the Commons, releases all keepers, and closes ${name} for good.`;
}

/** Posting new listings is refused while paused, winding up or completed; null when posting is open. */
export function postingBlockedText(detail: any): string | null {
    if (!detail) return null;
    if (detail.status === 'completed') return 'Enterprise closed permanently.';
    if (detail.status === 'winding_up') return 'Winding up — posting new listings is disabled.';
    if (detail.paused) return 'Paused for the season — posting new listings is disabled.';
    return null;
}

// ---- P&L ledger ----------------------------------------------------------------------

export type LedgerPeriod = 'all' | '30d' | '90d' | '365d';

export const LEDGER_PERIODS: Array<{ key: LedgerPeriod; label: string; a11y: string }> = [
    { key: 'all', label: 'All time', a11y: 'All time' },
    { key: '30d', label: '30d', a11y: 'Last 30 days' },
    { key: '90d', label: '90d', a11y: 'Last 90 days' },
    { key: '365d', label: '1y', a11y: 'Last year' },
];

/** The `since` the ledger route takes for a period; undefined for all time. */
export function ledgerSince(period: LedgerPeriod, now: number = Date.now()): string | undefined {
    const days = period === '30d' ? 30 : period === '90d' ? 90 : period === '365d' ? 365 : 0;
    return days ? new Date(now - days * DAY_MS).toISOString() : undefined;
}

/** "Came in" / "Went out" and who the other side was, for one ledger line. */
export function ledgerLineLabels(entry: { direction: 'income' | 'spend'; counterpartyName?: string; memo?: string }): { flow: string; with: string; what: string } {
    return {
        flow: entry.direction === 'income' ? 'Came in' : 'Went out',
        with: entry.counterpartyName || 'Member',
        what: entry.memo || 'Transfer',
    };
}

export function signedBeans(n: number, direction: 'income' | 'spend'): string {
    return `${direction === 'income' ? '+' : '-'}${(Number(n) || 0).toFixed(2)} 🫘`;
}

/** Beans to 2 places with a sign, but never "-0.00" / "+0.00": anything that rounds to zero is plain "0.00". */
function signedTotal(n: number, sign: '+' | '-'): string {
    const cents = Math.round(Math.abs(Number(n) || 0) * 100);
    return cents === 0 ? '0.00 🫘' : `${sign}${(cents / 100).toFixed(2)} 🫘`;
}

export interface PlSummaryText {
    cameIn: string;
    wentOut: string;
    net: string;
    netIsPositive: boolean;
    /** Shown only when fees came off income, so the three totals add up. Same wording as the web. */
    feeNote: string | null;
}

/** The P&L boxes on an enterprise page: "Came in", "Went out", "Net change" and the fee note. */
export function plSummaryText(summary: { totalIncome?: number; totalSpend?: number; netChange?: number } | null | undefined): PlSummaryText {
    const income = Number(summary?.totalIncome) || 0;
    const spend = Number(summary?.totalSpend) || 0;
    const net = Number(summary?.netChange) || 0;
    // The node counts "came in" before the community fee, while net change is what the balance actually moved.
    const fees = summary ? Math.round((income - spend - net) * 100) / 100 : 0;
    return {
        cameIn: signedTotal(income, '+'),
        wentOut: signedTotal(spend, '-'),
        net: signedTotal(net, net < 0 ? '-' : '+'),
        netIsPositive: net >= 0,
        feeNote: fees > 0 ? `Came in is before fees: ${fees.toFixed(2)} 🫘 in fees came off it.` : null,
    };
}

/**
 * Enterprise keeper governance, as the enterprise page shows it (answers A, G and M, 2026-09-19).
 * An enterprise's own membership is the keepers' own work: the lead adds or removes a keeper, and any other
 * keeper can object for 3 days, which cancels it. Any keeper can step down. Succession has a 14-day deadline
 * and a No vote. Pure functions only, so the words are tested; the PWA carries the same file.
 */

export interface KeeperLite {
    publicKey: string;
    callsign?: string;
    role?: string;
    suspended?: boolean;
    grantedAt?: string | null;
}

export interface KeeperChangeLite {
    id: string;
    kind: 'add' | 'remove';
    memberPubkey: string;
    memberCallsign?: string;
    proposedBy: string;
    proposedByCallsign?: string | null;
    pledgedBacking?: number;
    appliesAt: string;
    status?: string;
}

export interface SuccessionLite {
    status: string;
    closedReason?: string | null;
    deadlineAt?: string;
    votesCount: number;
    noVotesCount?: number;
    requiredVotes?: number;
    totalEligible?: number;
    votes?: Array<{ voterPubkey: string; choice?: 'yes' | 'no' }>;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "2 days 5 hours left", "5 hours left", "less than an hour left", or "ending now". */
export function timeLeftText(untilIso: string, now = Date.now()): string {
    const ms = new Date(untilIso).getTime() - now;
    if (!Number.isFinite(ms) || ms <= 0) return 'ending now';
    const days = Math.floor(ms / DAY);
    const hours = Math.floor((ms % DAY) / HOUR);
    if (days > 0) return hours > 0 ? `${plural(days, 'day')} ${plural(hours, 'hour')} left` : `${plural(days, 'day')} left`;
    if (hours > 0) return `${plural(hours, 'hour')} left`;
    return 'less than an hour left';
}

export function keeperChangeTitle(c: KeeperChangeLite): string {
    const who = c.memberCallsign || 'A member';
    if (c.kind === 'remove') return `Removing ${who} as a keeper`;
    const backing = Number(c.pledgedBacking || 0);
    return backing > 0 ? `Adding ${who} as a keeper, backing ${backing} beans` : `Adding ${who} as a keeper`;
}

export function keeperChangeBody(c: KeeperChangeLite): string {
    const lead = c.proposedByCallsign || 'The lead keeper';
    return `${lead} made this change. Any other keeper can object before it takes effect, and one objection cancels it.`;
}

function activeKeeper(keepers: KeeperLite[], me: string | null | undefined): KeeperLite | null {
    if (!me) return null;
    const k = keepers.find(x => x.publicKey === me);
    return k && !k.suspended ? k : null;
}

/** Any active keeper other than the lead who made it — and, for a removal, other than the keeper being removed. */
export function canObjectToChange(c: KeeperChangeLite, me: string | null | undefined, keepers: KeeperLite[]): boolean {
    if (!activeKeeper(keepers, me)) return false;
    return me !== c.proposedBy && me !== c.memberPubkey;
}

/** The lead may propose removing an ordinary keeper who has no change already waiting. */
export function canRemoveKeeper(k: KeeperLite, me: string | null | undefined, isLead: boolean, pending: KeeperChangeLite[]): boolean {
    if (!isLead || !me || k.publicKey === me || k.role === 'lead') return false;
    return !pending.some(c => c.memberPubkey === k.publicKey);
}

/** Any keeper may step down, except the only one. */
export function canStepDown(me: string | null | undefined, keepers: KeeperLite[]): boolean {
    if (!me || !keepers.some(k => k.publicKey === me)) return false;
    return keepers.length > 1;
}

/** Who becomes lead if this lead steps down: the longest-serving other active keeper (the server's order). */
export function nextLead(keepers: KeeperLite[], leaving: string): KeeperLite | null {
    const others = keepers.filter(k => k.publicKey !== leaving && !k.suspended);
    const sorted = [...others].sort((a, b) => String(a.grantedAt ?? '').localeCompare(String(b.grantedAt ?? '')));
    return sorted[0] ?? null;
}

export function stepDownConfirmText(me: string, keepers: KeeperLite[]): string {
    const mine = keepers.find(k => k.publicKey === me);
    const released = 'Any backing you pledged is released.';
    if (mine?.role !== 'lead') return `You stop being a keeper of this enterprise. ${released}`;
    const next = nextLead(keepers, me);
    if (!next) {
        return `You stop being a keeper. No other keeper is active, so the enterprise pauses until someone winds it up. ${released}`;
    }
    return `You stop being a keeper. ${next.callsign || 'The longest-serving keeper'} becomes lead at once, and the other keepers can choose someone else straight away. ${released}`;
}

export function removeKeeperConfirmText(k: KeeperLite): string {
    return `${k.callsign || 'This keeper'} stops being a keeper in 3 days, unless another keeper objects first.`;
}

/** What an applicant sees once the lead has approved them and the window is running. */
export function approvedApplicantText(appliesAt: string, now = Date.now()): string {
    return `The lead keeper approved you. You become a keeper when the other keepers' 3-day objection window ends (${timeLeftText(appliesAt, now)}).`;
}

export function successionTallyText(p: SuccessionLite): string {
    const yes = p.votesCount;
    const no = p.noVotesCount ?? 0;
    const need = p.requiredVotes ?? 0;
    const of = p.totalEligible ?? 0;
    return `${yes} yes, ${no} no. Needs ${need} yes of ${of} keepers.`;
}

export function successionDeadlineText(p: SuccessionLite, now = Date.now()): string | null {
    if (!p.deadlineAt) return null;
    return `Open for 14 days: ${timeLeftText(p.deadlineAt, now)}.`;
}

export function myChoice(p: SuccessionLite, me: string | null | undefined): 'yes' | 'no' | null {
    const v = me ? p.votes?.find(x => x.voterPubkey === me) : undefined;
    return v ? (v.choice === 'no' ? 'no' : 'yes') : null;
}

export function successionClosedText(reason: string | null | undefined): string | null {
    switch (reason) {
        case 'rejected': return 'Not enough keepers said yes, so the lead stays.';
        case 'expired': return 'The 14 days ran out before a majority said yes.';
        case 'lead_returned': return 'The lead became active again, so the proposal closed.';
        case 'lead_changed': return 'The lead changed, so the proposal closed.';
        case 'candidate_gone': return 'The candidate is no longer an active keeper.';
        default: return null;
    }
}

/** Heading for the succession card: why succession is open now. */
export function successionHeading(inactivity: { autoPromoted?: boolean; daysInactive?: number } | null | undefined): string {
    if (inactivity?.autoPromoted) return 'NEW LEAD CHOSEN AUTOMATICALLY';
    return `LEAD KEEPER INACTIVE (${Math.floor(inactivity?.daysInactive ?? 0)} DAYS)`;
}

export function successionExplainer(inactivity: { autoPromoted?: boolean; leadCallsign?: string | null } | null | undefined): string {
    const tail = 'More than half of the other keepers saying yes moves the lead role. Each proposal is open for 14 days.';
    if (inactivity?.autoPromoted) {
        return `${inactivity.leadCallsign || 'The lead'} became lead automatically as the longest-serving keeper. The other keepers can choose someone else now. ${tail}`;
    }
    return `${inactivity?.leadCallsign || 'The lead keeper'} has recorded no node activity for 30+ days. ${tail} If the lead returns first, the proposal closes.`;
}

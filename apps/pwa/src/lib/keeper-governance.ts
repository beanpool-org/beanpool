/**
 * Enterprise keeper governance, as the enterprise page shows it (answers A, G and M, 2026-09-19).
 * An enterprise's own membership is the keepers' own work: the lead adds or removes a keeper, and any other
 * keeper can object for 3 days, which cancels it. Any keeper can step down. Succession has a 14-day deadline
 * and a No vote. A project's are its leader and collaborators (group decisions pick 8): each words function takes the
 * row's KeeperWords, an enterprise's when none is given. Pure functions only, so the words are tested; the native app carries the same file.
 */

import { keeperWords, t, tn, type KeeperWords } from '@beanpool/core';

const ENTERPRISE = keeperWords('ongoing');
/**
 * Each sentence is written whole for a project (leader, collaborators) and for an enterprise (lead keeper, keepers),
 * never with the kind's words glued in, so a language can inflect them.
 */
const isProject = (w: KeeperWords): boolean => w.kind === 'project';

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
    /** The node sent the pledge's named part only: a keeper other than the lead reads no known part (keeperChangeForReader). */
    namedBackingOnly?: boolean;
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

/** "2 days 5 hours left", "5 hours left", "less than an hour left", or "ending now". */
export function timeLeftText(untilIso: string, now = Date.now()): string {
    const ms = new Date(untilIso).getTime() - now;
    if (!Number.isFinite(ms) || ms <= 0) return t('ending now');
    const days = Math.floor(ms / DAY);
    const hours = Math.floor((ms % DAY) / HOUR);
    if (days > 0) {
        return hours > 0
            ? t('{days} {hours} left', { days: tn(days, '{n} day', '{n} days'), hours: tn(hours, '{n} hour', '{n} hours') })
            : tn(days, '{n} day left', '{n} days left');
    }
    if (hours > 0) return tn(hours, '{n} hour left', '{n} hours left');
    return t('less than an hour left');
}

export function keeperChangeTitle(c: KeeperChangeLite, w: KeeperWords = ENTERPRISE): string {
    const name = c.memberCallsign || t('A member');
    const project = isProject(w);
    if (c.kind === 'remove') return project ? t('Removing {name} as a collaborator', { name }) : t('Removing {name} as a keeper', { name });
    const backing = Number(c.pledgedBacking || 0);
    // Never "backing N" for a part: the rest, from a known grant, still backs the enterprise, unnamed.
    if (backing > 0 && c.namedBackingOnly) {
        return project
            ? tn(backing, 'Adding {name} as a collaborator, with {n} beans of named backing', 'Adding {name} as a collaborator, with {n} beans of named backing', { name })
            : tn(backing, 'Adding {name} as a keeper, with {n} beans of named backing', 'Adding {name} as a keeper, with {n} beans of named backing', { name });
    }
    if (backing > 0) {
        return project
            ? tn(backing, 'Adding {name} as a collaborator, backing {n} beans', 'Adding {name} as a collaborator, backing {n} beans', { name })
            : tn(backing, 'Adding {name} as a keeper, backing {n} beans', 'Adding {name} as a keeper, backing {n} beans', { name });
    }
    return project ? t('Adding {name} as a collaborator', { name }) : t('Adding {name} as a keeper', { name });
}

export function keeperChangeBody(c: KeeperChangeLite, w: KeeperWords = ENTERPRISE): string {
    const name = c.proposedByCallsign;
    if (isProject(w)) {
        return name
            ? t('{name} made this change. Any other collaborator can object before it takes effect, and one objection cancels it.', { name })
            : t('The leader made this change. Any other collaborator can object before it takes effect, and one objection cancels it.');
    }
    return name
        ? t('{name} made this change. Any other keeper can object before it takes effect, and one objection cancels it.', { name })
        : t('The lead keeper made this change. Any other keeper can object before it takes effect, and one objection cancels it.');
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

export function stepDownConfirmText(me: string, keepers: KeeperLite[], w: KeeperWords = ENTERPRISE): string {
    const mine = keepers.find(k => k.publicKey === me);
    const project = isProject(w);
    if (mine?.role !== 'lead') {
        return project
            ? t('You stop being a collaborator of this project. Any backing you pledged is released.')
            : t('You stop being a keeper of this enterprise. Any backing you pledged is released.');
    }
    const next = nextLead(keepers, me);
    if (!next) {
        return project
            ? t('You stop being a collaborator. No other collaborator is active, so the project pauses until someone winds it up. Any backing you pledged is released.')
            : t('You stop being a keeper. No other keeper is active, so the enterprise pauses until someone winds it up. Any backing you pledged is released.');
    }
    const name = next.callsign;
    if (project) {
        return name
            ? t('You stop being a collaborator. {name} becomes leader at once, and the other collaborators can choose someone else straight away. Any backing you pledged is released.', { name })
            : t('You stop being a collaborator. The longest-serving collaborator becomes leader at once, and the other collaborators can choose someone else straight away. Any backing you pledged is released.');
    }
    return name
        ? t('You stop being a keeper. {name} becomes lead at once, and the other keepers can choose someone else straight away. Any backing you pledged is released.', { name })
        : t('You stop being a keeper. The longest-serving keeper becomes lead at once, and the other keepers can choose someone else straight away. Any backing you pledged is released.');
}

export function removeKeeperConfirmText(k: KeeperLite, w: KeeperWords = ENTERPRISE): string {
    const name = k.callsign;
    if (isProject(w)) {
        return name
            ? t('{name} stops being a collaborator in 3 days, unless another collaborator objects first.', { name })
            : t('This collaborator stops being a collaborator in 3 days, unless another collaborator objects first.');
    }
    return name
        ? t('{name} stops being a keeper in 3 days, unless another keeper objects first.', { name })
        : t('This keeper stops being a keeper in 3 days, unless another keeper objects first.');
}

/** What an applicant sees once the lead has approved them and the window is running. */
export function approvedApplicantText(appliesAt: string, now = Date.now(), w: KeeperWords = ENTERPRISE): string {
    const time = timeLeftText(appliesAt, now);
    return isProject(w)
        ? t("The leader approved you. You become a collaborator when the other collaborators' 3-day objection window ends ({time}).", { time })
        : t("The lead keeper approved you. You become a keeper when the other keepers' 3-day objection window ends ({time}).", { time });
}

/**
 * What the lead keeper reads on a join request about the applicant's backing: a yes or a no, never a figure (what an
 * applicant has left to back with is theirs alone). Null when a node too old to send canBackPledge answers: no line.
 */
export function applicantBackingText(canBackPledge: boolean | null | undefined): string | null {
    if (canBackPledge === true) return t('Their standing covers this pledge.');
    if (canBackPledge === false) return t("Their standing doesn't cover this pledge right now, so it can't be approved yet.");
    return null;
}

export function successionTallyText(p: SuccessionLite, w: KeeperWords = ENTERPRISE): string {
    const values = { yes: p.votesCount, no: p.noVotesCount ?? 0, need: p.requiredVotes ?? 0 };
    const of = p.totalEligible ?? 0;
    // Counted on the keepers, whose word takes the plural; English writes "keepers" for every count, as it always has.
    return isProject(w)
        ? tn(of, '{yes} yes, {no} no. Needs {need} yes of {n} collaborators.', '{yes} yes, {no} no. Needs {need} yes of {n} collaborators.', values)
        : tn(of, '{yes} yes, {no} no. Needs {need} yes of {n} keepers.', '{yes} yes, {no} no. Needs {need} yes of {n} keepers.', values);
}

export function successionDeadlineText(p: SuccessionLite, now = Date.now()): string | null {
    if (!p.deadlineAt) return null;
    return t('Open for 14 days: {time}.', { time: timeLeftText(p.deadlineAt, now) });
}

export function myChoice(p: SuccessionLite, me: string | null | undefined): 'yes' | 'no' | null {
    const v = me ? p.votes?.find(x => x.voterPubkey === me) : undefined;
    return v ? (v.choice === 'no' ? 'no' : 'yes') : null;
}

export function successionClosedText(reason: string | null | undefined, w: KeeperWords = ENTERPRISE): string | null {
    const project = isProject(w);
    switch (reason) {
        case 'rejected': return project ? t('Not enough collaborators said yes, so the leader stays.') : t('Not enough keepers said yes, so the lead stays.');
        case 'expired': return t('The 14 days ran out before a majority said yes.');
        case 'lead_returned': return project ? t('The leader became active again, so the proposal closed.') : t('The lead became active again, so the proposal closed.');
        case 'lead_changed': return project ? t('The leader changed, so the proposal closed.') : t('The lead changed, so the proposal closed.');
        case 'candidate_gone': return project ? t('The candidate is no longer an active collaborator.') : t('The candidate is no longer an active keeper.');
        default: return null;
    }
}

/** Heading for the succession card: why succession is open now. In capitals as written, in every language. */
export function successionHeading(inactivity: { autoPromoted?: boolean; daysInactive?: number } | null | undefined, w: KeeperWords = ENTERPRISE): string {
    const project = isProject(w);
    if (inactivity?.autoPromoted) return project ? t('NEW LEADER CHOSEN AUTOMATICALLY') : t('NEW LEAD CHOSEN AUTOMATICALLY');
    const days = Math.floor(inactivity?.daysInactive ?? 0);
    return project
        ? tn(days, 'LEADER INACTIVE ({n} DAYS)', 'LEADER INACTIVE ({n} DAYS)')
        : tn(days, 'LEAD KEEPER INACTIVE ({n} DAYS)', 'LEAD KEEPER INACTIVE ({n} DAYS)');
}

export function successionExplainer(inactivity: { autoPromoted?: boolean; leadCallsign?: string | null } | null | undefined, w: KeeperWords = ENTERPRISE): string {
    const name = inactivity?.leadCallsign;
    const project = isProject(w);
    if (inactivity?.autoPromoted) {
        if (project) {
            return name
                ? t('{name} became leader automatically as the longest-serving collaborator. The other collaborators can choose someone else now. More than half of the other collaborators saying yes moves the leader role. Each proposal is open for 14 days.', { name })
                : t('The leader became leader automatically as the longest-serving collaborator. The other collaborators can choose someone else now. More than half of the other collaborators saying yes moves the leader role. Each proposal is open for 14 days.');
        }
        return name
            ? t('{name} became lead automatically as the longest-serving keeper. The other keepers can choose someone else now. More than half of the other keepers saying yes moves the lead role. Each proposal is open for 14 days.', { name })
            : t('The lead became lead automatically as the longest-serving keeper. The other keepers can choose someone else now. More than half of the other keepers saying yes moves the lead role. Each proposal is open for 14 days.');
    }
    if (project) {
        return name
            ? t('{name} has recorded no node activity for 30+ days. More than half of the other collaborators saying yes moves the leader role. Each proposal is open for 14 days. If the leader returns first, the proposal closes.', { name })
            : t('The leader has recorded no node activity for 30+ days. More than half of the other collaborators saying yes moves the leader role. Each proposal is open for 14 days. If the leader returns first, the proposal closes.');
    }
    return name
        ? t('{name} has recorded no node activity for 30+ days. More than half of the other keepers saying yes moves the lead role. Each proposal is open for 14 days. If the lead returns first, the proposal closes.', { name })
        : t('The lead keeper has recorded no node activity for 30+ days. More than half of the other keepers saying yes moves the lead role. Each proposal is open for 14 days. If the lead returns first, the proposal closes.');
}

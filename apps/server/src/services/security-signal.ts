/**
 * The one call a security source makes to tell this server's owners (design scratch/global-node/DESIGN-alerts-fable.md
 * §3.2 sec.*, slice S4): a role granted or taken away, wrong passwords or claim proofs arriving, the community claimed,
 * a sign-in key or code changed, the address no longer this community's.
 *
 * It lives apart from services/alerts.ts, as takeover-signal.ts does from the sealing code, so that engine/node-roles.ts,
 * password-brake.ts, claim-code.ts and admin-key-auth.ts can call it without importing the alert book (and its imports
 * of them). Until the book is loaded, a note goes nowhere.
 *
 * A note's words are the server's own: what happened and how, never a member's name, callsign or key, nor an address.
 * Safe to call inside a database transaction: the book tells it once the transaction is over, and only if `stillTrue`
 * (when given) says it happened (a transaction that rolled back granted nothing).
 */

export type SecurityAlertKey = 'sec.role' | 'sec.password-burst' | 'sec.claim' | 'sec.claim-guess' | 'sec.keys' | 'sec.name' | 'sec.agent'
    | 'sec.restore' | 'sec.backups' | 'sec.members' | 'sec.settings';

/**
 * The address alert's words (sec.name), by why a name is lost, and its end: the name watch tells a change at once, and the
 * alert book's tick reads the record every minute and says the same. Never the other community's key, nor which address.
 */
export const NAME_ALERT_WORDS = {
    'another-key': "The address service names another community's key as the holder of this community's address, and the address "
        + 'answers as that community: what apps sign for this community there is refused. Open Settings → Public address.',
    released: 'This community released its address and the hold is over: what apps sign for it there is refused. Claiming it again brings it back.',
    back: "This community's address is its own again.",
} as const;

/**
 * The owner-delete alerts' words (design case 18 §7, S5): what changed and how, a date or a count, never a member's
 * name, callsign or key, nor an address. `{n}` is a day's count (SecurityNote.perDay).
 */
export const OWNER_ALERT_WORDS = {
    restored: (madeOn: string, by: 'owner' | 'shell') => `A backup made ${madeOn} was restored, ${by === 'shell' ? "from the server's shell" : 'by an owner'}. A restore point was kept.`,
    rolledBack: (madeOn: string, by: 'owner' | 'shell') => `This community was rolled back to how it was on ${madeOn}, ${by === 'shell' ? "from the server's shell" : 'by an owner'}. A restore point was kept.`,
    otherCommunityRefused: { one: 'A backup from another community was refused today.', many: '{n} backups from another community were refused today.' },
    addressOffline: "This community's address was taken offline, by an owner.",
    addressChanged: "This community's address was changed, by an owner.",
    tunnelKey: "A new tunnel key was made for this community's address, by an owner.",
    recoveryCodeReplaced: 'The recovery code was replaced, by an owner. Backups made before still open with the old one.',
    replicationTokenMade: 'A new replication token was made: a standby can copy this server with it.',
    replicationTokenCleared: 'The replication token was cleared: no standby can copy this server until a new one is made.',
    standbyForgotten: 'A standby was forgotten: this server no longer lists it.',
    copyFromChanged: 'The server this standby copies from was changed.',
    offBoxRemoved: 'An off-box backup destination was removed.',
    offBoxChanged: 'An off-box backup destination was changed.',
    snapshotKeepLowered: (from: number, to: number) => `Fewer snapshots are kept now: ${to}, down from ${from}.`,
    membersRemoved: { one: 'A member was removed today, by an admin.', many: '{n} members were removed today, by an admin.' },
    branchesPruned: { one: 'A branch of invites was pruned today, by an owner.', many: '{n} branches of invites were pruned today, by an owner.' },
    communityRenamed: "The community's name was changed, by an admin.",
    callsignChanged: "The community's callsign was changed, by an admin.",
    contactsChanged: "The community's contact details were changed, by an admin.",
    channelChanged: (community: string) => `${community}: the alert channel was changed, by an owner. This is the last alert sent here.`,
    channelRemoved: (community: string) => `${community}: the alert channel was removed, by an owner. This is the last alert sent here.`,
} as const;

/** The first this many one-shot pushes per actor and hour go at once (as many again for high ones); the rest fold into one hourly line. */
export const SECURITY_PUSHES_PER_HOUR = 3;

export interface SecurityNote {
    key: SecurityAlertKey;
    detail: string;
    /** ntfy's 3 default, 4 high, 5 urgent; the row's own when left out. */
    priority?: 3 | 4 | 5;
    /**
     * Left out: told once (a role changed). true / false: a condition that starts or ends (the address lost, then its
     * own again). 'seen': still going on (wrong passwords), ended by an hour without another.
     */
    state?: boolean | 'seen';
    /** Read once any transaction is over: false means it did not happen after all, and nothing is told. */
    stillTrue?: () => boolean;
    /**
     * Who acted (a member's key, 'owner:password', 'break-glass:enrolment'), only to bound the owners' pushes per actor
     * and hour: kept as a hash, never told. Left out: the server itself.
     */
    actor?: string;
    /** The actor's role in words for the hourly "N more changes by the same …" line: 'owner', 'admin', 'admin password'. */
    actorRole?: string;
    /** An owner made or removed, break-glass: never folded out of the channel or the Alerts card, pushed under its own bound. */
    high?: boolean;
    /**
     * Counted per day (UTC): the book keeps how many it was told today and tells `one` for the first, then `many` with
     * `{n}` as the count, in place of `detail`.
     */
    perDay?: { one: string; many: string };
    /** Members also pushed with this one (an owner or admin who lost the role): never kept, never told. */
    alsoPush?: string[];
}

type Handler = (note: SecurityNote) => void;
let handler: Handler | null = null;

export function setSecurityAlertHandler(h: Handler | null): void {
    handler = h;
}

export function noteSecurityEvent(note: SecurityNote): void {
    if (!handler) return;
    try {
        handler(note);
    } catch { /* an alert is never allowed to break the change it tells of */ }
}

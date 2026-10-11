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

export type SecurityAlertKey = 'sec.role' | 'sec.password-burst' | 'sec.claim' | 'sec.claim-guess' | 'sec.keys' | 'sec.name';

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

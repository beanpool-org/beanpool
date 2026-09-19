/**
 * The one call every chokepoint makes when something the take-over envelope holds may have changed: an owner
 * added or removed, an account disabled or pruned, the admin credentials, the connectors, the public address.
 *
 * It lives apart from services/takeover-envelope.ts so that engine/node-roles.ts, config/local-config.ts,
 * connector-manager.ts and state-engine.ts can call it without importing the sealing code (and its imports of
 * them). Until the envelope service starts, a note goes nowhere; the service checks everything at start anyway.
 *
 * Safe to call inside a database transaction: the handler only schedules a debounced check, which reads after
 * the transaction has committed (sealed-keys.md §4).
 */

type Handler = (reason: string) => void;
let handler: Handler | null = null;

export function setTakeoverChangeHandler(h: Handler | null): void {
    handler = h;
}

export function noteTakeoverInputsChanged(reason: string): void {
    if (!handler) return;
    try {
        handler(reason);
    } catch { /* a re-seal is never allowed to break the write that asked for it */ }
}

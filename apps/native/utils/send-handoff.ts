/**
 * Send opened by another page of this app with a recipient and a note (Learn's "🫘 Thank {name}", slice K8): handed over in
 * memory, never in the route. Route params also arrive from outside the app (a beanpool:// link goes to the router as it is:
 * app/+native-intent.ts), so no money screen reads a recipient, an amount or a name from them (review of #3243). The page
 * that offers Thank writes the request here just before it opens the Ledger, and the Ledger takes it once. A request not
 * taken within a minute is dropped, so a tap whose Ledger never opened can't open a form at some later visit.
 *
 * The recipient's name is never handed over: the Ledger names them from this community's member list, by key
 * ({@link sendPrefill}), and a key the list doesn't hold opens no form.
 */

/** What a page hands the Ledger: the recipient's key and the note, each changeable in the form. */
export interface SendRequest { to: string; note: string }

/** What the form opens with: the recipient as the member list names them, and the note. */
export interface SendPrefill { to: string; name: string; note: string }

/** How long a request waits for the Ledger to take it. */
export const SEND_REQUEST_MS = 60_000;

let held: (SendRequest & { at: number }) | null = null;

/** Called by the page itself, on the member's tap, just before it opens the Ledger. A newer request replaces an older one. */
export function handOverSend(request: SendRequest, nowMs: number = Date.now()): void {
    held = { to: request.to, note: request.note, at: nowMs };
}

/** The request, once: it is gone as it is read. None when nothing was handed over, or it waited too long. */
export function takeSendRequest(nowMs: number = Date.now()): SendRequest | null {
    const request = held;
    held = null;
    if (!request || nowMs < request.at || nowMs - request.at > SEND_REQUEST_MS) return null;
    return { to: request.to, note: request.note };
}

/**
 * What a request opens: the Beans form for someone this community's member list holds, other than the member themselves,
 * named as the list names them. Nothing for oneself, and nothing for a key the list doesn't hold (never a form naming it).
 */
export function sendPrefill(
    request: SendRequest | null,
    members: readonly { publicKey: string; callsign: string }[],
    me: string | null | undefined,
): SendPrefill | null {
    if (!request || !request.to || request.to === me) return null;
    const member = members.find((m) => m.publicKey === request.to);
    return member ? { to: member.publicKey, name: member.callsign, note: request.note } : null;
}

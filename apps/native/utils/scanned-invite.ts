/**
 * An invite scanned inside the app by a phone in a community (Find a community's Scan a code, app/find-community.tsx):
 * handed to the root layout's invite-link handling (app/_layout.tsx), the handling an invite opened as a link gets, so a
 * member is offered "Switch Nodes?" for another community, or asked how to go on for the one in use. Never to the first
 * screen's invite step: the root guard takes a member off welcome to the tabs before that step is used, and the invite
 * was gone with nothing said (PR #2604 review r4413833915).
 *
 * In memory, never through the phone's link handling: nothing from outside the app comes in this way. One handed over
 * before the root layout listens waits for it, and is taken once.
 */

let listener: ((link: string) => void) | null = null;
let waiting: string | null = null;

/** Where Find's scanned invite goes: the root layout's invite-link handling for a phone in a community, else the first screen's invite step. */
export function scannedInviteGoesToRoot({ hasIdentity, anchorUrl }: { hasIdentity: boolean; anchorUrl: string | null }): boolean {
    return hasIdentity && !!(anchorUrl ?? '').trim();
}

/** Hand a scanned invite, the scan's text as read, to the root layout's invite-link handling. */
export function handScannedInvite(link: string): void {
    const s = link.trim();
    if (!s) return;
    if (listener) listener(s);
    else waiting = s;
}

/** The root layout's: each scanned invite handed over (one waiting first), until the returned function is called. */
export function listenForScannedInvites(on: (link: string) => void): () => void {
    listener = on;
    const was = waiting;
    waiting = null;
    if (was) on(was);
    return () => { if (listener === on) listener = null; };
}

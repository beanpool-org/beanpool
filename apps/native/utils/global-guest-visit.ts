/**
 * Guest view first (Marty, board 21 Oct 2026: "Yes, guest view first"; DESIGN-global-entry-fable.md §A row 16). On the web
 * a visitor to the global community lands in its lobby, looks around, then joins (apps/pwa lib/visitor-lobby-gate.ts); a
 * local community's web app links it the same way (Settings, the members-only page). On the phone the BeanPool sheet's
 * global row, Settings → Saved communities and the Market's members-only page went straight to the door instead. Now they
 * open the global community as a guest: its listings without the people (G9a), the guest dot, and the header's Join pill,
 * which leads to People → Invites → the door (app/join-global.tsx) when the member is ready.
 *
 * A visit is a switch, as any saved community's (reconnect.ts switchPhoneTo), asked first, and the phone moves only for an
 * answer that lets it look:
 * - the door first (unsigned, node-profile.ts checkGlobalDoor), as every screen that offers it asks (use-global-entry.ts):
 *   shut, in a private preview, not the global community, or no answer, and nothing moves (`door`): the door's own page
 *   says which, with Try again. A phone whose door is shut never tells the global community which key opened it.
 * - then the key's standing (global-entry.ts askGlobalStanding: the membership probe, signed by the key, kept as the one
 *   rule keeps it):
 *   - a member: switched, as a member, and any guest mark it had goes;
 *   - a stranger: marked a guest visit FIRST (nodes.ts markGuestNode), so the root layout never diverts a chosen guest to
 *     the not-recognised screen and the sync keeps the visitors' view of the listings (posts-view.ts); kept in the saved
 *     list; then switched;
 *   - its account there closed: nothing moves (`closed`);
 *   - no answer: nothing moves (`door`): the door screen asks again, and lands a member it didn't know of.
 *
 * Identity: a visit never makes, replaces, reads out or sends away a key. It signs one probe with the key the phone already
 * holds and writes nothing of the account: the guest mark, the saved list, the community in use and the probe's kept
 * answer, nothing else. Joining afterwards is the door's, as the same account (#1402).
 *
 * A phone with no account yet (`identity` null: the first screen's Explore BeanPool worldwide, slice S12,
 * utils/look-around.ts) looks the same way with nothing to sign: the door is asked, and only a door that is open AND shows
 * visitors its view (`guestListingsOnly`, look-around.ts showsVisitorsView) lets it in as a guest; no probe is sent, so the
 * global community hears of no key at all. Every other answer moves nothing (`door`), and the first screen opens the door
 * as before, which says why. The key is made at Join, by the door, never here.
 *
 * Asked, then written: the asks can take a while (the door's read is bounded at node-profile.ts FETCH_TIMEOUT_MS), and the
 * screen that asked may have moved on by the answer (the first screen's Join with an invite works all the while). A
 * caller's `proceed` is asked once the answers are in and before the first write; false, and nothing moves (`left`), so
 * a visit nobody is waiting for never marks, saves or switches behind the screen now in use (PR #2559 review).
 *
 * No-domain-lock-in: only the global community's own row and links call this; nothing else on the phone waits on it.
 */

import { GLOBAL_NODE_URL } from './global-node-url';
import { showsVisitorsView } from './look-around';
import type { AskedStanding } from './global-entry';
import type { GlobalDoorCheck } from './node-profile';

export type GuestVisit =
    /** A member there: the phone switched to it. */
    | { kind: 'member' }
    /** Not a member there: the phone switched to it as a guest. */
    | { kind: 'guest' }
    /** Nothing moved: the door can't be used from here right now, or the key's standing got no answer. The door's page says. */
    | { kind: 'door' }
    /** Nothing moved: the global community closed this key's account. */
    | { kind: 'closed' }
    /** Nothing moved: whoever asked had moved on by the answer (`proceed` said no). */
    | { kind: 'left' };

export interface GuestVisitDeps {
    checkDoor(url: string): Promise<GlobalDoorCheck>;
    askStanding(identity: { publicKey: string; privateKey: string }, url: string): Promise<AskedStanding>;
    markGuestNode(url: string): Promise<void>;
    clearGuestNode(url: string): Promise<void>;
    addSavedNode(url: string, alias?: string): Promise<void>;
    /** Make `url` the phone's community: its own database, the anchor, the update screen told. */
    switchTo(url: string): Promise<unknown>;
    /** Asked once the answers are in, just before the first write: false when whoever asked has moved on. None: always on. */
    proceed?(): boolean;
}

async function defaultDeps(): Promise<GuestVisitDeps> {
    // Loaded when used, as reconnect.ts does: the switch pulls in the whole data layer, the probe signs.
    const [profiles, entry, nodes, reconnect] = await Promise.all([
        import('./node-profile'), import('./global-entry'), import('./nodes'), import('./reconnect'),
    ]);
    return {
        checkDoor: (url) => profiles.checkGlobalDoor(url),
        askStanding: (identity, url) => entry.askGlobalStanding(identity, undefined, url),
        markGuestNode: nodes.markGuestNode,
        clearGuestNode: nodes.clearGuestNode,
        addSavedNode: (url, alias) => nodes.addSavedNode(url, alias),
        switchTo: (url) => reconnect.switchPhoneTo(url),
    };
}

/**
 * Open the global community (`url`, the phone's saved spelling of it where it has one) as a guest, or as a member where
 * it says the key is one. With no identity (`null`: a phone with no account yet), as a guest or not at all: nothing is
 * signed or sent but the door's own unsigned read. Throws only when the switch itself fails (the phone then stays where
 * it was, as any switch).
 */
export async function visitGlobalAsGuest(
    identity: { publicKey: string; privateKey: string } | null,
    url: string = GLOBAL_NODE_URL,
    injected?: Partial<GuestVisitDeps>,
): Promise<GuestVisit> {
    const keys: (keyof GuestVisitDeps)[] = ['checkDoor', 'askStanding', 'markGuestNode', 'clearGuestNode', 'addSavedNode', 'switchTo'];
    const deps: GuestVisitDeps = keys.every(k => injected?.[k]) ? injected as GuestVisitDeps : { ...(await defaultDeps()), ...injected };
    const door = await deps.checkDoor(url).catch((): GlobalDoorCheck => ({ ok: false, reason: 'unreachable' }));
    if (!door.ok) return { kind: 'door' };
    if (!identity) {
        // Nothing to sign with, and nothing to sign: a visitor with no key reads only what the node shows visitors.
        if (!showsVisitorsView(door.profile)) return { kind: 'door' };
        if (deps.proceed && !deps.proceed()) return { kind: 'left' };
        await deps.markGuestNode(url);
        await deps.addSavedNode(url, 'Global community').catch(() => {});
        await deps.switchTo(url);
        return { kind: 'guest' };
    }
    const asked = await deps.askStanding(identity, url).catch((): AskedStanding => ({ standing: 'unknown', closed: false, answered: false }));
    if (!asked.answered) return { kind: 'door' };
    if (asked.closed) return { kind: 'closed' };
    if (deps.proceed && !deps.proceed()) return { kind: 'left' };
    if (asked.standing === 'member') {
        await deps.clearGuestNode(url).catch(() => {});
        await deps.addSavedNode(url, 'Global community').catch(() => {});
        await deps.switchTo(url);
        return { kind: 'member' };
    }
    // A stranger: the guest mark before anything moves, so the phone is never on the global community unmarked.
    await deps.markGuestNode(url);
    await deps.addSavedNode(url, 'Global community').catch(() => {});
    await deps.switchTo(url);
    return { kind: 'guest' };
}

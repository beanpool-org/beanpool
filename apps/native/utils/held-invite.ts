/**
 * The invite a link brought to this phone, kept until it is used or a newer link replaces it (Damo, 9 Nov).
 *
 * A link's invite reached welcome only as that screen's params and its `Linking.useURL()`. Both belong to one copy of the
 * screen: a warm start's link routes the app to `/` and on to a NEW welcome (app/index.tsx), with no params, and its
 * `useURL()` starts empty because the link's event fired before it mounted. So does any detour that replaces welcome on the
 * way. The member then met the first screen with no code, and "Join with an invite" asked them to scan the QR again.
 *
 * The root layout holds the invite here as it routes the link (app/_layout.tsx `routeToWelcomeWithInvite`); every copy of
 * welcome reads it when it mounts and hears a newer one while open, and "Join with an invite" fills the step from it. It is
 * forgotten when the invite is redeemed. Only the code, its community and the listing it was sent from are kept: never a
 * key, and nothing is sent anywhere because of it.
 */

/** The storage it is kept in (AsyncStorage in the app; a map in tests). */
export interface HeldInviteStorage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
}

export interface HeldInvite {
    invite: string;
    server?: string;
    /** The listing an invite-and-share link was sent from (core postIdFromInviteLink). */
    post?: string;
    /** When the link arrived (ms): a newer link wins, and each copy of welcome applies one arrival once. */
    at: number;
}

export const HELD_INVITE_KEY = 'beanpool_held_invite';
/** Invites last 30 days at the community; one held longer than that can't be used, so it is not offered. */
export const HELD_INVITE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const listeners = new Set<(held: HeldInvite) => void>();

function parse(raw: string | null, nowMs: number): HeldInvite | null {
    if (!raw) return null;
    try {
        const v = JSON.parse(raw);
        if (!v || typeof v.invite !== 'string' || !v.invite.trim() || typeof v.at !== 'number') return null;
        if (nowMs - v.at > HELD_INVITE_MAX_AGE_MS || v.at - nowMs > 60_000) return null;
        return {
            invite: v.invite,
            at: v.at,
            ...(typeof v.server === 'string' && v.server ? { server: v.server } : {}),
            ...(typeof v.post === 'string' && v.post ? { post: v.post } : {}),
        };
    } catch {
        return null;
    }
}

/** Keep a link's invite, replacing any held before, and tell every open welcome. */
export async function holdInvite(
    storage: HeldInviteStorage, invite: { invite: string; server?: string | null; post?: string | null }, nowMs: number = Date.now(),
): Promise<HeldInvite> {
    const held: HeldInvite = {
        invite: invite.invite,
        at: nowMs,
        ...(invite.server ? { server: invite.server } : {}),
        ...(invite.post ? { post: invite.post } : {}),
    };
    // Heard first, so a welcome that is open takes it even if the write is slow or fails.
    listeners.forEach((fn) => { try { fn(held); } catch { /* a listener's own trouble stays its own */ } });
    await storage.setItem(HELD_INVITE_KEY, JSON.stringify(held)).catch(() => {});
    return held;
}

/** The invite held now, if one is and it is not too old to use. */
export async function readHeldInvite(storage: HeldInviteStorage, nowMs: number = Date.now()): Promise<HeldInvite | null> {
    const raw = await storage.getItem(HELD_INVITE_KEY).catch(() => null);
    const held = parse(raw, nowMs);
    if (raw && !held) await storage.removeItem(HELD_INVITE_KEY).catch(() => {});
    return held;
}

/** Forget the held invite: it has been redeemed. Only the one named, so a newer link that arrived meanwhile stays. */
export async function forgetHeldInvite(storage: HeldInviteStorage, code?: string): Promise<void> {
    if (code !== undefined) {
        // Whatever its age: only which invite it is matters here.
        let heldCode: unknown = null;
        try { heldCode = JSON.parse((await storage.getItem(HELD_INVITE_KEY).catch(() => null)) ?? 'null')?.invite; } catch { /* unreadable: cleared */ }
        if (typeof heldCode === 'string' && heldCode.trim().toUpperCase() !== code.trim().toUpperCase()) return;
    }
    await storage.removeItem(HELD_INVITE_KEY).catch(() => {});
}

/** Hear each invite held from now on (a welcome that is open). Returns the unsubscribe. */
export function onHeldInvite(fn: (held: HeldInvite) => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

/** The key one arrival is known by, so each copy of welcome applies it once. */
export function heldInviteKey(held: HeldInvite): string {
    return `held:${held.invite}|${held.server ?? ''}|${held.at}`;
}

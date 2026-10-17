/**
 * Google Play's install referrer, read once ever on the first screen (app/welcome.tsx). A link tapped WITHOUT the app
 * installed detours via Google Play, and the website packs what the link was for into the store link's `referrer`, which
 * Google hands the app on its first start:
 * - an invite (the invite trampoline, routes/invite-trampoline.ts): `invite=…&server=…`, so the invite survives the install
 *   with no clipboard or retyping;
 * - the global community (beanpool.org/global, apps/website/global.html): `global=1`, which names no one and opens the first
 *   screen's door (DESIGN-global-entry-fable.md §A row 5).
 *
 * An invite in the same referrer wins over `global=1`. Android only; on iOS the App Store hands nothing over, and the first
 * screen shows both doors. No lock-in: with no referrer, or a store that isn't Google Play, the first screen is as it was.
 */
import { shouldBlockCleartextNodeUrl } from './node-url';

/** Set once the referrer has been read, so it is acted on once ever. Left unset when it couldn't be read, to try again. */
export const INSTALL_REFERRER_CHECKED_KEY = 'beanpool_install_referrer_checked';

/** What the referrer asked for: an invite (with its community's address when it named a safe one), the global door, or nothing. */
export type InstallReferrer =
    | { kind: 'invite'; invite: string; server: string | null }
    | { kind: 'global' }
    | null;

/** One `name=value` from the referrer, decoded once more as the trampoline encodes it, or null when absent or unreadable. */
function referrerValue(referrer: string, name: string): string | null {
    const m = new RegExp(`(?:^|&)${name}=([^&]+)`).exec(referrer);
    if (!m) return null;
    try {
        return decodeURIComponent(m[1]);
    } catch {
        return null;
    }
}

/**
 * What a referrer string asks for. The invite first: one in the referrer always wins. Its server only when it is not
 * cleartext to a public host, the same trust rule as a deep link's (utils/node-url.ts): the invite is still used without
 * it, and the join form asks for the address.
 */
export function readInstallReferrer(referrer: unknown): InstallReferrer {
    if (typeof referrer !== 'string' || !referrer) return null;
    const invite = referrerValue(referrer, 'invite');
    if (invite && invite.trim()) {
        const server = referrerValue(referrer, 'server');
        return { kind: 'invite', invite, server: server && !shouldBlockCleartextNodeUrl(server) ? server : null };
    }
    if (/(?:^|&)global=1(?:&|$)/.test(referrer)) return { kind: 'global' };
    return null;
}

export interface InstallReferrerDeps {
    os: string;
    storage: { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };
    /** expo-application's getInstallReferrerAsync, which throws without Play Services (an emulator, a de-Googled phone). */
    getReferrer(): Promise<string | null | undefined>;
}

/**
 * The referrer, the first time it can be read on this phone, and never again. Marked read as soon as it is read, before
 * anything acts on it, so a crash on the way never acts on it twice. One that couldn't be read is left unmarked, so a
 * passing failure is tried again on the next visit to the first screen.
 */
export async function takeInstallReferrer(deps: InstallReferrerDeps): Promise<InstallReferrer> {
    if (deps.os !== 'android') return null;
    try {
        if (await deps.storage.getItem(INSTALL_REFERRER_CHECKED_KEY)) return null;
        const referrer = await deps.getReferrer();
        await deps.storage.setItem(INSTALL_REFERRER_CHECKED_KEY, 'true');
        return readInstallReferrer(referrer);
    } catch {
        return null;
    }
}

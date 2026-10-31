/**
 * Look before you join, on a phone with no account yet (DESIGN-entry-points-fable.md §3.3 and §3.0 "Look", slice S12;
 * Marty, "all of Fable's picks", 27 Oct 2026, decision 11). The first screen's **Explore BeanPool worldwide** opens the
 * global community as a visitor, as the BeanPool sheet's row does for an account (utils/global-guest-visit.ts) and as the
 * web does for everyone (apps/pwa lib/visitor-lobby.ts): its listings without the people, Home's visitor cards, the map,
 * with **Join** at the top. The door's work (the key, the 12 words, the sign-in) starts at Join, never before.
 *
 * The root guard (app/_layout.tsx, utils/auth-return.ts `setupRedirect`) lets a phone with no identity stay on these
 * screens only while it is looking around: the community in use is one it chose to visit as a guest (nodes.ts
 * markGuestNode), and its profile is the global community's with the visitors' view on (`guestListingsOnly`), so every
 * read it makes is one the node answers unsigned. Anything that needs a key (a message, a profile, asking a community,
 * Settings) opens the door instead ({@link LOOK_DOOR}).
 *
 * Identity: nothing here makes, writes or sends a key ({@link forgetTheLook} and {@link lookingAroundHere} only ask
 * whether the phone holds one, readable or not: identity.ts readStoredIdentity).
 * Looking writes the guest mark, the saved list and the community in use, nothing of an account.
 *
 * No-domain-lock-in: only the global community's own door leads here; a phone that never taps it is exactly as before.
 */

import type { NodeProfile } from './node-profile';

/** The welcome screen's door, opened from the look (app/welcome.tsx `join=look`): Back there returns to the look. */
export const LOOK_DOOR = { pathname: '/welcome', params: { join: 'look' } } as const;

/** The value of welcome's `join` param that means "opened from the look". */
export const LOOK_JOIN = 'look';

/** Where the look lands, and where Back from its door returns: the Market, the visitors' listings (§3.3's walk). */
export const LOOK_LANDING = '/(tabs)/market' as const;

/**
 * The screens a phone with no account may look at: Home, the Market and the Map (with the example Ledger and Commons
 * where the node shows them), one listing, the members' guide, the BeanPool sheet, and Start a community (its ways to
 * run one and the details to copy: the organiser's door, which needs no key), and the map's + (app/new-listing.tsx: its
 * chooser tells a visitor nothing is saved until they join and offers Join to post, components/NewPostTypeSheet.tsx; the
 * Offer and Need form asks for a name first, and every submit on it checks for a key). Talk, People, Pulse and Settings
 * are an account's, as is every other screen.
 */
const LOOK_TABS: ReadonlySet<string> = new Set(['index', 'market', 'map', 'ledger', 'projects']);
const LOOK_ROOTS: ReadonlySet<string> = new Set(['post', 'guide', 'beanpool', 'start-community', 'new-listing']);

/** Whether `segments` (expo-router's useSegments) is a screen a visitor with no key may stay on. */
export function isLookRoute(segments: readonly string[]): boolean {
    const [root, tab] = segments;
    if (root === '(tabs)') return tab === undefined || LOOK_TABS.has(tab);
    return root !== undefined && LOOK_ROOTS.has(root);
}

/** Whether a node's profile gives a visitor with no key its view: the global community's, open to visitors, not a preview. */
export function showsVisitorsView(profile: Pick<NodeProfile, 'profile' | 'features'> | null | undefined): boolean {
    return profile?.profile === 'global' && profile.features?.guestListingsOnly === true && profile.features?.privatePreview !== true;
}

export interface ForgetDeps {
    /** The key the phone holds; throws for one it can't read (identity.ts readStoredIdentity, never loadIdentity's null). */
    storedKey(): Promise<unknown>;
    clearGuestNodes(): Promise<void>;
}

/**
 * An account is arriving on a phone that held none (a restore, a re-key code): the guest marks on it are the look's,
 * not this account's choices (nothing else marks a phone with no account: Sign Out and Delete wipe them, identity.ts
 * wipeIdentityScopedStorage), so they go before it arrives. Kept, the account restored into the global community would
 * read as a visitor there: the sync would send it none of the account's blocks (blocklist.ts) and keep a visitors' view
 * over its listings (posts-view.ts), and a key it doesn't know would sit there as a guest instead of hearing so
 * (app/node-mismatch.tsx), as before S12. A phone that holds a key, or one it can't read, keeps its marks. Never throws.
 */
export async function forgetTheLook(injected?: ForgetDeps): Promise<void> {
    try {
        const deps = injected ?? await (async (): Promise<ForgetDeps> => {
            const [identity, nodes] = await Promise.all([import('./identity'), import('./nodes')]);
            return { storedKey: identity.readStoredIdentity, clearGuestNodes: nodes.clearGuestNodes };
        })();
        if (await deps.storedKey()) return;
        await deps.clearGuestNodes();
    } catch {
        // A key this phone can't read is an account: its marks stay.
    }
}

export interface LookingDeps {
    /** The key the phone holds; throws for one it can't read (identity.ts readStoredIdentity). */
    storedKey(): Promise<unknown>;
    anchor(): Promise<string | null>;
    isGuestNode(url: string): Promise<boolean>;
    cachedProfile(url: string): Promise<Pick<NodeProfile, 'profile' | 'features'> | null>;
}

async function defaultDeps(): Promise<LookingDeps> {
    const [{ default: AsyncStorage }, nodes, profiles, identity] = await Promise.all([
        import('@react-native-async-storage/async-storage'), import('./nodes'), import('./node-profile'), import('./identity'),
    ]);
    return {
        storedKey: identity.readStoredIdentity,
        anchor: () => AsyncStorage.getItem('beanpool_anchor_url'),
        isGuestNode: nodes.isGuestNode,
        cachedProfile: profiles.getCachedNodeProfile,
    };
}

/**
 * Whether the phone, holding no account, is looking around: the community in use is a chosen guest visit whose saved
 * profile shows visitors its view ({@link showsVisitorsView}). False for anything it can't read: the guard then sends
 * the phone to the first screen, as it always has. False too for a phone that holds a key, readable or not: an account
 * whose key can't be read this launch is no visitor, and goes to the first screen as before the look. No network.
 */
export async function lookingAroundHere(injected?: LookingDeps): Promise<boolean> {
    try {
        const deps = injected ?? await defaultDeps();
        const anchor = await deps.anchor();
        if (!anchor) return false;
        if (!(await deps.isGuestNode(anchor))) return false;
        if (!showsVisitorsView(await deps.cachedProfile(anchor))) return false;
        return !(await deps.storedKey());
    } catch {
        return false;
    }
}

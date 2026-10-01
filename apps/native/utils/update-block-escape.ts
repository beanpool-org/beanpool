/**
 * The ways out of the full-screen "Update required" (components/ForceUpdateBlock.tsx), which one community's floor puts
 * up over the whole app (utils/force-update.ts).
 *
 * The account is the member's, not the community's, and a phone can hold several communities. So the block never takes
 * from the member more than that one community (#1415's deciding review, BLOCKING):
 * - **Use another community**: every other community saved on this phone, one tap each. The phone moves there as the
 *   BeanPool sheet moves it (use-communities.ts), the block comes down, and the community now in use is asked at once
 *   (utils/community-switch.ts): its own floor, not the one left, decides. The floor still holds where it was set:
 *   switching back is a safe moment, and that community puts its block up again.
 * - **The 12 words** and **leaving the community**, always: the block steps aside for Settings' own Recovery Phrase and
 *   Account Deletion & Sign Out, exactly as Settings has them (the phone's lock first, the typed confirmations, the plan
 *   of what a delete keeps). It steps aside only while one of those sections is in front on the Settings tab
 *   ({@link ACCOUNT_SECTIONS}), and comes back the moment the member goes anywhere else.
 *
 * It also makes a hostile or broken node survivable. A node can name any floor and, in the same answer, any store
 * version (the phone cannot ask the stores itself without depending on them), so it can put this block up on its own
 * members' phones whenever it likes. It still holds only that community: the member's other communities, their words
 * and the way to leave it stay one tap away.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { communityName } from './community-name';
import { communitySwitched } from './community-switch';
import { assertPlainNodeAddress, plainOriginOf } from './node-url';
import { SAVED_NODES_STORE_KEY } from './storage-keys';

const ANCHOR_STORE_KEY = 'beanpool_anchor_url';

interface Storage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
}

export interface OtherCommunity {
    /** The address as the phone saved it. */
    url: string;
    name: string;
}

/**
 * The communities saved on this phone other than the one it is set to, in the saved list's order: the block's "Use
 * another community". Only plain addresses (node-url.ts: the phone never switches to any other), each community once
 * (two addresses are one community when their origins are equal: node-url.ts plainOriginOf). Never
 * throws: a list that can't be read is none, and the block then offers the words and leaving only.
 */
export async function otherCommunitiesOnPhone(storage: Pick<Storage, 'getItem'> = AsyncStorage): Promise<OtherCommunity[]> {
    try {
        const [raw, anchor] = await Promise.all([storage.getItem(SAVED_NODES_STORE_KEY), storage.getItem(ANCHOR_STORE_KEY)]);
        const parsed: unknown = JSON.parse(raw ?? '[]');
        if (!Array.isArray(parsed)) return [];
        const here = plainOriginOf(anchor);
        const seen = new Set<string>(here ? [here] : []);
        const out: OtherCommunity[] = [];
        for (const n of parsed) {
            if (!n || typeof n !== 'object') continue;
            const { url, alias, nodeName } = n as { url?: unknown; alias?: unknown; nodeName?: unknown };
            const address = plainOriginOf(url);
            if (!address || seen.has(address)) continue;
            seen.add(address);
            out.push({ url: url as string, name: communityName({ url: url as string, alias: typeof alias === 'string' ? alias : null, nodeName }) });
        }
        return out;
    } catch {
        return [];
    }
}

export interface SwitchDeps {
    storage: Pick<Storage, 'setItem'>;
    closeDB(): Promise<void>;
    initDB(): Promise<void>;
}

async function defaultSwitchDeps(): Promise<SwitchDeps> {
    const { closeDB, initDB } = await import('./db');
    return { storage: AsyncStorage, closeDB, initDB };
}

/**
 * The block's "Use another community": the phone moves to `url` as the BeanPool sheet moves it (use-communities.ts
 * switchTo), then says so (community-switch.ts), which takes the block down and asks `url` at once. The caller then
 * bounces the screens through Welcome, as the sheet does. Throws, before anything moves, for an address that isn't
 * plain (node-url.ts).
 */
export async function switchFromUpdateBlock(url: string, injected?: SwitchDeps): Promise<void> {
    assertPlainNodeAddress(url);
    const deps = injected ?? await defaultSwitchDeps();
    await deps.closeDB();
    await deps.storage.setItem(ANCHOR_STORE_KEY, url);
    await deps.initDB();
    communitySwitched();
}

/**
 * Settings' sections the block steps aside for: the 12 words (View Recovery Phrase, or adding them to a phone with
 * none), Account Protection (a sign-in that restores the account, which Recovery Phrase sends a member without words
 * to), and Account Deletion & Sign Out (leaving the community).
 */
export const ACCOUNT_SECTIONS = ['seed', 'protection', 'wipe'] as const;
export type AccountSection = typeof ACCOUNT_SECTIONS[number];

export function isAccountSection(mode: unknown): mode is AccountSection {
    return (ACCOUNT_SECTIONS as readonly unknown[]).includes(mode);
}

let accountSectionOpen = false;
const accountSectionListeners = new Set<(open: boolean) => void>();

/**
 * Settings says, as its tab gains or loses focus and its section changes, whether one of {@link ACCOUNT_SECTIONS} is in
 * front now. The block reads it ({@link onAccountSectionInFront}).
 */
export function setAccountSectionInFront(open: boolean): void {
    if (open === accountSectionOpen) return;
    accountSectionOpen = open;
    for (const listener of [...accountSectionListeners]) {
        try { listener(open); } catch { /* skipped */ }
    }
}

export function accountSectionInFront(): boolean {
    return accountSectionOpen;
}

export function onAccountSectionInFront(listener: (open: boolean) => void): () => void {
    accountSectionListeners.add(listener);
    return () => { accountSectionListeners.delete(listener); };
}

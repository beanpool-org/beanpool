/**
 * The ways out of the full-screen "Update required" (components/ForceUpdateBlock.tsx), which one community's floor puts
 * up over the whole app (utils/force-update.ts).
 *
 * The account is the member's, not the community's, and a phone can hold several communities. So the block never takes
 * from the member more than that one community (#1415's deciding review, BLOCKING), and none of its ways out depends on
 * anything that community answers (#1415's re-review, BLOCKING): a node can name any floor and, in the same answer, any
 * store version, and it also answers whether the key is a member there. Each way out is done on the phone, inside the
 * block itself, never through a screen the block covers or a status the node controls:
 * - **Use another community**: every other community saved on this phone, one tap each, read from the phone's own
 *   list. The phone moves there as the BeanPool sheet moves it (use-communities.ts), the block comes down, and the
 *   community now in use is asked at once (utils/community-switch.ts): its own floor, not the one left, decides. The
 *   floor still holds where it was set: switching back is a safe moment, and that community puts its block up again.
 * - **The 12 words**: read from the phone's key store behind the phone's own lock (words-behind-lock.ts), and drawn in
 *   the block with capture blocked (components/WordsOnScreen.tsx); or, on a phone with none, added from paper
 *   (components/AddWordsForm.tsx, checked against the key on the phone and sent nowhere).
 * - **Leave this community** ({@link planLeaveFromUpdateBlock}, {@link leaveFromUpdateBlock}): the phone forgets it.
 *   With other communities on the phone, it goes from the list with its copy and the phone moves to the next; the key
 *   stays. As the last, the account leaves the phone as Sign Out takes it, after the words. The community is told only
 *   in passing (its push alerts), and nothing waits on it.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { BeanPoolIdentity } from './identity';
import { communityName } from './community-name';
import { communitySwitched } from './community-switch';
import { assertPlainNodeAddress, plainOriginOf } from './node-url';
import { SAVED_NODES_STORE_KEY } from './storage-keys';

const ANCHOR_STORE_KEY = 'beanpool_anchor_url';
/** The communities this key visited as a guest (nodes.ts `markGuestNode`). */
const GUEST_NODES_STORE_KEY = 'beanpool_guest_nodes';

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

/** What the block's "Leave this community" will do, read from the phone alone before the member confirms. */
export interface BlockLeavePlan {
    /** The community the phone is set to, as it saved it: the one being left. */
    here: string;
    hereName: string;
    /** Where the phone goes next: the first other community saved on it. None: this is the last, and the account leaves. */
    next: OtherCommunity | null;
}

/**
 * The plan for the block's "Leave this community": the community the phone is set to, its name, and the next one on the
 * phone, if any. Reads the phone's storage only. Throws when the phone is not set to a community, or its storage can't
 * be read: nothing is left then.
 */
export async function planLeaveFromUpdateBlock(storage: Pick<Storage, 'getItem'> = AsyncStorage): Promise<BlockLeavePlan> {
    const here = await storage.getItem(ANCHOR_STORE_KEY);
    if (!here || !plainOriginOf(here)) throw new Error('This phone is not set to a community.');
    let saved: unknown;
    try {
        saved = JSON.parse((await storage.getItem(SAVED_NODES_STORE_KEY)) ?? '[]');
    } catch {
        saved = [];
    }
    const hereAddress = plainOriginOf(here);
    const entry = Array.isArray(saved)
        ? saved.find((n) => n && typeof n === 'object' && plainOriginOf((n as { url?: unknown }).url) === hereAddress) as
            { url?: string; alias?: unknown; nodeName?: unknown } | undefined
        : undefined;
    const hereName = communityName({ url: here, alias: typeof entry?.alias === 'string' ? entry.alias : null, nodeName: entry?.nodeName });
    const [next] = await otherCommunitiesOnPhone(storage);
    return { here, hereName, next: next ?? null };
}

type LeavingAccount = Pick<BeanPoolIdentity, 'publicKey' | 'privateKey'>;

export interface LeaveDeps {
    storage: Pick<Storage, 'getItem'>;
    /** delete-here.ts: this community off the push record, its copy and its list entries gone, the phone set to `next`. */
    leaveThisCommunity(here: string, next: string): Promise<void>;
    initDB(): Promise<void>;
    /** account-leaves-phone.ts: Sign Out (Device Only). */
    signOutOfThisPhone(account: LeavingAccount): Promise<void>;
    /** No account on the phone and no other community: this one off the phone, and the phone on none. */
    forgetCommunity(here: string): Promise<void>;
    /** account-leaves-phone.ts: one community asked to drop the push token. Never throws. */
    stopPushAlertsAt(account: LeavingAccount, community: string): Promise<boolean>;
    /** push-registrations.ts: a community back on the push record, so a later Sign Out asks it again. */
    putBackOnRecord(communities: readonly string[]): Promise<void>;
}

async function defaultLeaveDeps(): Promise<LeaveDeps> {
    const [{ leaveThisCommunity }, { initDB }, { signOutOfThisPhone, stopPushAlertsAt }, { putBackOnRecord }] = await Promise.all([
        import('./delete-here'), import('./db'), import('./account-leaves-phone'), import('./push-registrations'),
    ]);
    return { storage: AsyncStorage, leaveThisCommunity, initDB, signOutOfThisPhone, stopPushAlertsAt, putBackOnRecord, forgetCommunity };
}

/**
 * A phone with no account (a join never finished: the block can land on Welcome's invite join) and no other community:
 * `here` comes off it, its cached copy, its list entry and its guest marker, and the phone is set to none. Then the
 * update screen has nothing to hold, and Welcome takes another invite. Its own storage only.
 */
async function forgetCommunity(here: string, storage: Pick<Storage, 'getItem' | 'setItem'> & { removeItem(key: string): Promise<void> } = AsyncStorage): Promise<void> {
    try {
        const { removeCommunityCaches } = await import('./community-cache');
        await removeCommunityCaches([here]);
    } catch (e) {
        console.warn('[Update] The cached copy of the community left could not be removed', e);
    }
    await storage.removeItem(ANCHOR_STORE_KEY);
    // No community on the phone: the update screen's block comes down (utils/community-switch.ts).
    communitySwitched();
    const hereAddress = plainOriginOf(here);
    const isHere = (url: unknown) => plainOriginOf(url) === hereAddress;
    for (const [key, entryUrl] of [[SAVED_NODES_STORE_KEY, (n: unknown) => (n && typeof n === 'object' ? (n as { url?: unknown }).url : n)], [GUEST_NODES_STORE_KEY, (n: unknown) => n]] as const) {
        try {
            const parsed: unknown = JSON.parse((await storage.getItem(key)) ?? '[]');
            if (Array.isArray(parsed) && parsed.some((n) => isHere(entryUrl(n)))) {
                await storage.setItem(key, JSON.stringify(parsed.filter((n) => !isHere(entryUrl(n)))));
            }
        } catch (e) {
            console.warn('[Update] The community left could not be taken off a list', e);
        }
    }
}

/** What the block's "Leave this community" did. */
export type BlockLeave =
    /** The community left the phone, which is on `to` now; the key and its words stay. */
    | { kind: 'moved'; to: OtherCommunity }
    /** It was the last: the account left the phone as Sign Out takes it. */
    | { kind: 'signed-out' }
    /** No account and no other community: the phone is on none now. */
    | { kind: 'forgotten' };

/**
 * The block's "Leave this community", once the member has confirmed `plan` behind the phone's lock. On the phone only:
 * - Another community on the phone: this one leaves it as a delete that keeps the key leaves it (delete-here.ts
 *   `leaveThisCommunity`: off the push record, its cached copy gone, the phone set to `plan.next`, off the saved list
 *   and the guest markers), the next one's copy opens, and the update screen hears the switch. The account at the
 *   community left is not deleted there: the member can come back with an invite or their words.
 * - The last: account-leaves-phone.ts `signOutOfThisPhone`, as Settings' Sign Out (Device Only). With no account on
 *   the phone (a join never finished), the community only comes off the phone, which is then on none.
 *
 * The community left is told only in passing: its push alerts are asked to stop (stopPushAlertsAt), without waiting,
 * and if it never confirms, it goes back on the push record, so a later Sign Out asks it again. Sign Out's own
 * requests are bounded and never fail it. Nothing the community answers, or fails to, changes what happens here.
 * Throws when the phone has moved since the plan (nothing is done), or when the phone's own storage fails.
 */
export async function leaveFromUpdateBlock(account: LeavingAccount | null, plan: BlockLeavePlan, injected?: LeaveDeps): Promise<BlockLeave> {
    const deps = injected ?? await defaultLeaveDeps();
    if (plainOriginOf(await deps.storage.getItem(ANCHOR_STORE_KEY)) !== plainOriginOf(plan.here)) {
        throw new Error('This phone changed community. Open Leave this community again.');
    }
    if (!plan.next) {
        if (!account) {
            await deps.forgetCommunity(plan.here);
            return { kind: 'forgotten' };
        }
        await deps.signOutOfThisPhone(account);
        return { kind: 'signed-out' };
    }
    const told = account ? deps.stopPushAlertsAt(account, plan.here).catch(() => false) : Promise.resolve(true);
    await deps.leaveThisCommunity(plan.here, plan.next.url);
    await deps.initDB();
    communitySwitched();
    void told.then((took) => (took ? undefined : deps.putBackOnRecord([plan.here]))).catch(() => {});
    return { kind: 'moved', to: plan.next };
}

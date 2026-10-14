/**
 * The key each community signs its notices with, pinned on this phone (scratch/global-node/DESIGN-push-relay-fable.md
 * §4.3; @beanpool/core push-notice.ts).
 *
 * The phone learns it from the answer to its own push registration (`POST /api/push-tokens` → `{ success, pushKey }`;
 * push-registrations.ts `registerPushTokenWithCommunity`): a request this account signed, over TLS, to the address the
 * member chose. It is kept under a store key of its own ({@link PUSH_PINS_STORE_KEY}: address → key), never on the
 * community's saved record, so nodes.ts's writers of the saved list (addSavedNode on every database open,
 * removeSavedNode, recordRequestSigning) can't overwrite a pin, and a pin write can't bring back a community the member
 * forgot. Pin writes are ordered against each other here; nothing else writes that key.
 *
 * - **A pin counts only while the phone keeps its community** (the one it is set to, or one in its saved list):
 *   {@link readPushPins} reads them through that list. So **forgetting a community drops its pin** by construction
 *   (Forget Community, Wipe Connection and Sign Out take it off the list), and its notices do nothing
 *   (push-notice-check.ts). Each pin write also clears the pins of communities the phone no longer keeps.
 * - **A take-over keeps it.** A take-over keeps the node key and the address, and nothing here touches the pin, so the
 *   promoted server's notices verify against the same pin. Its next registration answer names the same key.
 * - **Each registration answer is the truth for its address.** A new key replaces the pin (a community restored without
 *   its old node key); an answer with none removes it (a server from before signed notices, or one with no node key
 *   yet), and that community's pushes are then treated as unsigned. The address the member chose is what the pin
 *   rests on either way, so an answer can't lower what the phone trusts below that.
 *
 * Earlier builds of this change kept the pin on the saved record (`pushKey`; never released). Until this phone's first
 * pin write, those are read as its pins; that write moves them here, and they are never read from the saved list
 * again. The old field stays on the record, unread: taking it off would be one more write of the saved list.
 *
 * Kept apart from push-registrations.ts, which writes the pin, so push-notice-check.ts can read it without importing
 * the registration machinery.
 */
import { pushCommunityTag, PUSH_KEY_PATTERN } from '@beanpool/core';
import { PUSH_PINS_STORE_KEY, PUSH_REGISTERED_AT_STORE_KEY, SAVED_NODES_STORE_KEY } from './storage-keys';

const ANCHOR_STORE_KEY = 'beanpool_anchor_url';

interface Storage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
}

/** A community's address as the phone sends to it: trimmed, no trailing slash. Null for anything but an http(s) address. */
export function communityAddress(raw: unknown): string | null {
    if (typeof raw !== 'string' || !/^https?:\/\/\S+$/i.test(raw.trim())) return null;
    return raw.trim().replace(/\/+$/, '');
}

/** The `pushKey` a registration answer carries: a raw Ed25519 public key in lower-case hex, or null for anything else. */
export function pushKeyOf(answer: unknown): string | null {
    const key = answer && typeof answer === 'object' ? (answer as { pushKey?: unknown }).pushKey : undefined;
    return typeof key === 'string' && PUSH_KEY_PATTERN.test(key) ? key : null;
}

/** The saved list's records, or null when it is there but can't be read as a list. */
function savedRecords(raw: string | null): Record<string, unknown>[] | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw ?? '[]');
    } catch {
        return null;
    }
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((n): n is Record<string, unknown> => !!n && typeof n === 'object');
}

function parseList(raw: string | null): unknown[] {
    try {
        const parsed = JSON.parse(raw ?? '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

type PinMap = Map<string, string>;

/**
 * The pins as stored: address → key, each in its shape, anything else left out. With no store yet, the pins earlier
 * builds kept on the saved records (see the header).
 */
function storedPins(rawPins: string | null, saved: Record<string, unknown>[] | null): PinMap {
    const pins: PinMap = new Map();
    const take = (community: unknown, key: unknown) => {
        const at = communityAddress(community);
        if (at && typeof key === 'string' && PUSH_KEY_PATTERN.test(key) && !pins.has(at)) pins.set(at, key);
    };
    if (rawPins === null) {
        for (const n of saved ?? []) take(n.url, n.pushKey);
        return pins;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawPins);
    } catch {
        return pins;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [community, key] of Object.entries(parsed)) take(community, key);
    }
    return pins;
}

/** The communities the phone keeps, in order: the one it is set to, then its saved list. */
function keptCommunities(anchor: string | null, saved: Record<string, unknown>[] | null): string[] {
    const kept = [anchor, ...(saved ?? []).map((n) => n.url)].map(communityAddress).filter((c): c is string => c !== null);
    return [...new Set(kept)];
}

let pinWrites: Promise<unknown> = Promise.resolve();

/**
 * Pin `pushKey` for `community`, or take its pin off (null), after any pin write under way. Nothing is pinned for an
 * address the phone doesn't keep. The pins of communities the phone no longer keeps go at the same time (not when its
 * saved list can't be read: a list that can't be read says nothing about what was forgotten). Never throws: a pin that
 * can't be written is logged, and that community's notices are treated as unsigned until its next registration answer.
 */
export function pinPushKey(community: string, pushKey: string | null, storage: Storage): Promise<void> {
    const next = pinWrites.then(async () => {
        const at = communityAddress(community);
        if (!at) return;
        const anchor = await storage.getItem(ANCHOR_STORE_KEY);
        const saved = savedRecords(await storage.getItem(SAVED_NODES_STORE_KEY));
        const rawPins = await storage.getItem(PUSH_PINS_STORE_KEY);
        const pins = storedPins(rawPins, saved);
        const kept = new Set(keptCommunities(communityAddress(anchor), saved));
        if (pushKey && kept.has(at)) {
            const pinned = pins.get(at);
            if (pinned && pinned !== pushKey) console.warn(`[Push] ${at} now signs its notices with another key; the new one is pinned`);
            pins.set(at, pushKey);
        } else if (!pushKey) {
            pins.delete(at);
        }
        if (saved) for (const c of [...pins.keys()]) if (!kept.has(c)) pins.delete(c);
        const value = JSON.stringify(Object.fromEntries(pins));
        if (value !== rawPins) await storage.setItem(PUSH_PINS_STORE_KEY, value);
    }).catch((e) => {
        console.warn(`[Push] Could not pin the key ${community} signs its notices with`, e);
    });
    pinWrites = next;
    return next;
}

/** A community this phone keeps, and the key it pinned for its notices. */
export interface PushPin {
    community: string;
    pushKey: string;
    /** `data.c` of its notices (@beanpool/core `pushCommunityTag`). */
    tag: string;
}

export interface PushPins {
    /** The community the phone is set to, or null. */
    anchor: string | null;
    /** The kept communities with a pin. */
    pinned: PushPin[];
    /**
     * The kept communities this phone sent its push token to (push-registrations.ts, the record) that pinned no key: a
     * server from before signed notices, or one with no node key yet. Their pushes are unsigned, so the phone can't
     * tell one of theirs from anyone else's.
     */
    unpinnedRegistered: string[];
}

/**
 * The communities this phone keeps (the one it is set to, and its saved list) and what it pinned for each, after any
 * pin write under way. A pin for a community the phone doesn't keep is not read. Throws when the phone's storage can't
 * be read.
 */
export async function readPushPins(storage: Pick<Storage, 'getItem'>): Promise<PushPins> {
    await pinWrites;
    const anchor = communityAddress(await storage.getItem(ANCHOR_STORE_KEY));
    const saved = savedRecords(await storage.getItem(SAVED_NODES_STORE_KEY));
    const stored = storedPins(await storage.getItem(PUSH_PINS_STORE_KEY), saved);
    const kept = keptCommunities(anchor, saved);
    const pinned: PushPin[] = [];
    for (const community of kept) {
        const pushKey = stored.get(community);
        if (pushKey) pinned.push({ community, pushKey, tag: pushCommunityTag(pushKey) });
    }
    const registered = new Set(parseList(await storage.getItem(PUSH_REGISTERED_AT_STORE_KEY)).map(communityAddress));
    const unpinnedRegistered = kept.filter((c) => registered.has(c) && !stored.has(c));
    return { anchor, pinned, unpinnedRegistered };
}

/**
 * The key each community signs its notices with, pinned on this phone (scratch/global-node/DESIGN-push-relay-fable.md
 * §4.3; @beanpool/core push-notice.ts).
 *
 * The phone learns it from the answer to its own push registration (`POST /api/push-tokens` → `{ success, pushKey }`;
 * push-registrations.ts `registerPushTokenWithCommunity`): a request this account signed, over TLS, to the address the
 * member chose. It is kept on that community's saved record (nodes.ts `SavedNode.pushKey`), so it goes with it:
 *
 * - **A take-over keeps it.** A take-over keeps the node key and the address, and nothing here touches the record, so
 *   the promoted server's notices verify against the same pin. Its next registration answer names the same key.
 * - **Forgetting a community drops it.** Forget Community, Wipe Connection and Sign Out remove the saved record, and a
 *   community the phone no longer keeps has no pin: its notices do nothing (push-notice-check.ts).
 * - **Each registration answer is the truth for its address.** A new key replaces the pin (a community restored without
 *   its old node key); an answer with none removes it (a server from before signed notices, or one with no node key
 *   yet), and that community's pushes are then treated as unsigned. The address the member chose is what the pin
 *   rests on either way, so an answer can't lower what the phone trusts below that.
 *
 * Kept apart from push-registrations.ts, which writes the pin, so push-notice-check.ts can read it without importing
 * the registration machinery.
 */
import { pushCommunityTag, PUSH_KEY_PATTERN } from '@beanpool/core';
import { PUSH_REGISTERED_AT_STORE_KEY, SAVED_NODES_STORE_KEY } from './storage-keys';

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

function parseList(raw: string | null): unknown[] {
    try {
        const parsed = JSON.parse(raw ?? '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

let pinWrites: Promise<unknown> = Promise.resolve();

/**
 * Pin `pushKey` for `community` on its saved record, or take the pin off it (null), after any pin write under way.
 * The community the phone is set to gets a record if it has none yet, as nodes.ts `getSavedNodes` would give it.
 * Nothing for an address the phone doesn't keep. Never throws: a pin that can't be written is logged, and that
 * community's notices are treated as unsigned until its next registration answer.
 */
export function pinPushKey(community: string, pushKey: string | null, storage: Storage): Promise<void> {
    const next = pinWrites.then(async () => {
        const at = communityAddress(community);
        if (!at) return;
        const raw = await storage.getItem(SAVED_NODES_STORE_KEY);
        const nodes = parseList(raw).filter((n): n is Record<string, unknown> => !!n && typeof n === 'object');
        let found = false;
        let changed = false;
        for (const n of nodes) {
            if (communityAddress(n.url) !== at) continue;
            found = true;
            if (pushKey && n.pushKey !== pushKey) {
                if (typeof n.pushKey === 'string') console.warn(`[Push] ${at} now signs its notices with another key; the new one is pinned`);
                n.pushKey = pushKey;
                changed = true;
            } else if (!pushKey && 'pushKey' in n) {
                delete n.pushKey;
                changed = true;
            }
        }
        if (!found && pushKey) {
            const anchor = await storage.getItem(ANCHOR_STORE_KEY);
            if (communityAddress(anchor) !== at) return;
            nodes.push({ url: anchor, lastConnected: new Date().toISOString(), pushKey });
            changed = true;
        }
        if (changed) await storage.setItem(SAVED_NODES_STORE_KEY, JSON.stringify(nodes));
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
 * pin write under way. Throws when the phone's storage can't be read.
 */
export async function readPushPins(storage: Pick<Storage, 'getItem'>): Promise<PushPins> {
    await pinWrites;
    const anchor = communityAddress(await storage.getItem(ANCHOR_STORE_KEY));
    const saved = parseList(await storage.getItem(SAVED_NODES_STORE_KEY))
        .filter((n): n is Record<string, unknown> => !!n && typeof n === 'object');
    const kept = new Set<string>(anchor ? [anchor] : []);
    const pinned: PushPin[] = [];
    for (const n of saved) {
        const at = communityAddress(n.url);
        if (!at) continue;
        kept.add(at);
        if (typeof n.pushKey === 'string' && PUSH_KEY_PATTERN.test(n.pushKey) && !pinned.some((p) => p.community === at)) {
            pinned.push({ community: at, pushKey: n.pushKey, tag: pushCommunityTag(n.pushKey) });
        }
    }
    const registered = new Set(parseList(await storage.getItem(PUSH_REGISTERED_AT_STORE_KEY)).map(communityAddress));
    const unpinnedRegistered = [...kept].filter((c) => registered.has(c) && !pinned.some((p) => p.community === c));
    return { anchor, pinned, unpinnedRegistered };
}

/**
 * key-replaced — this phone's key was replaced by a re-key at its community: the account moved to a new phone. The node
 * says so on any signed request (403 `key_invalidated`, https-server.ts REPLACED_KEY_REFUSAL); this phone keeps that, per
 * community and key, so the old phone can offer its old 12 words to the new one
 * (scratch/global-node/DESIGN-group-history-after-rekey-fable.md §3: typed on the new phone, they unlock the group
 * messages from before the change). The words are shown here only behind the phone's lock, and never sent.
 *
 * The note is the node's word, so it lasts only while the node refuses the key (review of #1844, finding 5): any later
 * signed request from the same key that the node answers with success clears it (the node's middleware refuses every
 * signed request from a replaced key, read or write, https-server.ts REPLACED_KEY_REFUSAL), and the card goes.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const KEY_MOVED_TITLE = 'This account moved to a new phone';
export const KEY_MOVED_BODY = "This phone's key was replaced by a new one. If your new phone can't read earlier group messages, type these 12 words there: they unlock them.";
/** Under the body (finding 5): the words are this account's, and belong only in the member's own phone. */
export const KEY_MOVED_OWN_ONLY = "These are this account's own words. Type them only into your own new phone, never into a phone someone else holds out.";
export const KEY_MOVED_SHOW = 'Show my old 12 words, so my new phone can unlock earlier messages';
export const KEY_MOVED_REASON = 'Show your old 12 words';

/** The screens showing the offer (a plain set, not DeviceEventEmitter: db.ts imports this, and runs outside React Native in tests). */
const listeners = new Set<() => void>();
const storageKey = (nodeUrl: string, pubkey: string) => `beanpool_key_replaced:${nodeUrl.replace(/\/+$/, '')}:${pubkey}`;
/** Whether a note is kept, per storage key, once read: a successful request then costs no storage read. */
const kept = new Map<string, boolean>();

/** True for the node's answer that the signing key was replaced (403 with code `key_invalidated`). */
export function isKeyReplacedAnswer(status: number, body: unknown): boolean {
    return status === 403 && !!body && typeof body === 'object' && (body as { code?: unknown }).code === 'key_invalidated';
}

/** Keeps that the node said this key was replaced, and tells any screen showing the offer. */
export async function noteKeyReplaced(nodeUrl: string, pubkey: string): Promise<void> {
    try {
        const k = storageKey(nodeUrl, pubkey);
        kept.set(k, true);
        if (await AsyncStorage.getItem(k)) return;
        await AsyncStorage.setItem(k, String(Date.now()));
    } catch { /* the next refusal notes it again */ }
    for (const l of [...listeners]) l();
}

/** The node answered a signed request from this key with success: the key is current here, so any note goes. */
export async function noteKeyAnswered(nodeUrl: string, pubkey: string): Promise<void> {
    const k = storageKey(nodeUrl, pubkey);
    if (kept.get(k) === false) return;
    try {
        const had = !!(await AsyncStorage.getItem(k));
        kept.set(k, false);
        if (!had) return;
        await AsyncStorage.removeItem(k);
    } catch {
        kept.delete(k);
        return;
    }
    for (const l of [...listeners]) l();
}

/**
 * For a signed request's answer: a success clears the note (`signed` false, a request that went out unsigned, proves
 * nothing); a 403 is read (from a copy, so the caller's body is untouched) for the replaced-key code.
 */
export function watchForReplacedKey(nodeUrl: string, pubkey: string, res: Response, signed = true): void {
    if (res.ok) { if (signed) void noteKeyAnswered(nodeUrl, pubkey); return; }
    if (res.status !== 403 || typeof res.clone !== 'function') return;
    void res.clone().json().then((body) => { if (isKeyReplacedAnswer(res.status, body)) return noteKeyReplaced(nodeUrl, pubkey); }).catch(() => {});
}

/** Whether this community said this key was replaced. */
export async function keyReplacedHere(nodeUrl: string, pubkey: string): Promise<boolean> {
    try {
        return !!(await AsyncStorage.getItem(storageKey(nodeUrl, pubkey)));
    } catch {
        return false;
    }
}

/** Called when a refusal is noted or the note is cleared; returns the unsubscribe. */
export function onKeyReplaced(cb: () => void): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}

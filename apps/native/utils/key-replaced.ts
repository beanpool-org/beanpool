/**
 * key-replaced — this phone's key was replaced by a re-key at its community: the account moved to a new phone. The node
 * says so on any signed request (403 `key_invalidated`, https-server.ts REPLACED_KEY_REFUSAL); this phone keeps that, per
 * community and key, so the old phone can offer its old 12 words to the new one
 * (scratch/global-node/DESIGN-group-history-after-rekey-fable.md §3: typed on the new phone, they unlock the group
 * messages from before the change). The words are shown here only behind the phone's lock, and never sent.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DeviceEventEmitter } from 'react-native';

export const KEY_MOVED_TITLE = 'This account moved to a new phone';
export const KEY_MOVED_BODY = "This phone's key was replaced by a new one. If the new phone can't read earlier group messages, type these 12 words there: they unlock them.";
export const KEY_MOVED_SHOW = 'Show my old 12 words, so the new phone can unlock earlier messages';
export const KEY_MOVED_REASON = 'Show your old 12 words';

const EVENT = 'beanpool:key-replaced';
const storageKey = (nodeUrl: string, pubkey: string) => `beanpool_key_replaced:${nodeUrl.replace(/\/+$/, '')}:${pubkey}`;

/** True for the node's answer that the signing key was replaced (403 with code `key_invalidated`). */
export function isKeyReplacedAnswer(status: number, body: unknown): boolean {
    return status === 403 && !!body && typeof body === 'object' && (body as { code?: unknown }).code === 'key_invalidated';
}

/** Keeps that the node said this key was replaced, and tells any screen showing the offer. */
export async function noteKeyReplaced(nodeUrl: string, pubkey: string): Promise<void> {
    try {
        if (await AsyncStorage.getItem(storageKey(nodeUrl, pubkey))) return;
        await AsyncStorage.setItem(storageKey(nodeUrl, pubkey), String(Date.now()));
    } catch { /* the next refusal notes it again */ }
    DeviceEventEmitter?.emit?.(EVENT);
}

/** For a signed request's answer: a 403 is read (from a copy, so the caller's body is untouched) for the replaced-key code. */
export function watchForReplacedKey(nodeUrl: string, pubkey: string, res: Response): void {
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

/** Called when a refusal is noted; returns the unsubscribe. */
export function onKeyReplaced(cb: () => void): () => void {
    const sub = DeviceEventEmitter.addListener(EVENT, cb);
    return () => sub.remove();
}

/**
 * "I still have my 12 words", kept on the account (DESIGN-home-default-fable.md §2.5, the node's D1 `words_kept`): said on
 * the 12-words card, or by a Yes to "Did you keep it somewhere safe?" after the recovery kit (components/RecoveryKitButtons.tsx).
 * The kit alone never counts, since the phone cannot see a print or a save (the director's rule, review of #3113; the kit was
 * the director's addition to D1, Marty's report of 13 Nov 2026). It ends the Home card and ticks First steps' "Keep your 12
 * words safe" on every device, the web's too, where
 * the phone's own record (utils/one-way-back.ts) only ever spoke for this phone.
 *
 * One signed write, `POST /api/members/preferences` `{ words_kept: true }` (one way: the node never clears it). A write
 * that doesn't land (offline, or the account not yet on the node mid-sign-up) is kept on the phone and sent again at the
 * next Home landing ({@link resendWordsKept}). The phone's record is marked done at once either way.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { signedPost } from './node-post';
import { finishOneWayBack, putAwayRecord, readOneWayBack } from './one-way-back';
import { oneWayBackStoreKey, wordsKeptOwedStoreKey } from './storage-keys';
import type { BeanPoolIdentity } from './identity';

const sameUrl = (a: string, b: string) => a.trim().replace(/\/+$/, '').toLowerCase() === b.trim().replace(/\/+$/, '').toLowerCase();

/** The one write. True when the node took it. */
async function send(url: string, identity: BeanPoolIdentity): Promise<boolean> {
    try {
        const res = await signedPost(url, '/api/members/preferences', { publicKey: identity.publicKey, preferences: { words_kept: true } }, identity);
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * The member said they still have their 12 words (on the card, or Yes after the kit), for the community at `url`: the
 * phone's record is done ("checked"; started done where there was none, so a later start keeps it), and the account is
 * told. Never throws.
 */
export async function keepWords(url: string | null, identity: BeanPoolIdentity, now: number = Date.now()): Promise<void> {
    try {
        if (await readOneWayBack(identity.publicKey)) await finishOneWayBack(identity.publicKey, 'checked');
        else if (url) await AsyncStorage.setItem(oneWayBackStoreKey(identity.publicKey), JSON.stringify({ ...putAwayRecord(url, now), done: 'checked' }));
    } catch {
        // The phone's record stays as it was; the account's word below still ends the card at the next Home read.
    }
    if (!url) return;
    if (await send(url, identity)) {
        await AsyncStorage.removeItem(wordsKeptOwedStoreKey(identity.publicKey)).catch(() => undefined);
        return;
    }
    await AsyncStorage.setItem(wordsKeptOwedStoreKey(identity.publicKey), url).catch(() => undefined);
}

/** A say-so that didn't land, sent again for this community (Home's landing). True when nothing is owed any more. */
export async function resendWordsKept(url: string, identity: BeanPoolIdentity): Promise<boolean> {
    let owed: string | null = null;
    try {
        owed = await AsyncStorage.getItem(wordsKeptOwedStoreKey(identity.publicKey));
    } catch {
        return false;
    }
    if (!owed) return true;
    if (!sameUrl(owed, url)) return false;
    if (!(await send(url, identity))) return false;
    await AsyncStorage.removeItem(wordsKeptOwedStoreKey(identity.publicKey)).catch(() => undefined);
    return true;
}

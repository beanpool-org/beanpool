/**
 * "I still have my 12 words", kept on the account (scratch/fable-design/DESIGN-home-default-fable.md §2.5; the node's
 * `words_kept` Home preference, engine/home-preferences.ts, one way: a false never clears it). Said by the 12-words card
 * (on Home or in Settings), by the tick at sign-up's backup step, and by "Yes, it's kept" after the recovery kit (sign-up
 * or Settings), so the phone and the web agree, and First steps' "Keep your 12 words safe" and Home's card end on every
 * device.
 *
 * Never in the way of the tap that said it. A write that doesn't land (offline, a node that is down or busy, or the
 * account not yet readable there mid-sign-up) is kept in this browser and sent again at the next Home landing
 * ({@link resendWordsKept}), as the phone keeps its own (apps/native/utils/words-kept.ts): a say-so is never lost to one
 * failed request. The owed mark is the account's own, so a sign-out clears it with the rest (lib/device-prefs.ts).
 */
import { saveHomePreferences } from './api';

const owedKey = (publicKey: string) => `beanpool_words_kept_owed:${publicKey.toLowerCase()}`;

function markOwed(publicKey: string, owed: boolean): void {
    try {
        if (owed) localStorage.setItem(owedKey(publicKey), '1');
        else localStorage.removeItem(owedKey(publicKey));
    } catch { /* a private window: said again the next time the member says it */ }
}

/** Whether a say-so for this account is waiting to reach the node. */
export function wordsKeptOwed(publicKey: string): boolean {
    try {
        return localStorage.getItem(owedKey(publicKey)) === '1';
    } catch {
        return false;
    }
}

/** The one write. True when the node took it; a refusal or no answer keeps it owed. */
async function send(publicKey: string, where: string): Promise<boolean> {
    try {
        await saveHomePreferences(publicKey, { words_kept: true });
        markOwed(publicKey, false);
        return true;
    } catch (err) {
        console.warn(`[${where}] could not keep "I still have my 12 words" on the account; sent again at the next Home landing:`, err);
        markOwed(publicKey, true);
        return false;
    }
}

/** The member said they still have their 12 words: told to the account now, or at the next Home landing. Never throws. */
export function keepWordsOnAccount(publicKey: string, where: string): void {
    // Owed from the moment it is said: a page closed before the answer comes still sends it at the next landing.
    markOwed(publicKey, true);
    void send(publicKey, where);
}

/** A say-so that didn't land, sent again (Home's landing). True when nothing is owed any more. */
export async function resendWordsKept(publicKey: string): Promise<boolean> {
    if (!wordsKeptOwed(publicKey)) return true;
    return send(publicKey, 'Home');
}

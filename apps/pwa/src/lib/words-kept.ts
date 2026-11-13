/**
 * "I still have my 12 words", kept on the account (scratch/fable-design/DESIGN-home-default-fable.md §2.5; the node's
 * `words_kept` Home preference, engine/home-preferences.ts, one way: a false never clears it). Said by the 12-words card
 * on Home, by the tick at sign-up's backup step, and by the recovery kit printed or saved (sign-up or Settings), so the
 * phone and the web agree, and First steps' "Keep your 12 words safe" and Home's card end on every device.
 *
 * Best effort and never in the way of the tap that said it: offline or refused, it is only logged, and it is said again
 * the next time the member does any of those.
 */
import { saveHomePreferences } from './api';

export function keepWordsOnAccount(publicKey: string, where: string): void {
    try {
        void saveHomePreferences(publicKey, { words_kept: true })
            .catch((err) => console.warn(`[${where}] could not keep "I still have my 12 words" on the account:`, err));
    } catch (err) {
        console.warn(`[${where}] could not keep "I still have my 12 words" on the account:`, err);
    }
}

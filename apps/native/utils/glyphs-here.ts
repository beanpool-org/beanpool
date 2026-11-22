/**
 * Words drawn without the emoji this phone's font has no picture for (walk-s6, 23 Nov 2026: on Android 8 "🫘 Thank Ben"
 * began with a missing-glyph box). 🫘 is Emoji 14 (2021): Android draws it from Android 13 (API 33); before that, and the app
 * carries no emoji font of its own, it is a box. The words are the same without it.
 */
import * as ReactNative from 'react-native';

/** The first Android that draws 🫘. */
export const BEANS_EMOJI_API = 33;

/** This phone's system and Android version; none known (a test's stand-in without them): nothing is taken out. */
function thisPhone(): { os: string; api: number } {
    try {
        return { os: ReactNative.Platform.OS, api: Number(ReactNative.Platform.Version) };
    } catch {
        return { os: '', api: NaN };
    }
}

export function withGlyphsThisPhoneHas(words: string, phone: { os: string; api: number } = thisPhone()): string {
    if (phone.os !== 'android' || !(phone.api < BEANS_EMOJI_API) || !words.includes('🫘')) return words;
    return words.split('🫘').join('').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Words drawn without the emoji this phone's font has no picture for (walk-s6, 23 Nov 2026: on Android 8 "🫘 Thank Ben"
 * began with a missing-glyph box). 🫘 is Emoji 14 (2021): Android draws it from Android 13 (API 33); before that, and the app
 * carries no emoji font of its own, it is a box. The words are the same without it.
 */
import { Platform } from 'react-native';

/** The first Android that draws 🫘. */
export const BEANS_EMOJI_API = 33;

export function withGlyphsThisPhoneHas(words: string, os: string = Platform.OS, api: number = Number(Platform.Version)): string {
    if (os !== 'android' || !(api < BEANS_EMOJI_API) || !words.includes('🫘')) return words;
    return words.split('🫘').join('').replace(/\s{2,}/g, ' ').trim();
}

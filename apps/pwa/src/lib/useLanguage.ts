/**
 * The language the screens are in, and the member's way to change it (lib/language.ts). A component that calls it
 * re-renders when the language changes: App does, so every screen under it reads the new words at once.
 */

import { useSyncExternalStore } from 'react';
import type { Lang, UiLang } from '@beanpool/core';
import { chooseAndShowLanguage, failedLanguageChoice, shownLanguage, subscribeLanguage } from './language';

export function useLanguage(): [UiLang, (lang: Lang) => Promise<boolean>] {
    const lang = useSyncExternalStore(subscribeLanguage, shownLanguage, shownLanguage);
    return [lang, chooseAndShowLanguage];
}

/** The language the member chose whose words could not be fetched, until their next choice (lib/language.ts). */
export function useLanguageFailure(): Lang | null {
    return useSyncExternalStore(subscribeLanguage, failedLanguageChoice, failedLanguageChoice);
}

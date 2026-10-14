/**
 * The language the screens are in, and the member's way to change it (lib/language.ts). A component that calls it
 * re-renders when the language changes: App does, so every screen under it reads the new words at once.
 */

import { useSyncExternalStore } from 'react';
import type { Lang, UiLang } from '@beanpool/core';
import { chooseAndShowLanguage, shownLanguage, subscribeLanguage } from './language';

export function useLanguage(): [UiLang, (lang: Lang) => Promise<boolean>] {
    const lang = useSyncExternalStore(subscribeLanguage, shownLanguage, shownLanguage);
    return [lang, chooseAndShowLanguage];
}

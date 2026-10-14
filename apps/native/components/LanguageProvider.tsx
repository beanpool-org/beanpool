/**
 * The phone's language, live (design: scratch/global-node/DESIGN-translation-fable.md §1–2, slice S1).
 *
 * Holds the language the app writes in (utils/language-choice.ts: the member's choice on this phone, else the phone's
 * own language, else the community's default, else English), loads only that language's catalogs (utils/words-
 * catalogs.ts), and gives every screen under it `useWords()`: `const { t } = useWords()` re-renders the screen when the
 * member picks another language in Settings → Language or on the first screen's switch. No restart, nothing lost.
 *
 * Also sets core's device language (`setLanguage`), so a sentence written by a helper outside React (core's `t`, a
 * date from `formatDate`) reads the same language from the next render on.
 *
 * Never blocks: the first render is English (or the stored choice once read), a store that can't be read leaves the
 * phone's language, and a catalog that can't be built leaves English (onboarding-no-hard-gates).
 *
 * Right-to-left: off for now (`I18nManager.allowRTL(false)` at boot, app/_layout.tsx) until the RTL audit, so an
 * Arabic, Urdu or Persian phone sees a straight left-to-right app rather than a half-mirrored one (design §2.5 rule 3).
 *
 * The 12 recovery words never pass through here: they stay English in every language (design amendment 1).
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { I18nManager, NativeModules, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { setLanguage, wordsFor, type Lang, type UiLang, type Words } from '@beanpool/core';
import { catalogsFor } from '../utils/words-catalogs';
import { LANGUAGE_PREFERENCE_KEY, chooseLanguage, defaultLanguage, storedChoice } from '../utils/language-choice';
import { getCachedNodeProfile } from '../utils/node-profile';

export interface LanguageContextType extends Words {
    /** What the member chose on this phone, or null: follow the phone. */
    choice: Lang | null;
    /** The language with no choice made (the phone's, the community's, or English): what "Same as phone" gives. */
    phoneLanguage: Lang;
    /** Pick a language (null: follow the phone again). Live: every screen using `useWords()` re-renders in it. */
    chooseLanguage(lang: Lang | null): void;
}

/** The phone's preferred languages as the OS spells them, most preferred first. Empty when none can be read. */
export function deviceLanguageTags(): string[] {
    const tags: string[] = [];
    try {
        if (Platform.OS === 'ios') {
            const settings = NativeModules.SettingsManager?.settings;
            if (Array.isArray(settings?.AppleLanguages)) tags.push(...settings.AppleLanguages);
            else if (typeof settings?.AppleLocale === 'string') tags.push(settings.AppleLocale);
        }
    } catch { /* read from the next source */ }
    try {
        const id = (I18nManager as any).getConstants?.()?.localeIdentifier;
        if (typeof id === 'string') tags.push(id);
    } catch { /* read from the next source */ }
    try {
        const locale = Intl.DateTimeFormat().resolvedOptions().locale;
        if (typeof locale === 'string') tags.push(locale);
    } catch { /* no Intl: English */ }
    return tags;
}

/** The words of `lang`, with English when its catalogs can't be built. Also core's device language. */
function wordsIn(lang: UiLang): Words {
    let catalogs: ReturnType<typeof catalogsFor> = [];
    try { catalogs = catalogsFor(lang); } catch { lang = 'en'; }
    setLanguage(lang, catalogs);
    return wordsFor(lang, catalogs);
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export function LanguageProvider({ children, deviceTags, initial }: {
    children: React.ReactNode;
    /** The phone's tags; read from the OS when not given (tests give them). */
    deviceTags?: readonly string[];
    /** A language to draw the first frame in (tests); the stored choice still applies once read. */
    initial?: UiLang;
}) {
    const tags = useMemo(() => deviceTags ?? deviceLanguageTags(), [deviceTags]);
    const [choice, setChoice] = useState<Lang | null>(null);
    const [nodeDefault, setNodeDefault] = useState<string | null>(null);
    const [override, setOverride] = useState<UiLang | null>(initial ?? null);
    const phoneLanguage = defaultLanguage({ deviceTags: tags, nodeDefault });
    const lang: UiLang = override ?? chooseLanguage({ stored: choice, deviceTags: tags, nodeDefault });
    const words = useMemo(() => wordsIn(lang), [lang]);

    useEffect(() => {
        let live = true;
        AsyncStorage.getItem(LANGUAGE_PREFERENCE_KEY)
            .then((stored) => { if (live) setChoice(storedChoice(stored)); })
            .catch(() => { /* follow the phone */ });
        AsyncStorage.getItem('beanpool_anchor_url')
            .then((url) => getCachedNodeProfile(url))
            .then((profile) => { if (live && profile?.language) setNodeDefault(profile.language); })
            .catch(() => { /* no community default */ });
        return () => { live = false; };
    }, []);

    const choose = useCallback((next: Lang | null) => {
        setOverride(null);
        setChoice(next);
        const write = next ? AsyncStorage.setItem(LANGUAGE_PREFERENCE_KEY, next) : AsyncStorage.removeItem(LANGUAGE_PREFERENCE_KEY);
        write.catch(() => { /* this run keeps it; the next starts from the phone's */ });
    }, []);

    const value = useMemo<LanguageContextType>(() => ({ ...words, choice, phoneLanguage, chooseLanguage: choose }), [words, choice, phoneLanguage, choose]);
    return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

/**
 * The current language's words for a screen: `const { t, tn } = useWords()`. The screen re-renders when the language
 * changes. Outside a provider (a test rendering one component) it gives English, never a throw.
 */
export function useWords(): LanguageContextType {
    return useContext(LanguageContext) ?? ENGLISH;
}

const ENGLISH: LanguageContextType = { ...wordsFor('en'), choice: null, phoneLanguage: 'en', chooseLanguage: () => {} };

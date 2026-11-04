/**
 * Which language the phone writes in (design: scratch/global-node/DESIGN-translation-fable.md §1, slice S1).
 *
 * The member's own choice in Settings → Language (or the first screen's switch) wins, kept on this phone only, like the
 * theme: never sent to a node as a setting, never shown to anyone. With no choice made: the phone's own language when
 * BeanPool has a version in it (`ru-RU` → ru, `zh-TW` → zh-Hant, through core's canonicalLang), else the community's
 * default language (`language` in its /api/community/info), else English. A stored value that is not one of the 25
 * (a stale or hand-edited one) counts as no choice: it never breaks a screen (onboarding-no-hard-gates).
 *
 * The pseudo-locale (`xx`, translation tooling design §2.5, slice T4) is a 26th choice in a DEVELOPMENT build only: a
 * "Pseudo (test)" row under Settings → Language, to see every screen padded 40 % / 30 % on a real phone. A release build
 * (`__DEV__` false, which Metro folds into the bundle) neither lists it nor honours a stored `xx` left by a development
 * build on the same phone, so a member can never be in it.
 *
 * Pure: the provider (components/LanguageProvider.tsx) reads the phone's tags and the stored value and hands them in.
 */

import { LANGS, LANGUAGE_HEADER, PSEUDO_LANG, currentLanguage, isLang, normaliseLang, type Lang, type UiLang } from '@beanpool/core';

/** Where this phone keeps the member's choice. Absent: follow the phone. */
export const LANGUAGE_PREFERENCE_KEY = 'beanpool_language';

export interface LanguageInputs {
    /** What Settings → Language stored on this phone, if anything. */
    stored?: string | null;
    /** The phone's preferred languages, most preferred first, as the OS spells them (`en-AU`, `zh_TW_#Hant`). */
    deviceTags?: readonly (string | null | undefined)[];
    /** The community's default language, from its /api/community/info, if this phone has heard it. */
    nodeDefault?: string | null;
}

let devBuildForTests: boolean | null = null;

/** Tests only: act as a development (true) or a release (false) build; null: the bundle's own `__DEV__`. */
export function setDevBuildForTests(dev: boolean | null): void {
    devBuildForTests = dev;
}

/** Whether this is a development build: Metro's `__DEV__`, which a release bundle has as the constant false. */
export function isDevBuild(): boolean {
    return devBuildForTests ?? __DEV__;
}

/** The pseudo-locale's row in the picker: what a developer reads, never translated, never in a release build. */
export const PSEUDO_ROW_NAME = 'Pseudo (test)';

/** The member's stored choice when it is one of the 25 (or `xx` in a development build); anything else is no choice. */
export function storedChoice(stored: string | null | undefined): UiLang | null {
    if (isLang(stored)) return stored;
    return stored === PSEUDO_LANG && isDevBuild() ? PSEUDO_LANG : null;
}

/** The language to write in, with no choice made by the member: the phone's, then the community's, then English. */
export function defaultLanguage({ deviceTags = [], nodeDefault }: Omit<LanguageInputs, 'stored'>): Lang {
    for (const tag of deviceTags) {
        const lang = normaliseLang(tag);
        if (lang) return lang;
    }
    return normaliseLang(nodeDefault) ?? 'en';
}

/** The language to write in: the member's choice, else {@link defaultLanguage}. */
export function chooseLanguage(inputs: LanguageInputs): UiLang {
    return storedChoice(inputs.stored) ?? defaultLanguage(inputs);
}

/**
 * Each language in its own name and script, the way a speaker looks for it in a list. Never translated: someone who
 * cannot read the current language must still find their own. Picker order is LANGS' order.
 */
export const LANGUAGE_NAMES: Readonly<Record<Lang, string>> = Object.freeze({
    en: 'English',
    es: 'Español',
    pt: 'Português',
    hi: 'हिन्दी',
    bn: 'বাংলা',
    fr: 'Français',
    ar: 'العربية',
    id: 'Bahasa Indonesia',
    ru: 'Русский',
    'zh-Hans': '简体中文',
    'zh-Hant': '繁體中文',
    it: 'Italiano',
    de: 'Deutsch',
    tr: 'Türkçe',
    sw: 'Kiswahili',
    ml: 'മലയാളം',
    ta: 'தமிழ்',
    uk: 'Українська',
    ur: 'اردو',
    fa: 'فارسی',
    vi: 'Tiếng Việt',
    el: 'Ελληνικά',
    fil: 'Filipino',
    ja: '日本語',
    ko: '한국어',
});

/** The picker's rows: every language, in LANGS' order. */
export const LANGUAGE_OPTIONS: readonly { value: Lang; name: string }[] = Object.freeze(LANGS.map((value) => ({ value, name: LANGUAGE_NAMES[value] })));

/** The rows the picker draws: the 25, and last "Pseudo (test)" in a development build only. */
export function languagePickerRows(): readonly { value: UiLang; name: string }[] {
    return isDevBuild() ? [...LANGUAGE_OPTIONS, { value: PSEUDO_LANG, name: PSEUDO_ROW_NAME }] : LANGUAGE_OPTIONS;
}

/**
 * The language this phone writes in, for a node (Marty's call M6): `X-Language: ru` on a signed request, `lang` on the
 * push registration, so the node can answer and notify in it. Never the pseudo-locale; the node stores nothing that is
 * not one of the 25 (design §3). English before anything else is known.
 */
export function languageForNode(): Lang {
    const lang = currentLanguage();
    return isLang(lang) ? lang : 'en';
}

/** The `X-Language` header for a request to a node. */
export function languageHeader(): Record<string, string> {
    return { [LANGUAGE_HEADER]: languageForNode() };
}

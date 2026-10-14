/**
 * The web app's language (scratch/global-node/DESIGN-translation-fable.md §1, §7 S2; director amendments 1–5).
 *
 * One per browser, stored like the theme (localStorage), never on the node and never shown to anyone. The first time:
 * a stored choice, else the `?lang=` the visitor arrived by (the website's /ru/ pages link with it; taken as the first
 * choice and kept, never over a stored one), else the browser's own language when BeanPool writes it, else the node's
 * default (`language` in /api/community/info), else English. Settings → Language and the switch on the first screen
 * change it, live: core's `t()` reads the new words and the app's root re-renders (useLanguage).
 *
 * Each language is ONE chunk of the build, fetched only when chosen: this app's words, core's words and core's date
 * words for that language (vite.config.ts puts the three in `words-<lang>`; the first chunk carries English alone,
 * #1941 review N-f). A chunk that can't be fetched (offline before the first visit in that language) leaves the
 * language as it was: never a blank screen, never a throw (onboarding-no-hard-gates).
 *
 * `<html lang>` follows the choice, so the browser's own translate offer and screen readers know the UI's language;
 * `dir` stays `ltr` in every language until the RTL audit (design §2.5 rule 3), and member-written text carries
 * `dir="auto"` where it is shown. The 12 recovery words are never routed through `t()`: they stay English.
 *
 * `?lang=xx` (the pseudo-locale) is for the 320 px checks only: never offered, never stored.
 */

import {
    LANGS, LANGUAGE_HEADER, PSEUDO_LANG, addDateWords, currentLanguage, isLang, normaliseLang, setLanguage,
    type Catalog, type DateWords, type Lang, type UiLang,
} from '@beanpool/core';

export const LANGUAGE_STORAGE_KEY = 'beanpool-language';

/** Each language in itself: the list a member picks from is never translated (a Russian speaker looks for Русский). */
export const LANGUAGE_NAMES: Readonly<Record<Lang, string>> = Object.freeze({
    en: 'English', es: 'Español', pt: 'Português', hi: 'हिन्दी', bn: 'বাংলা', fr: 'Français', ar: 'العربية',
    id: 'Bahasa Indonesia', ru: 'Русский', 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文', it: 'Italiano', de: 'Deutsch',
    tr: 'Türkçe', sw: 'Kiswahili', ml: 'മലയാളം', ta: 'தமிழ்', uk: 'Українська', ur: 'اردو', fa: 'فارسی',
    vi: 'Tiếng Việt', el: 'Ελληνικά', fil: 'Filipino', ja: '日本語', ko: '한국어',
});

/** Where a member says a translation reads wrong, until "Suggest a change" is live (feedback.ts FEEDBACK_LIVE). */
export const WORDS_FEEDBACK_URL = 'https://github.com/beanpool-org/beanpool/issues/new?title=Words%3A%20';

type Loaded = [{ default: Catalog }, { default: Catalog }, { dateWords: DateWords }];

/**
 * One function per language, each naming its three files literally, so the build can split them out (a bare
 * specifier with a variable in it can't be): this app's words, core's words, core's dates.
 */
const LOADERS: Readonly<Record<Exclude<Lang, 'en'>, () => Promise<Loaded>>> = {
    es: () => Promise.all([import('../../words/es.json'), import('@beanpool/core/words/es.json'), import('@beanpool/core/words-dates/es')]),
    pt: () => Promise.all([import('../../words/pt.json'), import('@beanpool/core/words/pt.json'), import('@beanpool/core/words-dates/pt')]),
    hi: () => Promise.all([import('../../words/hi.json'), import('@beanpool/core/words/hi.json'), import('@beanpool/core/words-dates/hi')]),
    bn: () => Promise.all([import('../../words/bn.json'), import('@beanpool/core/words/bn.json'), import('@beanpool/core/words-dates/bn')]),
    fr: () => Promise.all([import('../../words/fr.json'), import('@beanpool/core/words/fr.json'), import('@beanpool/core/words-dates/fr')]),
    ar: () => Promise.all([import('../../words/ar.json'), import('@beanpool/core/words/ar.json'), import('@beanpool/core/words-dates/ar')]),
    id: () => Promise.all([import('../../words/id.json'), import('@beanpool/core/words/id.json'), import('@beanpool/core/words-dates/id')]),
    ru: () => Promise.all([import('../../words/ru.json'), import('@beanpool/core/words/ru.json'), import('@beanpool/core/words-dates/ru')]),
    'zh-Hans': () => Promise.all([import('../../words/zh-Hans.json'), import('@beanpool/core/words/zh-Hans.json'), import('@beanpool/core/words-dates/zh-Hans')]),
    'zh-Hant': () => Promise.all([import('../../words/zh-Hant.json'), import('@beanpool/core/words/zh-Hant.json'), import('@beanpool/core/words-dates/zh-Hant')]),
    it: () => Promise.all([import('../../words/it.json'), import('@beanpool/core/words/it.json'), import('@beanpool/core/words-dates/it')]),
    de: () => Promise.all([import('../../words/de.json'), import('@beanpool/core/words/de.json'), import('@beanpool/core/words-dates/de')]),
    tr: () => Promise.all([import('../../words/tr.json'), import('@beanpool/core/words/tr.json'), import('@beanpool/core/words-dates/tr')]),
    sw: () => Promise.all([import('../../words/sw.json'), import('@beanpool/core/words/sw.json'), import('@beanpool/core/words-dates/sw')]),
    ml: () => Promise.all([import('../../words/ml.json'), import('@beanpool/core/words/ml.json'), import('@beanpool/core/words-dates/ml')]),
    ta: () => Promise.all([import('../../words/ta.json'), import('@beanpool/core/words/ta.json'), import('@beanpool/core/words-dates/ta')]),
    uk: () => Promise.all([import('../../words/uk.json'), import('@beanpool/core/words/uk.json'), import('@beanpool/core/words-dates/uk')]),
    ur: () => Promise.all([import('../../words/ur.json'), import('@beanpool/core/words/ur.json'), import('@beanpool/core/words-dates/ur')]),
    fa: () => Promise.all([import('../../words/fa.json'), import('@beanpool/core/words/fa.json'), import('@beanpool/core/words-dates/fa')]),
    vi: () => Promise.all([import('../../words/vi.json'), import('@beanpool/core/words/vi.json'), import('@beanpool/core/words-dates/vi')]),
    el: () => Promise.all([import('../../words/el.json'), import('@beanpool/core/words/el.json'), import('@beanpool/core/words-dates/el')]),
    fil: () => Promise.all([import('../../words/fil.json'), import('@beanpool/core/words/fil.json'), import('@beanpool/core/words-dates/fil')]),
    ja: () => Promise.all([import('../../words/ja.json'), import('@beanpool/core/words/ja.json'), import('@beanpool/core/words-dates/ja')]),
    ko: () => Promise.all([import('../../words/ko.json'), import('@beanpool/core/words/ko.json'), import('@beanpool/core/words-dates/ko')]),
};

// ── Which language ──────────────────────────────────────────────────────────────────────────────────────────────

function readStored(): Lang | null {
    try {
        const v = localStorage.getItem(LANGUAGE_STORAGE_KEY);
        return isLang(v) ? v : null;
    } catch { return null; }
}

function writeStored(lang: Lang): void {
    try { localStorage.setItem(LANGUAGE_STORAGE_KEY, lang); } catch { /* private mode: the choice lasts for this visit */ }
}

/** `?lang=` in the address: one of LANGS (any tag that normalises to one: `pt-BR` → pt), or the pseudo-locale. */
export function languageFromQuery(search: string): UiLang | null {
    try {
        const raw = new URLSearchParams(search).get('lang');
        if (raw === PSEUDO_LANG) return PSEUDO_LANG;
        return normaliseLang(raw);
    } catch { return null; }
}

/** The browser's languages, in its order of preference: the first BeanPool writes. */
export function languageFromBrowser(nav: Pick<Navigator, 'language' | 'languages'> | undefined = typeof navigator === 'undefined' ? undefined : navigator): Lang | null {
    const tags = [...(nav?.languages ?? []), nav?.language];
    for (const tag of tags) {
        const lang = normaliseLang(tag);
        if (lang) return lang;
    }
    return null;
}

/** The node's default language (its `language` in /api/community/info), when it names one BeanPool writes. */
export function nodeDefaultLanguage(info: { language?: unknown } | null | undefined): Lang | null {
    return typeof info?.language === 'string' ? normaliseLang(info.language) : null;
}

export interface LanguageInputs {
    stored: Lang | null;
    query: UiLang | null;
    browser: Lang | null;
    nodeDefault: Lang | null;
}

/** Stored → ?lang= → the browser's → the node's default → English. */
export function chooseLanguage({ stored, query, browser, nodeDefault }: LanguageInputs): UiLang {
    return stored ?? query ?? browser ?? nodeDefault ?? 'en';
}

// ── The store the root subscribes to ────────────────────────────────────────────────────────────────────────────

let shown: UiLang = 'en';
/** Set by the member (Settings, the switch) or a stored or linked choice: the node's default never overrides it. */
let chosen = false;
let latest = 0;
/**
 * The language the member last chose whose words could not be fetched (a release changed the chunk names under an open
 * tab, or the connection dropped), until their next choice: the switch and Settings say so (#1947 review N3), rather
 * than snapping back to the old language with nothing said. A later choice overtaking this one is not a failure.
 */
let failedChoice: Lang | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };

export function subscribeLanguage(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** The language the screens are in now (what `t()` reads). */
export function shownLanguage(): UiLang {
    return shown;
}

function applyToDocument(lang: UiLang): void {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    // The pseudo-locale is English underneath: en-XA is the tag Android gives its own accented pseudo-locale.
    root.lang = lang === PSEUDO_LANG ? 'en-XA' : lang;
    root.dir = 'ltr';
}

/**
 * Load a language's words and show it. Resolves true once the screens read it; false when its chunk can't be
 * fetched (the screens stay as they were) or when a later switch overtook this one.
 */
export async function showLanguage(lang: UiLang): Promise<boolean> {
    const mine = ++latest;
    try {
        if (lang === 'en' || lang === PSEUDO_LANG || !isLang(lang)) {
            if (mine !== latest) return false;
            setLanguage(isLang(lang) || lang === PSEUDO_LANG ? lang : 'en');
        } else {
            const [app, core, dates] = await LOADERS[lang]();
            if (mine !== latest) return false;
            addDateWords(lang, dates.dateWords);
            setLanguage(lang, [app.default, core.default]);
        }
    } catch (e) {
        console.warn(`[language] could not load ${lang}; staying in ${shown}`, e);
        return false;
    }
    shown = currentLanguage();
    applyToDocument(shown);
    notify();
    return true;
}

/** The language the member chose that could not be loaded, or null (see failedChoice). */
export function failedLanguageChoice(): Lang | null {
    return failedChoice;
}

/**
 * The member's own choice (Settings → Language, the first screen's switch): stored, and shown at once. Stored even when
 * its words can't be fetched now, so the next visit tries again; failedLanguageChoice() says this one didn't load.
 */
export async function chooseAndShowLanguage(lang: Lang): Promise<boolean> {
    chosen = true;
    writeStored(lang);
    if (failedChoice !== null) { failedChoice = null; notify(); }
    const mine = latest + 1; // showLanguage takes the next number at once
    const ok = await showLanguage(lang);
    if (!ok && mine === latest) {
        failedChoice = lang;
        notify();
    }
    return ok;
}

/**
 * The first language of this page load, before the first paint where it can be (main.tsx waits a moment for it).
 * A `?lang=` with nothing stored is kept as the choice; the pseudo-locale never is.
 */
export function startLanguage(search: string = typeof window === 'undefined' ? '' : window.location.search): Promise<boolean> {
    const stored = readStored();
    const query = languageFromQuery(search);
    if (!stored && isLang(query)) writeStored(query);
    chosen = !!stored || !!query;
    applyToDocument(shown);
    return showLanguage(chooseLanguage({ stored, query, browser: languageFromBrowser(), nodeDefault: null }));
}

/**
 * The node's default arrived (/api/community/info): it applies only where nothing was chosen and the browser's
 * language is not one BeanPool writes. It is never stored: a later visit asks the node again.
 */
export function noteNodeDefaultLanguage(info: { language?: unknown } | null | undefined): Promise<boolean> {
    const nodeDefault = nodeDefaultLanguage(info);
    if (chosen || !nodeDefault || languageFromBrowser()) return Promise.resolve(false);
    if (nodeDefault === shown) return Promise.resolve(true);
    return showLanguage(nodeDefault);
}

/**
 * The header a request to this node carries so its answers' sentences can come back in the member's language
 * (design §3; the node reads it from S4 on). Same origin only: a node at another address may be older than the
 * header and refuse it in its CORS preflight, which would fail the whole request. Never the pseudo-locale.
 */
export function languageHeaders(nodeApiUrl: string): Record<string, string> {
    const lang = currentLanguage();
    if (!isLang(lang)) return {};
    const sameOrigin = nodeApiUrl === '' || (typeof window !== 'undefined' && nodeApiUrl === window.location.origin);
    return sameOrigin ? { [LANGUAGE_HEADER]: lang } : {};
}

/** Tests only: forget this page load's language, as a new page load would. */
export function resetLanguageForTests(): void {
    latest++;
    chosen = false;
    failedChoice = null;
    shown = 'en';
    setLanguage('en');
    listeners.clear();
}

export { LANGS };

/**
 * The members' guide's titles, summaries and help lines in each language (slice S5a): that language's titles file,
 * packages/beanpool-guide/content/<lang>/manifest.json, which useGuide lays over the English with core's guideInLanguage.
 * The page bodies stay English until slice S5b.
 *
 * A language's titles arrive with its words, in that language's one chunk (lib/language.ts loads the four together;
 * vite.config.ts puts them in `words-<lang>`): the first chunk carries none, and by the time the screens are drawn in a
 * language its titles are here. English needs none (the guide is English), nor does the pseudo-locale (core
 * pseudo-localises the English).
 */

import { isLang, type Lang, type UiLang } from '@beanpool/core';

const loaded = new Map<Lang, unknown>();

/** Keep a language's titles file, as its chunk arrives (lib/language.ts). */
export function addGuideTitles(lang: Lang, titles: unknown): void {
    if (isLang(lang) && lang !== 'en') loaded.set(lang, titles);
}

/** The titles file of a language whose words have loaded, else null (the English titles). */
export function guideTitlesFor(lang: UiLang): unknown {
    return isLang(lang) ? loaded.get(lang) ?? null : null;
}

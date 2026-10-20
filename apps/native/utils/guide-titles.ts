/**
 * The members' guide's titles, summaries and help lines in one language (slice S5a): that language's titles file,
 * packages/beanpool-guide/content/<lang>/manifest.json, which useGuide lays over the English with core's guideInLanguage.
 * The page bodies stay English until slice S5b.
 *
 * Every language's file ships in the bundle, so the titles work offline from the first launch, but each is required only
 * inside its own `case`, as utils/words-catalogs.ts requires the catalogs: a phone in English builds none of them. English
 * needs none (the guide is English), nor does the pseudo-locale `xx` (core pseudo-localises the English).
 *
 * A language added to core's LANGS fails tsc here until it has a case (the `never` below).
 */

import type { UiLang } from '@beanpool/core';

export function guideTitlesFor(lang: UiLang): unknown {
    switch (lang) {
        case 'en':
        case 'xx':
            return null;
        case 'es': return require('@beanpool/guide/content/es/manifest.json');
        case 'pt': return require('@beanpool/guide/content/pt/manifest.json');
        case 'hi': return require('@beanpool/guide/content/hi/manifest.json');
        case 'bn': return require('@beanpool/guide/content/bn/manifest.json');
        case 'fr': return require('@beanpool/guide/content/fr/manifest.json');
        case 'ar': return require('@beanpool/guide/content/ar/manifest.json');
        case 'id': return require('@beanpool/guide/content/id/manifest.json');
        case 'ru': return require('@beanpool/guide/content/ru/manifest.json');
        case 'zh-Hans': return require('@beanpool/guide/content/zh-Hans/manifest.json');
        case 'zh-Hant': return require('@beanpool/guide/content/zh-Hant/manifest.json');
        case 'it': return require('@beanpool/guide/content/it/manifest.json');
        case 'de': return require('@beanpool/guide/content/de/manifest.json');
        case 'tr': return require('@beanpool/guide/content/tr/manifest.json');
        case 'sw': return require('@beanpool/guide/content/sw/manifest.json');
        case 'ml': return require('@beanpool/guide/content/ml/manifest.json');
        case 'ta': return require('@beanpool/guide/content/ta/manifest.json');
        case 'uk': return require('@beanpool/guide/content/uk/manifest.json');
        case 'ur': return require('@beanpool/guide/content/ur/manifest.json');
        case 'fa': return require('@beanpool/guide/content/fa/manifest.json');
        case 'vi': return require('@beanpool/guide/content/vi/manifest.json');
        case 'el': return require('@beanpool/guide/content/el/manifest.json');
        case 'fil': return require('@beanpool/guide/content/fil/manifest.json');
        case 'ja': return require('@beanpool/guide/content/ja/manifest.json');
        case 'ko': return require('@beanpool/guide/content/ko/manifest.json');
        default: {
            const unknown: never = lang;
            void unknown;
            return null;
        }
    }
}

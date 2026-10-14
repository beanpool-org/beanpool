/**
 * The phone's catalogs for one language: the app's own (apps/native/words/<lang>.json) and core's shared sentences
 * (packages/beanpool-core/words/<lang>.json: the area words), for core's `setLanguage` / `wordsFor`.
 *
 * Every language ships in the bundle, but each catalog is required only inside its own `case`: Metro builds a module's
 * object the first time it is required, so a phone in English never builds any catalog, and a phone in Russian builds
 * Russian's alone (design §2.4; utils/__tests__/language-switch-render.test.ts measures both). English needs none: its
 * key is the sentence. The pseudo-locale `xx` needs none: core makes it from the English.
 *
 * A language added to core's LANGS fails tsc here until it has a case (the `never` below).
 */

import type { Catalog, UiLang } from '@beanpool/core';

export function catalogsFor(lang: UiLang): Catalog[] {
    switch (lang) {
        case 'en':
        case 'xx':
            return [];
        case 'es': return [require('../words/es.json'), require('@beanpool/core/words/es.json')];
        case 'pt': return [require('../words/pt.json'), require('@beanpool/core/words/pt.json')];
        case 'hi': return [require('../words/hi.json'), require('@beanpool/core/words/hi.json')];
        case 'bn': return [require('../words/bn.json'), require('@beanpool/core/words/bn.json')];
        case 'fr': return [require('../words/fr.json'), require('@beanpool/core/words/fr.json')];
        case 'ar': return [require('../words/ar.json'), require('@beanpool/core/words/ar.json')];
        case 'id': return [require('../words/id.json'), require('@beanpool/core/words/id.json')];
        case 'ru': return [require('../words/ru.json'), require('@beanpool/core/words/ru.json')];
        case 'zh-Hans': return [require('../words/zh-Hans.json'), require('@beanpool/core/words/zh-Hans.json')];
        case 'zh-Hant': return [require('../words/zh-Hant.json'), require('@beanpool/core/words/zh-Hant.json')];
        case 'it': return [require('../words/it.json'), require('@beanpool/core/words/it.json')];
        case 'de': return [require('../words/de.json'), require('@beanpool/core/words/de.json')];
        case 'tr': return [require('../words/tr.json'), require('@beanpool/core/words/tr.json')];
        case 'sw': return [require('../words/sw.json'), require('@beanpool/core/words/sw.json')];
        case 'ml': return [require('../words/ml.json'), require('@beanpool/core/words/ml.json')];
        case 'ta': return [require('../words/ta.json'), require('@beanpool/core/words/ta.json')];
        case 'uk': return [require('../words/uk.json'), require('@beanpool/core/words/uk.json')];
        case 'ur': return [require('../words/ur.json'), require('@beanpool/core/words/ur.json')];
        case 'fa': return [require('../words/fa.json'), require('@beanpool/core/words/fa.json')];
        case 'vi': return [require('../words/vi.json'), require('@beanpool/core/words/vi.json')];
        case 'el': return [require('../words/el.json'), require('@beanpool/core/words/el.json')];
        case 'fil': return [require('../words/fil.json'), require('@beanpool/core/words/fil.json')];
        case 'ja': return [require('../words/ja.json'), require('@beanpool/core/words/ja.json')];
        case 'ko': return [require('../words/ko.json'), require('@beanpool/core/words/ko.json')];
        default: {
            const unknown: never = lang;
            void unknown;
            return [];
        }
    }
}

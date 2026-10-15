/**
 * What the web build loads in place of core's words-dates.ts (vite.config.ts, wordsDatesPerLanguage): no language's
 * date words in the first chunk. Each language's own module arrives with its words (lib/language.ts), so a visitor
 * downloads one language's month and day names, not 24 (#1941 review N-f).
 */

import type { DateWords, Lang } from '@beanpool/core';

export const CLDR_DATE_WORDS: Readonly<Partial<Record<Exclude<Lang, 'en'>, DateWords>>> = {};

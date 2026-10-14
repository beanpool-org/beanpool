/**
 * The language switch on the first screen ("🌐 Español ▾", director amendment 2): at the top of the welcome page and
 * the guest lobby, before any sign-up, never a step and never in the way. Each language is listed in itself; the
 * browser's own list does the picking, so it works the same on a 320 px phone and with a screen reader. Settings →
 * Language is the same choice (SettingsPage).
 *
 * The <select> is invisible over the pill, so the pill shows keyboard focus for it (focus-within; #1947 review N4), and
 * a language whose words could not be fetched is said under it (LanguageLoadNote; review N3).
 */

import { LANGS, isLang, t } from '@beanpool/core';
import { LANGUAGE_NAMES } from '../lib/language';
import { useLanguage, useLanguageFailure } from '../lib/useLanguage';

export function LanguageSwitch({ className = '' }: { className?: string }) {
    const [lang, choose] = useLanguage();
    const value = isLang(lang) ? lang : 'en';
    return (
        <div className={`inline-flex flex-col items-end max-w-full ${className}`}>
            <label
                data-testid="language-switch"
                className="relative inline-flex items-center gap-1.5 min-h-[44px] max-w-full px-3 rounded-full border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-900 text-sm font-semibold text-nature-800 dark:text-nature-100 cursor-pointer focus-within:ring-2 focus-within:ring-bp-gold-fill"
            >
                <span aria-hidden="true">🌐</span>
                <span lang={value} className="truncate">{LANGUAGE_NAMES[value]}</span>
                <span aria-hidden="true" className="text-xs text-nature-500 dark:text-nature-300">▾</span>
                <select
                    aria-label={t('Language')}
                    value={value}
                    onChange={(e) => { if (isLang(e.target.value)) void choose(e.target.value); }}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                >
                    {LANGS.map((l) => <option key={l} value={l} lang={l}>{LANGUAGE_NAMES[l]}</option>)}
                </select>
            </label>
            <LanguageLoadNote className="mt-1 empty:mt-0 text-right" />
        </div>
    );
}

/**
 * One line when the language the member chose could not be loaded: in the language still showing, never a dead end
 * (they can choose again). The live region is always there, so a screen reader announces the line when it appears.
 */
export function LanguageLoadNote({ className = '' }: { className?: string }) {
    const failed = useLanguageFailure();
    return (
        <div role="status" aria-live="polite" data-testid="language-load-note" className={`max-w-full text-xs leading-snug break-words text-nature-700 dark:text-nature-200 ${className}`}>
            {failed ? t("Couldn't load that language. Check your connection, then try again.") : null}
        </div>
    );
}

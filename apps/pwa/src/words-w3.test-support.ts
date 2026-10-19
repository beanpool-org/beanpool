/**
 * What the web sweep W3's pseudo-locale tests share (settings, profiles, onboarding and the app shell): what others
 * wrote, which the screens show as written, a root that redraws on a language change as App's does, and the check
 * itself (words-xx.test-support's, which also reads a bold word inside a translated sentence as that sentence's).
 */
import { createElement, Fragment, type ReactNode } from 'react';
import { LANGUAGE_NAMES } from './lib/language';
import { useLanguage } from './lib/useLanguage';
import { getBundledGuide } from './lib/guide';
import { bypassing as bypassingEach, type BypassOptions } from './words-xx.test-support';

/**
 * The page's root as App draws it: it subscribes to the language and draws its screen anew on each change (App makes
 * its children in its own render; an element made once outside would be kept as it was).
 */
export function LanguageRoot({ draw }: { draw: () => ReactNode }) {
    useLanguage();
    return createElement(Fragment, null, draw());
}

/** The language list names each language in itself, never translated (a Russian speaker looks for Русский). */
export const LANGUAGE_LIST = Object.values(LANGUAGE_NAMES);

/** The brand and the website's address, as written in every language. */
export const AS_WRITTEN = ['BeanPool', 'beanpool.org'];

/**
 * The members' guide's own words: its pages are English until the guide carries other languages (design §4, slice S5),
 * so the guide's screen shows them as written. Every string in the bundled guide, with the `**bold**` marks and without.
 */
export function guideStrings(): string[] {
    const out = new Set<string>();
    const walk = (v: unknown) => {
        if (typeof v === 'string') {
            if (/\p{L}/u.test(v)) { out.add(v); out.add(v.replace(/\*\*/g, '')); }
        } else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(getBundledGuide());
    return [...out];
}

/** Every bracketed run in a text, outermost first: a translated sentence, values in it included. */
function bracketedRuns(text: string): string[] {
    const runs: string[] = [];
    let depth = 0;
    let start = -1;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '[') { if (depth === 0) start = i; depth++; }
        else if (text[i] === ']' && depth > 0) { depth--; if (depth === 0) runs.push(text.slice(start, i + 1)); }
    }
    return runs;
}

/**
 * words-xx.test-support's check, where a sentence's bold part (BoldWords, a Sentence part) is drawn as an element of its
 * own: that element's text is not bracketed, but it is a piece of a bracketed sentence its parent shows, so it came
 * through t(). Only accented text can be such a piece; English that bypassed t() never is.
 */
export function bypassing(root: ParentNode = document.body, opts: BypassOptions = {}): string[] {
    const runs = bracketedRuns((root as Node).textContent ?? '');
    return bypassingEach(root, opts).filter((entry) => {
        const m = /^text: (".*")$/s.exec(entry);
        if (!m) return true;
        const text = JSON.parse(m[1]) as string;
        return !runs.some((run) => run.includes(text));
    });
}

/**
 * The web app's pseudo-locale check (words slice S3, web sweeps): a screen drawn in `xx`, where every sentence that came
 * through t() is accented, padded ~35 % and bracketed ("Save" → "[Šāṽé~~]"), shows no letters outside a bracket except
 * what members (or other platforms) wrote. Any other text, screen-reader label, title, placeholder, alt text or alert
 * with letters outside a bracket bypassed t(). The phone's checks do the same (apps/native/utils/__tests__/
 * market-words-render.test.ts); this is the web's, for jsdom and Testing Library.
 *
 * Sweep W2's copy (the enterprise page, the Ledger, the Commons, people and groups), the same check as sweep W1's
 * words-xx.test-support.ts, kept apart while W1 and W3 merge (each brings its own); fold them into one after.
 *
 * jsdom does no layout: the 320 px × 1.3 checks of these screens run in a real browser (e2e/words-w2-check.mjs).
 */
import { act } from '@testing-library/react';
import { pseudoLocalise, type UiLang } from '@beanpool/core';
import { resetLanguageForTests, showLanguage } from './lib/language';

/** Show the screens in `lang` (xx, en, or a language whose words the test can load), inside act(). */
export async function showIn(lang: UiLang): Promise<void> {
    await act(async () => { await showLanguage(lang); });
}

/** Back to English, with no listener left behind (the next test starts as the app does). */
export function backToEnglish(): void {
    resetLanguageForTests();
}

/** `xx`'s form of an English sentence, as t() draws it: for finding a button or label by the words a member reads. */
export const xx = pseudoLocalise;

/** Text with letters outside a pseudo-locale bracket, once what others wrote is taken out. */
export function outsideBrackets(text: string | null | undefined, others: readonly string[] = []): boolean {
    if (!text) return false;
    let rest = text;
    // A member's words first: a title may hold a bracket of its own ("[Repair] café").
    for (const o of [...others].sort((a, b) => b.length - a.length)) rest = rest.split(o).join('');
    // Innermost first: a translated sentence can hold another as a value ("[[Ƒööđ~] ▾~~]").
    for (let was = ''; was !== rest;) { was = rest; rest = rest.replace(/\[[^[\]]*\]/g, ''); }
    return /\p{L}/u.test(rest);
}

/** The elements a sentence's bold or emphasised part is drawn in. */
const BOLD_PARTS = new Set(['STRONG', 'B', 'EM', 'I']);

const READ_ATTRIBUTES = [['aria-label', 'label'], ['title', 'title'], ['placeholder', 'placeholder'], ['alt', 'alt'], ['aria-description', 'description']] as const;

export interface BypassOptions {
    /** What members or other platforms wrote, shown as written: titles, names, messages, places, a node's name. */
    others?: readonly string[];
    /** What the screen said in window.alert / confirm / prompt, collected by the test. */
    said?: readonly string[];
}

/**
 * Every drawn text (read per element, so a sentence with a bold name in it reads whole), screen-reader label, title,
 * placeholder, alt text and alert that bypassed t(). Text a member types into a field is a value, not drawn text.
 */
export function bypassing(root: ParentNode = document.body, { others = [], said = [] }: BypassOptions = {}): string[] {
    const out = new Set<string>();
    const doc = (root as Node).ownerDocument ?? document;
    const walker = doc.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const parent = n.parentElement;
        if (parent && (parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE' || parent.tagName === 'TEXTAREA')) continue;
        // A bold part of a sentence (BoldWords, Sentence: "Use **Approximate** to round") is read with its sentence: in
        // xx the bracket is around the whole sentence, not around the bold word inside it.
        let reader = parent;
        while (reader && BOLD_PARTS.has(reader.tagName) && reader.parentElement) reader = reader.parentElement;
        const whole = reader?.textContent ?? n.nodeValue;
        if (outsideBrackets(whole, others)) out.add(`text: ${JSON.stringify(whole)}`);
    }
    const elements = root instanceof Element ? [root, ...Array.from(root.querySelectorAll('*'))] : Array.from(root.querySelectorAll('*'));
    for (const e of elements) {
        for (const [attr, kind] of READ_ATTRIBUTES) {
            const v = e.getAttribute(attr);
            if (outsideBrackets(v, others)) out.add(`${kind}: ${JSON.stringify(v)}`);
        }
    }
    for (const s of said) if (outsideBrackets(s, others)) out.add(`alert: ${JSON.stringify(s)}`);
    return [...out];
}

/** How many elements show a sentence that came through t() (bracketed), so a check on an empty screen can't pass by itself. */
export function bracketed(root: ParentNode = document.body): number {
    return Array.from(root.querySelectorAll('*')).filter((e) => {
        const own = Array.from(e.childNodes).filter((c) => c.nodeType === 3).map((c) => c.nodeValue ?? '').join('').trim();
        return own.length > 0 && /^\[[\s\S]*\]$/u.test(own);
    }).length;
}

/**
 * The structural checks behind `pnpm words:check` (scratch/global-node/DESIGN-translation-fable.md §2.2, §2.5).
 *
 * They refuse what would BREAK a sentence in some language: a placeholder a translation dropped or invented, a plural
 * entry missing a form its language needs, a catalog key no source uses any more, and a fragment (a `t()` argument that
 * starts or ends with a space, or is glued to something with `+`), which no language can reorder and bidi breaks.
 * A missing translation is never a problem: the English it is keyed by shows instead.
 *
 * Pure: scripts/words/words.mjs extracts the sources with the TypeScript compiler and hands them here.
 */

import { CONTEXT_SEPARATOR, LANGS, PLURAL_CATEGORIES, PLURAL_RULES, PLURAL_SEPARATOR, isLang, placeholdersOf, type Lang, type PluralCategory } from './words.js';

export interface WordProblem {
    key: string;
    problem: string;
}

/** One `t()` / `tn()` / `word()` call as the extractor found it. */
export interface WordCall {
    /** 't', 'tn', or 'word' (a sentence marked where it is written and translated where it is shown). */
    fn: 't' | 'tn' | 'word';
    /** The first string argument (t, word) or the singular (tn); null when the argument is not a plain string literal. */
    text: string | null;
    /**
     * t() was given a `word()` key from a table (a property or element access, e.g. `t(KINDS[kind].body)`): its
     * sentence was collected where word() marked it, and tsc refuses anything but a WordKey there.
     */
    keyed?: boolean;
    /** The call runs when its module is imported (no enclosing function), so it would freeze the starting language. */
    moduleLevel?: boolean;
    /** tn's plural argument. */
    other?: string | null;
    /** t's context argument, when it is a literal. */
    context?: string;
    /**
     * The call's text is glued to other text: an operand of `+`, a literal argument built with `+`, a span of a template
     * literal with other text, an element of an array that is joined, or a JSX child beside other text or values.
     */
    concatenated: boolean;
    /** "file:line", for the message. */
    at: string;
}

/** Why one extracted call cannot be a whole sentence, or null when it is fine. */
export function callProblem(call: WordCall): string | null {
    if (call.moduleLevel && call.fn !== 'word') {
        return `${call.fn}() at module level runs once, at import, and keeps the language the app started in; call it where the text is shown, or mark the sentence with word('…') and t() it there`;
    }
    if (call.concatenated) return `${call.fn}() is joined to other text (+, a template literal, a joined array or JSX beside it): a fragment; put the whole sentence in one string with {placeholders}`;
    if (call.fn === 't' && call.keyed) return null;
    const texts = call.fn === 'tn' ? [call.text, call.other] : [call.text];
    if (texts.some((s) => s === null || s === undefined)) {
        return `${call.fn}() takes a string literal (a sentence the extractor can read), or for t() a word('…') key from a table; not a variable`;
    }
    for (const s of texts as string[]) {
        if (s.trim().length === 0) return `${call.fn}() with an empty sentence`;
        if (s !== s.trim()) return `"${s}" starts or ends with a space: a fragment of a sentence; use one string with {placeholders}`;
    }
    return null;
}

/** The key an extracted call is looked up by. */
export function callKey(call: WordCall): string | null {
    if (call.keyed) return null;
    if (call.fn === 'tn') return call.text != null && call.other != null ? `${call.text}${PLURAL_SEPARATOR}${call.other}` : null;
    if (call.text == null) return null;
    return call.context ? `${call.text}${CONTEXT_SEPARATOR}${call.context}` : call.text;
}

function sameSet(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((x) => b.includes(x));
}

/** The forms a plural entry in `lang` may carry: the ones it must, and the ones it may (fr/pt/es/it `many`). */
export function allowedPluralForms(lang: Lang): readonly PluralCategory[] {
    return [...PLURAL_RULES[lang].forms, ...PLURAL_RULES[lang].optional];
}

/**
 * Check one language's catalog against the keys the sources use (`sourceKeys`, or null to skip the unknown-key check)
 * and the set of plural keys among them.
 */
export function checkCatalog(
    lang: Lang,
    catalog: Readonly<Record<string, unknown>>,
    sourceKeys: ReadonlySet<string> | null,
    pluralKeys: ReadonlySet<string> = new Set(),
): WordProblem[] {
    const problems: WordProblem[] = [];
    if (!isLang(lang) || lang === 'en') return [{ key: '', problem: `"${lang}" is not one of ${LANGS.filter((l) => l !== 'en').join(', ')} (en has no catalog: the key is the English)` }];
    const rule = PLURAL_RULES[lang];
    const allowedForms = allowedPluralForms(lang);
    for (const [key, value] of Object.entries(catalog)) {
        if (key === '_meta') continue;
        if (sourceKeys && !sourceKeys.has(key)) {
            problems.push({ key, problem: 'no source uses this key any more (the English changed or the sentence was removed)' });
            continue;
        }
        const isPlural = pluralKeys.has(key) || (value !== null && typeof value === 'object');
        if (isPlural) {
            if (!value || typeof value !== 'object') {
                problems.push({ key, problem: 'a plural sentence needs an object of forms, e.g. { "one": …, "other": … }' });
                continue;
            }
            const cut = key.indexOf(PLURAL_SEPARATOR);
            if (cut < 0) {
                problems.push({ key, problem: `a plural entry's key is "<one>${PLURAL_SEPARATOR}<other>"` });
                continue;
            }
            const englishPlaceholders = placeholdersOf(key.slice(cut + 1));
            const forms = value as Record<string, unknown>;
            const filled = Object.entries(forms).filter(([, v]) => typeof v === 'string' && v.length > 0);
            // An empty object is an untranslated entry (fallback to English), not a break.
            if (filled.length === 0) continue;
            for (const form of rule.forms) {
                if (typeof forms[form] !== 'string' || (forms[form] as string).length === 0) {
                    problems.push({ key, problem: `${lang} needs the "${form}" form (${rule.forms.join(', ')})` });
                }
            }
            for (const [form, text] of filled) {
                if (!(PLURAL_CATEGORIES as readonly string[]).includes(form)) {
                    problems.push({ key, problem: `"${form}" is not a plural form` });
                    continue;
                }
                if (!allowedForms.includes(form as PluralCategory)) {
                    problems.push({ key, problem: `${lang} has no "${form}" form (its forms: ${allowedForms.join(', ')})` });
                    continue;
                }
                // tn() always supplies {n}, so any form may use it. Only a form that holds ONE number (en/es "one" is 1,
                // ar "zero"/"one"/"two" are 0/1/2) may write the number in words and leave {n} out: fr "one" is also
                // 0 and 1.5, ru "one" is also 21 and 101, so "un haricot" there would print the wrong number.
                const have = placeholdersOf(text as string);
                const allowed = new Set([...englishPlaceholders, 'n']);
                const invented = have.filter((p) => !allowed.has(p));
                const mayDropN = rule.exact.includes(form as PluralCategory);
                const dropped = englishPlaceholders.filter((p) => !have.includes(p) && !(mayDropN && p === 'n'));
                if (invented.length || dropped.length) {
                    problems.push({ key, problem: `the ${form} form's placeholders differ from the English: ${describe(dropped, invented)}` });
                }
            }
            continue;
        }
        if (typeof value !== 'string') {
            problems.push({ key, problem: 'a translation is a string' });
            continue;
        }
        if (value.length === 0) continue;
        const english = placeholdersOf(key.split(CONTEXT_SEPARATOR)[0]);
        const have = placeholdersOf(value);
        if (!sameSet(english, have)) {
            problems.push({
                key,
                problem: `placeholders differ from the English: ${describe(english.filter((p) => !have.includes(p)), have.filter((p) => !english.includes(p)))}`,
            });
        }
    }
    return problems;
}

function describe(dropped: string[], invented: string[]): string {
    const parts: string[] = [];
    if (dropped.length) parts.push(`dropped ${dropped.map((p) => `{${p}}`).join(', ')}`);
    if (invented.length) parts.push(`unknown ${invented.map((p) => `{${p}}`).join(', ')}`);
    return parts.join('; ');
}

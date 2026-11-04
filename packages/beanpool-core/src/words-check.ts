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

/** One `t()` / `tn()` / `word()` / `wordn()` call as the extractor found it. */
export interface WordCall {
    /** 't', 'tn', 'word' or 'wordn' (a sentence, or one with a count, marked where it is written and translated where it is shown). */
    fn: 't' | 'tn' | 'word' | 'wordn';
    /** The first string argument (t, word) or the singular (tn, wordn); null when the argument is not a plain string literal. */
    text: string | null;
    /**
     * t() was given a `word()` key from a table (a property or element access, e.g. `t(KINDS[kind].body)`), or tn() the two
     * keys of a `wordn()` pair (`tn(n, line.key.one, line.key.other)`): its sentence was collected where word() or wordn()
     * marked it, and tsc refuses anything but a WordKey there.
     */
    keyed?: boolean;
    /** The call runs when its module is imported (no enclosing function), so it would freeze the starting language. */
    moduleLevel?: boolean;
    /** The plural argument of tn and wordn. */
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
    if (call.moduleLevel && call.fn !== 'word' && call.fn !== 'wordn') {
        return `${call.fn}() at module level runs once, at import, and keeps the language the app started in; call it where the text is shown, or mark the sentence with word('…') and t() it there`;
    }
    if (call.concatenated) return `${call.fn}() is joined to other text (+, a template literal, a joined array or JSX beside it): a fragment; put the whole sentence in one string with {placeholders}`;
    if ((call.fn === 't' || call.fn === 'tn') && call.keyed) return null;
    const texts = call.fn === 'tn' || call.fn === 'wordn' ? [call.text, call.other] : [call.text];
    if (texts.some((s) => s === null || s === undefined)) {
        return `${call.fn}() takes a string literal (a sentence the extractor can read), or for t() a word('…') key from a table and for tn() the keys of a wordn('…', '…') pair; not a variable`;
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
    if (call.fn === 'tn' || call.fn === 'wordn') return call.text != null && call.other != null ? `${call.text}${PLURAL_SEPARATOR}${call.other}` : null;
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

// ── Glossary, numbers, untranslatable ──────────────────────────────────────────────────────────────────────────
//
// The three checks that hold a translation to what the English means (scratch/fable-design/DESIGN-translation-tooling-fable.md
// §3.6, slice T0). They read pairs of (English, translation), so they do not care whether the catalogs are JSON today or PO later:
// only the reader changes. scripts/words/GLOSSARY.csv holds the terms; scripts/words/glossary.mjs reads it into `GlossaryTerm`s.
//
//   glossary        an English sentence that contains a glossary term must, in a language the term has a rendering for, carry that
//                   rendering or one of its allowed variants; a translation never carries a `forbidden` word.
//   numbers         every number in the English is in the translation.
//   untranslatable  "BeanPool", and a word the member must type, stay as they are in every language.
//
// None of the three is a structural break (a sentence still renders), so words.mjs holds them to a recorded baseline that may only
// fall, where `checkCatalog` above refuses outright.

export type WordRule = 'glossary' | 'numbers' | 'untranslatable';

export interface RuleProblem {
    key: string;
    rule: WordRule;
    /**
     * What the problem is about, apart from the words used to say it: the glossary term, or the number the translation lacks. Stable
     * when the glossary row gains a variant, so the baseline can name a problem by it (words.mjs violationId).
     */
    what: string;
    problem: string;
}

/** One problem on one (English, translation) pair, before it has a key. */
export interface RuleFinding {
    rule: WordRule;
    what: string;
    problem: string;
}

/** One row of GLOSSARY.csv. */
export interface GlossaryTerm {
    /** The English term, as a sentence has it. */
    term: string;
    /** One line: what the word means in BeanPool. */
    meaning: string;
    /**
     * `untranslatable` (stays as written), `forbidden` (never in a translation), `name` (matches only the capitalised or upper-case
     * word: "Offer" is the post, "offer" is the verb; not where the capital only opens a sentence, "Offer to help", or in a
     * heading in capitals: see termIn); others (`terminology`, `money`, `safety`, `operator`) are notes for translators.
     */
    flags: readonly string[];
    /**
     * Per language: the rendering (first) and its allowed variants. A `forbidden` row lists the renderings that are ruled out.
     * A trailing `~` makes an entry a stem: it matches any word that starts with it (Russian endings).
     */
    renderings: Readonly<Partial<Record<string, readonly string[]>>>;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LEFT = '(?<![\\p{L}\\p{N}_])';
const RIGHT = '(?![\\p{L}\\p{N}_])';

/** A word the member must type: an upper-case `untranslatable` term (CONFIRM, WIPE, DELETE). */
export function isTypedWord(term: GlossaryTerm): boolean {
    return term.flags.includes('untranslatable') && /^[A-Z]{3,}$/.test(term.term);
}

const patterns = new Map<string, RegExp>();

/**
 * Where a term is in an English sentence. A term flagged `name` ("Offer") matches its capitalised or upper-case word, with a plural
 * (Offers); any other term ("group", "Beans", "sign-in") matches in any case. A typed word matches only where the sentence tells the member to type it
 * (`Type CONFIRM`, `'WIPE'`), because "TO CONFIRM" in a label is the verb and is translated. Whole words only; `{placeholders}` are
 * not words (callers blank them first).
 */
export function termPattern(term: GlossaryTerm): RegExp {
    const cached = patterns.get(term.term);
    if (cached) return cached;
    const base = term.term.trim();
    let re: RegExp;
    if (isTypedWord(term)) {
        const lead = '(?:(?:[Tt]ype|TYPE|[Ee]nter|ENTER|[Ww]rite|WRITE)\\s+[\'"‘“«]?|[\'"‘“«])';
        re = new RegExp(`${lead}${escapeRe(base)}${RIGHT}`, 'u');
    } else {
        const isName = term.flags.includes('name');
        const forms = (b: string): string[] => {
            const upper = b === b.toUpperCase() && b !== b.toLowerCase();
            const s = upper ? 'S' : 's';
            const body = escapeRe(b).replace(/\s+/g, '\\s+');
            const alts = [body, `${body}${s}`];
            if (/y$/i.test(b)) alts.push(`${escapeRe(b.slice(0, -1)).replace(/\s+/g, '\\s+')}${upper ? 'IES' : 'ies'}`);
            return alts;
        };
        const alts = isName ? [...forms(base), ...forms(base.toUpperCase())] : forms(base);
        re = new RegExp(`${LEFT}(?:${alts.join('|')})${RIGHT}`, isName ? 'u' : 'iu');
    }
    patterns.set(term.term, re);
    return re;
}

/** The English with its `{placeholders}` blanked, so a `{owner}` is not the word owner. */
function plainEnglish(english: string): string {
    return english.replace(/\{[A-Za-z0-9_]+\}/g, ' ');
}

const lower = (s: string): string => s.normalize('NFC').toLowerCase();
const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * Does `text` carry this rendering? Case does not matter, and neither do accents once the rendering has four letters or more
 * (Spanish loses one in the plural: publicación, publicaciones; a two-letter word like "nó" must match as written, or it would
 * find "no" everywhere). A trailing `~` is a stem: any word starting with it.
 */
export function hasRendering(text: string, rendering: string): boolean {
    const stem = rendering.endsWith('~');
    const word = stem ? rendering.slice(0, -1) : rendering;
    if (word.length === 0) return false;
    const search = (haystack: string, needle: string): boolean => (stem
        ? new RegExp(`${LEFT}${escapeRe(needle)}`, 'u').test(haystack)
        : haystack.includes(needle));
    if (search(lower(text), lower(word))) return true;
    return fold(word).length >= 4 && search(fold(text), fold(word));
}

/** Text with no lower-case letter and at least two words: a heading in capitals. Its capitals say nothing about which word is a name. */
function inCapitalsOnly(text: string): boolean {
    return text === text.toUpperCase() && text !== text.toLowerCase() && (text.match(/\p{L}+/gu) ?? []).length >= 2;
}

/**
 * Is the word at `at`..`end` capitalised only because it opens a sentence, before a lower-case word ("Offer to help", "Needs you",
 * "Chat with {name}", "People who joined")? Then the capital is the sentence's, not the name's, and the word may be the verb or the
 * plain plural. A sentence opens at the start of the text (after any emoji, quote or bracket) or after . ? ! … and a space. A word
 * after an arrow ("Settings → Chat memory") is a place, not a new sentence.
 */
function opensSentenceBeforeLowercase(plain: string, at: number, end: number): boolean {
    const before = plain.slice(0, at);
    const opens = /^[^\p{L}\p{N}]*$/u.test(before) || /[.?!…][)"'”’»\]]*\s+$/u.test(before);
    return opens && /^\s+\p{Ll}/u.test(plain.slice(end));
}

/**
 * Does this English sentence carry the glossary term? A term flagged `name` is the term only where its capital tells it from the
 * verb or the plain word, so it is not found where the capital only opens a sentence before a lower-case word
 * (opensSentenceBeforeLowercase), nor in a heading in capitals (inCapitalsOnly). Any other term is found wherever termPattern
 * finds it. That leaves the label itself ("Offer", "Offers", "Offer Details"), and the name in the middle of a sentence.
 */
export function termIn(term: GlossaryTerm, plain: string): boolean {
    const re = termPattern(term);
    if (!term.flags.includes('name') || isTypedWord(term)) return re.test(plain);
    if (inCapitalsOnly(plain)) return false;
    for (const m of plain.matchAll(new RegExp(re.source, `${re.flags}g`))) {
        if (!opensSentenceBeforeLowercase(plain, m.index!, m.index! + m[0].length)) return true;
    }
    return false;
}

/** The glossary problems of one translated sentence (no `forbidden` here: see forbiddenProblems). */
function glossaryProblems(lang: string, english: string, text: string, glossary: readonly GlossaryTerm[]): RuleFinding[] {
    const plain = plainEnglish(english);
    const out: RuleFinding[] = [];
    for (const term of glossary) {
        if (term.flags.includes('forbidden') || term.flags.includes('untranslatable')) continue;
        const renderings = term.renderings[lang];
        if (!renderings || renderings.length === 0) continue;
        if (!termIn(term, plain)) continue;
        if (renderings.some((r) => hasRendering(text, r))) continue;
        const shown = renderings.map((r) => (r.endsWith('~') ? `"${r.slice(0, -1)}…"` : `"${r}"`)).join(' or ');
        out.push({ rule: 'glossary', what: term.term, problem: `"${term.term}" is ${shown} in ${lang}, and the translation has neither` });
    }
    return out;
}

/** A forbidden word in a translation, in any language: the term itself, or a rendering this language's column rules out. */
function forbiddenProblems(lang: string, text: string, glossary: readonly GlossaryTerm[]): RuleFinding[] {
    const haystack = fold(text);
    const out: RuleFinding[] = [];
    for (const term of glossary) {
        if (!term.flags.includes('forbidden')) continue;
        const banned = [term.term, ...(term.renderings[lang] ?? [])];
        const hit = banned.find((b) => b.length > 0 && haystack.includes(fold(b.replace(/~$/, ''))));
        if (hit) out.push({ rule: 'glossary', what: `never ${term.term}`, problem: `"${hit.replace(/~$/, '…')}" is a word we do not use (${term.meaning})` });
    }
    return out;
}

/**
 * The numbers in a sentence as plain digits ("1,5 %" and "1.5%" are both "1.5"; "1 000" and "1,000" are "1000"), in order. Digits
 * written against a letter before them are part of a name, not a quantity ("E2E", "v2", "H264"), and are not numbers.
 */
export function numbersOf(sentence: string): string[] {
    // Any script's digits to 0-9: a Nd run always starts at a zero, so the offset into its run is the value.
    const ascii = plainEnglish(sentence).replace(/\p{Nd}/gu, (c) => {
        let start = c.codePointAt(0)!;
        const cp = start;
        while (start > 0 && /^\p{Nd}$/u.test(String.fromCodePoint(start - 1))) start--;
        return String((cp - start) % 10);
    });
    const out: string[] = [];
    // Between two groups of digits: a point, comma or apostrophe; the Arabic decimal and thousands marks (U+066B ٫, U+066C ٬: what
    // Persian, and Arabic or Urdu in their own digits, write "۱٫۵" and "۱٬۰۰۰" with); a no-break or thin space (\p{Zs} but the plain
    // one); or a plain space only when exactly three digits follow ("1 000").
    for (const m of ascii.matchAll(/(?<![A-Za-z\d])\d+(?:(?:[.,'’\u066B\u066C]|(?!\x20)\p{Zs}|\x20(?=\d{3}(?!\d)))\d+)*/gu)) {
        const groups = m[0].split(/[.,'’\u066B\u066C\p{Zs}]/u);
        const last = groups[groups.length - 1];
        const thousands = groups.length > 1 && last.length === 3 && groups[0] !== '0';
        out.push(thousands ? groups.join('') : groups.length > 1 ? `${groups.slice(0, -1).join('')}.${last}` : groups[0]);
    }
    return out;
}

function numberProblems(english: string, text: string): RuleFinding[] {
    const have = new Set(numbersOf(text));
    const missing = [...new Set(numbersOf(english))].filter((n) => !have.has(n));
    return missing.map((n) => ({ rule: 'numbers' as const, what: n, problem: `the English has ${n} and the translation does not` }));
}

function untranslatableProblems(english: string, text: string, glossary: readonly GlossaryTerm[]): RuleFinding[] {
    const plain = plainEnglish(english);
    const out: RuleFinding[] = [];
    for (const term of glossary) {
        if (!term.flags.includes('untranslatable')) continue;
        const found = termPattern(term).exec(plain);
        if (!found) continue;
        const word = term.term;
        // A label in capitals ("BEANPOOL") is the same word in capitals, so its translation may be too.
        const inCapitals = found[0] === found[0].toUpperCase() && found[0] !== found[0].toLowerCase() && word !== word.toUpperCase();
        // A typed word is the whole word ("CONFIRMAR" is not "CONFIRM"); the mark may take an ending of the language ("BeanPool's", "BeanPoolは").
        const present = isTypedWord(term)
            ? new RegExp(`(?<![A-Za-z0-9_])${escapeRe(word)}(?![A-Za-z0-9_])`).test(text)
            : inCapitals ? text.toUpperCase().includes(word.toUpperCase()) : text.includes(word);
        if (!present) out.push({ rule: 'untranslatable', what: word, problem: `"${word}" stays "${word}" in every language, and the translation does not carry it` });
    }
    return out;
}

/** The three rules on one (English, translation) pair. */
export function ruleProblemsOf(lang: string, english: string, text: string, glossary: readonly GlossaryTerm[]): RuleFinding[] {
    if (text.length === 0) return [];
    return [
        ...glossaryProblems(lang, english, text, glossary),
        ...forbiddenProblems(lang, text, glossary),
        ...numberProblems(english, text),
        ...untranslatableProblems(english, text, glossary),
    ];
}

/**
 * The glossary, numbers and untranslatable problems of one language's catalog. A plural entry is read form by form against the
 * English form it stands for (`one` against the singular, every other form against the plural). An empty or missing translation is
 * untranslated, not a problem. Structural problems are checkCatalog's.
 */
export function checkCatalogRules(lang: Lang, catalog: Readonly<Record<string, unknown>>, glossary: readonly GlossaryTerm[]): RuleProblem[] {
    const out: RuleProblem[] = [];
    if (!isLang(lang) || lang === 'en') return out;
    const seen = new Set<string>();
    const push = (key: string, english: string, text: unknown) => {
        if (typeof text !== 'string') return;
        for (const p of ruleProblemsOf(lang, english, text, glossary)) {
            // Two forms of one plural entry can fail alike ("People" in `one` and `other`): one problem for the key.
            const id = `${key}\n${p.rule}\n${p.what}`;
            if (!seen.has(id)) { seen.add(id); out.push({ key, rule: p.rule, what: p.what, problem: p.problem }); }
        }
    };
    for (const [key, value] of Object.entries(catalog)) {
        if (key === '_meta') continue;
        if (value !== null && typeof value === 'object') {
            const cut = key.indexOf(PLURAL_SEPARATOR);
            if (cut < 0) continue;
            const one = key.slice(0, cut);
            const other = key.slice(cut + 1);
            for (const [form, text] of Object.entries(value as Record<string, unknown>)) push(key, form === 'one' ? one : other, text);
        } else {
            push(key, key.split(CONTEXT_SEPARATOR)[0], value);
        }
    }
    return out;
}

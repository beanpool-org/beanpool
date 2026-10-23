/**
 * The words a member reads from this server, in their language (scratch/global-node/DESIGN-translation-fable.md §3; Marty's
 * M6, 15 Oct: the server learns a language only from the `X-Language` request header, never stored, and from the push-token
 * row's `lang`, erased with the token). Logs, the operator's routes and the manager stay English (M8).
 *
 * Two places a member reads this server's words:
 *   - **Refusals the apps show as they come** (`error` / `message` in a 4xx or 5xx answer): {@link memberWordsOnTheWayOut}.
 *     A sentence is marked where it is written, `throw new Error(word('This poll is closed'))`, so everything inside the
 *     server still sees the English (every check on a message, every status chosen from one), and is translated once, on
 *     the way out, when the request names a language and the server's catalog has the sentence. A request with no
 *     `X-Language` is answered byte for byte as before. An `error` that is a code (`not_found`) is no sentence and stays.
 *     A sentence with values in it is written with English's own t(), `tr('A post can have at most {n} photos', { n })`
 *     (the very text a template literal wrote), and found again on the way out by the catalog's sentence it fits, its
 *     values read back out of the English and written into the translation ({@link sentenceTemplates}). A code the apps
 *     read before the sentence (`UNAUTHORIZED: …`, `FLOOR_LOCKED:1:2:200:500: …`) stays as it came, the sentence after it
 *     translated.
 *   - **Pushes**: the lock screen's sentence for the push's kind, in the language the phone registered with
 *     ({@link wordsIn}, state-engine.ts dispatchPushNotification).
 *
 * Never marked: a sentence an app matches on (`includes('already a member')`, `/set a profile photo/i`), or the code at the
 * start of one (`UNAUTHORIZED: `, marked after it: `unauthorized(word('…'))`). Translated, the app's branch would stop
 * matching; those move to a `code` first (test-member-words.ts holds the list, and reads the apps' sources for any match
 * on a marked sentence).
 *
 * The catalogs: apps/server/words/<lang>.json (the server's sentences and @beanpool/engine's) and core's
 * packages/beanpool-core/words/<lang>.json (the push sentences live in core). Read once per language, and the language's
 * words built from them once; a missing or unreadable file is no catalog, and the English shows (onboarding-no-hard-gates),
 * never a throw.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type Koa from 'koa';
import {
    CONTEXT_SEPARATOR, LANGUAGE_HEADER, PLURAL_SEPARATOR, normaliseLang, wordsFor,
    type Catalog, type Lang, type WordKey, type WordValues, type Words,
} from '@beanpool/core';
import { isOperatorPath } from './routes/member-error-text.js';

/** apps/server/words, from src/ (tsx) and from dist/ (the image) alike. */
const SERVER_WORDS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'words');
const requireFromHere = createRequire(import.meta.url);

interface Catalogs { server: Catalog | null; core: Catalog | null }

const held = new Map<Lang, Catalogs>();
const forTests = new Map<Lang, Partial<Catalogs>>();
/**
 * Each language's words, built once from its catalogs: the table holds every sentence of both catalogs, so building it
 * for each refused request was a cost per refusal that grew with the catalogs.
 */
const built = new Map<Lang, { all: Words; refusals: Words; templates: SentenceTemplate[] }>();

function readCatalog(file: () => string): Catalog | null {
    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(file(), 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Catalog : null;
    } catch {
        return null;
    }
}

function catalogsOf(lang: Lang): Catalogs {
    const test = forTests.get(lang);
    let read = held.get(lang);
    if (!read) {
        read = {
            server: readCatalog(() => path.join(SERVER_WORDS_DIR, `${lang}.json`)),
            core: readCatalog(() => requireFromHere.resolve(`@beanpool/core/words/${lang}.json`)),
        };
        held.set(lang, read);
    }
    return test ? { server: test.server ?? read.server, core: test.core ?? read.core } : read;
}

const present = (list: (Catalog | null)[]): Catalog[] => list.filter((c): c is Catalog => c !== null);
const ENGLISH = wordsFor('en');

function builtFor(lang: Lang): { all: Words; refusals: Words; templates: SentenceTemplate[] } {
    let words = built.get(lang);
    if (!words) {
        const { server, core } = catalogsOf(lang);
        words = {
            all: wordsFor(lang, present([core, server])),
            // A refusal is translated with the server's catalog alone, so only a sentence the server or the engine marked
            // is ever translated, never one that happens to match a sentence of core's the apps write.
            refusals: wordsFor(lang, present([server])),
            templates: sentenceTemplates(server),
        };
        built.set(lang, words);
    }
    return words;
}

/**
 * One of the catalog's sentences with values in it, as the way out finds it again in the English a route wrote:
 * `A post can have at most {n} photos` is /^A post can have at most ([\s\S]+?) photos$/. A sentence with a count is
 * two, its English singular and plural, either of which may have been written.
 */
interface SentenceTemplate {
    pattern: RegExp;
    names: string[];
    /** The characters of the sentence that are not a value: when two fit, the one that says more is the one meant. */
    fixed: number;
    sentence: string;
    context?: string;
    count?: { one: string; other: string };
}

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;
const escapeForPattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The catalog's sentences that hold a value, each as a pattern of its English (a count's both). */
function sentenceTemplates(catalog: Catalog | null): SentenceTemplate[] {
    const out: SentenceTemplate[] = [];
    for (const [key, value] of Object.entries(catalog ?? {})) {
        if (key === '_meta' || !value) continue;
        const [sentence, context] = key.split(CONTEXT_SEPARATOR);
        const isCount = typeof value === 'object' && sentence.includes(PLURAL_SEPARATOR);
        const [one, other] = isCount ? [sentence.slice(0, sentence.indexOf(PLURAL_SEPARATOR)), sentence.slice(sentence.indexOf(PLURAL_SEPARATOR) + 1)] : [sentence, ''];
        for (const english of isCount ? [one, other] : [sentence]) {
            const names: string[] = [];
            const parts = english.split(PLACEHOLDER);
            // split() with a group: the text between the values at the even places, the values' names at the odd ones.
            let source = '^';
            let fixed = 0;
            parts.forEach((part, i) => {
                if (i % 2 === 1) { names.push(part); source += '([\\s\\S]+?)'; } else { source += escapeForPattern(part); fixed += part.length; }
            });
            // A sentence that is nearly all values would fit nearly anything.
            if (names.length === 0 || fixed < 6) continue;
            out.push({ pattern: new RegExp(`${source}$`), names, fixed, sentence: english, context: context || undefined, count: isCount ? { one, other } : undefined });
        }
    }
    return out.sort((a, b) => b.fixed - a.fixed);
}

/**
 * A value read back out of the English, as the language writes it: a plain number in its own decimal mark and digits,
 * with the decimals it was written with ("12.50" stays two places), anything else as it came.
 */
function valueIn(words: Words, text: string): string {
    const number = /^-?(?:0|[1-9]\d*)(?:\.(\d+))?$/.exec(text);
    return number ? words.formatNumber(Number(text), number[1]?.length ?? 0) : text;
}

/** One sentence of a refusal in `words`' language: as a whole sentence, or as one with values in it. */
function translatedSentence(text: string, words: Words, templates: SentenceTemplate[]): string {
    // Looked up as it came: words:check saw the sentence where it was marked, word('…').
    const whole = words.t(text as WordKey);
    if (whole !== text) return whole;
    for (const template of templates) {
        const found = template.pattern.exec(text);
        if (!found) continue;
        const read: Record<string, string> = {};
        let fits = true;
        template.names.forEach((name, i) => {
            // The same value twice in one sentence is one value.
            if (name in read && read[name] !== found[i + 1]) fits = false;
            read[name] = found[i + 1];
        });
        if (!fits) continue;
        const values: WordValues = Object.fromEntries(Object.entries(read).map(([name, v]) => [name, valueIn(words, v)]));
        if (template.count) {
            // The count picks the language's form; it is written as the English wrote it, in the language's digits.
            if (!/^\d+$/.test(read.n ?? '')) continue;
            return words.tn(Number(read.n), template.count.one as WordKey, template.count.other as WordKey, values);
        }
        return words.t(template.sentence as WordKey, values, template.context);
    }
    return text;
}

/** Where one sentence ends and the next begins: after its stop, before the next one's capital. */
const BETWEEN_SENTENCES = /(?<=[.!?])(\s+)(?=[A-Z])/;

/**
 * A text of one sentence, or of several written apart (`${tr('This enterprise is {n} beans in debt.')} ${…}`, a sentence
 * of two with another after it), in `words`' language: each run of sentences the longest the catalog has, and only when
 * every run is the catalog's; else the whole stays as it came, never half translated.
 */
function translatedText(text: string, words: Words, templates: SentenceTemplate[]): string {
    const whole = translatedSentence(text, words, templates);
    if (whole !== text) return whole;
    // split() with a group: the sentences at the even places, the space between them at the odd ones.
    const pieces = text.split(BETWEEN_SENTENCES);
    if (pieces.length < 3) return text;
    const sentences = pieces.filter((_, i) => i % 2 === 0);
    const run = (from: number, to: number) => pieces.slice(from * 2, to * 2 + 1).join('');
    let said = '';
    for (let from = 0; from < sentences.length;) {
        let to = sentences.length - 1;
        let translated = text;
        for (; to >= from; to--) {
            if (from === 0 && to === sentences.length - 1) continue; // the whole: tried above
            const english = run(from, to);
            translated = translatedSentence(english, words, templates);
            if (translated !== english) break;
        }
        if (to < from) return text;
        said += (from > 0 ? pieces[from * 2 - 1] : '') + translated;
        from = to + 1;
    }
    return said;
}

/** A code the apps read before a sentence: `UNAUTHORIZED: `, `FLOOR_LOCKED:1:2:200:500: `. */
const CODE_BEFORE_SENTENCE = /^([A-Z][A-Z_]{2,}(?::[^\s:]+)*:\s*)(?=\S)/;

/** A refusal's `error` or `message` in `words`' language: a code before its sentence stays as it came. */
function translatedRefusal(text: string, words: Words, templates: SentenceTemplate[]): string {
    const said = translatedText(text, words, templates);
    if (said !== text) return said;
    const code = CODE_BEFORE_SENTENCE.exec(text);
    if (!code) return text;
    const sentence = text.slice(code[1].length);
    const translated = translatedText(sentence, words, templates);
    return translated === sentence ? text : `${code[1]}${translated}`;
}

/** The server's words and core's in `lang`; English for no language. */
export function wordsIn(lang: Lang | null | undefined): Words {
    if (!lang || lang === 'en') return ENGLISH;
    return builtFor(lang).all;
}


/** The language a request names in `X-Language`, when it is one BeanPool writes; null when it names none. */
export function requestLanguage(ctx: Pick<Koa.Context, 'get'>): Lang | null {
    const tag = ctx.get(LANGUAGE_HEADER);
    return tag ? normaliseLang(tag) : null;
}

/** An answer's body this can read: a plain JSON object, never a stream or a buffer. */
function isJsonObject(body: unknown): body is Record<string, unknown> {
    return !!body && typeof body === 'object' && !Array.isArray(body) && !Buffer.isBuffer(body)
        && typeof (body as { pipe?: unknown }).pipe !== 'function';
}

/**
 * A refusal's `error` and `message` in the request's language, outside the operator's routes: each one that is a sentence
 * of the server's catalog in that language is replaced by its translation. The status, the `code` and every other field
 * stay as the route made them. Mounted outside scrubServerFaults, so a fault's fixed words are translated too.
 */
export function memberWordsOnTheWayOut(): Koa.Middleware {
    return async (ctx, next) => {
        await next();
        if (!ctx.get(LANGUAGE_HEADER) || ctx.status < 400 || isOperatorPath(ctx.path)) return;
        const body = ctx.body;
        if (!isJsonObject(body)) return;
        // The answer depends on the header from here on, whatever language it named.
        ctx.vary(LANGUAGE_HEADER);
        const lang = requestLanguage(ctx);
        if (!lang || lang === 'en') return;
        const { refusals, templates } = builtFor(lang);
        let said: Record<string, unknown> | null = null;
        for (const field of ['error', 'message'] as const) {
            const text = body[field];
            if (typeof text !== 'string') continue;
            const translated = translatedRefusal(text, refusals, templates);
            // A copy: the body may be an object a route shares between answers.
            if (translated !== text) said = { ...(said ?? body), [field]: translated };
        }
        if (said) ctx.body = said;
    };
}

/**
 * Tests only: `catalogs` stand in for `lang`'s files (either one; the other is still read), or null to read the files
 * again. The catalogs are drafted after merge, so a suite brings its own sentence to see one translated.
 */
export function useCatalogsForTests(lang: Lang, catalogs: Partial<Catalogs> | null): void {
    if (catalogs) forTests.set(lang, catalogs);
    else forTests.delete(lang);
    held.delete(lang);
    built.delete(lang);
}

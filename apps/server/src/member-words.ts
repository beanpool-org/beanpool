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
 *   - **Pushes**: the lock screen's sentence for the push's kind, in the language the phone registered with
 *     ({@link wordsIn}, state-engine.ts dispatchPushNotification).
 *
 * Never marked: a sentence an app matches on (`includes('already a member')`, `/set a profile photo/i`) or one that
 * starts with a code the apps read (`FLOOR_LOCKED: …`, `UNAUTHORIZED: …`). Translated, the app's branch would stop
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
import { LANGUAGE_HEADER, normaliseLang, wordsFor, type Catalog, type Lang, type WordKey, type Words } from '@beanpool/core';
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
const built = new Map<Lang, { all: Words; refusals: Words }>();

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

function builtFor(lang: Lang): { all: Words; refusals: Words } {
    let words = built.get(lang);
    if (!words) {
        const { server, core } = catalogsOf(lang);
        words = {
            all: wordsFor(lang, present([core, server])),
            // A refusal is translated with the server's catalog alone, so only a sentence the server or the engine marked
            // is ever translated, never one that happens to match a sentence of core's the apps write.
            refusals: wordsFor(lang, present([server])),
        };
        built.set(lang, words);
    }
    return words;
}

/** The server's words and core's in `lang`; English for no language. */
export function wordsIn(lang: Lang | null | undefined): Words {
    if (!lang || lang === 'en') return ENGLISH;
    return builtFor(lang).all;
}

/** The words a refusal is translated with (builtFor). */
function refusalWordsIn(lang: Lang): Words {
    return builtFor(lang).refusals;
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
        const { t } = refusalWordsIn(lang);
        let said: Record<string, unknown> | null = null;
        for (const field of ['error', 'message'] as const) {
            const text = body[field];
            if (typeof text !== 'string') continue;
            // Looked up as it came: words:check saw the sentence where it was marked, word('…').
            const translated = t(text as WordKey);
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

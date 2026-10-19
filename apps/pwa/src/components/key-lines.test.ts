/**
 * key-lines.ts against the lib files whose English it translates (words S3, web sweep W4). Every whole sentence it knows
 * is one those files write, word for word; every sentence they build with a sign-in's name, a member's name, a status
 * or a wait is read back, and in the pseudo-locale nothing of it is left outside a bracket but the names and the
 * community's own words. English is exactly what the lib file wrote. So a sentence changed in a lib file fails here,
 * rather than quietly showing English.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { setLanguage } from '@beanpool/core';
import { KEY_FIXED_LINES, keyLineWords, twoSentences } from './key-lines';
import { outsideBrackets } from '../words-xx.test-support';
import {
    doorOutcome, doorRefusalMessage, matchAuthReturn, refusalMessage, tryAgainIn, withRetryAfter, wordsWorkRefusal,
    PRIVATE_PREVIEW_MESSAGE, WRONG_CLOCK, type DoorAnswer,
} from '../lib/web-join';
import { NO_STORAGE_SENTENCE, STORE_WOULD_NOT_OPEN_SENTENCE, type JoinProvider } from '../lib/identity';
import { aboutTime, busySentence, signInBusySentence, WORK_CANT_RUN } from '../lib/door-work';
import { releaseRefusalMessage, sessionRefusalMessage } from '../lib/web-restore';
import { leaveForLink, linkRefusalMessage, linkResultMessage } from '../lib/link-signin';

/** The lib files key-lines.ts reads (its header names them). */
const LIB_FILES = ['web-join.ts', 'identity.ts', 'door-work.ts', 'words-work.ts', 'web-restore.ts', 'link-signin.ts'];
const PROVIDERS: JoinProvider[] = ['google', 'apple', 'facebook'];
const NAMES = ['Google', 'Apple', 'Facebook', 'Alice', 'Maria José', 'Bob. Use your 12 words'];

/** Every string literal a lib file writes, and the sentence a template literal starts with ("Too many tries just now. ${…}"). */
function literals(file: string): string[] {
    const text = readFileSync(join(__dirname, '../lib', file), 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const out: string[] = [];
    const visit = (n: ts.Node) => {
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
        if (ts.isTemplateExpression(n)) out.push(n.head.text.trim());
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
}

const answer = (status: number, body: Record<string, unknown> = {}, retryAfterSeconds: number | null = null): DoorAnswer => ({ status, body, retryAfterSeconds });

/** What the lib files say, through their own builders, for every case key-lines.ts reads back. */
function libSentences(): string[] {
    const out: string[] = [];
    for (const p of [...PROVIDERS, null]) {
        for (const r of ['no_pending', 'foreign_state', 'wrong_provider', 'no_state', 'no_id_token', 'not_a_token', 'nonce_mismatch', 'no_subject'] as const) {
            out.push(refusalMessage(r, p));
        }
        for (const a of [
            answer(401), answer(409, { code: 'already_joined' }), answer(400, { code: 'work_required' }), answer(403, { code: 'sign_in_required' }),
            answer(403, { code: 'private_preview' }), answer(429), answer(429, {}, 30), answer(429, {}, 600), answer(429, {}, 4 * 3600), answer(429, {}, 3600),
            answer(503), answer(404), answer(418),
        ]) {
            const o = doorOutcome(a, p);
            if ('message' in o) out.push(o.message);
        }
    }
    for (const p of PROVIDERS) {
        const ret = { provider: p, state: 'n', idToken: null, error: 'server_error', errorDescription: 'Something broke at the provider' };
        const o = matchAuthReturn(ret as never, { provider: p, nonce: 'n' });
        if (o.kind === 'provider_error') out.push(o.message);
        for (const a of [answer(400), answer(401), answer(429), answer(503), answer(404), answer(500), answer(401, { code: 'x' })]) {
            out.push(releaseRefusalMessage(a, p, 'Alice'));
        }
        for (const code of ['already_joined', 'removed', 'sign_in']) out.push(linkRefusalMessage(answer(400, { code }), p));
        out.push(linkResultMessage({ kind: 'linked', provider: p, recoveryStored: true }));
        out.push(linkResultMessage({ kind: 'linked', provider: p, recoveryStored: false }));
        const left = leaveForLink({ publicKey: 'k' } as never, p, { nonce: 'n', expiresInSeconds: 600, providers: [p], clientIds: {} }, { navigate: () => {} });
        if (!left.ok) out.push(left.message);
    }
    out.push(linkResultMessage({ kind: 'cancelled', provider: 'google' }));
    for (const a of [answer(400), answer(409), answer(429), answer(500), answer(401)]) out.push(sessionRefusalMessage(a, 'Alice'));
    for (const a of [answer(404), answer(429), answer(429, {}, 120), answer(500)]) {
        out.push(doorRefusalMessage(a));
        out.push(linkRefusalMessage(a, null));
    }
    for (const a of [answer(401), answer(403, { code: 'sign_in_required' }), answer(403, { code: 'private_preview' }), answer(429), answer(429, {}, 90), answer(404), answer(500)]) {
        out.push(wordsWorkRefusal(a).message);
    }
    for (const s of [null, 1, 7, 15, 44, 60, 61, 240]) {
        out.push(busySentence(s));
        out.push(signInBusySentence(s));
    }
    for (const m of [60, 300, 5400, 7200, 3 * 3600]) out.push(tryAgainIn(m));
    out.push(NO_STORAGE_SENTENCE, STORE_WOULD_NOT_OPEN_SENTENCE, WORK_CANT_RUN, WRONG_CLOCK, PRIVATE_PREVIEW_MESSAGE);
    return [...new Set(out)];
}

afterEach(() => setLanguage('en'));

describe('key-lines.ts', () => {
    it('every whole sentence it knows is one a key-path lib file writes, word for word (a literal, or a builder\'s for one case)', () => {
        const written = new Set([...LIB_FILES.flatMap(literals), ...libSentences()]);
        const missing = KEY_FIXED_LINES.filter((line) => !written.has(line));
        expect(missing).toEqual([]);
        expect(KEY_FIXED_LINES.length).toBeGreaterThan(20);
    });

    it('in English, every lib sentence reads exactly as the lib file wrote it', () => {
        const all = libSentences();
        expect(all.length).toBeGreaterThan(60);
        for (const s of all) expect(keyLineWords(s)).toBe(s);
    });

    it('in the pseudo-locale, every lib sentence these screens show is translated: only names are left as written', () => {
        setLanguage('xx');
        const left = libSentences().filter((s) => outsideBrackets(keyLineWords(s), NAMES));
        expect(left).toEqual([]);
    });

    it('a community\'s own words are shown as they came; a wait after them is translated', () => {
        setLanguage('xx');
        expect(keyLineWords('Nope, not today.')).toBe('Nope, not today.');
        const said = withRetryAfter('Our own sentence.', 300);
        expect(said).toBe('Our own sentence. Try again in 5 minutes.');
        const shown = keyLineWords(said);
        expect(shown.startsWith('[')).toBe(true);
        expect(shown).toContain('Our own sentence.');
        expect(outsideBrackets(shown, ['Our own sentence.'])).toBe(false);
    });

    it('the provider\'s own words stay as they came inside the translated sentence', () => {
        setLanguage('xx');
        const shown = keyLineWords("Google couldn't sign you in: Something broke at the provider");
        expect(shown).toContain('Something broke at the provider');
        expect(outsideBrackets(shown, ['Google', 'Something broke at the provider'])).toBe(false);
    });

    it('the 12 words, codes and keys are never read back: a sentence it does not know comes back as it was', () => {
        setLanguage('xx');
        const words = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
        expect(keyLineWords(words)).toBe(words);
        expect(keyLineWords('RK-7KQ2M9XH')).toBe('RK-7KQ2M9XH');
    });

    it('two sentences, one after the other, read as they always did in English', () => {
        expect(twoSentences('One.', 'Two.')).toBe('One. Two.');
        expect(aboutTime(15)).toBe('about 15 seconds');
    });
});

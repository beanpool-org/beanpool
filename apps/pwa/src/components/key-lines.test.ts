/**
 * key-lines.ts against the lib files whose English it translates (words S3, web sweep W4). Every whole sentence it knows
 * is one those files write, word for word; every sentence they build with a sign-in's name, a member's name, a status
 * or a wait is read back, and in the pseudo-locale nothing of it is left outside a bracket but the names and the
 * community's own words. English is exactly what the lib file wrote. So a sentence changed in a lib file fails here,
 * rather than quietly showing English.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { setLanguage } from '@beanpool/core';
import { KEY_FIXED_LINES, keyLineWords, ownerWordsCheckedWords, ownerWordsCountWords, signInNamesWords, twoSentences } from './key-lines';
import { signInNames } from '../lib/join-recovery';
import { outsideBrackets } from '../words-xx.test-support';
import {
    doorOutcome, doorRefusalMessage, matchAuthReturn, refusalMessage, tryAgainIn, withRetryAfter, wordsWorkRefusal,
    PRIVATE_PREVIEW_MESSAGE, WRONG_CLOCK, type DoorAnswer,
} from '../lib/web-join';
import { NO_STORAGE_SENTENCE, STORE_WOULD_NOT_OPEN_SENTENCE, type JoinProvider } from '../lib/identity';
import { aboutTime, busySentence, signInBusySentence, WORK_CANT_RUN } from '../lib/door-work';
import { releaseRefusalMessage, sessionRefusalMessage } from '../lib/web-restore';
import { leaveForLink, linkRefusalMessage, linkResultMessage } from '../lib/link-signin';
import { WEB_REKEY_TEXT } from '../lib/web-rekey';
import { approveUnlock, lookupUnlock, pasteProblemMessage, unlockRefusalMessage } from '../lib/takeover-unlock';
import { OWNER_WORDS_COPY } from '../lib/owner-words';
import { KIT_WEB_FAILED_LINE, KIT_WEB_LABEL, KIT_WEB_WARNING } from '../lib/recovery-kit';

/** The lib files key-lines.ts reads (its header names them). */
const LIB_FILES = [
    'web-join.ts', 'identity.ts', 'door-work.ts', 'words-work.ts', 'web-restore.ts', 'link-signin.ts', 'web-rekey.ts', 'takeover-unlock.ts',
    'owner-words.ts', 'recovery-kit.ts',
];
const HOST = 'standby.example.org';
const UNLOCK_REFUSALS = ['not-a-recipient', 'wrong-community', 'wrong-signer', 'wrong-envelope', 'bad-signature', 'wrong-kind', 'expired', 'used', 'closed', 'unknown-session', 'malformed'] as const;
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
    out.push(NO_STORAGE_SENTENCE, STORE_WOULD_NOT_OPEN_SENTENCE, WORK_CANT_RUN, WRONG_CLOCK, PRIVATE_PREVIEW_MESSAGE, ...Object.values(WEB_REKEY_TEXT));
    out.push(pasteProblemMessage('malformed'), pasteProblemMessage('not-unlock'));
    for (const v of Object.values(OWNER_WORDS_COPY) as unknown[]) if (typeof v === 'string') out.push(v);
    out.push(KIT_WEB_LABEL, KIT_WEB_WARNING, KIT_WEB_FAILED_LINE);
    for (const r of UNLOCK_REFUSALS) out.push(unlockRefusalMessage(r as never, HOST));
    return [...new Set(out)];
}

/** lib/takeover-unlock.ts's sentences for a server that answers with no words of its own, or not at all. */
async function unlockAnswers(): Promise<string[]> {
    const qr = { serverUrl: `https://${HOST}`, sessionId: 's1', purpose: 'takeover' } as never;
    const out: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    const look = await lookupUnlock(qr, { publicKey: 'k', privateKey: 'p' }, null);
    if ('message' in look) out.push(look.message);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error(''); }));
    const gone = await lookupUnlock(qr, { publicKey: 'k', privateKey: 'p' }, null);
    if ('message' in gone) out.push(gone.message);
    const refused = await approveUnlock(qr, { header: {} } as never, { publicKey: 'k', privateKey: 'not a key' });
    if ('message' in refused) out.push(refused.message);
    vi.unstubAllGlobals();
    return out;
}

afterEach(() => { setLanguage('en'); vi.unstubAllGlobals(); });

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

    it('a server that answers with no words of its own, or not at all, or a key that did not open: read back by its address', async () => {
        const said = await unlockAnswers();
        expect(said).toEqual([`${HOST} did not answer (500).`, `Could not reach ${HOST}.`, "This browser's key did not open its part of the lock. Try another owner, or the recovery code."]);
        for (const s of said) expect(keyLineWords(s)).toBe(s);
        setLanguage('xx');
        expect(said.filter((s) => outsideBrackets(keyLineWords(s), [HOST]))).toEqual([]);
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

    it("an owner's 12 words: the date and the count are said again as lib/owner-words.ts says them, in English", () => {
        const at = Date.UTC(2026, 9, 3, 12);
        expect(ownerWordsCheckedWords(at)).toMatch(/^12 words checked 3 Oct 2026$/);
        expect(OWNER_WORDS_COPY.checked(at)).toMatch(/^12 words checked /);
        for (const n of [0, 1, 2, 11, 13]) expect(ownerWordsCountWords(n)).toBe(OWNER_WORDS_COPY.count(n));
        setLanguage('xx');
        expect(outsideBrackets(ownerWordsCheckedWords(at))).toBe(false);
        expect(outsideBrackets(ownerWordsCountWords(3))).toBe(false);
    });

    it('a list of sign-ins: "Google", "Google and Apple", "Google, Apple and Facebook", the joining words translated', () => {
        for (const providers of [['google'], ['google', 'apple'], ['google', 'apple', 'facebook']]) {
            const english = signInNames(providers)!;
            expect(signInNamesWords(english)).toBe(english);
            setLanguage('xx');
            expect(outsideBrackets(signInNamesWords(english), NAMES)).toBe(false);
            setLanguage('en');
        }
    });

    it('two sentences, one after the other, read as they always did in English', () => {
        expect(twoSentences('One.', 'Two.')).toBe('One. Two.');
        expect(aboutTime(15)).toBe('about 15 seconds');
    });
});

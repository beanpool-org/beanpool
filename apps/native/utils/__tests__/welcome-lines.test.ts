/**
 * components/welcome/welcome-lines.ts translates, where welcome (and the panels it shares with Settings) shows them, the
 * sentences its lower layers write in English (those layers handle keys, signatures, the 12 words or the key vault, and
 * never reach the words layer). Each sentence it knows is held here to what it stands for: the real constants and
 * builders where a module exports them, and otherwise the literal its source writes (read with the TypeScript parser,
 * pieces joined by `+` read whole), so a sentence changed there fails this test instead of quietly showing English.
 * Every one is found (the pseudo-locale brackets it), and in English each reads exactly as its source writes it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { randomBytes } from 'node:crypto';

(globalThis as any).__DEV__ = false;

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
    DeviceEventEmitter: { addListener: () => ({ remove() {} }), emit() {} },
    NativeModules: {},
}));
vi.mock('expo-linking', () => ({ addEventListener: () => ({ remove() {} }), openURL: async () => undefined }));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: async () => ({ type: 'cancel' }), openBrowserAsync: async () => ({}), dismissAuthSession() {}, dismissBrowser: async () => undefined }));
vi.mock('expo-apple-authentication', () => ({ isAvailableAsync: async () => false, signInAsync: async () => ({}), AppleAuthenticationScope: { EMAIL: 0, FULL_NAME: 1 } }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (len: number) => new Uint8Array(randomBytes(len)), digest: async () => new ArrayBuffer(32) }));
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => true, getStringAsync: async () => '' }));
vi.mock('expo-local-authentication', () => ({
    SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
    hasHardwareAsync: async () => false, isEnrolledAsync: async () => false, getEnrolledLevelAsync: async () => 0,
    authenticateAsync: async () => ({ success: false }),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {}, getAllKeys: async () => [], multiRemove: async () => {} },
}));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: async () => { throw new Error('no database here'); } }));
vi.mock('expo-file-system/legacy', () => ({ cacheDirectory: '/tmp/cache/', documentDirectory: '/tmp/docs/' }));

import { setLanguage } from '@beanpool/core';
import { DOOR_MESSAGES, PRIVATE_PREVIEW_MESSAGE, WORK_MESSAGES, doorMessage, nameCheckMessage, readDoorAnswer, tryAgainIn, type DoorAnswer, type NameCheck } from '../global-join';
import { GLOBAL_DOOR_MESSAGES } from '../node-profile';
import { DOOR_WORK_MESSAGES, busyLevelSentence } from '../door-work';
import { linkedNotice } from '../join-link';
import { NO_WORDS_WAY_BACK, SSO_WORDS_NOTE, noWordsBeforeWipe, signInReplacedNote } from '../no-words-copy';
import { NO_SCREEN_LOCK_LINE } from '../words-on-screen';
import { COPY_CLEARS_LINE } from '../words-clipboard';
import { KIT_FAILED_LINE, KIT_PRINT_LABEL, KIT_SAVE_LABEL, KIT_SAVE_WARNING } from '../recovery-kit';
import { COMMUNITY_RESTORE_NOT_OFFERED, RELEASED_COPY_NOT_OPENED } from '../sso-recovery';
import { VAULT_MESSAGES } from '../vault';
import { REDEEM_NO_ANSWER } from '../db';
import { KEEPER_LABELS } from '../protection-state';
import { SSO_PROVIDER_NAMES, type SsoProvider } from '../sso-providers';
import type { KeeperEnrolmentResult } from '../keeper-enrolment';
import {
    WELCOME_FIXED_LINES, doorAnswerWords, linkedNoticeWords, nameCheckWords, noWordsBeforeWipeWords, signInReplacedWords, tryAgainWords,
    welcomeLineWords,
} from '../../components/welcome/welcome-lines';

afterEach(() => setLanguage('en'));

const ROOT = path.resolve(__dirname, '../..');
/** The lower layers whose sentences welcome shows. */
const SOURCES = [
    'utils/node-profile.ts', 'utils/global-join.ts', 'utils/door-key.ts', 'utils/door-work.ts', 'utils/sso-recovery.ts', 'utils/sso-signin.ts',
    'utils/sso-sheet-connect.ts', 'utils/keeper-enrolment.ts', 'utils/no-words-copy.ts', 'utils/words-on-screen.ts',
    'utils/words-clipboard.ts', 'utils/recovery-kit.ts', 'utils/protection-state.ts', 'utils/vault.ts', 'utils/db.ts',
];

/** Every string a source writes: literals, pieces joined with `+` read whole, and templates with `{x}` for each `${…}`. */
function literalsOf(rel: string): Set<string> {
    const sf = ts.createSourceFile(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const out = new Set<string>();
    const text = (n: ts.Node): string | null => {
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
        if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((s) => `{x}${s.literal.text}`).join('');
        if (ts.isParenthesizedExpression(n)) return text(n.expression);
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
            const a = text(n.left);
            const b = text(n.right);
            return a !== null && b !== null ? a + b : null;
        }
        return null;
    };
    const visit = (n: ts.Node) => {
        const s = text(n);
        if (s !== null) out.add(s);
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
}
const WRITTEN = new Set(SOURCES.flatMap((rel) => [...literalsOf(rel)]));

const inXx = (fn: () => string) => { setLanguage('xx'); try { return fn(); } finally { setLanguage('en'); } };
/** Letters left once every bracket, and the names given, are taken out. */
function outsideBrackets(text: string, names: readonly string[] = []): string {
    let rest = text;
    for (let was = ''; was !== rest;) { was = rest; rest = rest.replace(/\[[^[\]]*\]/g, ''); }
    for (const n of [...names].sort((a, b) => b.length - a.length)) rest = rest.split(n).join('');
    return rest.replace(/[^\p{L}]+/gu, ' ').trim();
}
/** Read in English exactly as written, and wholly the pseudo-locale's but for the names it carries. */
function heldTo(english: string, words: () => string, names: readonly string[] = []) {
    expect(words(), english).toBe(english);
    const xx = inXx(words);
    expect(xx, english).not.toBe(english);
    expect(outsideBrackets(xx, names), `${english} → ${xx}`).toBe('');
}

describe('the lower layers\' whole sentences', () => {
    it('each one the table knows is a sentence its source writes, word for word', () => {
        expect(WELCOME_FIXED_LINES.length).toBeGreaterThan(60);
        for (const english of WELCOME_FIXED_LINES) expect(WRITTEN.has(english), `"${english}" is not written in ${SOURCES.join(', ')}`).toBe(true);
    });

    it('every constant welcome and its panels show is in it: in English as written, and translated', () => {
        const constants = [
            ...Object.values(GLOBAL_DOOR_MESSAGES), ...Object.values(DOOR_MESSAGES), PRIVATE_PREVIEW_MESSAGE, ...Object.values(WORK_MESSAGES),
            DOOR_WORK_MESSAGES.solverUnavailable, RELEASED_COPY_NOT_OPENED, COMMUNITY_RESTORE_NOT_OFFERED,
            NO_WORDS_WAY_BACK, SSO_WORDS_NOTE, NO_SCREEN_LOCK_LINE, COPY_CLEARS_LINE,
            KIT_PRINT_LABEL, KIT_SAVE_LABEL, KIT_SAVE_WARNING, KIT_FAILED_LINE, ...Object.values(KEEPER_LABELS),
        ];
        for (const english of constants) {
            expect(WELCOME_FIXED_LINES, english).toContain(english);
            heldTo(english, () => welcomeLineWords(english));
        }
    });

    it('the phone-made refusals of the restore, the door and the sign-ins are in it', () => {
        for (const english of [
            "That sign-in did not say who you are, so it can't be used. Try again.",
            'This phone holds a different BeanPool account, so the join was not sent.',
            'Connecting to node recovery session...', 'Account restored successfully!', 'Node returned an empty sign-in nonce.',
            "Google's sign-in page could not open on this phone. Try again.", "The phone's lock was not passed, so no sign-in was linked.",
            'No node configured yet.', 'The sign-in could not be linked.',
            // utils/vault.ts subjectOf: Recover with a sign-in whose token names no account (PR #2206 review).
            "That sign-in didn't say which account it was, so it can't be used. Try again.",
        ]) heldTo(english, () => welcomeLineWords(english));
    });

    it("the invite join's redeem that failed on the phone's side: no answer in time, a node that is down, no word it took the join", () => {
        // utils/db.ts redeemInvite, on the join wizard's Next (PR #2206 review): the node's own `error` stays as it came.
        for (const english of [
            REDEEM_NO_ANSWER,
            'Relay Node Offline: The selected community node is currently unreachable.',
            'The community node did not confirm the invite. Please try again.',
        ]) {
            expect(WELCOME_FIXED_LINES, english).toContain(english);
            heldTo(english, () => welcomeLineWords(english));
        }
        expect(inXx(() => welcomeLineWords('Invite code expired'))).toBe('Invite code expired');
    });

    it("anything else goes on to Settings' table (the key vault's words), and otherwise shows exactly as it came", () => {
        heldTo(VAULT_MESSAGES.paused, () => welcomeLineWords(VAULT_MESSAGES.paused));
        // A community's own words: as it sent them, in every language.
        expect(inXx(() => welcomeLineWords('Mullum is closed for the holidays.'))).toBe('Mullum is closed for the holidays.');
    });
});

describe('the sentences with a name, a number or a time in them', () => {
    it("the door's 429s, as readDoorAnswer writes them from the node's answer, for each door, window and wait", () => {
        let seen = 0;
        for (const body of [
            { code: 'network_busy', door: 'words', window: 'day' }, { code: 'network_busy_words', window: 'hour' },
            { code: 'network_busy', door: 'sign-in', window: 'day' }, { code: 'network_busy', door: 'sign-in' }, {},
        ]) {
            for (const wait of [null, 30, 60, 300, 3599, 3600, 7200]) {
                const answer = readDoorAnswer(429, body, wait);
                if (answer.kind !== 'rate_limited') throw new Error('not a 429');
                const english = doorMessage(answer);
                heldTo(english, () => doorAnswerWords(answer));
                seen += 1;
            }
        }
        expect(seen).toBe(35);
    });

    it('a 429 the node gave its own words, with Retry-After: the phone adds when, in the language', () => {
        const answer: Extract<DoorAnswer, { kind: 'rate_limited' }> = { kind: 'rate_limited', message: DOOR_MESSAGES.rateLimited, retryAfterSeconds: 120 };
        heldTo(doorMessage(answer), () => doorAnswerWords(answer));
        const theirs: Extract<DoorAnswer, { kind: 'rate_limited' }> = { kind: 'rate_limited', message: 'Slow down there.', retryAfterSeconds: 120 };
        expect(doorAnswerWords(theirs)).toBe(doorMessage(theirs));
        expect(inXx(() => doorAnswerWords(theirs))).toContain('Slow down there.');
    });

    it('tryAgainWords says what tryAgainIn says', () => {
        for (const s of [1, 59, 60, 61, 119, 300, 3540, 3599, 3600, 5400, 7200, 86_400]) heldTo(tryAgainIn(s), () => tryAgainWords(s));
    });

    it("the door's name step, for each check", () => {
        const checks: NameCheck[] = [
            { kind: 'timed_out' },
            { kind: 'taken', suggestions: ['Ana2', 'Ana_3'], suggestionsTimedOut: false },
            { kind: 'taken', suggestions: [], suggestionsTimedOut: false },
            { kind: 'taken', suggestions: [], suggestionsTimedOut: true },
        ];
        for (const check of checks) heldTo(nameCheckMessage('Ana', check), () => nameCheckWords('Ana', check), ['Ana']);
        expect(nameCheckWords('Ana', { kind: 'free' })).toBe(nameCheckMessage('Ana', { kind: 'free' }));
    });

    it("the door's busy line, with this phone's own estimate", () => {
        const now = 1_000_000;
        for (const estimateMs of [800, 1500, 9000, 23_000, 54_000, 56_000, 90_000, 240_000]) {
            const english = busyLevelSentence({ level: 3, estimateMs, startedAt: now, phase: 'solving' }, now);
            expect(english).toBeTruthy();
            heldTo(english!, () => welcomeLineWords(english!));
        }
    });

    it('a sign-in added at Safety Backup, for each provider, with and without a copy', () => {
        for (const provider of Object.keys(SSO_PROVIDER_NAMES) as SsoProvider[]) {
            for (const enrolment of [null, { enrolled: [], generation: 1, skipped: [], available: 1 } as KeeperEnrolmentResult]) {
                const answer = { kind: 'linked' as const, provider, enrolment };
                heldTo(linkedNotice(answer), () => linkedNoticeWords(answer), [SSO_PROVIDER_NAMES[provider]]);
            }
            // Where the deposit said the copy was kept (VR2), and a door whose community keeps none.
            for (const keptAt of ['vault', 'community'] as const) {
                const answer = { kind: 'linked' as const, provider, enrolment: { enrolled: [], generation: null, skipped: [], available: 1, keptAt } as KeeperEnrolmentResult };
                heldTo(linkedNotice(answer), () => linkedNoticeWords(answer), [SSO_PROVIDER_NAMES[provider]]);
            }
            const none = { kind: 'linked' as const, provider, enrolment: null, noCopies: true as const };
            heldTo(linkedNotice(none), () => linkedNoticeWords(none), [SSO_PROVIDER_NAMES[provider]]);
        }
    });

    it('a sign-in that protected another account, and a phone with no 12 words, by name or not', () => {
        heldTo(signInReplacedNote('Google'), () => signInReplacedWords('Google'), ['Google']);
        heldTo(noWordsBeforeWipe('Sally'), () => noWordsBeforeWipeWords('Sally'), ['Sally']);
        heldTo(noWordsBeforeWipe(), () => noWordsBeforeWipeWords());
    });

    it("the restore's and the sign-ins' sentences with a status, a provider or the node's words after them", () => {
        const cases: Array<[template: string, english: string, names: string[]]> = [
            ['Signing in with {x}...', 'Signing in with Google...', ['Google']],
            ['Failed to fetch fragments ({x})', 'Failed to fetch fragments (500)', []],
            ['Could not open recovery session ({x})', 'Could not open recovery session (503)', []],
            ['Could not obtain sign-in challenge ({x})', 'Could not obtain sign-in challenge (429)', []],
            ['Sign-in verification failed ({x})', 'Sign-in verification failed (401)', []],
            ['Hub release failed ({x})', 'Hub release failed (404)', []],
            ['Could not reach your node: {x}', 'Could not reach your node: Network request failed', ['Network request failed']],
            ['Your node would not start a sign-in ({x}): {x}', 'Your node would not start a sign-in (500): oops', ['oops']],
            ['Apple could not sign you in: {x}', 'Apple could not sign you in: The operation couldn’t be completed.', ['The operation couldn’t be completed.']],
            ['Google could not sign you in: {x}', 'Google could not sign you in: DEVELOPER_ERROR', ['DEVELOPER_ERROR']],
            ['Your node does not accept {x} sign-in.', 'Your node does not accept facebook sign-in.', ['facebook']],
            ['Provider {x} is not supported on this device.', 'Provider facebook is not supported on this device.', ['facebook']],
            // utils/sso-signin.ts: the provider's page gave no answer in time (the provider's key, as the file writes it).
            ['{x} sign-in timed out.', 'google sign-in timed out.', ['google']],
            ['{x} sign-in timed out.', 'facebook sign-in timed out.', ['facebook']],
            ['The global community does not accept {x} sign-in.', 'The global community does not accept apple sign-in.', ['apple']],
            ["Your account couldn't be locked to this sign-in ({x}). Nothing was linked.", "Your account couldn't be locked to this sign-in (no key). Nothing was linked.", ['no key']],
            // utils/db.ts redeemInvite: the node down, and a refusal without its own words (any text it sent instead after it).
            ['Relay Node Offline: The selected community node is currently unreachable (HTTP {x}).', 'Relay Node Offline: The selected community node is currently unreachable (HTTP 503).', []],
            ['Failed to redeem invite (HTTP {x})', 'Failed to redeem invite (HTTP 500)', []],
            [': [Text] {x}', 'Failed to redeem invite (HTTP 404): [Text] Not Found', ['Not Found']],
        ];
        for (const [template, english, names] of cases) {
            expect(WRITTEN.has(template), `"${template}" is not written in ${SOURCES.join(', ')}`).toBe(true);
            heldTo(english, () => welcomeLineWords(english), names);
        }
    });
});

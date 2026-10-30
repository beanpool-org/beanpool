/**
 * components/key-lines.ts translates, where the key, sign-in and recovery screens show them, the sentences their lower
 * layers write in English (those layers handle keys, signatures, the 12 words or a backup, and never reach the words
 * layer). Each sentence it knows is held here to the constant or builder it stands for, from the real modules, so a
 * sentence changed there fails this test instead of quietly showing English: in English each reads exactly as its
 * source writes it, and the pseudo-locale brackets it. A sentence with a name in it is read back only when it can be
 * read one way; the sentences built again from the same values read word for word as their sources in English.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('react-native', () => ({ Platform: { OS: 'android' }, AppState: { addEventListener: () => ({ remove() {} }) } }));
vi.mock('expo-local-authentication', () => ({
    SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
    hasHardwareAsync: async () => false, isEnrolledAsync: async () => false, getEnrolledLevelAsync: async () => 0,
    authenticateAsync: async () => ({ success: false }),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {}, getAllKeys: async () => [], multiRemove: async () => {} },
}));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (len: number) => new Uint8Array(randomBytes(len)) };
});
vi.mock('../db', () => ({ clearDB: async () => {}, closeDB: async () => {}, initDB: async () => {} }));
vi.mock('../community-cache', () => ({ removeCommunityCaches: async () => {} }));
vi.mock('../../services/pillar-sync', () => ({ resetSyncFingerprints: () => {} }));

import { NAMES_LIMITS, normaliseNamesEntryText, pseudoLocalise, setLanguage } from '@beanpool/core';
import {
    LOCKED_HISTORY_WORDS, NEW_PHONE_BAD_CODE, NEW_PHONE_CONFIRM_ACTION, NEW_PHONE_SHOW_BODY, NEW_PHONE_SHOW_TITLE, OLD_WORDS_DONE,
    OLD_WORDS_NOTHING_LISTED, OLD_WORDS_NOT_THE_KEY, OLD_WORDS_OWNER, confirmedByText, newPhoneConfirmText, newPhoneEnd, newPhoneKeyWasOtherText,
    newPhoneMismatchText, newPhoneNoMemoryText, newPhoneNotListedText, newPhoneProgressText, oldWordsEnd, oldWordsProgressText, oldWordsWithheldText,
    type OldWordsResult,
} from '../group-history-unlock';
import { OWNER_WORDS_COPY, ownerWordsFindThem } from '../owner-words';
import { NO_DEVICE_LOCK_MESSAGE } from '../node-admin';
import { openedFromLinkWarning, scanProblemMessage as unlockScanProblem, unlockRefusalMessage } from '../takeover-unlock';
import {
    AGENT_QUESTION, AGENT_WARNING, DIGITS_PRIVATE, SIGNIN_QUESTION, SIGNIN_WARNING, agentLines, computerLines, confirmDigitsLine, digitsDone,
    formatTimeLeft, scanProblemMessage as signinScanProblem, type PairingLookup,
} from '../settings-signin';
import { REKEY_TEXT } from '../rekey-redeem';
import { claimOutcomeMessage, type ClaimOutcome } from '../node-claim';
import { NO_OTHER_COMMUNITY_LINE, SIGN_OUT_FROM_SETTINGS_LINE, stillKeptLine, type KeptCommunity } from '../delete-here';
import { NAMES_COPY, UNREACHABLE, firstSentence } from '../names-list';
import { DEBT_COPY, DEBT_UNREACHABLE, SETTLE_UNANSWERED } from '../names-debts';
import { HEALTH_COPY } from '../community-health';
import {
    agentLinesWords, claimOutcomeWords, computerLinesWords, confirmDigitsWords, confirmedByWords, digitsDoneWords, keyLineWords, knownKeyLines,
    newPhoneConfirmWords, newPhoneEndWords, newPhoneProgressWords, oldWordsEndWords, oldWordsProgressWords, openedFromLinkWords,
    ownerWordsCountWords, stillKeptWords, timeLeftWords,
} from '../../components/key-lines';

afterEach(() => setLanguage('en'));

const ROOT = path.resolve(__dirname, '../..');
/** A source file's code with its quoted pieces joined ('a ' + 'b' → 'a b') and its escaped quotes read as quotes. */
const joined = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/(['"`])\s*\+\s*(['"`])/g, '').replace(/\\'/g, "'").replace(/\\"/g, '"');
const inXx = <T,>(fn: () => T): T => { setLanguage('xx'); try { return fn(); } finally { setLanguage('en'); } };
/** Letters left once every bracket, and the names given, are taken out. */
function outsideBrackets(text: string, names: readonly string[] = []): string {
    let rest = text;
    for (let was = ''; was !== rest;) { was = rest; rest = rest.replace(/\[[^[\]]*\]/g, ''); }
    for (const n of [...names].sort((a, b) => b.length - a.length)) rest = rest.split(n).join('');
    return rest.replace(/[^\p{L}]+/gu, ' ').trim();
}
/** The sentence `english`, with `{x}` for what its source fills in, is written in `file` (as `${…}` there). */
function writtenIn(file: string, english: string): boolean {
    const pattern = english.split(/\{[A-Za-z0-9_]+\}/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\$\\{[^}]+\\}');
    return new RegExp(pattern).test(joined(file));
}

const HOST = 'standby.riverbend.example';
const GROUP_A = 'Riverbend Garden';
const GROUP_B = 'Tool Library';

/** The names list's refusals names-list.ts writes inline (not exported): the test below holds each to that file. */
const NAMES_LIST_INLINE = [
    'This phone couldn’t keep the names list’s keys. Nothing was sent. Try again.',
    'This phone couldn’t read the names list’s keys just now. Nothing was changed. Try again.',
    'There is no new key to make here.', 'There is no key history to follow here.',
];
/** Why core's names-list-crypto.ts won't seal a name and note (names-list.ts sealedFor passes it on as a bad_text refusal). */
const entryRefusal = (raw: { name?: string; note?: string }) => { const r = normaliseNamesEntryText(raw); return r.ok ? '' : r.error; };

/** Every sentence key-lines.ts knows whole, from the files that write it. */
const WHOLE: string[] = [
    LOCKED_HISTORY_WORDS, OLD_WORDS_NOT_THE_KEY, OLD_WORDS_OWNER, OLD_WORDS_DONE, OLD_WORDS_NOTHING_LISTED, NEW_PHONE_SHOW_TITLE, NEW_PHONE_SHOW_BODY,
    NEW_PHONE_CONFIRM_ACTION, NEW_PHONE_BAD_CODE, newPhoneNotListedText('this member'),
    OWNER_WORDS_COPY.title, OWNER_WORDS_COPY.why, OWNER_WORDS_COPY.stays, OWNER_WORDS_COPY.match, OWNER_WORDS_COPY.matchSaved, OWNER_WORDS_COPY.matchNotSaved,
    OWNER_WORDS_COPY.mismatch, ownerWordsFindThem(true), ownerWordsFindThem(false), OWNER_WORDS_COPY.saveOffer, OWNER_WORDS_COPY.saveButton,
    OWNER_WORDS_COPY.saving, OWNER_WORDS_COPY.saved, OWNER_WORDS_COPY.saveFailed,
    NO_DEVICE_LOCK_MESSAGE,
    ...(['not-unlock', 'malformed'] as const).flatMap((kind) => Object.values(unlockScanProblem({ kind }))),
    unlockScanProblem({ kind: 'cleartext', host: HOST }).title,
    ...(['wrong-community', 'wrong-kind', 'expired', 'used', 'closed', 'unknown-session', 'malformed', 'wrong-session'] as const).map((r) => unlockRefusalMessage(r, HOST)),
    "This phone's key did not open its part of the lock. Try another owner, or the recovery code.",
    'Too many attempts. Wait a minute and try again.',
    ...(['not-signin', 'malformed', 'no-node'] as const).flatMap((kind) => Object.values(signinScanProblem({ kind }))),
    signinScanProblem({ kind: 'wrong-node', scannedHost: HOST, appHost: 'mullum.example' }).title,
    "The code on the computer doesn't match this QR. Get a new code on the computer and scan again.",
    'Could not reach the node.', 'The node refused the sign-in.',
    SIGNIN_QUESTION, SIGNIN_WARNING, AGENT_QUESTION, AGENT_WARNING, DIGITS_PRIVATE,
    ...Object.values(REKEY_TEXT),
    'That isn’t a whole code. It starts RK- or BB- and has eight letters and numbers.',
    'That isn’t a community address the app can use.',
    'That is not a community address the app can use.', 'Could not reach the server.', "That address doesn't answer like a BeanPool server.",
    ...(['wrong-code', 'code-changed', 'no-code', 'wrong-server', 'check-again'] as const).map((kind) => claimOutcomeMessage({ kind }, 'Riverbend')),
    claimOutcomeMessage({ kind: 'braked', retryAfter: null }, 'Riverbend'),
    "The claim didn't reach the server. Try again.", 'The claim could not be made.',
    NO_OTHER_COMMUNITY_LINE, SIGN_OUT_FROM_SETTINGS_LINE,
    NAMES_COPY.copyUnreachable, NAMES_COPY.copyBad, NAMES_COPY.copyTooBig, NAMES_COPY.copyNotSaved, NAMES_COPY.copyNewer, NAMES_COPY.startAfresh,
    firstSentence(NAMES_COPY.who).first, NAMES_COPY.who, NAMES_COPY.whoMore, NAMES_COPY.whoLess, NAMES_COPY.compareListKey, NAMES_COPY.refusedDifferent,
    NAMES_COPY.refusedDifferentNone, NAMES_COPY.wait([]), NAMES_COPY.otherCommunity, NAMES_COPY.missingRecord, NAMES_COPY.waitNewKey([]),
    NAMES_COPY.tooMany, NAMES_COPY.notReady, NAMES_COPY.reloading, NAMES_COPY.openAgainButton, NAMES_COPY.notShownToMembers,
    NAMES_COPY.checkEachOtherTitle, NAMES_COPY.checkSomeone, NAMES_COPY.putBackButton, NAMES_COPY.putBackTitle, NAMES_COPY.startAgainButton,
    NAMES_COPY.startAgainTitle, NAMES_COPY.makeNewButton, NAMES_COPY.makeNewTitle, NAMES_COPY.followButton, NAMES_COPY.followTitle, NAMES_COPY.followNone,
    NAMES_COPY.follow, NAMES_COPY.myKeyTitle, NAMES_COPY.myKey, NAMES_COPY.showMyKey, NAMES_COPY.hideMyKey, NAMES_COPY.scanButton, NAMES_COPY.stopScan,
    NAMES_COPY.cameraNeeded, NAMES_COPY.codeLabel, NAMES_COPY.compareButton, NAMES_COPY.unreadable, NAMES_COPY.noMatch, NAMES_COPY.self,
    NAMES_COPY.checkNotKept, NAMES_COPY.exportTitle, NAMES_COPY.export, NAMES_COPY.deleteConfirmed, NAMES_COPY.removedConfirmTitle,
    NAMES_COPY.twoAdminsLabel, NAMES_COPY.twoAdminsHelp, UNREACHABLE, ...NAMES_LIST_INLINE, entryRefusal({ name: '' }),
    DEBT_COPY.workOffTitle, DEBT_COPY.workOffButton, DEBT_COPY.settleTitle, DEBT_COPY.settleButton, DEBT_COPY.forgiveTitle, DEBT_COPY.forgiveButton,
    DEBT_COPY.sameNameTitle, DEBT_COPY.sameNameAdd, DEBT_UNREACHABLE, SETTLE_UNANSWERED,
    HEALTH_COPY.totalsHeading, HEALTH_COPY.totalsHint, HEALTH_COPY.totalsMissing, HEALTH_COPY.totalsNotOnThisNode,
];

describe('key-lines.ts: the whole sentences it knows', () => {
    it('in English each is shown exactly as its file writes it; in the pseudo-locale each is translated', () => {
        for (const line of WHOLE) expect(keyLineWords(line), line).toBe(line);
        const translated = inXx(() => WHOLE.map((line) => keyLineWords(line)));
        expect(WHOLE.filter((line, i) => outsideBrackets(translated[i]) !== '')).toEqual([]);
    });

    it('every sentence it knows whole is one of those, or one of the source files writes it (sentences a function says)', () => {
        const sources = ['utils/takeover-unlock.ts', 'utils/settings-signin.ts', 'utils/rekey-redeem.ts', 'utils/node-claim.ts', 'utils/community-copy.ts'];
        const unknown = knownKeyLines().filter((line) => !WHOLE.includes(line) && !sources.some((file) => writtenIn(file, line)));
        expect(unknown).toEqual([]);
        // The ones read from the sources above are still written there.
        for (const line of WHOLE.filter((l) => !knownKeyLines().includes(l))) expect(keyLineWords(line), line).toBe(line);
        // The names list's inline refusals are still written in names-list.ts.
        for (const line of NAMES_LIST_INLINE) expect(writtenIn('utils/names-list.ts', line), line).toBe(true);
    });

    it('a line it doesn\'t know, a node\'s own, is shown as it came, in any language', () => {
        expect(inXx(() => keyLineWords('Riverbend is closed for the winter.'))).toBe('Riverbend is closed for the winter.');
    });
});

describe('key-lines.ts: sentences with a name, an address or a number, read back', () => {
    const filled: Array<{ line: string; names: string[] }> = [
        { line: oldWordsWithheldText(GROUP_A), names: [GROUP_A] },
        { line: newPhoneNotListedText('Wren'), names: ['Wren'] },
        { line: newPhoneMismatchText('Wren'), names: ['Wren'] },
        { line: newPhoneNoMemoryText('Wren'), names: ['Wren'] },
        { line: newPhoneKeyWasOtherText('Wren', 'Ash'), names: ['Wren', 'Ash'] },
        { line: unlockScanProblem({ kind: 'cleartext', host: HOST }).message, names: [HOST] },
        ...(['not-a-recipient', 'wrong-signer', 'wrong-envelope', 'bad-signature'] as const).map((r) => ({ line: unlockRefusalMessage(r, HOST), names: [HOST] })),
        { line: `${HOST} did not answer (502).`, names: [HOST] },
        { line: `Could not reach ${HOST}.`, names: [HOST] },
        { line: signinScanProblem({ kind: 'wrong-node', scannedHost: HOST, appHost: 'mullum.example' }).message, names: [HOST, 'mullum.example'] },
        { line: 'The node did not answer (503).', names: [] },
        { line: "You are not an owner, admin or moderator of Riverbend, so you can't open its Settings.", names: ['Riverbend'] },
        { line: 'Your re-key at mullum.example went through, but this phone holds another account now, and a phone holds only one. Forget that re-key to go on: your account at mullum.example then needs a new code from an admin there.', names: ['mullum.example'] },
        { line: 'This phone showed a number for a re-key at mullum.example, and mullum.example isn’t answering. Try again later, or forget that re-key.', names: ['mullum.example'] },
        { line: 'The re-key you started at mullum.example with RK-AB12-CD34 is still open: an admin there can still type the number this phone showed. To go on with it, type that code. To end it, ask the admin there to press Not theirs. Otherwise this phone lets it go by itself within the hour.', names: ['mullum.example', 'RK-AB12-CD34'] },
        { line: 'The re-key you started at mullum.example with RK-AB12-CD34 is still open: an admin there can still type the number this phone showed. To go on with it, type that code. To end it, ask the admin there to press Not theirs. Otherwise this phone lets it go by itself in about 7 hours.', names: ['mullum.example', 'RK-AB12-CD34'] },
        { line: claimOutcomeMessage({ kind: 'already-claimed' }, 'Riverbend'), names: ['Riverbend'] },
        { line: 'The server did not answer (500).', names: [] },
        { line: 'The server refused the claim (409).', names: [] },
        { line: NAMES_COPY.checkButton('Wren'), names: ['@Wren'] },
        { line: NAMES_COPY.removeKeyButton('Wren'), names: ['@Wren'] },
        { line: NAMES_COPY.removeKeyTitle('Wren'), names: ['@Wren'] },
        { line: NAMES_COPY.removeKey('Wren'), names: ['@Wren'] },
        { line: NAMES_COPY.sendAgainButton('Wren'), names: ['@Wren'] },
        { line: NAMES_COPY.toCheck('Wren'), names: ['@Wren'] },
        { line: NAMES_COPY.checkIntro('Wren'), names: ['@Wren'] },
        { line: NAMES_COPY.codeMismatch('Wren'), names: ['@Wren'] },
        { line: NAMES_COPY.mismatch('Wren'), names: ['@Wren'] },
        { line: NAMES_COPY.matched('Wren'), names: ['@Wren'] },

        { line: NAMES_COPY.refusedRolledBack(2, 5), names: [] },
        { line: entryRefusal({ name: 'x'.repeat(NAMES_LIMITS.nameChars + 1) }), names: [] },
        { line: entryRefusal({ name: 'Wren', note: 'x'.repeat(NAMES_LIMITS.noteChars + 1) }), names: [] },
    ];

    it('the sources still write each one so (the ones a function writes inline, in its source)', () => {
        expect(writtenIn('utils/takeover-unlock.ts', '{host} did not answer ({status}).')).toBe(true);
        expect(writtenIn('utils/takeover-unlock.ts', 'Could not reach {host}.')).toBe(true);
        expect(writtenIn('utils/settings-signin.ts', 'The node did not answer ({status}).')).toBe(true);
        expect(writtenIn('utils/settings-signin.ts', "You are not an owner, admin or moderator of {name}, so you can't open its Settings.")).toBe(true);
        expect(writtenIn('utils/rekey-redeem.ts', 'Your re-key at {where} went through, but this phone holds another account now, and a phone holds only one. Forget that re-key to go on: your account at {where} then needs a new code from an admin there.')).toBe(true);
        expect(writtenIn('utils/rekey-redeem.ts', 'This phone showed a number for a re-key at {where}, and {where} isn’t answering. Try again later, or forget that re-key.')).toBe(true);
        expect(writtenIn('utils/rekey-redeem.ts', 'The re-key you started at {where} with {code} is still open: an admin there can still type the number this phone showed. To go on with it, type that code. To end it, ask the admin there to press Not theirs. Otherwise this phone lets it go by itself {when}.')).toBe(true);
        expect(writtenIn('utils/rekey-redeem.ts', "return hours <= 1 ? 'within the hour' : `in about {hours} hours`;")).toBe(true);
        expect(writtenIn('utils/node-claim.ts', 'The server did not answer ({status}).')).toBe(true);
        expect(writtenIn('utils/node-claim.ts', 'The server refused the claim ({status}).')).toBe(true);
        // The phone's lock prompt the claim screen passes says what node-admin.ts says when it is given none.
        expect(writtenIn('utils/node-admin.ts', "promptMessage: promptMessage ?? `Confirm it's you to manage {name}`")).toBe(true);
        // A name and a note over core's limits (names-list-crypto.ts, a key-path file): the limit is the sentence's number.
        expect(writtenIn('../../packages/beanpool-core/src/names-list-crypto.ts', 'Keep the name to {n} characters.')).toBe(true);
        expect(writtenIn('../../packages/beanpool-core/src/names-list-crypto.ts', 'Keep the note to {n} characters.')).toBe(true);
        // A new phone whose code carries no callsign is "this member" (NO_NAME): its not-listed line is a FIXED sentence.
        expect(writtenIn('utils/group-history-unlock.ts', "const shownName = name ?? (code.callsign || 'this member');")).toBe(true);
    });

    it('in English each reads as written; in the pseudo-locale each is translated, with its names as they are', () => {
        for (const { line } of filled) expect(keyLineWords(line), line).toBe(line);
        for (const { line, names } of filled) {
            const said = inXx(() => keyLineWords(line));
            expect(outsideBrackets(said, names), line).toBe('');
            for (const n of names) expect(said, line).toContain(n);
        }
        // A count is given to the language as a number.
        expect(inXx(() => keyLineWords(NAMES_COPY.refusedRolledBack(2, 5)))).toMatch(/2.*5/s);
        expect(inXx(() => keyLineWords(entryRefusal({ name: 'x'.repeat(NAMES_LIMITS.nameChars + 1) })))).toContain(String(NAMES_LIMITS.nameChars));
        expect(inXx(() => keyLineWords(entryRefusal({ name: 'Wren', note: 'x'.repeat(NAMES_LIMITS.noteChars + 1) })))).toContain(String(NAMES_LIMITS.noteChars));
    });

    it('a name the lower layer had to fill with English ("an admin"), and one that could be read two ways, are shown as they came', () => {
        expect(inXx(() => keyLineWords(NAMES_COPY.removeKeyButton('')))).toBe(NAMES_COPY.removeKeyButton(''));
        expect(inXx(() => keyLineWords(NAMES_COPY.matched('')))).toBe(NAMES_COPY.matched(''));
        // "this member" is group-history-unlock.ts's name for a code with no callsign: never read back as a name, and its
        // not-listed line is said whole, with no English left inside it.
        expect(inXx(() => keyLineWords(newPhoneMismatchText('this member')))).toBe(newPhoneMismatchText('this member'));
        expect(inXx(() => keyLineWords(newPhoneNotListedText('this member')))).toBe(pseudoLocalise(newPhoneNotListedText('this member')));
        // "Check an admin’s code" with nobody named is the button's own sentence (checkSomeone), so it is translated.
        expect(NAMES_COPY.checkButton('')).toBe(NAMES_COPY.checkSomeone);
        // "Ash, not Wren" could be either name: the sentence is shown as written, never with the names swapped.
        const twoWays = newPhoneKeyWasOtherText('Bo', 'Ash, not Wren');
        expect(inXx(() => keyLineWords(twoWays))).toBe(twoWays);
    });
});

describe('key-lines.ts: sentences built again from the same values read word for word as their sources', () => {
    it('the old 12 words: progress and every ending', () => {
        for (const [d, n] of [[0, 1], [1, 1], [1, 3], [3, 3]]) expect(oldWordsProgressWords(d, n)).toBe(oldWordsProgressText(d, n));
        const shapes: OldWordsResult[] = [
            { outcome: 'not_the_key', unlocked: {}, withheld: [], refused: 0 },
            { outcome: 'owner', unlocked: {}, withheld: [], refused: 0 },
            { outcome: 'done', unlocked: { g1: 2 }, withheld: [{ id: 'g2', name: GROUP_B }], refused: 0 },
            { outcome: 'done', unlocked: { g1: 1 }, withheld: [], refused: 0 },
            { outcome: 'done', unlocked: {}, withheld: [{ id: 'g1', name: GROUP_A }, { id: 'g2', name: GROUP_B }], refused: 1 },
            { outcome: 'done', unlocked: {}, withheld: [], refused: 0 },
        ];
        for (const r of shapes) expect(oldWordsEndWords(r)).toEqual(oldWordsEnd(r));
        for (const r of shapes) {
            const said = inXx(() => oldWordsEndWords(r));
            expect(outsideBrackets([said.text, ...said.lines].join(' '), [GROUP_A, GROUP_B])).toBe('');
        }
    });

    it('a new phone: what confirming does, the progress, every ending, and who confirmed it', () => {
        for (const groups of [[GROUP_A], [GROUP_A, GROUP_B], [GROUP_A, GROUP_B, 'Seed Swap']]) {
            expect(newPhoneConfirmWords('Wren', groups)).toBe(newPhoneConfirmText('Wren', groups));
            expect(outsideBrackets(inXx(() => newPhoneConfirmWords('Wren', groups)), ['Wren', ...groups])).toBe('');
        }
        expect(newPhoneProgressWords(2, 5)).toBe(newPhoneProgressText(2, 5));
        const ends = [
            { total: 2, planned: 5, stopped: true }, { total: 2, planned: 5, stopped: false }, { total: 2, already: 1, planned: 3, stopped: false },
            { total: 0, listedHeld: 1, planned: 0, stopped: false }, { total: 0, listedHeld: 3, planned: 0, stopped: false },
            { total: 0, planned: 0, stopped: false }, { total: 4, planned: 4, stopped: false },
        ];
        for (const r of ends) {
            expect(newPhoneEndWords('Wren', r)).toEqual(newPhoneEnd('Wren', r));
            expect(outsideBrackets(inXx(() => newPhoneEndWords('Wren', r)).text, ['Wren'])).toBe('');
        }
        const october = new Date(2026, 9, 3, 10, 30).getTime();
        expect(confirmedByWords('Wren', october)).toBe(confirmedByText('Wren', october));
    });

    it('an owner\'s words: a count that isn\'t twelve', () => {
        for (const n of [0, 1, 2, 11, 13]) expect(ownerWordsCountWords(n)).toBe(OWNER_WORDS_COPY.count(n));
    });

    it('a take-over or restore opened from a link', () => {
        for (const purpose of ['takeover', 'restore'] as const) {
            expect(openedFromLinkWords(purpose, HOST)).toBe(openedFromLinkWarning(purpose, HOST));
            expect(outsideBrackets(inXx(() => openedFromLinkWords(purpose, HOST)), [HOST])).toBe('');
        }
    });

    it('a computer signing in: its lines, the time left, the digits and the held Done', () => {
        const look = (over: Partial<Extract<PairingLookup, { kind: 'ok' }>>): Extract<PairingLookup, { kind: 'ok' }> => ({
            kind: 'ok', browser: 'Firefox on Linux', expiresAt: 0, expiresInSeconds: 90, askedSecondsAgo: 12, fromAddress: '203.0.113.7', sameNetwork: false, agent: null, ...over,
        });
        const looks = [look({}), look({ askedSecondsAgo: 0, sameNetwork: true }), look({ askedSecondsAgo: 1 }), look({ askedSecondsAgo: 125, fromAddress: null }),
            look({ browser: 'A browser', askedSecondsAgo: null })];
        for (const l of looks) for (const open of [0, 7, 59]) expect(computerLinesWords(l, open)).toEqual(computerLines(l, open));
        for (const s of [0, 1, 59.2, 95, 600]) expect(timeLeftWords(s)).toBe(formatTimeLeft(s));
        expect(confirmDigitsWords('42')).toBe(confirmDigitsLine('42'));
        for (const ms of [0, -5, 1, 9_000, 30_000]) expect(digitsDoneWords(ms)).toBe(digitsDone(ms).label);
        for (const a of [{ name: 'Claude', sendsTo: 'api.example.com' }, { name: '', sendsTo: 'api.example.com' }]) expect(agentLinesWords(a)).toEqual(agentLines(a));
        const xx = inXx(() => [...computerLinesWords(look({}), 3), ...agentLinesWords({ name: 'Claude', sendsTo: 'api.example.com' }), timeLeftWords(95), confirmDigitsWords('42'), digitsDoneWords(9_000)]);
        expect(xx.filter((line) => outsideBrackets(line, ['Firefox on Linux', 'Claude', 'api.example.com']) !== '')).toEqual([]);
    });

    it('a claim: every outcome', () => {
        const outcomes: ClaimOutcome[] = [
            { kind: 'wrong-code' }, { kind: 'code-changed' }, { kind: 'already-claimed' }, { kind: 'no-code' }, { kind: 'wrong-server' },
            { kind: 'braked', retryAfter: null }, { kind: 'braked', retryAfter: 1 }, { kind: 'braked', retryAfter: 30 }, { kind: 'check-again' },
            { kind: 'error', message: "The claim didn't reach the server. Try again." }, { kind: 'error', message: 'Riverbend is busy.' },
            { kind: 'owner', callsign: null },
        ];
        for (const o of outcomes) expect(claimOutcomeWords(o, 'Riverbend'), o.kind).toBe(claimOutcomeMessage(o, 'Riverbend'));
        for (const o of outcomes.filter((x) => x.kind !== 'owner' && !(x.kind === 'error' && x.message === 'Riverbend is busy.'))) {
            expect(outsideBrackets(inXx(() => claimOutcomeWords(o, 'Riverbend')), ['Riverbend']), o.kind).toBe('');
        }
    });

    it('the delete from the not-recognised screen: why this phone keeps the key', () => {
        const c = (name: string, membership: KeptCommunity['membership']): KeptCommunity => ({ url: `https://${name.toLowerCase()}.example`, name, membership });
        const shapes: KeptCommunity[][] = [
            [c('Mullum', 'member')], [c('Mullum', 'member'), c('Castlemaine', 'member')], [c('Mullum', 'unreachable')],
            [c('Mullum', 'member'), c('Castlemaine', 'unreachable'), c('Bega', 'unreachable')],
        ];
        for (const keeps of shapes) {
            expect(stillKeptWords(keeps)).toBe(stillKeptLine(keeps));
            expect(outsideBrackets(inXx(() => stillKeptWords(keeps)), ['Mullum', 'Castlemaine', 'Bega'])).toBe('');
        }
    });
});

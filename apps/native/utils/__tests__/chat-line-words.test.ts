/**
 * utils/chat-line-words.ts translates, by its exact English, what the phone's key and encryption code writes (that code
 * never reaches the words layer). Each sentence is written there again, so here each one is held to the source it
 * stands for: a sentence changed in db.ts, dm-crypto.ts or the group chat's key and line code fails this test, rather
 * than quietly showing English in every other language. A member's own words are never touched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } }));
vi.mock('../node-post', () => ({ signedGet: async () => ({}), signedPost: async () => ({}), anchorUrl: async () => null }));

import {
    pseudoLocalise, setLanguage, DM_LINE_DELETED_TEXT, DM_LINE_NOT_ENCRYPTED_TEXT, DM_LINE_NOT_VERIFIED_TEXT, dmLineMarkText, dmQuoteLabel,
} from '@beanpool/core';
import { chatLineWords } from '../chat-line-words';
import { earlierKeyDetails } from '../group-line-display';
import { lockedHistoryRowText } from '../group-history-unlock';
import { KEY_CHANGED_DETAILS, markKeyChanged } from '../name-key-memory';

const UTILS = path.resolve(__dirname, '..');
const source = (file: string) => fs.readFileSync(path.join(UTILS, file), 'utf8');

/** Every `export const NAME = '…'` (or "…") sentence of a file. */
function exportedSentences(file: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of source(file).matchAll(/^export const (\w+)\s*=\s*(['"])((?:\\.|(?!\2).)*)\2;/gm)) out[m[1]] = m[3].replace(/\\(['"\\])/g, '$1');
    return out;
}

afterEach(() => setLanguage('en'));

/** In the pseudo-locale a known sentence comes back bracketed (through t()); an unknown one exactly as given. */
function known(text: string): boolean {
    setLanguage('xx');
    try {
        const shown = chatLineWords(text);
        return shown !== text && /^\[.*\]$/su.test(shown);
    } finally {
        setLanguage('en');
    }
}

describe('every sentence the key and line code writes is in the table', () => {
    const groups: Array<[string, string[]]> = [
        ['group-chat-lines.ts', ['GROUP_CHAT_OLD_NODE_NOTICE', 'GROUP_CHAT_LOCKED_NOTICE', 'GROUP_CHAT_LOCK_LOST_TEXT', 'GROUP_CHAT_NOT_MEMBER_TEXT', 'GROUP_KEYS_FOR_DM_TEXT', 'GROUP_EDIT_NO_KEY_TEXT', 'GROUP_EDIT_LINE_GONE_TEXT', 'GROUP_LINE_UNSEALED_DETAILS']],
        ['group-line-display.ts', ['GROUP_LINE_UNVERIFIED_NAME', 'GROUP_LINE_UNVERIFIED_TEXT', 'GROUP_LINE_UNVERIFIED_DETAILS', 'GROUP_LINE_FORMER_MEMBER', 'GROUP_LINE_NOT_IN_GROUP', 'GROUP_LINE_WAITING_KEY_TEXT']],
        ['group-chat-keys.ts', ['GROUP_KEY_ROLLBACK_TEXT', 'GROUP_KEY_WAITING_TEXT', 'GROUP_KEY_MISSING_TEXT', 'GROUP_KEYS_UNOPENABLE_TEXT', 'GROUP_KEY_ROSTER_TEXT', 'GROUP_KEY_ROSTER_UNREAD_TEXT', 'GROUP_KEY_STORE_UNREAD_TEXT']],
        ['group-history-unlock.ts', ['LOCKED_HISTORY_SHEET_TITLE', 'LOCKED_HISTORY_SHEET_BODY', 'LOCKED_OWN_LINE_TEXT', 'LOCKED_HISTORY_WORDS', 'LOCKED_HISTORY_ASK', 'LOCKED_HISTORY_KEEP', 'NEW_PHONE_CONFIRM_MENU']],
        ['name-key-memory.ts', ['KEY_CHANGED_HINT', 'KEY_CHANGED_DETAILS']],
    ];
    for (const [file, names] of groups) {
        it(`${file}: ${names.length} sentences`, () => {
            const sentences = exportedSentences(file);
            for (const name of names) {
                expect(sentences[name], `${file} ${name}`).toBeTruthy();
                expect(known(sentences[name]), `${file} ${name}: ${sentences[name]}`).toBe(true);
            }
        });
    }

    it('core dm-crypto.ts: the stand-ins for a DM line, the marks under one, and who a quote is from', () => {
        for (const s of [DM_LINE_NOT_VERIFIED_TEXT, DM_LINE_NOT_ENCRYPTED_TEXT, DM_LINE_DELETED_TEXT]) expect(known(s), s).toBe(true);
        for (const mark of ['old-app', 'out-of-order', 'moved', 'from-admins'] as const) expect(known(dmLineMarkText(mark)!), mark).toBe(true);
        for (const from of ['admins', 'notice', 'nobody'] as const) expect(known(dmQuoteLabel(from)), from).toBe(true);
    });

    it('utils/db.ts: a preview with no words to show, a line it can\'t open, and a trade\'s lines (read from its source)', () => {
        const db = source('db.ts');
        for (const s of ['[Message]', 'Started conversation', '🔒 Encrypted message', '[Unreadable message]', '[Encrypted — update your app to read]']) {
            expect(db, s).toContain(`'${s}'`);
            expect(known(s), s).toBe(true);
        }
        // formatSystemMessage writes `${beansStr} …` with beansStr "<amount> Beans" or "Beans".
        expect(db).toContain('`${beansStr} held in trust.`');
        expect(db).toContain('`Payment of ${beansStr} released to you.`');
        expect(db).toContain('`Payment of ${beansStr} released to the provider.`');
        expect(db).toContain('`Trust hold cancelled and funds refunded.`');
        for (const s of ['5 Beans held in trust.', 'Beans held in trust.', 'Payment of 12.5 Beans released to you.', 'Payment of Beans released to the provider.', 'Trust hold cancelled and funds refunded.']) {
            expect(known(s), s).toBe(true);
        }
        expect(db).toContain("`From your community's admins: ${lastView.text}`");
        expect(db).toContain("`${dmQuoteLabel('notice')}: ${displayMsg}`");
    });

    it('the sentences with a number, a name or a date in them, from the functions that write them', () => {
        for (const n of [1, 3]) expect(known(lockedHistoryRowText(n)), lockedHistoryRowText(n)).toBe(true);
        expect(known(earlierKeyDetails('Ana', '2026-10-03T00:00:00Z'))).toBe(true);
        expect(known(earlierKeyDetails('Ana', 'not a date'))).toBe(true);
        expect(known('The node answered 503.')).toBe(true);
    });
});

describe('what it gives back', () => {
    it('in English, every sentence exactly as written', () => {
        for (const s of ['5 Beans held in trust.', DM_LINE_NOT_VERIFIED_TEXT, lockedHistoryRowText(3), earlierKeyDetails('Ana', '2026-10-03T00:00:00Z'), 'Notice: 🔒 Encrypted message', KEY_CHANGED_DETAILS, `${earlierKeyDetails('Ana', '2026-10-03T00:00:00Z')} ${KEY_CHANGED_DETAILS}`]) {
            expect(chatLineWords(s)).toBe(s);
        }
    });

    it('in another language, the parts of a sentence it fills in keep what they hold', () => {
        setLanguage('xx');
        expect(chatLineWords('Payment of 12.5 Beans released to you.')).toBe(pseudoLocalise('Payment of {n} Beans released to you.').replace('{n}', '12.5'));
        expect(chatLineWords(earlierKeyDetails('Ana', '2026-10-03T00:00:00Z'))).toContain('Ana');
        // A notice holding a stand-in: both in the member's language.
        expect(chatLineWords('Notice: 🔒 Encrypted message')).toBe(pseudoLocalise('Notice: {text}').replace('{text}', pseudoLocalise('🔒 Encrypted message')));
        // A label over words this table doesn't know (a member's, the admins', the node's): the whole line exactly as given,
        // never a translated label over someone's words.
        expect(chatLineWords("From your community's admins: bring a chair")).toBe("From your community's admins: bring a chair");
        expect(chatLineWords('Notice: bring gloves')).toBe('Notice: bring gloves');
        // A label over a known line: both in the member's language.
        expect(chatLineWords('Notice: 5 Beans held in trust.')).toBe(pseudoLocalise('Notice: {text}').replace('{text}', pseudoLocalise('{n} Beans held in trust.').replace('{n}', '5')));
    });

    it('a changed key\'s details after the note a line already had: two sentences, the details never inside the first one\'s date', () => {
        setLanguage('xx');
        const earlier = earlierKeyDetails('Ana', '2026-10-03T00:00:00Z');
        const [alone, after] = markKeyChanged([
            { senderId: 'k', authorName: 'Ana', integrityNote: null },
            { senderId: 'k', authorName: 'Ana', integrityNote: earlier },
        ], new Set(['k']));
        expect(alone.integrityNote).toBe(KEY_CHANGED_DETAILS);
        expect(after.integrityNote).toBe(`${earlier} ${KEY_CHANGED_DETAILS}`);
        expect(chatLineWords(alone.integrityNote)).toBe(pseudoLocalise(KEY_CHANGED_DETAILS));
        expect(chatLineWords(after.integrityNote)).toBe(pseudoLocalise('{note} {details}').replace('{note}', chatLineWords(earlier)).replace('{details}', pseudoLocalise(KEY_CHANGED_DETAILS)));
        expect(chatLineWords(after.integrityNote)).not.toContain('This phone knew');
        // After words this table doesn't know (a member's), the whole line exactly as given.
        expect(chatLineWords(`see you then ${KEY_CHANGED_DETAILS}`)).toBe(`see you then ${KEY_CHANGED_DETAILS}`);
    });

    it('a member\'s own words, and anything it doesn\'t know, exactly as given', () => {
        setLanguage('xx');
        for (const s of ['see you at the hall', 'Beans held in trust', '5 Beans held in trust. Thanks!', '', 'Unverified?']) expect(chatLineWords(s)).toBe(s);
        expect(chatLineWords(null)).toBeNull();
        expect(chatLineWords(undefined)).toBeUndefined();
    });
});

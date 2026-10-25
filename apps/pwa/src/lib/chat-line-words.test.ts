/**
 * lib/chat-line-words.ts translates, where Talk shows them, the sentences the web's group chat and DM code writes in
 * English. Each sentence it knows is held here to the constant or builder it stands for, from the real modules, so a
 * sentence changed there fails this test instead of quietly showing English: in English each reads exactly as its
 * source writes it, in the pseudo-locale it is bracketed, and in Portuguese it is the catalog's. The node's own words,
 * and anything the table doesn't know, are shown as they came.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DM_LINE_DELETED_TEXT, DM_LINE_NOT_ENCRYPTED_TEXT, DM_LINE_NOT_VERIFIED_TEXT, dmLineMarkText, dmQuoteLabel, pseudoLocalise, setLanguage } from '@beanpool/core';
import { chatAuthorWords, chatLineWords, knownChatLines } from './chat-line-words';
import {
    GROUP_CHAT_NOT_MEMBER_TEXT, GROUP_KEYS_UNOPENABLE_TEXT, GROUP_KEY_MISSING_TEXT, GROUP_KEY_ROLLBACK_TEXT, GROUP_KEY_ROSTER_TEXT,
    GROUP_KEY_ROSTER_UNREAD_TEXT, GROUP_KEY_STORE_UNREAD_TEXT, GROUP_KEY_WAITING_TEXT,
} from './group-chat-keys';
import {
    GROUP_CHAT_LOCKED_NOTICE, GROUP_CHAT_LOCK_LOST_TEXT, GROUP_CHAT_OLD_NODE_NOTICE, GROUP_CHAT_UNREAD_TEXT,
    GROUP_EDIT_NO_KEY_TEXT, GROUP_LINE_DELETED_TEXT, GROUP_LINE_REMOVED_TEXT, GROUP_LINE_UNSEALED_DETAILS, GROUP_REPORT_NO_KEY_TEXT,
} from './group-chat-lines';
import {
    GROUP_LINE_FORMER_MEMBER, GROUP_LINE_NOT_IN_GROUP, GROUP_LINE_UNVERIFIED_DETAILS, GROUP_LINE_UNVERIFIED_NAME, GROUP_LINE_UNVERIFIED_TEXT,
    GROUP_LINE_WAITING_KEY_TEXT, earlierKeyDetails,
} from './group-line-display';
import { GROUP_CHAT_IS_DM_TEXT, GROUP_HOLD_EVENT_TEXT, GROUP_HOLD_STARTED_DM_TEXT, GROUP_HOLD_UNREAD_OPEN_TEXT, GROUP_HOLD_UNREAD_TEXT } from './group-hold';
import { DmNotLockedError, dmNotLockedLine } from './dm-lock';
import { MAX_CHAT_IMAGE_LABEL, NODE_READABLE_NO_PHOTOS_TEXT, chatImageRefusal } from './chat-image-transfer';

afterEach(() => setLanguage('en'));

/** Every whole sentence the table stands for, from the module that writes it. */
const WHOLE = [
    GROUP_KEY_ROLLBACK_TEXT, GROUP_KEY_WAITING_TEXT, GROUP_KEY_MISSING_TEXT, GROUP_KEYS_UNOPENABLE_TEXT, GROUP_KEY_ROSTER_TEXT,
    GROUP_KEY_ROSTER_UNREAD_TEXT, GROUP_KEY_STORE_UNREAD_TEXT, GROUP_CHAT_NOT_MEMBER_TEXT,
    GROUP_CHAT_OLD_NODE_NOTICE, GROUP_CHAT_LOCKED_NOTICE, GROUP_CHAT_LOCK_LOST_TEXT, GROUP_CHAT_UNREAD_TEXT,
    GROUP_LINE_UNSEALED_DETAILS, GROUP_EDIT_NO_KEY_TEXT, GROUP_REPORT_NO_KEY_TEXT, GROUP_LINE_DELETED_TEXT, GROUP_LINE_REMOVED_TEXT,
    GROUP_LINE_UNVERIFIED_NAME, GROUP_LINE_UNVERIFIED_TEXT, GROUP_LINE_UNVERIFIED_DETAILS, GROUP_LINE_FORMER_MEMBER, GROUP_LINE_NOT_IN_GROUP,
    GROUP_LINE_WAITING_KEY_TEXT,
    GROUP_HOLD_UNREAD_TEXT, GROUP_HOLD_UNREAD_OPEN_TEXT, GROUP_HOLD_EVENT_TEXT, GROUP_HOLD_STARTED_DM_TEXT, GROUP_CHAT_IS_DM_TEXT,
    DM_LINE_NOT_VERIFIED_TEXT, DM_LINE_NOT_ENCRYPTED_TEXT, DM_LINE_DELETED_TEXT,
    dmLineMarkText('old-app')!, dmLineMarkText('out-of-order')!, dmLineMarkText('moved')!, dmLineMarkText('from-admins')!,
    dmQuoteLabel('admins'), dmQuoteLabel('notice'), dmQuoteLabel('nobody'),
    chatImageRefusal({ type: 'text/plain', size: 10 } as File)!, NODE_READABLE_NO_PHOTOS_TEXT,
];
/** Written inline where it is thrown (group-chat-lines.ts editSealedGroupLine: the node refused with no words). */
const INLINE = ['Failed to edit message.'];
WHOLE.push(...INLINE);
const outsideBrackets = (s: string, names: readonly string[] = []) => {
    let rest = s;
    for (const n of names) rest = rest.split(n).join('');
    for (let was = ''; was !== rest;) { was = rest; rest = rest.replace(/\[[^[\]]*\]/g, ''); }
    return /\p{L}/u.test(rest);
};

describe('the web\'s chat lines: the whole sentences', () => {
    it('in English each is shown exactly as its module writes it; in the pseudo-locale each is translated', () => {
        for (const line of WHOLE) expect(chatLineWords(line), line).toBe(line);
        setLanguage('xx');
        expect(WHOLE.filter((line) => outsideBrackets(chatLineWords(line)))).toEqual([]);
    });

    it('every sentence the table knows is one of those (none is left that no module writes)', () => {
        expect(knownChatLines().filter((line) => !WHOLE.includes(line))).toEqual([]);
        for (const line of INLINE) expect(fs.readFileSync(path.resolve(__dirname, 'group-chat-lines.ts'), 'utf8')).toContain(`'${line}'`);
    });

    it('in Portuguese where the catalog has one; anything else, the node\'s own words, as they came', () => {
        setLanguage('pt', [{ [GROUP_CHAT_LOCKED_NOTICE]: 'Cifrado de ponta a ponta: só os membros deste grupo o podem ler.' }]);
        expect(chatLineWords(GROUP_CHAT_LOCKED_NOTICE)).toBe('Cifrado de ponta a ponta: só os membros deste grupo o podem ler.');
        // Not in the catalog yet: the English, never a blank.
        expect(chatLineWords(GROUP_CHAT_LOCK_LOST_TEXT)).toBe(GROUP_CHAT_LOCK_LOST_TEXT);
        expect(chatLineWords('Riverbend Garden is closed for the winter.')).toBe('Riverbend Garden is closed for the winter.');
        expect(chatLineWords(null)).toBeNull();
    });
});

describe('the web\'s chat lines with a name, a date or a number in them', () => {
    it('read back from what the builders write, the name, date and number kept as written', () => {
        const replaced = earlierKeyDetails('Ana', '2026-10-03T00:00:00.000Z');
        const named = dmNotLockedLine('Kofi');
        const nobody = dmNotLockedLine(null);
        const tooBig = chatImageRefusal({ type: 'image/png', size: 100 * 1024 * 1024 } as File)!;
        for (const line of [replaced, named, nobody, tooBig, 'The node answered 503.']) expect(chatLineWords(line), line).toBe(line);
        expect(new DmNotLockedError().message).toBe("This message couldn't be locked yet.");
        setLanguage('xx');
        expect(outsideBrackets(chatLineWords(replaced), ['Ana', '3 Oct 2026'])).toBe(false);
        expect(outsideBrackets(chatLineWords(named), ['Kofi'])).toBe(false);
        expect(outsideBrackets(chatLineWords(nobody))).toBe(false);
        expect(outsideBrackets(chatLineWords(tooBig), [MAX_CHAT_IMAGE_LABEL])).toBe(false);
        expect(chatLineWords('The node answered 503.')).toBe(pseudoLocalise('The node answered {status}.').replace('{status}', '503'));
    });

    it('"The node answered N." is what both group chat modules write for a refusal with no words of the node\'s', () => {
        for (const file of ['group-chat-keys.ts', 'group-chat-lines.ts']) {
            expect(fs.readFileSync(path.resolve(__dirname, file), 'utf8'), file).toContain('`The node answered ${res.status}.`');
        }
    });
});

describe("who a group chat line is from (chatAuthorWords)", () => {
    it('only the two stand-ins are the app\'s: in English as written, in the pseudo-locale translated', () => {
        for (const name of [GROUP_LINE_UNVERIFIED_NAME, GROUP_LINE_FORMER_MEMBER]) expect(chatAuthorWords(name)).toBe(name);
        setLanguage('xx');
        expect(chatAuthorWords(GROUP_LINE_UNVERIFIED_NAME)).toBe(chatLineWords(GROUP_LINE_UNVERIFIED_NAME));
        expect(chatAuthorWords(GROUP_LINE_FORMER_MEMBER)).toBe(chatLineWords(GROUP_LINE_FORMER_MEMBER));
        expect(outsideBrackets(chatAuthorWords(GROUP_LINE_UNVERIFIED_NAME))).toBe(false);
        expect(outsideBrackets(chatAuthorWords(GROUP_LINE_FORMER_MEMBER))).toBe(false);
    });

    it('a member called "Notice", or anything else the table knows, keeps the name as written in every language', () => {
        setLanguage('xx');
        expect(chatAuthorWords('Notice')).toBe('Notice');
        const spelledLikeALine = knownChatLines().filter((line) => line !== GROUP_LINE_UNVERIFIED_NAME && line !== GROUP_LINE_FORMER_MEMBER);
        expect(spelledLikeALine.filter((line) => chatAuthorWords(line) !== line)).toEqual([]);
        expect(chatAuthorWords('Ana')).toBe('Ana');
        expect(chatAuthorWords(null)).toBeNull();
        expect(chatAuthorWords(undefined)).toBeUndefined();
    });
});

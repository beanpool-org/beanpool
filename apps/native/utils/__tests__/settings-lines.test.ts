/**
 * components/settings/settings-lines.ts translates, where Settings shows them, the sentences its lower layers write in
 * English (those layers handle keys, signatures, the 12 words or the key vault, and never reach the words layer). Each
 * sentence it knows is held here to the constant or builder it stands for, from the real modules, so a sentence changed
 * there fails this test instead of quietly showing English. Every one is found (the pseudo-locale brackets it), and in
 * English each reads exactly as its source writes it. The delete's sentences, built again from the same plan, read
 * word for word as delete-here.ts's in English for every plan shape.
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

import { setLanguage } from '@beanpool/core';
import {
    DELETE_CARD_LINE, DELETE_CHECKING_LINE, SIGN_OUT_INSTEAD_LINE, VAULT_COPY_GOES_LINE, deleteFailedLine, deletePlanFailedLine,
    deletedButLine, keepsKeyLine, lastCommunityLine, listNames, vaultCopyStaysLine, type DeletePlan, type KeptCommunity,
} from '../delete-here';
import { NAMES_COPY, namesSignOutWords } from '../names-list';
import { VAULT_MESSAGES, hasVault } from '../vault';
import { APP_LOCK_NEEDS_SCREEN_LOCK } from '../LocalAuth';
import { UNSAFE_NODE_ADDRESS_MESSAGE } from '../node-url';
import { ADD_WORDS_COPY } from '../add-words';
import {
    NO_WORDS_CHECK_FIRST, NO_WORDS_CONNECT, NO_WORDS_MENU, NO_WORDS_SIGN_OUT_ALERT, NO_WORDS_VIEW_LINE, VIEW_WORDS_MENU, noWordsBeforeWipe,
} from '../no-words-copy';
import { REMINDER_OFFSETS, reminderOffsetLabel } from '../event-extras';
import { APP_LOCK_ON_FOR_ROLE } from '../LocalAuth';
import { computerSigninLabel, manageLabel, manageSubtitle } from '../node-role';
import { signOutEverywhereDone, signOutEverywhereWarning } from '../sign-out-everywhere';
import {
    appLockOnForRoleWords, computerSigninLabelWords, deleteFailedWords, deletePlanFailedWords, deletedButWords, keepsKeyWords, lastCommunityWords,
    listNameWords, manageLabelWords, manageSubtitleWords, reminderBeforeWords, settingsLineWords, signOutEverywhereWarningWords, vaultCopyStaysWords,
} from '../../components/settings/settings-lines';

afterEach(() => setLanguage('en'));

const ROOT = path.resolve(__dirname, '../..');
/** A source file's code with its single-quoted pieces joined ('a ' + 'b' → 'a b'), so a long sentence reads whole. */
const joined = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/'\s*\+\s*'/g, '').replace(/"\s*\+\s*'/g, '').replace(/'\s*\+\s*"/g, '');
/** The words a sentence's {placeholders} stand for in English, and whether the pseudo-locale bracketed it. */
const inXx = (fn: () => string) => { setLanguage('xx'); try { return fn(); } finally { setLanguage('en'); } };
/** Letters left once every bracket, and the names given, are taken out. */
function outsideBrackets(text: string, names: readonly string[] = []): string {
    let rest = text;
    for (let was = ''; was !== rest;) { was = rest; rest = rest.replace(/\[[^[\]]*\]/g, ''); }
    for (const n of [...names].sort((a, b) => b.length - a.length)) rest = rest.split(n).join('');
    return rest.replace(/[^\p{L}]+/gu, ' ').trim();
}

/** pillar-sync's progress lines, as performSync and performSyncWhenFree pass them. */
function syncStages(): string[] {
    const src = joined('services/pillar-sync.ts');
    return [...src.matchAll(/onProgress\?\.\(\d+, \d+, '([^']+)'\)/g)].map((m) => m[1]);
}
/** delete-here.ts vaultCopyFailure's phrases. */
function vaultCopyFailures(): string[] {
    const src = joined('utils/delete-here.ts');
    const body = src.slice(src.indexOf('function vaultCopyFailure('), src.indexOf('\n}\n', src.indexOf('function vaultCopyFailure(')));
    return [...body.matchAll(/return (['"])(.+?)\1;/g)].map((m) => m[2]);
}

describe('the lower layers\' fixed sentences', () => {
    const SOURCES: Record<string, string[]> = {
        'no-words-copy.ts': [VIEW_WORDS_MENU.title, VIEW_WORDS_MENU.sub, NO_WORDS_MENU.title, NO_WORDS_MENU.sub, NO_WORDS_VIEW_LINE,
            NO_WORDS_CONNECT, NO_WORDS_CHECK_FIRST, noWordsBeforeWipe(), NO_WORDS_SIGN_OUT_ALERT],
        'add-words.ts': [ADD_WORDS_COPY.done],
        'LocalAuth.ts': [APP_LOCK_NEEDS_SCREEN_LOCK],
        'node-url.ts': [UNSAFE_NODE_ADDRESS_MESSAGE],
        'delete-here.ts': [DELETE_CARD_LINE, DELETE_CHECKING_LINE, SIGN_OUT_INSTEAD_LINE, ...vaultCopyFailures()],
        'names-list.ts': [NAMES_COPY.title, NAMES_COPY.tryAgain, NAMES_COPY.savePdf, NAMES_COPY.signOutAnyway, NAMES_COPY.signOutNotConfirmed],
        'vault.ts': Object.values(VAULT_MESSAGES),
        'pillar-sync.ts and Settings': [...syncStages(), 'Initializing Database Reset...', 'Clearing Local Database Cache...'],
    };

    it('reads every source it stands for (no empty list passes by itself)', () => {
        expect(vaultCopyFailures()).toHaveLength(5);
        expect(syncStages()).toHaveLength(6);
        for (const list of Object.values(SOURCES)) expect(list.length).toBeGreaterThan(0);
    });

    for (const [where, sentences] of Object.entries(SOURCES)) {
        it(`${where}: each is found, and reads in English exactly as written there`, () => {
            for (const english of sentences) {
                expect(settingsLineWords(english), english).toBe(english);
                const xx = inXx(() => settingsLineWords(english));
                expect(xx, english).not.toBe(english);
                expect(outsideBrackets(xx), english).toBe('');
            }
        });
    }

    it('vault.ts\'s other fixed refusals, the disconnect\'s, the area row\'s and Settings\' own line are the same English', () => {
        const vault = joined('utils/vault.ts');
        const keeper = joined('utils/keeper-enrolment.ts');
        const area = joined('utils/member-area.ts');
        const settings = joined('app/(tabs)/settings.tsx');
        const pairs: Array<[string, string]> = [
            [vault, 'A restore of this account is already waiting on another phone. It goes through there, or you can use your 12 words here.'],
            [keeper, 'No node configured.'],
            [area, "const unknown = \"Couldn't check right now\";"],
            [settings, "useState('Checking…')"],
            [settings, "useState('Initializing Database Reset...')"],
            [settings, "setResyncProgressStage('Clearing Local Database Cache...')"],
        ];
        for (const [src, english] of pairs) expect(src).toContain(english);
        for (const english of ['A restore of this account is already waiting on another phone. It goes through there, or you can use your 12 words here.',
            'No node configured.', "Couldn't check right now", 'Checking…']) {
            expect(outsideBrackets(inXx(() => settingsLineWords(english))), english).toBe('');
        }
        // The vault's refusal with only a status: the pattern follows the source's template, the status kept.
        expect(vault).toContain("`BeanPool's key vault couldn't do that (${status}). Try again later. Your 12 words work any time.`");
        const said = "BeanPool's key vault couldn't do that (418). Try again later. Your 12 words work any time.";
        expect(settingsLineWords(said)).toBe(said);
        const xx = inXx(() => settingsLineWords(said));
        expect(xx).toContain('418');
        expect(outsideBrackets(xx)).toBe('');
    });

    it('the names list\'s two sign-out lines with a key\'s number, from namesSignOutWords itself', () => {
        const only = namesSignOutWords([{ anchor: 'https://a.example', onlyKey: 7 }])!.text;
        const maybe = namesSignOutWords([{ anchor: 'https://a.example', onlyKey: 12, maybe: true }])!.text;
        expect(only).toContain('key 7');
        expect(maybe).toContain('key 12');
        for (const [english, n] of [[only, '7'], [maybe, '12']] as const) {
            expect(settingsLineWords(english)).toBe(english);
            const xx = inXx(() => settingsLineWords(english));
            expect(xx).toContain(n);
            expect(outsideBrackets(xx)).toBe('');
        }
    });

    it('anything else, a node\'s or the vault\'s own words or an object\'s own names, is shown exactly as given', () => {
        for (const other of ['We could not do that today', 'constructor', 'toString', '__proto__', '']) {
            expect(inXx(() => settingsLineWords(other))).toBe(other);
        }
    });
});

describe('Account Deletion\'s sentences, built again from the same plan', () => {
    const kept = (name: string, membership: KeptCommunity['membership'] = 'member'): KeptCommunity => ({ url: `https://${name.toLowerCase()}.example`, name, membership });
    const THIS_ONE: Array<Extract<DeletePlan, { kind: 'this-one' }>> = [
        { kind: 'this-one', here: 'https://mullum.example', hereName: 'Mullum', keeps: [kept('Castlemaine')], next: kept('Castlemaine') },
        { kind: 'this-one', here: 'https://mullum.example', hereName: 'Mullum', keeps: [kept('Castlemaine'), kept('Hills', 'unreachable')], next: kept('Castlemaine') },
        { kind: 'this-one', here: 'https://mullum.example', hereName: 'Mullum', keeps: [kept('Hills', 'unreachable'), kept('River', 'unreachable'), kept('Coast', 'unreachable')], next: kept('Hills', 'unreachable') },
    ];
    const LAST: Extract<DeletePlan, { kind: 'last' }> = { kind: 'last', here: 'https://mullum.example', hereName: 'Mullum' };
    const NAMES = ['Mullum', 'Castlemaine', 'Hills', 'River', 'Coast', 'the vault said no', 'disk full'];

    it('lists names as delete-here does', () => {
        for (const names of [[], ['A'], ['A', 'B'], ['A', 'B', 'C'], ['A', 'B', 'C', 'D']]) expect(listNameWords(names)).toBe(listNames(names));
    });

    it('what stays when other communities keep the key: the same English, and every word through t()', () => {
        for (const plan of THIS_ONE) {
            for (const words of [true, false]) {
                expect(keepsKeyWords(plan, words)).toBe(keepsKeyLine(plan, words));
                expect(outsideBrackets(inXx(() => keepsKeyWords(plan, words)), NAMES)).toBe('');
            }
        }
    });

    it('the last community: the same English with this build\'s vault, and the vault\'s line after it when there is one', () => {
        for (const words of [true, false]) {
            expect(lastCommunityWords(LAST, words, hasVault())).toBe(lastCommunityLine(LAST, words));
            expect(lastCommunityWords(LAST, words, true)).toBe(`${lastCommunityWords(LAST, words, false)} ${VAULT_COPY_GOES_LINE}`);
            expect(outsideBrackets(inXx(() => lastCommunityWords(LAST, words, true)), NAMES)).toBe('');
        }
    });

    it('a vault copy not removed, a delete the phone could not finish, a delete refused, a plan not asked', () => {
        for (const copyKnown of [true, false]) {
            for (const reason of [...vaultCopyFailures(), 'the vault said no']) {
                const outcome = { kind: 'vault-copy-stays' as const, reason, copyKnown };
                expect(vaultCopyStaysWords('Mullum', outcome)).toBe(vaultCopyStaysLine('Mullum', outcome));
                expect(outsideBrackets(inXx(() => vaultCopyStaysWords('Mullum', outcome)), NAMES)).toBe('');
            }
        }
        for (const keyStays of [true, false]) {
            for (const words of [true, false]) {
                expect(deletedButWords('Mullum', 'disk full', keyStays, words)).toBe(deletedButLine('Mullum', 'disk full', keyStays, words));
                expect(outsideBrackets(inXx(() => deletedButWords('Mullum', 'disk full', keyStays, words)), NAMES)).toBe('');
            }
        }
        for (const words of [true, false]) {
            expect(deleteFailedWords('the vault said no', words)).toBe(deleteFailedLine('the vault said no', words));
            expect(outsideBrackets(inXx(() => deleteFailedWords('the vault said no', words)), NAMES)).toBe('');
        }
        expect(deletePlanFailedWords('disk full')).toBe(deletePlanFailedLine('disk full'));
        expect(outsideBrackets(inXx(() => deletePlanFailedWords('disk full')), NAMES)).toBe('');
    });
});

describe('Community admin\'s sentences (NodeAdminEntry)', () => {
    it('node-role.ts\'s labels, LocalAuth.ts\'s App Lock line and sign-out-everywhere.ts\'s warning: the same English, every word through t()', () => {
        for (const role of ['owner', 'admin', 'moderator'] as const) {
            expect(manageLabelWords(role, 'Mullum')).toBe(manageLabel(role, 'Mullum'));
            expect(manageSubtitleWords(role)).toBe(manageSubtitle(role));
            expect(computerSigninLabelWords(role)).toBe(computerSigninLabel(role));
            expect(outsideBrackets(inXx(() => manageLabelWords(role, 'Mullum')), ['Mullum'])).toBe('');
            expect(outsideBrackets(inXx(() => manageSubtitleWords(role)))).toBe('');
            expect(outsideBrackets(inXx(() => computerSigninLabelWords(role)))).toBe('');
        }
        expect(appLockOnForRoleWords('Mullum')).toBe(APP_LOCK_ON_FOR_ROLE('Mullum'));
        expect(outsideBrackets(inXx(() => appLockOnForRoleWords('Mullum')), ['Mullum'])).toBe('');
        for (const owner of [true, false]) {
            expect(signOutEverywhereWarningWords('Mullum', owner)).toBe(signOutEverywhereWarning('Mullum', owner));
            expect(outsideBrackets(inXx(() => signOutEverywhereWarningWords('Mullum', owner)), ['Mullum'])).toBe('');
        }
    });

    it('break-glass.ts\'s and sign-out-everywhere.ts\'s own refusals, and what Sign out everywhere says it did', () => {
        const breakGlass = joined('utils/break-glass.ts');
        const signOut = joined('utils/sign-out-everywhere.ts');
        const fixed = [...breakGlass.matchAll(/message: '([^']+)'/g), ...signOut.matchAll(/message: '([^']+)'/g)].map((m) => m[1]);
        expect(fixed).toHaveLength(6);
        for (const english of [...fixed, signOutEverywhereDone({ breakGlassCodeRetired: true }), signOutEverywhereDone({ breakGlassCodeRetired: false })]) {
            expect(settingsLineWords(english), english).toBe(english);
            expect(outsideBrackets(inXx(() => settingsLineWords(english))), english).toBe('');
        }
        // A refusal with only its status, by the source's template.
        expect(signOut).toContain('`The community did not sign you out (${res.status}).`');
        expect(breakGlass).toContain('`The community said no (${res.status}).`');
        for (const said of ['The community did not sign you out (403).', 'The community said no (409).']) {
            expect(settingsLineWords(said)).toBe(said);
            expect(outsideBrackets(inXx(() => settingsLineWords(said)))).toBe('');
        }
    });
});

describe('event reminders, as the tick rows say them', () => {
    it('reads as event-extras\' label + " before" for every offset, and is translated', () => {
        for (const minutes of [...REMINDER_OFFSETS, 45]) {
            expect(reminderBeforeWords(minutes)).toBe(`${reminderOffsetLabel(minutes)} before`);
            expect(outsideBrackets(inXx(() => reminderBeforeWords(minutes)))).toBe('');
        }
    });
});

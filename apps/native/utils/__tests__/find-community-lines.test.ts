/**
 * components/find-community-lines.ts and components/useManageNode.tsx translate, where they are shown, the sentences their
 * lower layers write in English (utils/community-directory.ts, utils/knock.ts and utils/node-admin.ts sign what they send,
 * so they never reach the words layer; utils/typed-place.ts likewise). Each sentence they know is held here to the
 * constant or builder it stands for, from the real modules (or, for a literal fallback inside a function, the source it
 * is written in), so a sentence changed there fails this test instead of quietly showing English. Every one is found (the
 * pseudo-locale brackets it), and in English each reads exactly as its source writes it. A community's own words are
 * shown as given.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('react-native', () => ({
    Platform: { OS: 'android' }, AppState: { addEventListener: () => ({ remove() {} }) },
    Alert: { alert: () => {} }, Keyboard: { dismiss: () => {} },
}));
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
vi.mock('expo-web-browser', () => ({ openBrowserAsync: async () => ({}) }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: null }) }));
vi.mock('../../components/TotpCodeDialog', () => ({ TotpCodeDialog: () => null, looksLikeTotpCode: () => true }));

import { FIND_TOWN_SEARCH_WORDS, setLanguage } from '@beanpool/core';
import { DIRECTORY_MESSAGES } from '../community-directory';
import { KNOCK_CALLSIGN_CHARS, KNOCK_MESSAGES, KNOCK_MESSAGE_CHARS, knockFormProblem } from '../knock';
import { LOCATION_NOTES, nearLine } from '../typed-place';
import { NO_DEVICE_LOCK_MESSAGE } from '../node-admin';
import { UNSIGNABLE_CHALLENGE_MESSAGE } from '../member-statements';
import { UNSAFE_NODE_ADDRESS_MESSAGE } from '../node-url';
import { findLineWords, findTownSearchWords, nearWords } from '../../components/find-community-lines';
import { manageLineWords } from '../../components/useManageNode';

afterEach(() => setLanguage('en'));

const ROOT = path.resolve(__dirname, '../..');
const source = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const inXx = (fn: () => string) => { setLanguage('xx'); try { return fn(); } finally { setLanguage('en'); } };
const bracketedWhole = /^\[[\s\S]*\]$/;

describe("Find a community's lines: the lower layers' sentences, in the member's language", () => {
    const problems = [
        knockFormProblem({ callsign: 'W', message: 'Hello' }),
        knockFormProblem({ callsign: 'W'.repeat(KNOCK_CALLSIGN_CHARS + 1), message: 'Hello' }),
        knockFormProblem({ callsign: 'Wren', message: '   ' }),
        knockFormProblem({ callsign: 'Wren', message: 'x'.repeat(KNOCK_MESSAGE_CHARS + 1) }),
    ];

    it('the knock form has four problems, each its own sentence', () => {
        expect(problems.every((p) => typeof p === 'string')).toBe(true);
        expect(new Set(problems).size).toBe(4);
    });

    it('each fixed sentence reads as its source writes it in English, and is found (bracketed) in the pseudo-locale', () => {
        const sentences = [
            ...Object.values(DIRECTORY_MESSAGES), ...Object.values(KNOCK_MESSAGES), LOCATION_NOTES.off, LOCATION_NOTES.failed,
            ...(problems as string[]),
        ];
        for (const s of sentences) {
            expect(findLineWords(s), s).toBe(s);
            expect(inXx(() => findLineWords(s)), s).toMatch(bracketedWhole);
        }
        // The limits are said with their numbers, in the language's own plural.
        expect(inXx(() => findLineWords(problems[1]!))).toContain(String(KNOCK_CALLSIGN_CHARS));
        expect(inXx(() => findLineWords(problems[3]!))).toContain(String(KNOCK_MESSAGE_CHARS));
    });

    it('"already a member" is the fallback utils/knock.ts writes when the community gave no words', () => {
        const fallback = 'You are already a member of this community.';
        expect(source('utils/knock.ts')).toContain(`message ?? '${fallback}'`);
        expect(findLineWords(fallback)).toBe(fallback);
        expect(inXx(() => findLineWords(fallback))).toMatch(bracketedWhole);
    });

    it("a community's or the worldwide node's own words are shown exactly as given", () => {
        for (const said of ['We only take members from the valley.', 'Too many requests. Try again in an hour.']) {
            expect(inXx(() => findLineWords(said))).toBe(said);
        }
    });

    it('the place typed reads as utils/typed-place.ts nearLine, with a name or without', () => {
        for (const p of [{ lat: 1, lng: 2, name: 'Mullumbimby' }, { lat: 1, lng: 2, name: null }] as const) {
            expect(nearWords(p as any)).toBe(nearLine(p as any));
            expect(inXx(() => nearWords(p as any))).toMatch(bracketedWhole);
        }
    });

    it("the town search's words are core's FIND_TOWN_SEARCH_WORDS, through t()", () => {
        const w = findTownSearchWords();
        for (const field of ['label', 'placeholder', 'unavailable', 'noMatches', 'source'] as const) {
            expect(w[field], field).toBe(FIND_TOWN_SEARCH_WORDS[field]);
            expect(inXx(() => findTownSearchWords()[field]), field).toMatch(bracketedWhole);
        }
        expect(w.pickLabel!('Byron Bay')).toBe('Look near Byron Bay');
    });
});

describe("Manage's lines (components/useManageNode.tsx): utils/node-admin.ts's sentences, in the member's language", () => {
    it('each reads as node-admin.ts and member-statements.ts write it, and is found in the pseudo-locale', () => {
        const admin = source('utils/node-admin.ts');
        const fallbacks = ['The node refused the request.', 'You do not hold an owner, admin or moderator role on this node.', 'Could not reach the node.'];
        for (const s of fallbacks) expect(admin, s).toContain(`'${s}'`);
        for (const s of [NO_DEVICE_LOCK_MESSAGE, UNSIGNABLE_CHALLENGE_MESSAGE, UNSAFE_NODE_ADDRESS_MESSAGE, ...fallbacks]) {
            expect(manageLineWords(s), s).toBe(s);
            expect(inXx(() => manageLineWords(s)), s).toMatch(bracketedWhole);
        }
    });

    it('"The node did not answer (503)." keeps its status', () => {
        expect(source('utils/node-admin.ts')).toContain('`The node did not answer (${res.status}).`');
        expect(manageLineWords('The node did not answer (503).')).toBe('The node did not answer (503).');
        const xx = inXx(() => manageLineWords('The node did not answer (503).'));
        expect(xx).toMatch(bracketedWhole);
        expect(xx).toContain('503');
    });

    it("a node's own words are shown exactly as given", () => {
        expect(inXx(() => manageLineWords('Settings are closed for maintenance.'))).toBe('Settings are closed for maintenance.');
    });
});

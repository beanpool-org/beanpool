/**
 * A bill with an invite on the phone (DESIGN-getting-paid-fable.md §4.5, slice B3). The fold's rule, the share sentence and the
 * row's words are core's (packages/beanpool-core invite-bill.test.ts); this file checks what the phone adds: that it hears the
 * node's `bills` answer, and that People › Invites draws the fold and shares from core rather than words of its own. The screen
 * can't be drawn here (vitest.config.ts: logic, not screens), so the source blocks read it.
 */
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((len: number) => new Uint8Array(len)) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) },
}));
import { readNodeProfile } from '../node-profile';
import { billsOn } from '@beanpool/core';

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf-8');

describe('the phone hears whether the community takes bills', () => {
    it('`bills: true` is heard (red if the key is not in the phone\'s FEATURE_KEYS)', () => {
        expect(billsOn(readNodeProfile({ profile: 'local', features: { beans: true, bills: true } })!.features)).toBe(true);
    });
    it('a node that says nothing, false or a string takes none: no fold', () => {
        for (const features of [{ beans: true }, { beans: true, bills: false }, { beans: true, bills: 'true' }]) {
            expect(billsOn(readNodeProfile({ profile: 'local', features })!.features)).toBe(false);
        }
        expect(billsOn(readNodeProfile({})!.features)).toBe(false);
    });
});

describe('People › Invites (app/(tabs)/people.tsx) draws the fold and shares from core', () => {
    const src = read('../../app/(tabs)/people.tsx');
    const fold = read('../../components/InviteBillFold.tsx');
    it('the fold shows only where bills are on, never in the sample community, never with the names box ticked', () => {
        expect(src).toMatch(/const billsShown = !invitesPreview && billsOn\(nodeProfile\?\.features\)/);
        expect(src).toMatch(/const billFoldShown = billsShown && !\(inviteNames\.offered && inviteNames\.namesTicked\);/);
        expect(src).toMatch(/\{billFoldShown && \(\s*<InviteBillFold/);
    });
    // What each tap sends, the id and the words, over the whole table: invite-bill-send-render.test.ts.
    it('the bill is read by core only from the fold as drawn and open, goes in the generate body with that bill\'s id, and never on an offline ticket', () => {
        expect(src).toMatch(/inviteBillToSend\(\{ open: billFoldShown && billOpen, whatFor: billWhatFor, beans: billBeans \}, billHeld\.current, newBillId\)/);
        expect(src).toMatch(/\.\.\.\(bill \? \{ bill \} : \{\}\)/);
        expect(src).toMatch(/if \(bill\) \{\s*billNotMade\(\{ kind: 'lost' \}\);\s*return;/);
    });
    it('with a bill, a refusal the node words is shown as it said it, anything else is "not known", and no offline ticket is made', () => {
        expect(src).toMatch(/if \(bill\) \{\s*billNotMade\(inviteBillAnswerOf\(res\.status, serverMsg, body\?\.code, body === null\)\);\s*return;/);
    });
    it('Share names the inviter when the invite carries a bill, through core\'s one message', () => {
        expect(src).toMatch(/inviteShareText\(\{ name, link: magicLink, code: codeToShare, address, billFrom: carriesBill \? identity\?\.callsign : null \}\)/);
    });
    it('the fold\'s words are core\'s: no English of its own', () => {
        expect(fold).toMatch(/inviteBillLines\.fold\(\)/);
        expect(fold).toMatch(/billLines\.whatForLabel\(\)/);
        expect(fold).toMatch(/billLines\.amountLabel\(\)/);
        expect(fold).toMatch(/billLines\.youReceive\(/);
        expect(fold).toMatch(/inviteBillLines\.theyChoose\(\)/);
    });
});

import { describe, it, expect } from 'vitest';
import { BLOCKED_BEANS_NOTE, ledgerLineNote } from '../blocked-beans-note.js';
import * as barrel from '../index.js';

const BO = 'b'.repeat(64);
const CY = 'c'.repeat(64);
const blocked = new Set([BO]);

describe('a ledger line from someone the reader has blocked', () => {
    it('shows the neutral words in place of the note that came with the Beans', () => {
        expect(ledgerLineNote({ incoming: true, counterparty: BO, memo: 'meet me behind the shed' }, blocked)).toBe(BLOCKED_BEANS_NOTE);
    });

    it('and in place of none, or of the empty note the community kept from them', () => {
        expect(ledgerLineNote({ incoming: true, counterparty: BO, memo: '' }, blocked)).toBe(BLOCKED_BEANS_NOTE);
        expect(ledgerLineNote({ incoming: true, counterparty: BO, memo: null }, blocked)).toBe(BLOCKED_BEANS_NOTE);
    });

    it('says nothing of what was sent', () => {
        expect(BLOCKED_BEANS_NOTE).toBe('Beans from a member you blocked');
    });
});

describe('every other line', () => {
    it("shows its own note: someone not blocked, or the reader's own send to someone blocked", () => {
        expect(ledgerLineNote({ incoming: true, counterparty: CY, memo: 'thanks for the eggs' }, blocked)).toBe('thanks for the eggs');
        expect(ledgerLineNote({ incoming: false, counterparty: BO, memo: 'for the bread' }, blocked)).toBe('for the bread');
    });

    it('shows nothing when it carries nothing, and no list blocks nobody', () => {
        expect(ledgerLineNote({ incoming: true, counterparty: CY, memo: undefined }, blocked)).toBe('');
        expect(ledgerLineNote({ incoming: true, counterparty: BO, memo: 'hello' }, new Set())).toBe('hello');
        expect(ledgerLineNote({ incoming: true, counterparty: null, memo: 'hello' }, blocked)).toBe('hello');
    });

    it('takes any list with has(): an array-backed one as the phone app keeps it', () => {
        const list = { has: (k: string) => [BO].includes(k) };
        expect(ledgerLineNote({ incoming: true, counterparty: BO, memo: 'x' }, list)).toBe(BLOCKED_BEANS_NOTE);
    });
});

describe('the barrel', () => {
    it('exports both, for the server and the apps', () => {
        expect(barrel.BLOCKED_BEANS_NOTE).toBe(BLOCKED_BEANS_NOTE);
        expect(barrel.ledgerLineNote).toBe(ledgerLineNote);
    });
});

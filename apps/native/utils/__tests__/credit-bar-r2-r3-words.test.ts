/**
 * The credit bar's R2 and R3 words (DESIGN-credit-bar-amend-fable.md §3 "Leaving the catalogs", §7a, §11): the old "Credit
 * Slider Info" modal is gone, with its strings, from every catalog of every package; no catalog holds "Your budget:"; the
 * phone's Ledger row for a voucher reads "Vouching budget" with its line (an owner's with theirs), from core's words.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { VOUCH_PRESET_WORDS, ledgerBudget, t } from '@beanpool/core';

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const CATALOG_DIRS = ['apps/native/words', 'apps/pwa/words', 'apps/server/words', 'packages/beanpool-core/words'];
const catalogs = CATALOG_DIRS.flatMap((d) => fs.readdirSync(path.join(ROOT, d)).filter((f) => /^[A-Za-z-]+\.json$/.test(f)).map((f) => path.join(d, f)));
const keysOf = (file: string) => Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')));
const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');

/** The old modal's own sentences (its title, its three tabs and their headings). */
const OLD_MODAL = [
    'Credit Slider Info', 'Credit Slider', 'Overdraft Floors', 'Idle Balance Tiers', 'Zero is the Sweet Spot', 'SPECTRUM COLOR ZONES',
    'HOW YOUR FLOOR GROWS', 'ROUGH GUIDE (VALUE TRADED → FLOOR)', 'IDLE BALANCE RECIRCULATION TIERS', 'MONTHLY SUMMARY EXAMPLE',
    '{rate}% (Fee-Free Zone)', '~{amount}B traded',
];

describe('R2: the old Credit Slider Info is gone', () => {
    it('its file is gone and nothing imports it', () => {
        expect(fs.existsSync(path.join(__dirname, '..', '..', 'components', 'info-content', 'SliderInfoModal.tsx'))).toBe(false);
        expect(read('app', '(tabs)', 'ledger.tsx')).not.toContain('SliderInfoModal');
        expect(read('app', '(tabs)', 'ledger.tsx')).toContain('<CreditSheet');
    });
    it(`none of its strings is in any catalog (${catalogs.length} catalogs)`, () => {
        expect(catalogs.length).toBeGreaterThan(90);
        const found = catalogs.flatMap((f) => keysOf(f).filter((k) => OLD_MODAL.includes(k)).map((k) => `${f}: ${k}`));
        expect(found).toEqual([]);
    });
});

describe('R3: Vouching budget, never "Your budget:"', () => {
    it('no catalog holds "Your budget:"', () => {
        const found = catalogs.flatMap((f) => keysOf(f).filter((k) => k.includes('Your budget:')).map((k) => `${f}: ${k}`));
        expect(found).toEqual([]);
    });
    it('the row reads "Vouching budget" and its line says it is credit line given to others, not Beans and not their spending', () => {
        expect(ledgerBudget(80000, 100000)).toBe('Vouching budget: 800 of 1,000 left');
        expect(t(VOUCH_PRESET_WORDS.ledgerBudgetNoLimit)).toBe('Vouching budget: no limit');
        expect(t(VOUCH_PRESET_WORDS.ledgerBudgetLine)).toBe('What you can give other members as credit line when you vouch for them. Not Beans, and not your own spending.');
        expect(t(VOUCH_PRESET_WORDS.ledgerBudgetLineNoLimit)).toBe('As an owner you can vouch for members without a limit. This is credit line you give to others: not Beans, and not your own spending.');
        expect(t(VOUCH_PRESET_WORDS.budgetTitle)).toBe('Your vouching budget');
    });
    it('the phone\'s Ledger row draws the budget and, under it, its line (an owner\'s their own)', () => {
        const ledger = read('app', '(tabs)', 'ledger.tsx');
        expect(ledger).toContain('{myVouching.noLimit ? t(VOUCH_PRESET_WORDS.ledgerBudgetNoLimit) : ledgerBudget(myVouching.budget.left, myVouching.budget.level)}');
        expect(ledger).toMatch(/testID="ledger-budget-line"[\s\S]{0,200}\{myVouching\.noLimit \? t\(VOUCH_PRESET_WORDS\.ledgerBudgetLineNoLimit\) : t\(VOUCH_PRESET_WORDS\.ledgerBudgetLine\)\}/);
        expect(ledger).toContain('{t(VOUCH_PRESET_WORDS.budgetTitle)}');
    });
});

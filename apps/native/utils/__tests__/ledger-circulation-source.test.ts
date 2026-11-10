/**
 * The phone Wallet's Community Circulation box (PR #2020 fix round 1, as on the web): its figure is core's
 * monthlyCirculation, the ledger's own brackets, never a hand copy; and at or under the 200 Beans fee-free line it says
 * so in words instead of "0.00 per month → commons pool".
 *
 * Read from the source, as ledger-header-scrolls.test.ts does: the native suite draws no screens (vitest.config.ts).
 * The figure itself is pinned against the ledger in packages/beanpool-core/src/__tests__/circulation.test.ts.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { monthlyCirculation } from '@beanpool/core';

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app', '(tabs)', 'ledger.tsx'), 'utf8');
const box = src.slice(src.indexOf('{/* ── Community Circulation ── */}'), src.indexOf('{/* ── Project Pledges ── */}'));

describe("the phone Wallet's Community Circulation box", () => {
    it('reads the month from core and keeps no copy of the brackets', () => {
        // The balance in whole hundredths (getBalance's balance_c), as core's brackets are.
        expect(src).toMatch(/const monthly = monthlyCirculation\(balanceState\.balance_c\);/);
        expect(src).not.toMatch(/\{ m: 200, r: 0\.0 \}|maxInBracket|0\.025/);
        expect(src).not.toMatch(/CIRC_TICKS/);
    });

    it('shows the amount and the next run only above the line, and a sentence through t() at or under it', () => {
        expect(box.length).toBeGreaterThan(0);
        expect(box).toMatch(/\{monthly > 0 && \(\s*\/\/[^\n]*\n\s*<CurrencyDisplay/);
        expect(box).toMatch(/\{monthly > 0 \? \(\s*<View style=\{styles\.circRow\}>\s*<Text[^>]*>\{t\('per month → commons pool'\)\}/);
        // The line is whole hundredths (core's CIRCULATION_FREE_BEANS), written as every figure is.
        expect(box).toContain("t('Nothing goes to the Commons while you hold {free} Beans or less.', { free: formatHundredths(CIRCULATION_FREE_BEANS) })");
    });

    it('is nothing for the example member (85 Beans) and at 200, something just above', () => {
        // Whole hundredths: 85 Beans is 8500; 100 Beans over the line at 1 % a month is exactly one Bean (100).
        expect(monthlyCirculation(8500)).toBe(0);
        expect(monthlyCirculation(20000)).toBe(0);
        expect(monthlyCirculation(30000)).toBe(100);
    });
});

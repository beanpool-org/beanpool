/**
 * Levels are merit badges (#1838; memory tiers-are-merit-badges): they gate nothing, so the Ledger's levels list never
 * shows a level the member hasn't reached yet as locked. No lock, no "Locked", not faded, not greyed as if out of
 * bounds: it reads as something to grow into ("Next level", "Up ahead") in its own colours.
 *
 * Read from the source, as ledger-header-scrolls.test.ts does: the native suite draws no screens (vitest.config.ts).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ledger = fs.readFileSync(path.join(__dirname, '..', '..', 'app', '(tabs)', 'ledger.tsx'), 'utf8');
// Code only: the doc comment says what the coin must never be.
const badge = fs.readFileSync(path.join(__dirname, '..', '..', 'components', 'TrustBadge.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// The medallion shelf and the selected level's card, up to the "how to reach the next tier" card.
const start = ledger.indexOf('{/* ── Medallion shelf');
const end = ledger.indexOf('{/* How to reach the next tier', start);
const levels = ledger.slice(start, end);
// The code alone: the comment above the shelf explains the rule in the words it forbids.
const levelsCode = levels.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const LOCK = /🔒|lock/i;

describe('the levels list on the phone', () => {
    it('is where the test looks for it', () => {
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        expect(levelsCode).toContain('<TrustBadge');
        expect(levelsCode).toContain('styles.detailStatePill');
    });

    it('shows no lock and says no "Locked"', () => {
        expect(levelsCode).not.toMatch(LOCK);
    });

    it('calls a level not reached yet the next level or one up ahead', () => {
        expect(levelsCode).toContain("selLevel === tierIdx + 1 ? 'Next level' : 'Up ahead'");
    });

    it('fades nothing, and greys no level name, state or perk for not being reached', () => {
        expect(levelsCode).not.toMatch(/\bopacity\b/);
        // A reached/unreached choice that falls back to the muted text, a strong border or the bare app surface.
        expect(levelsCode).not.toMatch(/[rR]eached\s*\?[^:{}]*:\s*colors\.(text\.muted|border\.strong|surface\.app)\b/);
    });
});

describe('the trust badge coin', () => {
    it('is never drawn faded or labelled locked', () => {
        expect(badge).toContain('<Svg');
        expect(badge).not.toMatch(LOCK);
        expect(badge).not.toMatch(/<Svg[^>]*\bopacity=/);
    });
});

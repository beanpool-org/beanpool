import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The enterprise screen's Decisions block (DESIGN-group-decisions S2). Its words and checks are @beanpool/core
 * scoped-decision.ts (tested there); this holds the screen to them.
 */
const ROOT = path.join(__dirname, '..', '..');
const block = fs.readFileSync(path.join(ROOT, 'components', 'EnterpriseDecisions.tsx'), 'utf-8');
const screen = fs.readFileSync(path.join(ROOT, 'app', 'treasury-detail.tsx'), 'utf-8');

describe("an enterprise's Decisions block", () => {
    it('the enterprise screen draws it, and reads it again on each focus (where a Needs-you vote line lands)', () => {
        expect(screen).toContain("import { EnterpriseDecisions } from '../components/EnterpriseDecisions';");
        expect(screen).toMatch(/<EnterpriseDecisions\s/);
        expect(screen).toContain('useFocusEffect(useCallback(() => { setDecisionsRefresh(n => n + 1); }, []));');
    });

    it('the tally is the shared one (turnout while open, Yes and No at close); no count of its own', () => {
        expect(block).toContain('{scopedTallyWords(d)}');
        expect(block).not.toMatch(/tally\.yes|tally\.no\b/);
    });

    it('the form checks the amount against what it holds and shows the fee; the pickers come from the roll', () => {
        expect(block).toContain('checkPayOutAmount(amountText, balance)');
        expect(block).toContain('payOutFeeWords(amount.amount, person.name)');
        expect(block).toContain('rollChoices(effect, roll, me)');
        expect(block).toContain('scopedEffectsFor(lifecycle)');
    });

    it('Beans, never the old sign; no tier anywhere', () => {
        expect(block).not.toMatch(/Ʀ/);
        expect(block).not.toMatch(/\btier\b/i);
    });

    it('no propose button unless the node says this keeper can (a roll of one holds no vote)', () => {
        expect(block).toMatch(/\{list\.canPropose && \(/);
    });
});

/**
 * The Ledger's header scrolls with the page (rehearsal 2026-10-05b, summary item 1). At 320 dp and 1.3x text the
 * frozen card or the repayment banner alone fills the screen; with the profile bar, the credit card, the repayment
 * card and the Levels / Wallet tab bar fixed above the only scrolling area, a member working off a debt couldn't
 * reach Pay the Commons (the one way into the pay screen) and a frozen member couldn't reach Levels or Wallet.
 *
 * Read from the source, as names-debts.test.ts does for the card: the native suite draws no screens (vitest.config.ts).
 * The emulator check at 320 dp / 1.3x is the PR's screenshots.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app', '(tabs)', 'ledger.tsx'), 'utf8');

/** The body of `const <name> = () => …` up to the next top-level (4-space) `const` of the component. */
function fnBody(name: string): string {
    const start = src.indexOf(`    const ${name} = () =>`);
    expect(start, name).toBeGreaterThan(0);
    const next = src.indexOf('\n    const ', start + 1);
    const ret = src.indexOf('\n    return (\n        <View style={styles.root}>', start + 1);
    const end = [next, ret].filter(i => i > 0).reduce((a, b) => Math.min(a, b));
    return src.slice(start, end);
}

/** The `{…}` value of a JSX prop in `text`, braces balanced (so a reformatted prop still reads the same). */
function propValue(text: string, prop: string): string {
    const at = text.indexOf(`${prop}={`);
    expect(at, prop).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = at + prop.length + 1; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}' && --depth === 0) return text.slice(at + prop.length + 2, i);
    }
    throw new Error(`${prop}: unbalanced braces`);
}

describe('the Ledger header scrolls with the page', () => {
    // What sits between the page title and the end of the keyboard-avoiding area: the fixed part of the page.
    const fixed = src.slice(src.indexOf('<PageTitle title="Ledger"'), src.indexOf('</KeyboardAvoidingView>'));

    it('the shared header is drawn once, inside the one list’s header, and nothing pins it (#1633 review r4180150904)', () => {
        expect(fixed.match(/renderLedgerHeader\(\)/g)?.length).toBe(1);
        const listHeader = propValue(fixed.slice(fixed.indexOf('<FlatList')), 'ListHeaderComponent');
        expect(listHeader).toContain('renderLedgerHeader()');
        expect(listHeader.indexOf('renderLedgerHeader()')).toBeLessThan(listHeader.indexOf('renderTrustTab()'));
        expect(listHeader).toContain('renderActivityHeader()');
        // A sticky header would pin the cards again and hide the tabs at 320 dp / 1.3x. If only the tab bar should
        // ever stick, give it its own cell and change this line with it.
        expect(fixed).not.toMatch(/stickyHeaderIndices|stickySectionHeadersEnabled/);
    });

    it('nothing but the page title and one list is fixed: the cards and the tab bar are not', () => {
        expect(fixed.length).toBeGreaterThan(0);
        expect(fixed.match(/<FlatList\b/g)?.length).toBe(1);
        for (const piece of ['<RepaymentCard', 'styles.topBar', 'styles.tabBar', 'ledger-known-frozen', 'ledger-wallet-tab', '<CreditBar']) {
            expect(fixed, piece).not.toContain(piece);
        }
    });

    it('the list’s header is the shared header followed by the open tab, in both tabs', () => {
        const header = fnBody('renderLedgerHeader');
        for (const piece of ['styles.topBar', '<CreditBar', 'testID="ledger-known-frozen"', 'testID="ledger-frozen-debit"', '<RepaymentCard />', 'styles.tabBar', 'testID="ledger-wallet-tab"']) {
            expect(header, piece).toContain(piece);
        }
    });

    it('Levels has no scroll view of its own, and the one list keeps the title collapse, re-tap and keyboard room', () => {
        expect(fnBody('renderTrustTab')).not.toMatch(/<ScrollView\b/);
        expect(src.match(/ref=\{listRef\}/g)?.length).toBe(1);
        expect(fixed).toContain('ref={listRef}');
        expect(src).toContain('useTabRetapScrollTop(listRef)');
        expect(src).toMatch(/onListScroll = \(e[^)]*\) => \{[\s\S]*?pageTitle\.onScroll\(e\);/);
        expect(fixed).toContain('onScroll={onListScroll}');
        expect(fixed).toContain('keyboardShouldPersistTaps="handled"');
        expect(fixed).toContain('paddingBottom: keyboardHeight > 0 ? keyboardHeight + 48 : 48');
    });
});

/**
 * The 3 Nov keyboard audit, groups C, D and F (scratch/keyboard-audit/AUDIT-2026-11-03.md): the phone pop-ups that live in
 * a React Native Modal keep the field being typed in above the keyboard. A Modal's window does not shrink for the keyboard,
 * and React Native's own KeyboardAvoidingView only works on iOS, so:
 *   C: no pop-up takes React Native's KeyboardAvoidingView; it is lifted by useModalKeyboardLift (Android got no lift);
 *   D: a pop-up whose form scrolls hands its ScrollView and its fields to useScrollFieldIntoView;
 *   F: the hours prompt in treasury-manage is lifted the same way.
 * These read the sources (the behaviour itself is in scroll-field-into-view.test.ts and modal-keyboard-lift.test.ts, and was
 * driven on the Android emulator); a pop-up that later drops its wiring fails here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url).href), 'utf8');
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('group C: React Native\'s own KeyboardAvoidingView is gone from the pop-ups', () => {
    for (const file of ['components/ProposeDecisionModal.tsx', 'components/PricingGuideModal.tsx']) {
        it(`${file} is lifted by useModalKeyboardLift`, () => {
            const c = code(file);
            expect(c).not.toMatch(/KeyboardAvoidingView/);
            expect(c).toMatch(/useModalKeyboardLift\(/);
            expect(c).toMatch(/marginBottom: (lift|reportLift)\.lift/);
        });
    }
});

describe('group D: each scrolling pop-up scrolls the field being typed in into view', () => {
    // [file, the ScrollView wired, the TextInputs wired]
    const sheets: Array<[string, number, number]> = [
        ['components/CreateGroupModal.tsx', 1, 2],
        ['components/EnterpriseDecisions.tsx', 2, 5],
        ['components/InviteAsks.tsx', 1, 2],
        ['components/home/CardSettingsSheet.tsx', 1, 1],
        ['components/ReviewModal.tsx', 1, 1],
        ['components/RemovalReplySheet.tsx', 1, 1],
        ['components/ProposeDecisionModal.tsx', 1, 8],
        ['components/PricingGuideModal.tsx', 1, 1],
    ];
    for (const [file, scrolls, inputs] of sheets) {
        it(`${file}: ${scrolls} ScrollView and ${inputs} TextInput(s) are wired to the helper`, () => {
            const c = code(file);
            expect(c).toMatch(/useScrollFieldIntoView\(\)/);
            expect(c.match(/\{\.\.\.(fieldScroll|reportScroll)\.scrollProps\}/g) ?? []).toHaveLength(scrolls);
            expect(c.match(/\{\.\.\.(fieldScroll|reportScroll)\.inputProps\}/g) ?? []).toHaveLength(inputs);
        });
    }

    it('the report sheet and the shop sheets pass the helper to their fields through the context', () => {
        const report = code('components/ReportMessageSheet.tsx');
        expect(report).toMatch(/\{\.\.\.fieldScroll\.scrollProps\}/);
        expect(report).toMatch(/ScrollFieldContext\.Provider value=\{fieldScroll\}/);
        expect(code('components/ReportReasonBox.tsx')).toMatch(/\{\.\.\.fieldScroll\?\.inputProps\}/);
        const shop = code('components/shop/ShopSheets.tsx');
        expect(shop).toMatch(/\{\.\.\.fieldScroll\.scrollProps\}/);
        expect(shop).toMatch(/ScrollFieldContext\.Provider value=\{fieldScroll\}/);
        expect(shop).toMatch(/\{\.\.\.fieldScroll\?\.inputProps\}/);
    });

    it('the field of a child component sits inside the provider, not beside it (a hook called by the sheet\'s parent would find nothing)', () => {
        const shop = code('components/shop/ShopSheets.tsx');
        // ShopTextSheet renders <Sheet> and calls no scroll hook itself; the text box is a component of its own.
        const sheetFn = shop.slice(shop.indexOf('export function ShopTextSheet'));
        expect(sheetFn.slice(0, sheetFn.indexOf('\n}\n'))).not.toMatch(/useScrollFieldContext\(\)/);
        expect(shop).toMatch(/function ShopTextBox\([\s\S]*?useScrollFieldContext\(\)/);
    });
});

describe('group F: the hours prompt is lifted above the keyboard', () => {
    it('treasury-manage lifts the centred card by the keyboard\'s height and bounds its height', () => {
        const c = code('app/treasury-manage.tsx');
        expect(c).toMatch(/useModalKeyboardLift\(hoursInsets\.top \+ 8\)/);
        expect(c).toMatch(/paddingBottom: 20 \+ hoursLift\.lift/);
        expect(c).toMatch(/maxHeight: hoursLift\.maxHeight/);
    });
});

describe('no pop-up nests a KeyboardProvider (memory keyboard-avoidance-pattern)', () => {
    for (const file of [
        'components/ProposeDecisionModal.tsx', 'components/PricingGuideModal.tsx', 'components/CreateGroupModal.tsx',
        'components/EnterpriseDecisions.tsx', 'components/InviteAsks.tsx', 'components/home/CardSettingsSheet.tsx',
        'components/shop/ShopSheets.tsx', 'components/ReportMessageSheet.tsx', 'components/ReviewModal.tsx',
        'components/RemovalReplySheet.tsx', 'components/TagPicker.tsx', 'components/useScrollFieldIntoView.ts',
    ]) {
        it(file, () => expect(code(file)).not.toMatch(/<KeyboardProvider/));
    }
});

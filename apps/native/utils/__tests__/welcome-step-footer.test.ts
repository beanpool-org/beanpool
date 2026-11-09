/**
 * Each join step's main button stays on screen (Damo, 9 Nov: "the counter-intuitive 'Next' button and the following 'Let's
 * Begin!' buttons being right on the bottom of the screen and forcing me to scroll down before I can even see them").
 *
 * The button was the last thing in each step's scroll view, under the step's words; on a tablet in landscape, or a small
 * phone at 1.3x text, it was below the fold. It is now in components/welcome/StepFooter.tsx, drawn under the scroll view, so
 * the words scroll and the button stays put above the system bar and the keyboard. The screen can't be laid out here (see
 * vitest.config.ts), so this reads welcome.tsx: for every step, the main button sits in a StepFooter after the step's scroll
 * view closes, never inside it.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '..', '..');
const welcome = fs.readFileSync(path.join(root, 'app/welcome.tsx'), 'utf8');
const footer = fs.readFileSync(path.join(root, 'components/welcome/StepFooter.tsx'), 'utf8');
const theme = fs.readFileSync(path.join(root, 'app/ThemeContext.tsx'), 'utf8');

/** The source of one step: from its `if (mode === '<mode>'` to the next step's. */
function step(mode: string): string {
    // The screen's own branch, at the render's indent (an effect's `if (mode === 'create' && …)` is deeper).
    const start = welcome.indexOf(`\n    if (mode === '${mode}'`);
    expect(start, mode).toBeGreaterThan(-1);
    const next = welcome.indexOf('\n    if (mode === ', start + 10);
    return welcome.slice(start, next === -1 ? undefined : next);
}

const STEPS: Array<{ mode: string; scroll: string; button: RegExp; testID: string }> = [
    { mode: 'create', scroll: '</KeyboardAwareScrollView>', button: /onPress=\{handleCreate\}/, testID: 'step-footer-invite' },
    { mode: 'profileSetup', scroll: '</ScrollView>', button: /onPress=\{handleCompleteProfile\}/, testID: 'step-footer-profile' },
    { mode: 'seedBackup', scroll: '</ScrollView>', button: /recordOnboardingEvent\('protection_choice'/, testID: 'step-footer-words' },
    { mode: 'onboardingGuide', scroll: '</ScrollView>', button: /t\("Let's Begin! 🚀"\)/, testID: 'step-footer-guide' },
    { mode: 'ownerCard', scroll: '</ScrollView>', button: /t\("Let's Begin! 🚀"\)/, testID: 'step-footer-owner' },
];

describe('the join steps\' main button is in a footer that stays on screen', () => {
    for (const s of STEPS) {
        it(`${s.mode}: the main button is in the StepFooter, after the scroll view closes`, () => {
            const src = step(s.mode);
            const scrollEnd = src.indexOf(s.scroll);
            const open = src.indexOf(`<StepFooter testID="${s.testID}"`);
            const close = src.indexOf('</StepFooter>', open);
            expect(scrollEnd).toBeGreaterThan(-1);
            expect(open, 'footer after the scroll view').toBeGreaterThan(scrollEnd);
            const inFooter = src.slice(open, close);
            expect(inFooter).toMatch(s.button);
            // Never also left in the scroll view.
            expect(src.slice(0, scrollEnd)).not.toMatch(s.button);
        });
    }

    it('the invite step keeps its fields clear of the footer while typing', () => {
        const src = step('create');
        expect(src).toMatch(/bottomOffset=\{24 \+ stepFooterHeight\}/);
        expect(src).toMatch(/<StepFooter testID="step-footer-invite" onHeight=\{setStepFooterHeight\}>/);
    });

    it('the footer rides above the keyboard and the system bar, from the central colour tokens', () => {
        expect(footer).toMatch(/<KeyboardStickyView offset=\{\{ opened: Platform\.OS === 'ios' \? insets\.bottom : 0 \}\}/);
        expect(footer).toMatch(/paddingBottom: 12 \+ \(Platform\.OS === 'android' \? insets\.bottom : 0\)/);
        expect(footer).toMatch(/backgroundColor: colors\.surface\.chrome/);
        expect(footer).toMatch(/borderTopColor: colors\.border\.default/);
        expect(footer).not.toMatch(/<KeyboardProvider|import \{[^}]*KeyboardProvider/);
        expect(footer).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    });

    // Walked on the emulator (9 Nov): on surface.page the footer was see-through, because the doodle pattern turns that token
    // 'transparent', and the step's words scrolled visibly behind and beside Next (a tablet in landscape showed the code
    // field through it). surface.chrome is the token for bars that content slides under: the pattern's ground when it is on.
    it('the footer is opaque with the pattern on: never on the token the pattern turns transparent', () => {
        expect(theme).toMatch(/surface: \{ \.\.\.base\.surface, page: 'transparent', chrome: ground \}/);
        expect(footer).not.toMatch(/colors\.surface\.page/);
    });
});

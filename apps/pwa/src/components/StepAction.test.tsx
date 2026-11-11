/**
 * Each join step's main button stays on screen on the web too (Damo, 9 Nov: "the counter-intuitive 'Next' button and the
 * following 'Let's Begin!' buttons being right on the bottom of the screen and forcing me to scroll down before I can even
 * see them"). The phone's twin is apps/native/utils/__tests__/welcome-step-footer.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StepAction } from './StepAction';

const welcome = readFileSync(join(__dirname, '..', 'pages', 'WelcomePage.tsx'), 'utf8');

/** The `<StepAction>` that holds the button whose label is `label`, or null when the button is not in one. */
function actionAround(label: string): string | null {
    const at = welcome.indexOf(label);
    expect(at, label).toBeGreaterThan(-1);
    const open = welcome.lastIndexOf('<StepAction>', at);
    const close = welcome.indexOf('</StepAction>', open);
    if (open === -1 || close < at) return null;
    // Only the one button in it: nothing between the wrapper and its button but the button's own opening.
    const inside = welcome.slice(open, close);
    return (inside.match(/<button/g) ?? []).length === 1 ? inside : null;
}

describe('the web join steps\' main button stays on screen', () => {
    for (const label of [
        "{loading ? t('Creating...') : t('Create Identity & Join →')}",
        "{loading ? t('Saving…') : renameUnsaved !== null",
        "{loading ? t('Entering...') : t(\"Let's Begin! 🚀\")}",
    ]) {
        it(`${label.slice(0, 60)}: in a StepAction`, () => {
            expect(actionAround(label)).not.toBeNull();
        });
    }

    it('the photo step\'s and Safety Backup\'s Next are each in a StepAction', () => {
        const nexts = [...welcome.matchAll(/\{t\('Next →'\)\}/g)].map((m) => m.index!);
        expect(nexts).toHaveLength(2);
        for (const at of nexts) {
            const open = welcome.lastIndexOf('<StepAction>', at);
            const close = welcome.indexOf('</StepAction>', open);
            expect(open).toBeGreaterThan(-1);
            expect(close).toBeGreaterThan(at);
            expect((welcome.slice(open, close).match(/<button/g) ?? []).length).toBe(1);
        }
    });

    it('sticks to the bottom of the window, in the card\'s colours and across its padding, above the home indicator', () => {
        render(<StepAction><button type="button">Next →</button></StepAction>);
        const bar = screen.getByTestId('step-action');
        expect(bar.style.position).toBe('sticky');
        expect(bar.style.bottom).toBe('0px');
        // jsdom drops a calc() with env() from the style it keeps, so the iPhone's home indicator is read from the source.
        expect(readFileSync(join(__dirname, 'StepAction.tsx'), 'utf8')).toContain("paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))'");
        expect(bar.className).toContain('bg-white');
        expect(bar.className).toContain('dark:bg-nature-900');
        expect(bar.className).toContain('-mx-8');
        expect(bar.className).toContain('max-[359px]:-mx-4');
        expect(screen.getByRole('button', { name: 'Next →' })).toBeTruthy();
    });
});

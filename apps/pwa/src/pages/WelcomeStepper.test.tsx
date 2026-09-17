import { render, screen, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import React from 'react';
import { OnboardingStepper } from './WelcomePage';

// The Welcome page is the first screen a new member sees. At 320px with 1.3x text the stepper's
// fixed-width, non-wrapping step labels pushed it out to 376px and the page scrolled sideways.
describe('OnboardingStepper on a 320px screen', () => {
    it('lays the four steps out as equal columns that can shrink', () => {
        render(<OnboardingStepper step={1} />);
        const stepper = screen.getByTestId('onboarding-stepper');

        expect(stepper.style.display).toBe('grid');
        expect(stepper.style.gridTemplateColumns).toBe('repeat(4, minmax(0, 1fr))');
        expect(stepper.style.width).toBe('100%');

        const columns = Array.from(stepper.children) as HTMLElement[];
        expect(columns).toHaveLength(4);
        for (const column of columns) {
            expect(column.style.minWidth).toBe('0px');
            expect(column.style.width).toBe('');
        }
    });

    it('lets every step label wrap instead of overflowing', () => {
        render(<OnboardingStepper step={3} />);
        const stepper = screen.getByTestId('onboarding-stepper');

        for (const label of ['Your Name', 'Your Photo', 'Safety Backup', 'How it Works']) {
            const el = within(stepper).getByText(label);
            expect(el.style.whiteSpace).toBe('normal');
            expect(el.style.maxWidth).toBe('100%');
        }
    });
});

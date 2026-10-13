/**
 * The tour's bar and the "?"'s dialog in the web app (scratch/global-node/DESIGN-getting-started-fable.md §2, §4), with
 * the real steps and words (@beanpool/core tour.ts) and the bundled guide. Colour and fit at 320 px / 130% are the
 * Playwright check's (scratch, the PR's numbers); this is the tree, its words, its roles and its taps.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HELP_MAP, helpSheetFor, tourSteps, webHelpKey } from '@beanpool/core';
import { TourBar } from './TourBar';
import { HelpDialog } from './HelpDialog';
import { getBundledGuide } from '../lib/guide';

afterEach(cleanup);

const home = (on: string[] = []) => ({
    chips: ['steps', 'market', 'beans'], chipName: (t: string) => ({ steps: 'First steps', market: 'New in the Market', beans: 'Your Beans' } as Record<string, string>)[t],
    onHome: (t: string) => on.includes(t), addChip: vi.fn(), moreCards: vi.fn(),
});

describe('the tour bar', () => {
    for (const node of [{ global: false, beans: true }, { global: true, beans: false }]) {
        const steps = tourSteps('web', node);
        it(`${node.global ? 'global' : 'local'}: each of the ${steps.length} steps says "Step n of ${steps.length}", its words (a polite live region), Skip and Next (Done last)`, () => {
            steps.forEach((step, i) => {
                const on = { onNext: vi.fn(), onSkip: vi.fn(), onDone: vi.fn() };
                render(<TourBar steps={steps} index={i} home={home()} {...on} />);
                expect(screen.getByTestId('tour-step-caption')).toHaveTextContent(`Step ${i + 1} of ${steps.length}`);
                expect(screen.getByTestId('tour-words')).toHaveTextContent(step.words);
                expect(screen.getByTestId('tour-words')).toHaveAttribute('aria-live', 'polite');
                // Focus goes to the step's words, so a screen reader reads each step as it comes.
                expect(document.activeElement).toBe(screen.getByTestId('tour-words'));
                fireEvent.click(screen.getByRole('button', { name: 'Skip the tour' }));
                expect(on.onSkip).toHaveBeenCalled();
                const last = i === steps.length - 1;
                fireEvent.click(screen.getByTestId(last ? 'tour-done' : 'tour-next'));
                expect(last ? on.onDone : on.onNext).toHaveBeenCalled();
                cleanup();
            });
        });
    }

    it('is no dialog and holds nothing behind it: a labelled strip, no backdrop, no aria-modal', () => {
        const steps = tourSteps('web', { global: false, beans: true });
        render(<TourBar steps={steps} index={1} home={null} onNext={vi.fn()} onSkip={vi.fn()} onDone={vi.fn()} />);
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(document.querySelector('[aria-modal]')).toBeNull();
        expect(screen.getByRole('region', { name: 'A look around the app' })).toBe(screen.getByTestId('tour-bar'));
        expect(screen.getByTestId('tour-bar').className).not.toMatch(/inset-0|top-0/);
    });

    it('the last step: three chips, one on Home reads "On Home ✓" and is disabled, More cards opens Add a card', () => {
        const steps = tourSteps('web', { global: false, beans: true });
        const h = home(['market']);
        render(<TourBar steps={steps} index={steps.length - 1} home={h} onNext={vi.fn()} onSkip={vi.fn()} onDone={vi.fn()} />);
        expect(screen.getByTestId('tour-chip-market')).toHaveTextContent('New in the Market · On Home ✓');
        expect(screen.getByTestId('tour-chip-market')).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Put Your Beans on Home' }));
        expect(h.addChip).toHaveBeenCalledWith('beans');
        fireEvent.click(screen.getByTestId('tour-more-cards'));
        expect(h.moreCards).toHaveBeenCalled();
    });
});

describe('the "?" dialog', () => {
    const guide = getBundledGuide();
    it('every web tab and Settings has a title and words from the bundled guide, and a page or section to read', () => {
        for (const tab of ['home', 'marketplace', 'map', 'projects', 'messages', 'people', 'ledger']) {
            const key = webHelpKey({ tab });
            const sheet = helpSheetFor(guide, key);
            expect(HELP_MAP[key], tab).toBeTruthy();
            expect(sheet.title && sheet.text, tab).toBeTruthy();
        }
        expect(helpSheetFor(guide, webHelpKey({ tab: 'home', settings: true })).section).toBe('settings');
    });

    it('a real dialog, labelled by the page title, with Read the guide page, Search the guide, Take the tour again', () => {
        const sheet = helpSheetFor(guide, 'market');
        const on = { onReadPage: vi.fn(), onSearch: vi.fn(), onTour: vi.fn(), onClose: vi.fn() };
        render(<HelpDialog sheet={sheet} tourOpen={false} canTour {...on} />);
        expect(screen.getByRole('dialog', { name: sheet.title! })).toBeTruthy();
        expect(screen.getByTestId('help-text')).toHaveTextContent(sheet.text!);
        fireEvent.click(screen.getByRole('button', { name: 'Read the guide page ›' }));
        fireEvent.click(screen.getByRole('button', { name: 'Search the guide' }));
        fireEvent.click(screen.getByRole('button', { name: 'Take the tour again' }));
        expect(on.onReadPage).toHaveBeenCalled();
        expect(on.onSearch).toHaveBeenCalled();
        expect(on.onTour).toHaveBeenCalled();
        fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
        expect(on.onClose).toHaveBeenCalled();
    });

    it('never dead: no words still gives Search and the tour, never "no help here"; Pick up the tour while one runs', () => {
        render(<HelpDialog sheet={{ title: null, text: null, slug: null, section: null }} tourOpen canTour onReadPage={vi.fn()} onSearch={vi.fn()} onTour={vi.fn()} onClose={vi.fn()} />);
        expect(screen.queryByTestId('help-read-page')).toBeNull();
        expect(screen.getByTestId('help-search')).toBeTruthy();
        expect(screen.getByTestId('help-tour')).toHaveTextContent('Pick up the tour');
        expect(document.body.textContent).not.toMatch(/no help/i);
    });
});

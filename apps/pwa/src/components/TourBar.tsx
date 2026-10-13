import { useEffect, useRef } from 'react';
import { tourStepCaption, type TourStep } from '@beanpool/core';
import type { TourHome } from '../lib/tour-store';

const primary = 'min-w-[96px] min-h-[44px] px-4 rounded-xl border-0 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400';
const quiet = 'min-w-[44px] min-h-[44px] px-3 rounded-xl border-0 bg-transparent text-sm font-bold text-emerald-800 dark:text-emerald-300 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';
const chip = 'min-h-[44px] px-3 rounded-full border text-sm font-bold break-words text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';

/**
 * The tour's bar in the web app (scratch/global-node/DESIGN-getting-started-fable.md §2): a card-coloured strip above the
 * mobile bottom nav (a panel bottom-right beside the sidebar on a desktop). One or two sentences, "STEP 2 OF 7", Skip and
 * Next ›; the page behind is the real tab and stays live: the bar is no dialog and takes only its own strip. The words
 * are a polite live region and take focus on each step, so a screen reader reads each step as it comes. The last step
 * adds the three chips, More cards › and Done.
 */
export function TourBar({ steps, index, home, onNext, onSkip, onDone }: {
    steps: readonly TourStep[];
    index: number;
    home: TourHome | null;
    onNext: () => void;
    onSkip: () => void;
    onDone: () => void;
}) {
    const words = useRef<HTMLParagraphElement>(null);
    useEffect(() => { words.current?.focus({ preventScroll: true }); }, [index]);
    const step = steps[index];
    if (!step) return null;
    const last = index === steps.length - 1;
    const chips = last && home ? home.chips : [];
    return (
        <section
            aria-label="A look around the app"
            data-testid="tour-bar"
            className="fixed left-0 right-0 md:left-auto md:right-4 md:w-[360px] md:rounded-2xl md:bottom-4 border-t md:border border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-900 shadow-lg px-4 pt-3 pb-3 min-w-0"
            style={{ bottom: 'var(--bottom-nav-offset, 0px)', zIndex: 90 }}
        >
            <p className="m-0 text-[0.6875rem] font-bold uppercase tracking-wide text-nature-700 dark:text-nature-300" data-testid="tour-step-caption">
                {tourStepCaption(index, steps.length)}
            </p>
            <p ref={words} tabIndex={-1} aria-live="polite" data-testid="tour-words"
                className="m-0 mt-1 text-[0.9375rem] leading-snug text-nature-950 dark:text-white break-words focus:outline-none">
                {step.words}
            </p>
            {chips.length > 0 && home && (
                <div className="flex flex-wrap gap-2 mt-2" data-testid="tour-chips">
                    {chips.map(type => {
                        const on = home.onHome(type);
                        const name = home.chipName(type);
                        return (
                            <button key={type} type="button" disabled={on} onClick={() => home.addChip(type)} data-testid={`tour-chip-${type}`}
                                aria-label={on ? `${name} is on Home` : `Put ${name} on Home`}
                                className={`${chip} ${on ? 'border-nature-300 dark:border-nature-700 bg-nature-100 dark:bg-nature-800 text-nature-700 dark:text-nature-200 cursor-default' : 'border-emerald-700 dark:border-emerald-400 bg-transparent text-emerald-800 dark:text-emerald-300 cursor-pointer'}`}>
                                {on ? `${name} · On Home ✓` : name}
                            </button>
                        );
                    })}
                    <button type="button" onClick={home.moreCards} className={quiet} data-testid="tour-more-cards" aria-label="More cards: open Add a card">More cards ›</button>
                </div>
            )}
            <div className="flex items-center justify-between gap-2 mt-2">
                <button type="button" onClick={onSkip} className={quiet} data-testid="tour-skip" aria-label="Skip the tour">Skip</button>
                <button type="button" onClick={last ? onDone : onNext} className={primary} data-testid={last ? 'tour-done' : 'tour-next'}
                    aria-label={last ? 'Done: end the tour' : `Next: step ${index + 2} of ${steps.length}`}>
                    {last ? 'Done' : 'Next ›'}
                </button>
            </div>
        </section>
    );
}

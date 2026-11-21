import { stepDot, t, type JoinStep } from '@beanpool/core';

/**
 * The web join's step bar (DESIGN-onboarding-home-landing-fable.md §3.1 and §5, slice W1), as the phone's
 * (apps/native/components/welcome/StepDots.tsx): ‹ on the left where the step has a way back, then one dot per step this
 * join shows (core join-steps.ts, the rule both apps read), filled up to this one, no words on screen. A screen reader hears
 * "Step 2 of 3" once.
 *
 * Replaces the labelled stepper of old (Your Name, Your Photo, Safety Backup, How it Works): at 320 px and 130 % text its
 * labels broke inside words, and below 360 px they were hidden for a line of their own. Dots fit any number.
 *
 * Colours from the central tokens only: the brand ink (`ink.brand`) for the dots, the heading ink for ‹.
 */
export function StepDots({ steps, step, onBack, backLabel, busy = false }: {
    /** This join's steps (core `joinStepList`). */
    steps: readonly JoinStep[];
    step: JoinStep;
    /** ‹: absent where the step has nothing to go back to (a join already in at the node). */
    onBack?: () => void;
    backLabel?: string;
    /** The step's request is out: ‹ waits, faded. */
    busy?: boolean;
}) {
    const dot = stepDot(steps, step);
    if (!dot && !onBack) return null;
    return (
        <div data-testid="step-dots" className="flex items-center mb-4 min-h-[48px]">
            <div className="w-12 shrink-0">
                {onBack && (
                    <button type="button" onClick={onBack} disabled={busy} aria-label={backLabel ?? t('Back')} data-testid="step-dots-back"
                        className="w-12 h-12 rounded-full flex items-center justify-center bg-transparent border-none text-text-primary text-4xl leading-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-brand">
                        <span aria-hidden="true">‹</span>
                    </button>
                )}
            </div>
            <div className="flex-1 flex justify-center gap-2.5">
                {dot && (
                    <>
                        <span className="sr-only" data-testid="step-dots-steps">{t('Step {n} of {total}', { n: dot.at, total: dot.of })}</span>
                        {Array.from({ length: dot.of }, (_, i) => (
                            <span key={i} aria-hidden="true" data-testid={i < dot.at ? 'step-dots-on' : 'step-dots-off'}
                                className={`block w-3 h-3 rounded-full border-2 border-bp-ink-brand ${i < dot.at ? 'bg-bp-ink-brand' : 'bg-transparent'}`} />
                        ))}
                    </>
                )}
            </div>
            {/* The same width as ‹'s side, so the dots sit in the middle. */}
            <div className="w-12 shrink-0" />
        </div>
    );
}

import type { ReactNode } from 'react';

/**
 * A join step's main button, kept on screen (Damo, 9 Nov: "the counter-intuitive 'Next' button and the following 'Let's
 * Begin!' buttons being right on the bottom of the screen and forcing me to scroll down before I can even see them"). The
 * phone's twin is apps/native/components/welcome/StepFooter.tsx.
 *
 * Sticky at the bottom of the window: while the step is taller than the screen the button stays in view, the step's words
 * scrolling behind it, and it settles in its place under them once they are all on screen. In the welcome card's own colours
 * and across its padding (2rem, 1rem below 360 px), so nothing shows through at its sides; above the iPhone's home indicator.
 */
export function StepAction({ children }: { children: ReactNode }) {
    return (
        <div
            data-testid="step-action"
            className="bg-white dark:bg-nature-900 -mx-8 px-8 max-[359px]:-mx-4 max-[359px]:px-4"
            style={{
                position: 'sticky',
                bottom: 0,
                zIndex: 1,
                paddingTop: '0.75rem',
                paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))',
            }}
        >
            {children}
        </div>
    );
}

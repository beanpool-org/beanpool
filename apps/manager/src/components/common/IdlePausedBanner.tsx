import React from 'react';
import { useActivityPause } from '../../lib/activity-pause';

/**
 * Shown when this screen has stopped refreshing itself because nobody has touched it for ten
 * minutes (lib/activity-pause). Calm on purpose: nothing is wrong, and nothing was lost — the
 * numbers on screen are simply as old as the banner says the pause is.
 *
 * Nothing is shown for a hidden tab: there is nobody looking at it, and it resumes on its own the
 * moment it comes back.
 */
export function IdlePausedBanner() {
    const { reason, resume } = useActivityPause();
    if (reason !== 'idle') return null;

    return (
        <div
            role="status"
            className="bg-nature-900/80 border-b border-nature-800 px-4 sm:px-6 py-2.5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-xs text-nature-300"
        >
            <span>
                <span aria-hidden="true">⏸ </span>
                Updates paused while you&rsquo;re away
            </span>
            <button
                type="button"
                onClick={resume}
                className="min-h-[36px] px-3 rounded-lg bg-nature-800 hover:bg-nature-700 border border-nature-700 text-nature-100 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-terra-400"
            >
                Resume
            </button>
        </div>
    );
}

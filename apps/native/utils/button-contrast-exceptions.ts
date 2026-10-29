/**
 * The reviewed exceptions to the phone's button-contrast check (utils/button-contrast.ts, run as `native_dark_contrast`
 * by scripts/test-all.sh).
 *
 * The check fails when a piece of words sits on a background the same screen sets, and the two reach less than 4.5:1
 * (3:1 for words of 24px, or 18.66px and bold) in light or in dark. An entry here excuses ONE such pair, in one file.
 * It starts empty and is meant to stay that way: a pair that reads badly is fixed in the screen (fill under words is
 * brand.fill with text.onBrand, never text.heading with text.inverse - they are the same white in dark), not listed.
 *
 * An entry needs all of:
 *   file        the screen or component, relative to apps/native (as the check prints it)
 *   words       the words' colour expression exactly as the screen writes it, e.g. `colors.text.inverse`
 *   background  the nearest background's expression exactly as written, e.g. `colors.text.heading`
 *   theme       'light' | 'dark' to excuse one theme only; leave out for both
 *   reason      why the pair is not a defect (at least 30 characters): what else makes the words readable, or why
 *               the element is never drawn that way. A bare "false positive" is refused.
 *
 * An entry that no longer excuses a failing pair is itself a failure ("stale"): delete it in the change that fixed
 * the pair, so the list only ever holds live exceptions.
 */
export interface ContrastException {
    file: string;
    words: string;
    background: string;
    theme?: 'light' | 'dark';
    reason: string;
}

export const BUTTON_CONTRAST_EXCEPTIONS: readonly ContrastException[] = [];

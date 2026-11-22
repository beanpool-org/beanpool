/**
 * A text box's placeholder on its one line, whatever the screen and its text size (walk-s6, 23 Nov 2026, at 320 dp with
 * 1.3× text: a group's chat box wrapped "Message River Clean-up…" to two lines and its one-line height cut the second; Chat's
 * search box showed "Search ch"). Android neither wraps a one-line box's placeholder nor ends it with "…": it cuts it.
 *
 * Widths are estimated, about 0.6 em a character in the phone's font, as the walk measured it (18 characters to a line in a
 * 214 dp box of 16 sp text at 1.3×).
 */
import { t } from '@beanpool/core';

const EM_PER_CHARACTER = 0.6;

/** About how wide `words` draw at `fontSp` and `fontScale` (Android never draws text smaller than 1×), in dp. */
export function textWidthDp(words: string, fontSp: number, fontScale: number): number {
    return [...words].length * fontSp * Math.max(1, fontScale) * EM_PER_CHARACTER;
}

/** The first of `choices` that fits `roomDp` on one line, else the last (the shortest, which every caller ends with). */
export function wordsThatFit(choices: readonly string[], roomDp: number, fontSp: number, fontScale: number): string {
    return choices.find((words) => textWidthDp(words, fontSp, fontScale) <= roomDp) ?? choices[choices.length - 1];
}

/**
 * A group's or enterprise's chat box (components/chat/styles.ts): the row's 12 dp each side, Send's 40 dp and its 8 dp gap,
 * the box's own 16 dp padding each side and its border, its text 16 sp; a photo button takes 40 dp more (48 dp, less its
 * -8 dp margin).
 */
const BOX_CHROME_DP = 12 * 2 + 40 + 8 + 16 * 2 + 2;
const PHOTO_BUTTON_DP = 40;
const BOX_FONT_SP = 16;

/** The chat's name only where the whole sentence fits the box; then "Message the group…"; else "Message…": the header names the chat. */
export function groupComposerPlaceholder(
    name: string,
    kind: 'group' | 'enterprise',
    screen: { width: number; fontScale: number; photoButton: boolean },
): string {
    const room = screen.width - BOX_CHROME_DP - (screen.photoButton ? PHOTO_BUTTON_DP : 0);
    const choices = [
        ...(name.trim() ? [t('Message {name}…', { name })] : []),
        ...(kind === 'group' ? [t('Message the group…')] : []),
        t('Message…'),
    ];
    return wordsThatFit(choices, room, BOX_FONT_SP, screen.fontScale);
}

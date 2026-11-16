/**
 * How the DM screen's column (app/chat/[id].tsx, under the header) shares its room, so the message box is never cut and the
 * thread is never squeezed out (walk of 17 Nov, 320 dp at 1.3× text: a market DM's deals strip, listing header, release bar
 * and About chip filled the column, the thread had 0 dp, the box went under the navigation bar, and with the keyboard up the
 * box was entirely behind it).
 *
 * The column holds, top to bottom: the bars (the deals strip, the listing's header, the release bar; with the key card above
 * them while sending is paused), the thread, and the box: the banners over the composer (Editing, About, Replying to) and
 * the composer itself (its line, the field and Send, or the request's panel). A keyboard up takes its height off the bottom.
 * When they don't all fit, the room goes in this order:
 *
 *  1. the composer, always whole: nothing can be typed or sent otherwise;
 *  2. one line of the thread (CHAT_THREAD_LINE), so the newest message is in view and the thread can be scrolled;
 *  3. the banners over the composer, which scroll in what is left there (they say what the message is about or answers);
 *  4. the bars, which scroll as one page in what is left above the thread, and fold away while the room has none (typing on a
 *     small phone): they come back whole when the keyboard goes down. Release and Review are a scroll away, never cut off.
 *
 * A page given less than CHAT_PAGE_MIN folds away rather than show a sliver nobody can scroll or tap, and its room goes to
 * the thread. Nothing in either page is shorter than that (a banner's ✕ and every bar are 44 dp or more), so a page that
 * would fit is never folded.
 *
 * While the key card is up (sending paused) the thread gives way: the card's page takes the bars with it in the room
 * dmKeyBannerMaxHeight gives it (#3278), and the banners have all the composer leaves.
 * Every figure is in dp, read from the screen's own layout: `column` is the header's bottom to the keyboard view's bottom,
 * `box` everything under the thread as drawn (the banners as shown and the composer), `input` the composer alone.
 * Before the column is measured (the first frame), 55% of the window, as dmKeyBannerMaxHeight does.
 */
/**
 * One line of the thread at 320 dp and 1.3× text: a line of a message (22 dp × 1.3) with its bubble's padding, and a
 * 44-dp target to drag the thread by. The rest of a line is a scroll away.
 */
export const CHAT_THREAD_LINE = 44;

/** The least room a page is shown in: a 44-dp target, to scroll it or tap what is in it. */
export const CHAT_PAGE_MIN = 44;

const pageRoom = (room: number) => (room < CHAT_PAGE_MIN ? 0 : room);

export interface ChatColumnMeasure {
    /** The header's bottom to the keyboard view's bottom; 0 until measured. */
    column: number;
    /** Everything under the thread as drawn: the banners over the composer as shown, and the composer. 0 until measured. */
    box: number;
    /** The composer alone (its line, the field and Send, or a request's panel). 0 until measured. */
    input: number;
    windowHeight: number;
    /** The keyboard's height while it is up, else 0. */
    keyboard: number;
    /** The key card is up: nothing can be sent, and the thread gives way to its page. */
    paused: boolean;
}

export interface ChatColumnFit {
    /** The most the bars may take without the key card; a page taller than this scrolls in it. */
    bars: number;
    /** The most the banners over the composer may take; taller, they scroll in it. */
    banners: number;
    /** The thread's floor, kept before the banners and the bars get anything. */
    threadLine: number;
}

export function chatColumnFit(m: ChatColumnMeasure): ChatColumnFit {
    const keyboard = Math.max(0, m.keyboard);
    const column = m.column > 0 ? m.column : Math.round(m.windowHeight * 0.55);
    const room = Math.max(0, Math.round(column - keyboard));
    const input = Math.max(0, m.input);
    const box = Math.max(0, m.box);
    const threadLine = m.paused ? 0 : Math.min(CHAT_THREAD_LINE, Math.max(0, room - input));
    const banners = pageRoom(room - input - threadLine);
    const bars = pageRoom(room - box - threadLine);
    return { bars, banners, threadLine };
}

/**
 * How the DM screen's column (app/chat/[id].tsx, under the header) shares its room, so the message box is never cut, the
 * Editing or Replying to banner over it never leaves view while typing, and the thread is never squeezed out (walk of
 * 17 Nov, 320 dp at 1.3× text: a market DM's deals strip, listing header, release bar and About chip filled the column, the
 * thread had 0 dp, the box went under the navigation bar, and with the keyboard up the box was entirely behind it).
 *
 * The column holds, top to bottom: the bars (the deals strip, the listing's header, the release bar; with the key card above
 * them while sending is paused), the thread, and the box: the About chip, the Editing or Replying to banner, and the composer
 * (its line, the field and Send, or the request's panel). A keyboard up takes its height off the bottom. When they don't all
 * fit, the room goes in this order:
 *
 *  1. the composer, always whole: nothing can be typed or sent otherwise;
 *  2. the Editing or Replying to banner, whole and next to the composer: it is the only sign that Send will change an old
 *     message or answer one, and its ✕ the only way out while typing (deciding review of f4bbcfa4, finding 1). The
 *     composer's field gives way to it first: past the room the banner leaves, the field stops growing and scrolls within
 *     itself, never under its one line (chatFieldCap). Only when the field is down to that line and they still don't fit
 *     is the banner's own padding cropped, its words and ✕ centred in what is left;
 *  3. one line of the thread (CHAT_THREAD_LINE), so the newest message is in view and the thread can be scrolled;
 *  4. the bars and then the About chip give way, in that order: the deals strip, the listing's header and the release bar
 *     are one page in what is left above the thread, kept scrolled to its end so the deals strip goes first; once that page
 *     has folded the About chip is a page in what is left over the box. Each folds away while its room has none (typing on
 *     a small phone) and comes back whole when the keyboard goes down. Release and Review are a scroll away, never cut off.
 *
 * A page given less than CHAT_PAGE_MIN folds away rather than show a sliver nobody can scroll or tap, and its room goes to
 * the thread. Nothing in either page is shorter than that (every bar and the About chip's ✕ are 44 dp or more), so a page
 * that would fit is never folded.
 *
 * While a line's menu is open (tapped or held: Reply, React, Edit and Delete beside it, Copy and Report under it, or the
 * emoji row), the thread's floor is CHAT_MENU_ROOM instead of one line, so the line and its menu are in view: the bars and
 * then the About chip give way to it as they do to the composer, and come back when the menu closes. In one line of thread
 * only Copy showed, and dragging the thread to reach Reply or Edit closes the menu (emulator walk 146, 17 Nov: the walk's
 * market DM at 320 dp and 1.3×, both themes). A phone with room for it all moves nothing.
 *
 * While the key card is up (sending paused) the thread gives way: the card's page takes the bars with it in the room
 * dmKeyBannerMaxHeight gives it (#3278), and the About chip has all the composer and the banner leave.
 * Every figure is in dp, read from the screen's own layout: `column` is the header's bottom to the keyboard view's bottom,
 * `box` everything under the thread as drawn, `input` the composer alone, `banner` the Editing or Replying to banner laid
 * out whole. Before the column is measured (the first frame), 55% of the window, as dmKeyBannerMaxHeight does.
 */
import { CHAT_INPUT_MAX_HEIGHT, CHAT_INPUT_MIN_HEIGHT } from '../components/chat/styles';

/**
 * One line of the thread at 320 dp and 1.3× text: a line of a message (22 dp × 1.3) with its bubble's padding, and a
 * 44-dp target to drag the thread by. The rest of a line is a scroll away.
 */
export const CHAT_THREAD_LINE = 44;

/**
 * The thread's floor while a line's menu is open: a line and its menu at 320 dp and 1.3× text. The walk's two-line line
 * (83 dp) with Copy (44) and Report (43) under it took 174 dp (emulator walk 146); this holds a line of four lines with
 * them, or one of mine with the "You can edit a message for 15 minutes" note and Copy. The menu's buttons sit beside the
 * line, so a longer line keeps them in view with its top cut.
 */
export const CHAT_MENU_ROOM = 240;

/** The least room a page is shown in: a 44-dp target, to scroll it or tap what is in it. */
export const CHAT_PAGE_MIN = 44;

const pageRoom = (room: number) => (room < CHAT_PAGE_MIN ? 0 : room);

export interface ChatColumnMeasure {
    /** The header's bottom to the keyboard view's bottom; 0 until measured. */
    column: number;
    /** Everything under the thread as drawn: the About chip as shown, the banner and the composer. 0 until measured. */
    box: number;
    /** The composer alone (its line, the field and Send, or a request's panel). 0 until measured. */
    input: number;
    /** The Editing or Replying to banner laid out whole; 0 with neither (or until measured). */
    banner: number;
    windowHeight: number;
    /** The keyboard's height while it is up, else 0. */
    keyboard: number;
    /** The key card is up: nothing can be sent, and the thread gives way to its page. */
    paused: boolean;
    /** A line's menu (or its emoji row) is open: the thread's floor is CHAT_MENU_ROOM until it closes. */
    menu?: boolean;
}

export interface ChatColumnFit {
    /** The most the composer may take (ChatComposer's maxHeight): the room less the banner. Its field stops growing there. */
    composer: number;
    /** The most the Editing or Replying to banner is shown in: whole unless the composer at its least leaves less. */
    banner: number;
    /** The most the About chip may take; taller, it scrolls in it. */
    about: number;
    /** The most the bars may take without the key card; a page taller than this scrolls in it. */
    bars: number;
    /** The thread's floor, kept before the About chip and the bars get anything. */
    threadLine: number;
}

export function chatColumnFit(m: ChatColumnMeasure): ChatColumnFit {
    const keyboard = Math.max(0, m.keyboard);
    const column = m.column > 0 ? m.column : Math.round(m.windowHeight * 0.55);
    const room = Math.max(0, Math.round(column - keyboard));
    const input = Math.max(0, m.input);
    const box = Math.max(0, m.box);
    const banner = Math.max(0, m.banner);
    // The banner never counts on its own crop: the composer's room leaves it whole, and it is cropped only by what the
    // composer, once at its least, takes.
    const composer = Math.max(0, room - banner);
    const bannerRoom = Math.max(0, room - input);
    const bannerShown = Math.min(banner, bannerRoom);
    const left = Math.max(0, room - input - bannerShown);
    const threadLine = m.paused ? 0 : Math.min(m.menu ? CHAT_MENU_ROOM : CHAT_THREAD_LINE, left);
    const about = pageRoom(room - input - bannerShown - threadLine);
    const bars = pageRoom(room - box - threadLine);
    return { composer, banner: bannerRoom, about, bars, threadLine };
}

/**
 * The composer's field in its room (components/chat/ChatComposer): it grows to CHAT_INPUT_MAX_HEIGHT, or only as far as the
 * room less the composer's own frame (its padding, border and any line over the field) allows, and never under its one line
 * (CHAT_INPUT_MIN_HEIGHT). Past that the field scrolls within itself. Without a room, CHAT_INPUT_MAX_HEIGHT.
 */
export function chatFieldCap(room: number | undefined, frame: number): number {
    if (room === undefined || !Number.isFinite(room)) return CHAT_INPUT_MAX_HEIGHT;
    return Math.max(CHAT_INPUT_MIN_HEIGHT, Math.min(CHAT_INPUT_MAX_HEIGHT, Math.floor(room - Math.max(0, frame))));
}

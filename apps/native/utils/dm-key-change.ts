/**
 * The words and styles of the DM screen's "key changed" banner and of Settings → "My key code" (DESIGN-dm-peer-key-pin
 * §3.5, slice 2), as plain functions and objects so utils/__tests__/dm-key-change-banner.test.ts can hold them to the
 * small-screen rules without a device: no fixed width or height (text wraps at 320 dp and 1.3× text), buttons stacked,
 * every touch target at least 48 dp, and text at 4.5:1 or better on its background in light and dark.
 *
 * The banner never decides anything by itself. "Continue with the new key" is offered only after the member ticks that
 * they checked the code with the person (pick 1). What the node says about a re-key is only a line of words here, never
 * a reason to continue (pick 4).
 */
import { t, word, formatDate } from '@beanpool/core';
import { type AppColors } from '../constants/colors';

/** The name as the banner says it: the node's callsign, or "this person" while it is unknown. */
function nameOf(peerName?: string | null): string {
    const n = peerName?.trim();
    return n && n !== 'Loading...' ? n : 'this person';
}

/** "3 Oct 2026" (in en) for an ISO date, or null for anything that isn't one. */
export function rekeyedOnText(iso?: string | null): string | null {
    if (!iso) return null;
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return null;
    // The words layer's one table of month names (core words.ts), read in UTC as the node fixed it: "3 Oct 2026" in en.
    return formatDate(new Date(ms), 'day-month-year', { utc: true });
}

export interface DmKeyChangeCopyInput {
    peerName?: string | null;
    /** The new key's code (utils/key-code.ts), or null when there is no one key to continue with. */
    code: string | null;
    /**
     * The first-sight case (§3.4 amendment, rules 3-4): this phone is checking the chat from the start (after a restore,
     * or an update meeting a DM with two keys in its rows), and the earlier messages came from another key than the one
     * on offer.
     */
    firstSight: boolean;
    /**
     * The first-sight pause was made by the re-seed after the member reset this community's chat memory (§3.4 amendment 7
     * §1): the banner opens with the reset's sentence in the restored-phone sentence's place.
     */
    afterReset?: boolean;
    /** The date the node says the account was re-keyed (slice 3), when it says so. */
    rekeyedAt?: string;
}

export interface DmKeyChangeCopy {
    title: string;
    body: string;
    /** "This community says…", only when the node gives a date. */
    dateLine: string | null;
    /** The member's tick before "Continue" appears to work; null when there is nothing to continue with. */
    confirm: string | null;
    continueLabel: string | null;
    notNowLabel: string;
}

/** The first-sight banner's opening sentence (design §3.4 amendment), true after a restore and after an update alike. */
export const DM_FIRST_SIGHT_LEAD = word('This phone is checking this chat from the start, as it does after you restore it or update the app.');

/** The opening sentence when the member's reset of this community's chat memory made the pause (§3.4 amendment 7 §1). */
export const DM_RESET_LEAD = word("This community's chat memory was reset, so this phone is checking this chat from the start.");

const LEADS = { firstSight: DM_FIRST_SIGHT_LEAD, reset: DM_RESET_LEAD } as const;

/** The banner's words. */
export function dmKeyChangeCopy({ peerName, code, firstSight, afterReset, rekeyedAt }: DmKeyChangeCopyInput): DmKeyChangeCopy {
    const name = nameOf(peerName);
    const title = t('The key behind "{name}" changed.', { name });
    const on = rekeyedOnText(rekeyedAt);
    const dateLine = on ? t('This community says the account was re-keyed on {on}.', { on }) : null;
    if (!code) {
        return {
            title,
            body: t('This community now lists more than one other key in this chat, so there is no one key to continue with. Nothing will be sent here. To keep talking with {name}, start a new chat with them.', { name }),
            dateLine, confirm: null, continueLabel: null, notNowLabel: t('Not now'),
        };
    }
    // The first-sight case opens with the amendment's sentence, worded so it is true after an update too (P17), not only
    // after a restore. Each sentence is translated whole; the lead and the rest are joined with one space.
    const said: string[] = [];
    if (firstSight) {
        if (afterReset) said.push(t(LEADS.reset));
        else said.push(t(LEADS.firstSight));
        said.push(t('The earlier messages here came from a different key than the one this community now gives for {name}. Anything you send now would go to the new key. Check with {name} first, in person or on a call: their key code should be', { name }));
    } else {
        said.push(t('Anything you send now would go to the new key. If {name} got a new phone and re-keyed, check with them first, in person or on a call: their key code should be', { name }));
    }
    return {
        title, body: said.join(' '), dateLine,
        confirm: t('I checked with {name}: the key code in their Settings matches this one.', { name }),
        continueLabel: t('Continue with the new key'),
        notNowLabel: t('Not now'),
    };
}

/** Settings → "My key code": what the member reads next to their own code. */
export const MY_KEY_CODE_COPY = {
    title: word('My key code'),
    body: word("If a chat with you ever says your key changed, the other person can check this code against the one their phone shows. It isn't secret: it's safe to read out."),
    unknown: word('Your key code shows here once this phone has your key.'),
} as const;

/** What you press. Each has minHeight ≥ 48. */
export const DM_KEY_CHANGE_TOUCH_TARGETS = ['continueBtn', 'notNowBtn', 'confirmRow'] as const;

/** Text entries and the background each sits on, for the contrast check. */
export const DM_KEY_CHANGE_TEXT_ON = {
    title: 'banner',
    body: 'banner',
    code: 'codeBox',
    dateLine: 'banner',
    confirmText: 'confirmRow',
    continueText: 'continueBtn',
    continueTextOff: 'continueBtnOff',
    notNowText: 'notNowBtn',
    myCodeTitle: 'myCodeCard',
    myCode: 'codeBox',
    myCodeBody: 'myCodeCard',
} as const;

/** The banner's and the key code card's styles, for StyleSheet.create inside useStyles (the theme switch restyles them). */
export function dmKeyChangeStyleSpec(colors: AppColors) {
    const warn = colors.feedback.warning;
    return {
        banner: { backgroundColor: warn.bg, borderColor: warn.border, borderWidth: 1, borderRadius: 12, padding: 12, marginHorizontal: 12, marginTop: 8, gap: 8 },
        title: { color: colors.text.heading, fontSize: 16, fontWeight: '700' as const },
        body: { color: colors.text.heading, fontSize: 14, lineHeight: 20 },
        // The code wraps as whole groups at 320 dp and 1.3× text (spaces between them), never cut.
        codeBox: { backgroundColor: colors.surface.card, borderColor: warn.border, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
        code: { color: colors.text.heading, fontSize: 18, fontWeight: '700' as const, letterSpacing: 1, fontVariant: ['tabular-nums'] as ('tabular-nums')[] },
        dateLine: { color: colors.text.heading, fontSize: 13, fontStyle: 'italic' as const },
        confirmRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 10, minHeight: 48, paddingVertical: 4, backgroundColor: warn.bg },
        confirmBox: { borderColor: colors.text.heading, borderWidth: 2, borderRadius: 4, minWidth: 22, minHeight: 22, alignItems: 'center' as const, justifyContent: 'center' as const },
        confirmTick: { color: colors.text.heading, fontSize: 14, fontWeight: '700' as const },
        confirmText: { color: colors.text.heading, fontSize: 14, flex: 1, flexShrink: 1 },
        // Stacked, full width: two buttons never share a row at 320 dp.
        buttons: { flexDirection: 'column' as const, gap: 8 },
        continueBtn: { backgroundColor: colors.brand.fill, borderRadius: 10, minHeight: 48, paddingHorizontal: 14, paddingVertical: 10, alignItems: 'center' as const, justifyContent: 'center' as const },
        continueBtnOff: { backgroundColor: colors.surface.subtle, borderColor: colors.border.strong, borderWidth: 1 },
        continueText: { color: colors.text.onBrand, fontSize: 15, fontWeight: '700' as const, textAlign: 'center' as const },
        continueTextOff: { color: colors.text.secondary },
        notNowBtn: { backgroundColor: colors.surface.card, borderColor: colors.border.strong, borderWidth: 1, borderRadius: 10, minHeight: 48, paddingHorizontal: 14, paddingVertical: 10, alignItems: 'center' as const, justifyContent: 'center' as const },
        notNowText: { color: colors.text.heading, fontSize: 15, fontWeight: '600' as const, textAlign: 'center' as const },
        myCodeCard: { backgroundColor: colors.surface.card, borderColor: colors.border.default, borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 12, gap: 8 },
        myCodeTitle: { color: colors.text.heading, fontSize: 16, fontWeight: '700' as const },
        myCode: { color: colors.text.heading, fontSize: 18, fontWeight: '700' as const, letterSpacing: 1, fontVariant: ['tabular-nums'] as ('tabular-nums')[] },
        myCodeBody: { color: colors.text.secondary, fontSize: 14, lineHeight: 20 },
    };
}

/** The thread's floor under the banner: the list's own padding plus one short message at the member's text size. */
export function dmThreadFloor(fontScale: number): number {
    return Math.round(24 + 56 * Math.max(1, fontScale));
}

/** The banner always shows at least this much (its title and the start of what changed), unless the box needs it. */
export const DM_KEY_BANNER_FLOOR = 120;

/**
 * How tall the DM screen's key-changed banner may be (#1873 review, finding 7). Worked out from the column under the
 * header as measured (banner + deals strip + thread + the paused box, with the nav bar's inset in the box's padding when
 * the screen is edge-to-edge), never from a share of the window: the box is never cut, the thread keeps dmThreadFloor
 * when there is room for it and the banner's floor, and the banner never takes more than 55% of the column. The banner
 * scrolls inside whatever it gets. Before the column is measured (the first frame), 55% of the window minus the box.
 * A keyboard already up when the pause starts (#1872/#1873 confirmation 2, finding 5) is padding the KeyboardAvoidingView
 * adds inside the measured column, at most the keyboard's height, so it comes off the room like the box.
 */
export function dmKeyBannerMaxHeight(m: { column: number; composer: number; deals: number; fontScale: number; windowHeight: number; keyboard?: number }): number {
    const keyboard = Math.max(0, m.keyboard ?? 0);
    if (!(m.column > 0) || !(m.composer > 0)) return Math.max(0, Math.round(m.windowHeight * 0.55) - Math.max(0, m.composer) - keyboard);
    const room = Math.max(0, m.column - m.composer - Math.max(0, m.deals) - keyboard);
    const wanted = Math.min(room - dmThreadFloor(m.fontScale), Math.round(m.column * 0.55));
    return Math.max(0, Math.min(room, Math.round(Math.max(wanted, DM_KEY_BANNER_FLOOR))));
}

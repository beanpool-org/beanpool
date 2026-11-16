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

/**
 * The name as the banner says it: the node's callsign, or null while it is unknown. Each sentence then has a whole twin
 * for the unknown name ("this chat", "the other person", "them"), never an English word pasted into a translated one
 * (15 Oct words design, D4).
 */
function nameOf(peerName?: string | null): string | null {
    const n = peerName?.trim();
    return n && n !== 'Loading...' ? n : null;
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
    /**
     * The new key's code (utils/key-code.ts), or null when there is no one key to continue with. Under Signal's model a
     * code is only ever a verified person's new key (DESIGN-dm-key-signal-model §2.3): first sight, a rule-5 record and a
     * person not marked verified all take a single listed key by themselves, so no other card names a key.
     */
    code: string | null;
    /** The date the node says the account was re-keyed (slice 3), when it says so. */
    rekeyedAt?: string;
    /** The member marked this person verified (DESIGN-dm-key-signal-model §4): the card opens with "You marked … as verified". */
    verified?: boolean;
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

/** The banner's words. Every sentence is whole, with a twin for when the name is unknown (D4). */
export function dmKeyChangeCopy({ peerName, code, rekeyedAt, verified }: DmKeyChangeCopyInput): DmKeyChangeCopy {
    const name = nameOf(peerName);
    const title = name ? t('The key behind "{name}" changed.', { name }) : t('The key behind this chat changed.');
    const on = rekeyedOnText(rekeyedAt);
    const dateLine = on ? t('This community says the account was re-keyed on {on}.', { on }) : null;
    if (!code) {
        // A pause offering no key, or a rule-5 record: no single key listed, several or none (D2 (c)). It promises nothing
        // about when it lifts.
        return {
            title,
            body: name
                ? t("This community doesn't list a single key for {name} in this chat, so there is no key to continue with. Nothing will be sent here. Check with {name} in person or on a call.", { name })
                : t("This community doesn't list a single key for the other person in this chat, so there is no key to continue with. Nothing will be sent here. Check with them in person or on a call."),
            dateLine, confirm: null, continueLabel: null, notNowLabel: t('Not now'),
        };
    }
    // A person the member marked verified (Signal's model): the one change that still stops, and the card says why. Each
    // sentence is translated whole; they are joined with one space.
    const said: string[] = [];
    if (verified) {
        said.push(name
            ? t('You marked {name} as verified, so this phone is asking before it sends to a new key.', { name })
            : t('You marked this person as verified, so this phone is asking before it sends to a new key.'));
    }
    said.push(name
        ? t('Anything you send now would go to the new key. If {name} got a new phone and re-keyed, check with them first, in person or on a call: their key code should be', { name })
        : t('Anything you send now would go to the new key. If the other person got a new phone and re-keyed, check with them first, in person or on a call: their key code should be'));
    return {
        title, body: said.join(' '), dateLine,
        confirm: name
            ? t('I checked with {name}: the key code in their Settings matches this one.', { name })
            : t('I checked with them: the key code in their Settings matches this one.'),
        continueLabel: t('Continue with the new key'),
        notNowLabel: t('Not now'),
    };
}

/**
 * The thread's notice that the key behind a chat changed (DESIGN-dm-key-signal-model §4): a person not marked verified,
 * so the chat carried on with the new key. Information, never a warning; tapping it opens the key code screen.
 */
export function dmKeyChangedNoticeText(peerName?: string | null): string {
    const name = nameOf(peerName);
    return name
        ? t("{name}'s key changed. This usually means they got back into their account on a new phone. Tap to see their key code.", { name })
        : t("This chat's key changed. This usually means the other person got back into their account on a new phone. Tap to see their key code.");
}

/**
 * What the key code screen is showing (§3): exactly one of these under the code. 'paused': a verified person's new key
 * waits at the top of the chat; 'waiting': a pause with no single key listed (several, none, or listings that disagree),
 * verified or not, with nothing to mark while it lasts (S2).
 */
export type DmKeyCodeState = 'not-verified' | 'verified' | 'paused' | 'waiting' | 'none';

/** What the screen reads to pick its state: utils/db.ts DmKeyCodeInfo's flags. */
export interface DmKeyCodeFlags {
    verified: boolean;
    paused: boolean;
    offersKey: boolean;
}

/** The key code screen's one state under the code, for the code it shows (null: there is none). */
export function dmKeyCodeState(info: DmKeyCodeFlags | null | undefined, code: string | null): DmKeyCodeState {
    if (!code) return 'none';
    if (info?.offersKey) return 'paused';
    if (info?.paused) return 'waiting';
    return info?.verified ? 'verified' : 'not-verified';
}

/**
 * "Verified ✓", on the key code screen and beside "🔒 End-to-end encrypted" under the chat's name (§7 S2): shown exactly
 * while the person is marked verified and no new key waits for the member, so never beside a card asking about one.
 */
export function dmKeyCodeShowsVerified(info: DmKeyCodeFlags | null | undefined, code: string | null): boolean {
    const state = dmKeyCodeState(info, code);
    return !!info?.verified && (state === 'verified' || state === 'waiting');
}

export interface DmKeyCodeCopy {
    title: string;
    heading: string;
    howTo: string;
    /** The one state line or button under the code. */
    mark: string;
    markNote: string;
    verified: string;
    verifiedNote: string;
    remove: string;
    paused: string;
    /** Why sending waits while no single key is listed ('waiting'). */
    waiting: string;
    none: string;
    moved: string;
    removeConfirmTitle: string;
    /** The confirmation's body: `whilePaused` when removing it ends a pause (the chat carries on with the new key). */
    removeConfirmBody: string;
    cancel: string;
}

/** The key code screen's words (§4), each sentence whole with its unknown-name twin (D4). */
export function dmKeyCodeCopy(peerName: string | null | undefined, whilePaused = false): DmKeyCodeCopy {
    const name = nameOf(peerName);
    return {
        title: t('Key code'),
        heading: name ? t("{name}'s key code", { name }) : t("This chat's key code"),
        howTo: name
            ? t('Ask {name} to open Settings, then Account Protection, and read you My key code. Do it in person or on a call. If every digit matches, this chat is really with {name}.', { name })
            : t('Ask the other person to open Settings, then Account Protection, and read you My key code. Do it in person or on a call. If every digit matches, this chat is really with them.'),
        mark: t('Mark as verified'),
        markNote: name
            ? t('After that, this phone asks you before it sends to a new key for {name}. Kept on this phone only.', { name })
            : t('After that, this phone asks you before it sends to a new key for this person. Kept on this phone only.'),
        verified: t('Verified ✓'),
        verifiedNote: name
            ? t('This phone asks you before it sends to a new key for {name}. Kept on this phone only.', { name })
            : t('This phone asks you before it sends to a new key for this person. Kept on this phone only.'),
        remove: t('Remove verification'),
        paused: name ? t("{name}'s key changed. The new code is at the top of the chat.", { name }) : t("This chat's key changed. The new code is at the top of the chat."),
        waiting: name
            ? t("This community doesn't list a single key for {name} in this chat, so sending waits.", { name })
            : t("This community doesn't list a single key for the other person in this chat, so sending waits."),
        none: t('There is no key code to show for this chat yet.'),
        moved: t("This chat's key changed while you were checking. Look at the new code and check it again."),
        removeConfirmTitle: t('Remove verification?'),
        removeConfirmBody: whilePaused
            ? (name ? t("This chat will carry on with {name}'s new key, without the check.", { name }) : t("This chat will carry on with the other person's new key, without the check."))
            : (name ? t('This phone will stop asking before it sends to a new key for {name}.', { name }) : t('This phone will stop asking before it sends to a new key for this person.')),
        cancel: t('Cancel'),
    };
}

/** Settings → "My key code": what the member reads next to their own code. */
export const MY_KEY_CODE_COPY = {
    title: word('My key code'),
    body: word("If a chat with you ever says your key changed, the other person can check this code against the one their phone shows. It isn't secret: it's safe to read out."),
    unknown: word('Your key code shows here once this phone has your key.'),
} as const;

/** What you press. Each has minHeight ≥ 48. */
export const DM_KEY_CHANGE_TOUCH_TARGETS = ['continueBtn', 'notNowBtn', 'confirmRow', 'notice', 'markBtn', 'removeBtn'] as const;

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
    noticeText: 'notice',
    keyCodeHeading: 'keyCodeScreen',
    keyCodeTitle: 'keyCodeHeader',
    keyCodeBody: 'keyCodeScreen',
    markText: 'markBtn',
    removeText: 'removeBtn',
    verifiedText: 'keyCodeScreen',
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
        // The thread's notice (DESIGN-dm-key-signal-model §4): neutral, never the warning yellow (hex roles, so the contrast check reads them).
        // A button 48 dp high at least, wrapping freely (no line limit) at 320 dp and 1.3× text.
        notice: { backgroundColor: colors.surface.subtle, borderColor: colors.border.default, borderWidth: 1, borderRadius: 12, minHeight: 48, paddingHorizontal: 12, paddingVertical: 10, marginVertical: 12, marginHorizontal: 24, alignSelf: 'center' as const, flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8 },
        noticeText: { color: colors.text.heading, fontSize: 13, lineHeight: 18, fontWeight: '500' as const, flexShrink: 1 },
        // The key code screen (§3): a plain scrolling screen; the code reuses the banner's code box.
        keyCodeContainer: { flex: 1, backgroundColor: colors.surface.app },
        keyCodeHeader: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8, paddingHorizontal: 8, minHeight: 56, borderBottomWidth: 1, borderBottomColor: colors.border.default, backgroundColor: colors.surface.app },
        keyCodeBack: { minWidth: 48, minHeight: 48, alignItems: 'center' as const, justifyContent: 'center' as const },
        keyCodeTitle: { color: colors.text.heading, fontSize: 18, fontWeight: '700' as const, flexShrink: 1 },
        keyCodeScreen: { backgroundColor: colors.surface.app, padding: 16, gap: 12 },
        keyCodeHeading: { color: colors.text.heading, fontSize: 18, fontWeight: '700' as const },
        keyCodeBody: { color: colors.text.heading, fontSize: 14, lineHeight: 20 },
        verifiedText: { color: colors.text.heading, fontSize: 16, fontWeight: '700' as const },
        markBtn: { backgroundColor: colors.brand.fill, borderRadius: 10, minHeight: 48, paddingHorizontal: 14, paddingVertical: 10, alignItems: 'center' as const, justifyContent: 'center' as const },
        markText: { color: colors.text.onBrand, fontSize: 15, fontWeight: '700' as const, textAlign: 'center' as const },
        removeBtn: { backgroundColor: colors.surface.card, borderColor: colors.border.strong, borderWidth: 1, borderRadius: 10, minHeight: 48, paddingHorizontal: 14, paddingVertical: 10, alignItems: 'center' as const, justifyContent: 'center' as const },
        removeText: { color: colors.text.heading, fontSize: 15, fontWeight: '600' as const, textAlign: 'center' as const },
    };
}

/**
 * How tall the DM screen's key-changed card may be: the whole room above the paused box (walk of 17 Nov at 320 dp and
 * 1.3× text). The room is the column under the header as measured, less the box (everything under the thread: the
 * paused composer and any banner over it, with the nav bar's inset in its padding when the screen is edge-to-edge), the
 * deals bar and any keyboard still up. Nothing can be sent while the card is up, so the thread gives way to it: a card
 * that fits leaves the rest to the thread; one that does not fill the room and scrolls as the page, its cut edge on the
 * box, so the code, the tick and Continue are never in a small scroll inside the card (DmKeyChangedPane). The cap that
 * kept a thread floor and 55% of the column (#1873 review, finding 7) left the card 219 dp on a 320 × 569 phone at 1.3×:
 * its title and part of its body, the rest in a scroll with no hint. Before the column is measured (the first frame),
 * 55% of the window less the box and the keyboard.
 */
export function dmKeyBannerMaxHeight(m: { column: number; composer: number; deals: number; windowHeight: number; keyboard?: number }): number {
    const keyboard = Math.max(0, m.keyboard ?? 0);
    if (!(m.column > 0) || !(m.composer > 0)) return Math.max(0, Math.round(m.windowHeight * 0.55) - Math.max(0, m.composer) - keyboard);
    return Math.max(0, Math.round(m.column - m.composer - Math.max(0, m.deals) - keyboard));
}

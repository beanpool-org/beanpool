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
import { palette, type AppColors } from '../constants/colors';

/** The name as the banner says it: the node's callsign, or "this person" while it is unknown. */
function nameOf(peerName?: string | null): string {
    const n = peerName?.trim();
    return n && n !== 'Loading...' ? n : 'this person';
}

/** "3 Oct 2026" for an ISO date, or null for anything that isn't one. */
export function rekeyedOnText(iso?: string | null): string | null {
    if (!iso) return null;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return null;
    const d = new Date(t);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export interface DmKeyChangeCopyInput {
    peerName?: string | null;
    /** The new key's code (utils/key-code.ts), or null when there is no one key to continue with. */
    code: string | null;
    /** The first-sight case: no earlier key on this phone, only earlier lines that don't open under this one. */
    firstSight: boolean;
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

/** The banner's words. */
export function dmKeyChangeCopy({ peerName, code, firstSight, rekeyedAt }: DmKeyChangeCopyInput): DmKeyChangeCopy {
    const name = nameOf(peerName);
    const title = `The key behind "${name}" changed.`;
    const on = rekeyedOnText(rekeyedAt);
    const dateLine = on ? `This community says the account was re-keyed on ${on}.` : null;
    if (!code) {
        return {
            title,
            body: `This community now lists more than one other key in this chat, so there is no one key to continue with. Nothing will be sent here. To keep talking with ${name}, start a new chat with them.`,
            dateLine, confirm: null, continueLabel: null, notNowLabel: 'Not now',
        };
    }
    const body = firstSight
        ? `None of the earlier messages here open with the key this community now gives for ${name}. Anything you send would go to that key. Check with ${name} first, in person or on a call: their key code should be`
        : `Anything you send now would go to the new key. If ${name} got a new phone and re-keyed, check with them first, in person or on a call: their key code should be`;
    return {
        title, body, dateLine,
        confirm: `I checked with ${name}: the key code in their Settings matches this one.`,
        continueLabel: 'Continue with the new key',
        notNowLabel: 'Not now',
    };
}

/** Settings → "My key code": what the member reads next to their own code. */
export const MY_KEY_CODE_COPY = {
    title: 'My key code',
    body: 'If a chat with you ever says your key changed, the other person can check this code against the one their phone shows. It isn\'t secret: it\'s safe to read out.',
    unknown: 'Your key code shows here once this phone has your key.',
} as const;

/** One step darker than the brand green, so white text on it reads at 5.5:1 in both themes (as names-list-style.ts). */
const BUTTON_GREEN = palette.emerald700;

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
        continueBtn: { backgroundColor: BUTTON_GREEN, borderRadius: 10, minHeight: 48, paddingHorizontal: 14, paddingVertical: 10, alignItems: 'center' as const, justifyContent: 'center' as const },
        continueBtnOff: { backgroundColor: colors.surface.subtle, borderColor: colors.border.strong, borderWidth: 1 },
        continueText: { color: palette.white, fontSize: 15, fontWeight: '700' as const, textAlign: 'center' as const },
        continueTextOff: { color: colors.text.secondary },
        notNowBtn: { backgroundColor: colors.surface.card, borderColor: colors.border.strong, borderWidth: 1, borderRadius: 10, minHeight: 48, paddingHorizontal: 14, paddingVertical: 10, alignItems: 'center' as const, justifyContent: 'center' as const },
        notNowText: { color: colors.text.heading, fontSize: 15, fontWeight: '600' as const, textAlign: 'center' as const },
        myCodeCard: { backgroundColor: colors.surface.card, borderColor: colors.border.default, borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 12, gap: 8 },
        myCodeTitle: { color: colors.text.heading, fontSize: 16, fontWeight: '700' as const },
        myCode: { color: colors.text.heading, fontSize: 18, fontWeight: '700' as const, letterSpacing: 1, fontVariant: ['tabular-nums'] as ('tabular-nums')[] },
        myCodeBody: { color: colors.text.secondary, fontSize: 14, lineHeight: 20 },
    };
}

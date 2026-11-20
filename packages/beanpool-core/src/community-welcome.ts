/**
 * The community's welcome for new members (scratch/fable-design/DESIGN-onboarding-home-landing-fable.md §4.5, slice S6;
 * Marty, 21 Nov 2026: "Yes, all of Fable's picks"). An owner writes it in the community's Settings; members read it on
 * Home, under BeanPool's own welcome.
 *
 * - Plain text: at most {@link COMMUNITY_WELCOME_MAX_CHARS} characters, counted as both apps' fields count them (`maxLength`
 *   counts UTF-16 code units, JavaScript's `.length`, as text-limits.ts does), and at most
 *   {@link COMMUNITY_WELCOME_MAX_LINE_BREAKS} line breaks. No links made tappable, no pictures, no formatting: an app
 *   draws it as written.
 * - The owner's own words, in their language: never machine-translated, so it never goes through t().
 * - Empty by default. Kept on the community's server (and its standby) only: members read it in the signed Home read,
 *   never on the public community card, the directory or the global community.
 *
 * What is cleaned rather than refused: a Windows or old-Mac line end and a line or paragraph separator become a line break
 * (each one counts), a tab becomes a space, the bidi marks a copy from an Android phone wraps right-to-left text in are
 * dropped (as config/clean-label.ts drops them from a name), and the ends are trimmed. Any other control character is
 * refused, never quietly removed: the owner sees what is wrong.
 *
 * Pure: no I/O and no Node built-ins (the barrel is bundled for the phone).
 */

/** The most characters a welcome may hold (UTF-16 code units, as `maxLength` counts them). */
export const COMMUNITY_WELCOME_MAX_CHARS = 280;
/** The most line breaks a welcome may hold: four lines at most. */
export const COMMUNITY_WELCOME_MAX_LINE_BREAKS = 3;

/** Why a welcome can't be kept. */
export type CommunityWelcomeProblem = 'not_text' | 'too_long' | 'too_many_lines' | 'control_character';

export type CommunityWelcomeCheck = { ok: true; text: string } | { ok: false; problem: CommunityWelcomeProblem };

const LINE_ENDS = /\r\n|[\r\u2028\u2029]/g;
const BIDI_MARKS = /[\u202a-\u202e\u2066-\u2069]/g;
/** Every control character (C0, DEL and C1) but the line break: a range, not a Unicode property, which an old phone engine may not read. */
// eslint-disable-next-line no-control-regex -- finding control characters is the point
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

/** How many line breaks a cleaned welcome holds. */
export function welcomeLineBreaks(text: string): number {
    let n = 0;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
    return n;
}

/**
 * The welcome as it is kept, or why it can't be. `null` or a text that is only spaces is the empty welcome (`''`), which
 * clears it. The text kept is what the owner wrote, cleaned as the header says; nothing else is changed.
 */
export function cleanCommunityWelcome(raw: unknown): CommunityWelcomeCheck {
    if (raw === null || raw === undefined) return { ok: true, text: '' };
    if (typeof raw !== 'string') return { ok: false, problem: 'not_text' };
    const text = raw.replace(LINE_ENDS, '\n').replace(/\t/g, ' ').replace(BIDI_MARKS, '').trim();
    if (CONTROL.test(text)) return { ok: false, problem: 'control_character' };
    if (welcomeLineBreaks(text) > COMMUNITY_WELCOME_MAX_LINE_BREAKS) return { ok: false, problem: 'too_many_lines' };
    if (text.length > COMMUNITY_WELCOME_MAX_CHARS) return { ok: false, problem: 'too_long' };
    return { ok: true, text };
}

/**
 * Whether a value is a welcome as one is kept: text that cleaning leaves exactly as it is, and not empty (the empty welcome
 * is no value at all). What a standby takes from its main server's record, and what an app may draw.
 */
export function isKeptCommunityWelcome(value: unknown): value is string {
    if (typeof value !== 'string' || value === '') return false;
    const c = cleanCommunityWelcome(value);
    return c.ok && c.text === value;
}

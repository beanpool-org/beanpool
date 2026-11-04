/**
 * The recovery kit's own sentences, in the member's language: the printed page's title, labels, warning and the steps
 * back in, on a phone and in a web browser.
 *
 * Kept apart from recovery-kit.ts on purpose. That file builds the page around the member's 12 words, so it is on the
 * words' key path and reaches the words layer in no way (__tests__/recovery-path-files.test.ts): no `t`, no `word`, no
 * `setLanguage`. This file is the other half. It holds only the kit's FIXED sentences, takes no argument, and so is never
 * handed a recovery word, a community's name or address, or a date: nothing it writes can carry one, and nothing a member's
 * words are can reach `t()` from here. The caller (the phone's utils/recovery-kit.ts, the web app's lib/recovery-kit.ts)
 * asks for the lines at the moment the page is made and passes them to the page, which escapes every one for HTML and
 * writes the 12 words beside them exactly as the key is made from them, English in every language.
 *
 * Each sentence reads exactly as the English page always has. A language with no translation of one yet shows the
 * English for that sentence (the words layer's fallback), so a half-translated kit is still a whole, usable page.
 * The English constants in recovery-kit.ts and these sentences are held to each other by __tests__/recovery-kit-lines.test.ts.
 *
 * Pure and universal, like words.ts: no React Native, no DOM, no Node built-ins.
 */

import { currentLanguage, isLang, t, word } from './words.js';

/** What a kit page says besides the member's own words, in one language. */
export interface PrintedKitLines {
    /** The page's `lang` attribute: one of LANGS, which the browser and the phone's print engine pick fonts and hyphenation by. */
    lang: string;
    title: string;
    /** The labels before the community's name and its address (the page writes the value after each). */
    community: string;
    address: string;
    /** "Made on 3 October 2026": given the date as the page writes it in this language. */
    madeOn: (date: string) => string;
    warning: string;
    howBack: string;
    onPhone: string;
    inBrowser: string;
    phoneSteps: readonly string[];
    webSteps: readonly string[];
}

const LINES = {
    title: word('Your BeanPool recovery kit'),
    community: word('Community:'),
    address: word('Address:'),
    madeOn: word('Made on {date}'),
    warning: word('Anyone who has these 12 words can sign in as you. Keep this page somewhere safe. Never photograph it or send it in a chat.'),
    howBack: word('How to get back in'),
    onPhone: word('On a phone'),
    inBrowser: word('In a web browser'),
} as const;

/** On a phone, worded as the app's restore screens are (the same steps recovery-kit.ts holds in English). */
const PHONE_STEPS = [
    word('Install BeanPool on your phone and open it.'),
    word('Tap “🔑 Already a Member? Restore Account →”.'),
    word('Tap “🔑 Recover with 12 Words”.'),
    word('Type your 12 words in order, one in each box.'),
    word('Type your community’s name or address (written above).'),
    word('Tap “Recover Identity”. Your name and picture come back once you’re in.'),
] as const;

/** In a web browser, worded as the web app's restore screens are, whichever door the community has. */
const WEB_STEPS = [
    word('Open your community’s address (written above) in a web browser.'),
    word('Click “Already have BeanPool?”. If the page asks for an invite code instead, click “🔑 Restore Existing Identity →” at the bottom of the page.'),
    word('Click “Use my 12 words” or “🔑 Recover with 12 Words”, whichever the page shows.'),
    word('Type your 12 words in order, one in each box.'),
    word('Click “Recover Identity”. Your name and picture come back once you’re in.'),
] as const;

/**
 * The kit's sentences in the device's language now (the one the app or the web app is showing). Call it when the page is
 * made, not at import, so a member who changes language and prints again gets the new one.
 */
export function printedKitLines(): PrintedKitLines {
    const language = currentLanguage();
    return {
        lang: isLang(language) ? language : 'en',
        title: t(LINES.title),
        community: t(LINES.community),
        address: t(LINES.address),
        madeOn: (date) => t(LINES.madeOn, { date }),
        warning: t(LINES.warning),
        howBack: t(LINES.howBack),
        onPhone: t(LINES.onPhone),
        inBrowser: t(LINES.inBrowser),
        phoneSteps: PHONE_STEPS.map((_, i) => t(PHONE_STEPS[i])),
        webSteps: WEB_STEPS.map((_, i) => t(WEB_STEPS[i])),
    };
}

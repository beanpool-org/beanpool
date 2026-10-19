/**
 * The sentences the join, restore, re-key and sign-in screens show that their lib files write in English, shown in the
 * member's language (words S3, web sweep W4), as the phone's components/key-lines.ts and welcome-lines.ts do.
 *
 * Code that handles keys, signatures, the 12 words or a backup never reaches the words layer (core
 * recovery-path-files.test.ts): lib/web-join.ts (signs the door's requests), lib/identity.ts (keeps the key and its
 * words), lib/door-work.ts and lib/words-work.ts (the door's work, signed with the joining key), lib/web-restore.ts (opens
 * a sign-in's copy of the account), lib/link-signin.ts (seals the account to a sign-in). The screens translate those
 * files' sentences here: by the exact English (the key IS the English), or by the English with a sign-in's name, a member's
 * name, a status or a time in it, built again word for word. Nothing here imports those files at runtime:
 * key-lines.test.ts holds every sentence to the constant or builder it stands for, so a sentence changed there fails a
 * test rather than quietly showing English.
 *
 * Anything else (a community's own words, a sign-in provider's own error, a member's name) is shown exactly as given.
 * The 12 words, codes and keys are never looked up: a name or a number is only put into a sentence.
 */
import { t, tn, word, type WordKey } from '@beanpool/core';

/** Whole sentences, by their English. */
const FIXED: Readonly<Record<string, WordKey>> = {
    // lib/web-join.ts: what the door answered.
    "This community isn't taking new members right now.": word("This community isn't taking new members right now."),
    'This community is in a private preview. Ask its owner for an invite.': word('This community is in a private preview. Ask its owner for an invite.'),
    "The community couldn't accept this because this device's date and time look wrong. Check them in this device's settings (set them to automatic), then try again.": word("The community couldn't accept this because this device's date and time look wrong. Check them in this device's settings (set them to automatic), then try again."),
    "That took a while and the sign-in expired. Let's try once more.": word("That took a while and the sign-in expired. Let's try once more."),
    "Setting up your account didn't work out. Please try again.": word("Setting up your account didn't work out. Please try again."),
    'This community needs a sign-in to join: Google, Apple or Facebook.': word('This community needs a sign-in to join: Google, Apple or Facebook.'),
    'Too many tries from this network just now.': word('Too many tries from this network just now.'),
    "The community couldn't take your join right now. Please try again in a minute.": word("The community couldn't take your join right now. Please try again in a minute."),
    // lib/web-join.ts refusalMessage: a sign-in that came back and was refused.
    "That sign-in wasn't started here. Start again.": word("That sign-in wasn't started here. Start again."),
    "That sign-in didn't finish. Try again, or choose another way.": word("That sign-in didn't finish. Try again, or choose another way."),
    "The sign-in didn't send back what we need. Try again, or choose another way.": word("The sign-in didn't send back what we need. Try again, or choose another way."),
    // lib/identity.ts: a browser that can't keep an account.
    "This browser can't keep your account, so open the site in your phone's normal browser, or use the BeanPool app.": word("This browser can't keep your account, so open the site in your phone's normal browser, or use the BeanPool app."),
    "Couldn't open your account on this browser. Reload the page.": word("Couldn't open your account on this browser. Reload the page."),
    // lib/door-work.ts and lib/words-work.ts: the 12-words door's work.
    "This browser can't finish setting up a 12-words account right now. Try again, or sign in.": word("This browser can't finish setting up a 12-words account right now. Try again, or sign in."),
    "Can't reach the community right now. Try again in a minute, or sign in.": word("Can't reach the community right now. Try again in a minute, or sign in."),
    "This community isn't taking 12-words accounts right now. Sign in to join.": word("This community isn't taking 12-words accounts right now. Sign in to join."),
    'Lots of people are joining right now, so setting up a 12-words account takes a little longer in this browser. Or sign in to join now.': word('Lots of people are joining right now, so setting up a 12-words account takes a little longer in this browser. Or sign in to join now.'),
    'Lots of people are joining right now, so joining takes a little longer in this browser.': word('Lots of people are joining right now, so joining takes a little longer in this browser.'),
    // lib/link-signin.ts and lib/web-join.ts: the community can't be reached.
    "Can't reach the community right now. Try again in a minute.": word("Can't reach the community right now. Try again in a minute."),
    // lib/link-signin.ts: adding a sign-in.
    "This community doesn't take sign-ins right now.": word("This community doesn't take sign-ins right now."),
    "This browser couldn't keep track of the sign-in, so it didn't start. Try again.": word("This browser couldn't keep track of the sign-in, so it didn't start. Try again."),
    'Adding a sign-in was cancelled. Nothing changed.': word('Adding a sign-in was cancelled. Nothing changed.'),
    // Before tryAgainIn's sentence (linkRefusalMessage's 429): see WITH_WAIT.
    'Too many tries just now.': word('Too many tries just now.'),
    // lib/web-restore.ts: a restore with a sign-in.
    'That restore timed out on the community. Start again.': word('That restore timed out on the community. Start again.'),
    'Too many tries from this network. Please try again later.': word('Too many tries from this network. Please try again later.'),
};

/** The English of every whole sentence above: what key-lines.test.ts holds to the lib files. */
export const KEY_FIXED_LINES: readonly string[] = Object.freeze(Object.keys(FIXED));

/** lib/web-join.ts tryAgainIn's sentence for `minutes` or `hours`, in the member's language. */
function tryAgainInWords(minutes: number | null, hours: number | null): string {
    if (minutes !== null) return tn(minutes, 'Try again in {n} minute.', 'Try again in {n} minutes.');
    return tn(hours ?? 1, 'Try again in about an hour.', 'Try again in about {n} hours.');
}

/** lib/web-join.ts tryAgainIn's sentence read back ("Try again in 5 minutes."), or null when it is not one. */
function tryAgainBack(sentence: string): string | null {
    if (sentence === 'Try again in 1 minute.') return tryAgainInWords(1, null);
    if (sentence === 'Try again in about an hour.') return tryAgainInWords(null, 1);
    const m = sentence.match(/^Try again in (\d+) minutes\.$/);
    if (m) return tryAgainInWords(Number(m[1]), null);
    const h = sentence.match(/^Try again in about (\d+) hours\.$/);
    return h ? tryAgainInWords(null, Number(h[1])) : null;
}

/** lib/door-work.ts aboutTime's phrase ("about 15 seconds", "about a minute"), in the member's language. */
function aboutWords(phrase: string): string {
    const seconds = phrase === 'about a second' ? 1 : Number(phrase.match(/^about (\d+) seconds$/)?.[1] ?? NaN);
    if (Number.isFinite(seconds)) return tn(seconds, 'about a second', 'about {n} seconds');
    const minutes = phrase === 'about a minute' ? 1 : Number(phrase.match(/^about (\d+) minutes$/)?.[1] ?? NaN);
    if (Number.isFinite(minutes)) return tn(minutes, 'about a minute', 'about {n} minutes');
    return phrase;
}

const PROVIDER = '(Google|Apple|Facebook)';

/** Sentences with a sign-in's name, a member's name, a status or a time in them, by their English pattern. */
const FILLED: ReadonlyArray<{ pattern: RegExp; words: (m: RegExpMatchArray) => string }> = [
    // lib/web-join.ts refusalMessage and matchAuthReturn: a sign-in that came back without what the door needs.
    {
        pattern: new RegExp(`^${PROVIDER} didn't send back what we need\\. Try again, or choose another way\\.$`),
        words: (m) => t("{provider} didn't send back what we need. Try again, or choose another way.", { provider: m[1] }),
    },
    // The provider's own words after it are shown as they came.
    { pattern: new RegExp(`^${PROVIDER} couldn't sign you in: ([\\s\\S]*)$`), words: (m) => t("{provider} couldn't sign you in: {reason}", { provider: m[1], reason: m[2] }) },
    // lib/web-join.ts doorOutcome.
    {
        pattern: new RegExp(`^This ${PROVIDER} account already has a BeanPool identity here\\. Restore it instead\\.$`),
        words: (m) => t('This {provider} account already has a BeanPool identity here. Restore it instead.', { provider: m[1] }),
    },
    {
        pattern: new RegExp(`^${PROVIDER} sign-in could not be checked right now\\. Please try again in a minute\\.$`),
        words: (m) => t('{provider} sign-in could not be checked right now. Please try again in a minute.', { provider: m[1] }),
    },
    { pattern: /^The community could not add you \((\d+)\)\. Please try again\.$/, words: (m) => t('The community could not add you ({status}). Please try again.', { status: m[1] }) },
    // lib/web-join.ts doorRefusalMessage and wordsWorkRefusal: a refusal with no words of the community's own.
    {
        pattern: /^The community could not start a sign-in \((\d+)\)\. Please try again in a minute\.$/,
        words: (m) => t('The community could not start a sign-in ({status}). Please try again in a minute.', { status: m[1] }),
    },
    {
        pattern: /^The community couldn't start a 12-words account \((\d+)\)\. Try again, or sign in\.$/,
        words: (m) => t("The community couldn't start a 12-words account ({status}). Try again, or sign in.", { status: m[1] }),
    },
    // lib/door-work.ts busySentence and signInBusySentence: the door is busy, with this browser's own estimate.
    {
        pattern: /^Lots of people are joining right now\. Setting up a 12-words account will take (.+) in this browser\. Or sign in to join now\.$/,
        words: (m) => t('Lots of people are joining right now. Setting up a 12-words account will take {time} in this browser. Or sign in to join now.', { time: aboutWords(m[1]) }),
    },
    {
        pattern: /^Lots of people are joining right now, so joining will take (.+) more in this browser\.$/,
        words: (m) => t('Lots of people are joining right now, so joining will take {time} more in this browser.', { time: aboutWords(m[1]) }),
    },
    // lib/web-restore.ts releaseRefusalMessage and sessionRefusalMessage: a member's name, a sign-in, a status.
    {
        pattern: new RegExp(`^That ${PROVIDER} account isn't a way back into (.+)\\. Try the sign-in you joined with, or your 12 words\\.$`, 's'),
        words: (m) => t("That {provider} account isn't a way back into {name}. Try the sign-in you joined with, or your 12 words.", { provider: m[1], name: m[2] }),
    },
    {
        pattern: new RegExp(`^${PROVIDER} sign-in couldn't be checked or took too long\\. Try again\\.$`),
        words: (m) => t("{provider} sign-in couldn't be checked or took too long. Try again.", { provider: m[1] }),
    },
    {
        pattern: /^The community could not bring the account back \((\d+)\)\. Please try again\.$/,
        words: (m) => t('The community could not bring the account back ({status}). Please try again.', { status: m[1] }),
    },
    {
        pattern: /^(.+) has no sign-in to come back with here\. Use your 12 words, or the phone app\.$/s,
        words: (m) => t('{name} has no sign-in to come back with here. Use your 12 words, or the phone app.', { name: m[1] }),
    },
    {
        pattern: /^More than one account here is called (.+)\. Use your 12 words, or the phone app\.$/s,
        words: (m) => t('More than one account here is called {name}. Use your 12 words, or the phone app.', { name: m[1] }),
    },
    {
        pattern: /^The community could not start a restore \((\d+)\)\. Please try again in a minute\.$/,
        words: (m) => t('The community could not start a restore ({status}). Please try again in a minute.', { status: m[1] }),
    },
    // lib/link-signin.ts: adding a sign-in, and what became of it.
    {
        pattern: new RegExp(`^${PROVIDER} sign-in isn't available here\\.$`),
        words: (m) => t("{provider} sign-in isn't available here.", { provider: m[1] }),
    },
    {
        pattern: new RegExp(`^This ${PROVIDER} account already has another BeanPool account here, so it can't be added to this one\\. Choose another sign-in\\.$`),
        words: (m) => t("This {provider} account already has another BeanPool account here, so it can't be added to this one. Choose another sign-in.", { provider: m[1] }),
    },
    {
        pattern: new RegExp(`^This ${PROVIDER} account belonged to an account that was removed from this community, so it can't be added\\.$`),
        words: (m) => t("This {provider} account belonged to an account that was removed from this community, so it can't be added.", { provider: m[1] }),
    },
    {
        pattern: new RegExp(`^${PROVIDER} couldn't confirm that sign-in\\. Try again\\.$`),
        words: (m) => t("{provider} couldn't confirm that sign-in. Try again.", { provider: m[1] }),
    },
    {
        pattern: /^The community couldn't add your sign-in \((\d+)\)\. Try again in a minute\.$/,
        words: (m) => t("The community couldn't add your sign-in ({status}). Try again in a minute.", { status: m[1] }),
    },
    {
        pattern: new RegExp(`^${PROVIDER} is added\\. Signing in with it also brings this account back, and your new-account limits are now the usual ones\\.$`),
        words: (m) => t('{provider} is added. Signing in with it also brings this account back, and your new-account limits are now the usual ones.', { provider: m[1] }),
    },
    {
        pattern: new RegExp(`^${PROVIDER} is added, and your new-account limits are now the usual ones\\. Its copy of your account couldn't be saved, so your 12 words are still your only way back\\.$`),
        words: (m) => t("{provider} is added, and your new-account limits are now the usual ones. Its copy of your account couldn't be saved, so your 12 words are still your only way back.", { provider: m[1] }),
    },
];

/**
 * A lib sentence with lib/web-join.ts tryAgainIn's sentence after it (withRetryAfter, linkRefusalMessage's 429): the
 * two, each in the member's language. The first may be the community's own words, shown as they came.
 */
const WITH_WAIT = /^([\s\S]+?) (Try again in (?:\d+ minutes?|about an hour|about \d+ hours)\.)$/;

/**
 * Two whole sentences, one after the other: a language that writes no space between sentences (Chinese, Japanese)
 * joins them its way.
 */
export function twoSentences(first: string, second: string): string {
    return t('{first} {second}', { first, second }, 'two sentences, one after the other');
}

/**
 * One of the sentences above in the member's language; anything else (a community's own words, a provider's, a
 * member's) exactly as given.
 */
export function keyLineWords(english: string): string {
    if (Object.prototype.hasOwnProperty.call(FIXED, english)) return t(FIXED[english]);
    for (const f of FILLED) {
        const m = english.match(f.pattern);
        if (m) return f.words(m);
    }
    const alone = tryAgainBack(english);
    if (alone) return alone;
    const w = english.match(WITH_WAIT);
    if (w) {
        const wait = tryAgainBack(w[2]);
        if (wait) return twoSentences(keyLineWords(w[1]), wait);
    }
    return english;
}

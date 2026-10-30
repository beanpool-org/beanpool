/**
 * The sentences the join, restore, re-key and sign-in screens show that their lib files write in English, shown in the
 * member's language (words S3, web sweep W4), as the phone's components/key-lines.ts and welcome-lines.ts do.
 *
 * Code that handles keys, signatures, the 12 words or a backup never reaches the words layer (core
 * recovery-path-files.test.ts): lib/web-join.ts (signs the door's requests), lib/identity.ts (keeps the key and its
 * words), lib/door-work.ts and lib/words-work.ts (the door's work, signed with the joining key), lib/web-restore.ts (opens
 * a sign-in's copy of the account), lib/link-signin.ts (seals the account to a sign-in), lib/web-rekey.ts (signs a re-key
 * ask), lib/takeover-unlock.ts (opens an owner's part of a community's locked keys), lib/owner-words.ts (checks an
 * owner's 12 words), lib/recovery-kit.ts (prints the 12 words), lib/delete-here.ts (deletes the account here and says
 * whether this browser's key stays) and lib/words-clipboard.ts (copies the 12 words). The screens translate those
 * files' sentences here: by the exact English (the key IS the English), or by the English with a sign-in's name, a member's
 * name, a status or a time in it, built again word for word. Nothing here imports those files at runtime:
 * key-lines.test.ts holds every sentence to the constant or builder it stands for, so a sentence changed there fails a
 * test rather than quietly showing English.
 *
 * Anything else (a community's own words, a sign-in provider's own error, a member's name) is shown exactly as given.
 * The 12 words, codes and keys are never looked up: a name or a number is only put into a sentence.
 */
import { formatDate, t, tn, word, type WordKey } from '@beanpool/core';

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
    // lib/web-rekey.ts WEB_REKEY_TEXT: a re-key code's answers (the phone's rekey-redeem.ts says two of them the same).
    'Your admin said this device isn’t yours, so nothing changed. Ask them to try again with you there.': word('Your admin said this device isn’t yours, so nothing changed. Ask them to try again with you there.'),
    'That code isn’t valid any more. Ask the admin for a new one.': word('That code isn’t valid any more. Ask the admin for a new one.'),
    'That code is for another community. Open the link your admin gave you, or ask them for a new code.': word('That code is for another community. Open the link your admin gave you, or ask them for a new code.'),
    'Couldn’t reach your community. Check your connection: you can try again, and the code still works until it expires.': word('Couldn’t reach your community. Check your connection: you can try again, and the code still works until it expires.'),
    // lib/takeover-unlock.ts: a take-over or restore code pasted into Settings, and why the browser won't open the keys.
    "That looks like a take-over code but part of it is missing. Copy it again from the server's screen.": word("That looks like a take-over code but part of it is missing. Copy it again from the server's screen."),
    "That isn't a take-over code. On the standby's Settings, choose “Take over with an owner's phone” and copy the code it shows.": word("That isn't a take-over code. On the standby's Settings, choose “Take over with an owner's phone” and copy the code it shows."),
    'These keys belong to another community, not the one this app is in. Nothing was opened.': word('These keys belong to another community, not the one this app is in. Nothing was opened.'),
    'That code is for a different kind of unlock than the server sent. Start again on the server.': word('That code is for a different kind of unlock than the server sent. Start again on the server.'),
    'That code has run out or was already used. Start again on the server and copy the new code.': word('That code has run out or was already used. Start again on the server and copy the new code.'),
    "The server's answer could not be read. Start again on the server.": word("The server's answer could not be read. Start again on the server."),
    "This browser's key did not open its part of the lock. Try another owner, or the recovery code.": word("This browser's key did not open its part of the lock. Try another owner, or the recovery code."),
    // lib/owner-words.ts OWNER_WORDS_COPY: an owner's 12 words check and its prompt (those with a date or a count in
    // them are said again where shown: OwnerWordsCheck).
    'Check your 12 words': word('Check your 12 words'),
    "You're an owner of this community. Its take-over keys and backups are locked to your account. If you lose this device, your 12 words are what get you back in — so check you still have the right ones.": word("You're an owner of this community. Its take-over keys and backups are locked to your account. If you lose this device, your 12 words are what get you back in — so check you still have the right ones."),
    "Your 12 words aren't checked. If you lose this device you couldn't take over the server or open a backup.": word("Your 12 words aren't checked. If you lose this device you couldn't take over the server or open a backup."),
    'Your words stay in this browser. They are never sent or saved.': word('Your words stay in this browser. They are never sent or saved.'),
    'These are the right words.': word('These are the right words.'),
    'These are the right words. Your community can see you checked them today.': word('These are the right words. Your community can see you checked them today.'),
    "These are the right words. We couldn't tell your community's server just now; check again later to record it.": word("These are the right words. We couldn't tell your community's server just now; check again later to record it."),
    "These aren't the words for this account.": word("These aren't the words for this account."),
    "Can't find them? If this browser still has them, View Recovery Phrase (below) shows them.": word("Can't find them? If this browser still has them, View Recovery Phrase (below) shows them."),
    "Can't find them? They aren't saved in this browser, so View Recovery Phrase can't show them.": word("Can't find them? They aren't saved in this browser, so View Recovery Phrase can't show them."),
    "Your 12 words aren't checked": word("Your 12 words aren't checked"),
    "If you lose this device you couldn't take over the server or open a backup.": word("If you lose this device you couldn't take over the server or open a backup."),
    'Time to check your 12 words': word('Time to check your 12 words'),
    "It's a year since you last checked them. If you lose this device, they're how you'd take over the server or open a backup.": word("It's a year since you last checked them. If you lose this device, they're how you'd take over the server or open a backup."),
    'Check now': word('Check now'),
    Later: word('Later'),
    // lib/recovery-kit.ts: the printed kit, from the 12 words.
    'Print or save your recovery kit': word('Print or save your recovery kit'),
    'Keep this page or file off cloud backups and chats. Anyone who has it can sign in as you.': word('Keep this page or file off cloud backups and chats. Anyone who has it can sign in as you.'),
    'The recovery kit couldn’t be made in this browser. Write the 12 words down instead.': word('The recovery kit couldn’t be made in this browser. Write the 12 words down instead.'),
    // lib/web-restore.ts: a restore with a sign-in.
    'That restore timed out on the community. Start again.': word('That restore timed out on the community. Start again.'),
    'Too many tries from this network. Please try again later.': word('Too many tries from this network. Please try again later.'),
    // lib/delete-here.ts: Settings' Permanently Delete Account, and whether this browser's key stays.
    "Permanently purges your account from this community node. Cancels active posts, clears push tokens, and settles your balance with the Commons Pool. Your key leaves this browser unless another community this web app opens still has you. The phone app, and other communities' web addresses, keep their own copy.": word("Permanently purges your account from this community node. Cancels active posts, clears push tokens, and settles your balance with the Commons Pool. Your key leaves this browser unless another community this web app opens still has you. The phone app, and other communities' web addresses, keep their own copy."),
    'Checking whether this browser still needs your key…': word('Checking whether this browser still needs your key…'),
    "Your key and 12 words leave this browser, for this web address. The phone app, and other communities' web addresses, keep their own copy. Write your 12 words down first if you use them anywhere else.": word("Your key and 12 words leave this browser, for this web address. The phone app, and other communities' web addresses, keep their own copy. Write your 12 words down first if you use them anywhere else."),
    "Your key leaves this browser, for this web address. The phone app, and other communities' web addresses, keep their own copy.": word("Your key leaves this browser, for this web address. The phone app, and other communities' web addresses, keep their own copy."),
    "If the phone app put a copy of your key in BeanPool's key vault, when you linked a sign-in there, deleting here doesn't remove it. Remove it in the phone app first: Settings → Account Protection → Disconnect.": word("If the phone app put a copy of your key in BeanPool's key vault, when you linked a sign-in there, deleting here doesn't remove it. Remove it in the phone app first: Settings → Account Protection → Disconnect."),
    // lib/delete-here.ts purgeHere: why the node's delete didn't happen (before webDeleteFailedLine's sentence: see FILLED).
    "The community didn't answer. You can try again: if it deleted your account meanwhile, trying again finishes the delete in this browser.": word("The community didn't answer. You can try again: if it deleted your account meanwhile, trying again finishes the delete in this browser."),
    "The community's answer didn't confirm the delete. Try again.": word("The community's answer didn't confirm the delete. Try again."),
    'This web app now talks to a different community. Open Delete account again.': word('This web app now talks to a different community. Open Delete account again.'),
    'Failed to purge account from node. Active deals holding Beans in trust may need to be resolved first.': word('Failed to purge account from node. Active deals holding Beans in trust may need to be resolved first.'),
    // lib/words-clipboard.ts: under Copy All Words.
    'If you stay on this screen, the copy clears from your clipboard after a minute. On an iPhone or iPad, in Safari or in Firefox, it clears at your first tap or key press after that minute. If you leave this screen or switch to another app or tab first, it stays: copy something else over it.': word('If you stay on this screen, the copy clears from your clipboard after a minute. On an iPhone or iPad, in Safari or in Firefox, it clears at your first tap or key press after that minute. If you leave this screen or switch to another app or tab first, it stays: copy something else over it.'),
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
    // lib/takeover-unlock.ts: a server by its address (the phone's takeover-unlock.ts says the last three the same).
    {
        pattern: /^These keys are not locked to you, so this browser can't open them\. Another owner of your community can, or the printed recovery code on (\S+)\.$/,
        words: (m) => t("These keys are not locked to you, so this browser can't open them. Another owner of your community can, or the printed recovery code on {host}.", { host: m[1] }),
    },
    {
        pattern: /^These take-over keys were not locked by your community's server, so this browser will not open them for (\S+)\.$/,
        words: (m) => t("These take-over keys were not locked by your community's server, so this browser will not open them for {host}.", { host: m[1] }),
    },
    {
        pattern: /^(\S+) sent keys that do not match its screen, or that have been altered\. Nothing was opened\. Start again on the server\.$/,
        words: (m) => t('{host} sent keys that do not match its screen, or that have been altered. Nothing was opened. Start again on the server.', { host: m[1] }),
    },
    { pattern: /^(\S+) did not answer \((\d+)\)\.$/, words: (m) => t('{host} did not answer ({status}).', { host: m[1], status: m[2] }) },
    { pattern: /^Could not reach (\S+)\.$/, words: (m) => t('Could not reach {host}.', { host: m[1] }) },
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
    {
        pattern: new RegExp(`^${PROVIDER} is added, and your new-account limits are now the usual ones\\. This community keeps no copies of members' accounts, so your 12 words are still your way back\\.$`),
        words: (m) => t("{provider} is added, and your new-account limits are now the usual ones. This community keeps no copies of members' accounts, so your 12 words are still your way back.", { provider: m[1] }),
    },
    // lib/delete-here.ts webKeepsKeyLine: the page's own community keeps the key, by its address and the one deleted at.
    {
        pattern: /^(Your key and 12 words stay|Your key stays) in this browser, for (\S+), the community this web address belongs to\. After the delete at (\S+), the web app goes back to (\S+)\.(?: (\S+) couldn't be reached, so it counts as a community you are still in\.)?$/,
        words: (m) => {
            const stays = m[1] === 'Your key stays'
                ? t('Your key stays in this browser, for {home}, the community this web address belongs to.', { home: m[2] })
                : t('Your key and 12 words stay in this browser, for {home}, the community this web address belongs to.', { home: m[2] });
            const back = twoSentences(stays, t('After the delete at {here}, the web app goes back to {home}.', { here: m[3], home: m[4] }));
            return m[5] ? twoSentences(back, t("{home} couldn't be reached, so it counts as a community you are still in.", { home: m[5] })) : back;
        },
    },
    // lib/delete-here.ts webDeletedButLine: the browser's own error, shown as it came (the phone's says it of a phone).
    {
        pattern: /^Your account was deleted, but this browser couldn't be cleared \(([\s\S]*)\)\. Use Sign Out \(Device Only\) to finish\.$/,
        words: (m) => t("Your account was deleted, but this browser couldn't be cleared ({reason}). Use Sign Out (Device Only) to finish.", { reason: m[1] }),
    },
    // lib/delete-here.ts webDeleteFailedLine: purgeHere's reason (one of the sentences above, or the community's own
    // words, shown as they came), then that nothing here changed.
    {
        pattern: /^([\s\S]+?) Nothing was removed from this browser: your key is still here\.$/,
        words: (m) => twoSentences(keyLineWords(m[1]), t('Nothing was removed from this browser: your key is still here.')),
    },
];

/**
 * A lib sentence with lib/web-join.ts tryAgainIn's sentence after it (withRetryAfter, linkRefusalMessage's 429): the
 * two, each in the member's language. The first may be the community's own words, shown as they came.
 */
const WITH_WAIT = /^([\s\S]+?) (Try again in (?:\d+ minutes?|about an hour|about \d+ hours)\.)$/;

/** lib/owner-words.ts OWNER_WORDS_COPY.checked: when the owner last checked their 12 words, as the phone's OwnerWordsCard. */
export function ownerWordsCheckedWords(ms: number): string {
    return t('12 words checked {date}', { date: formatDate(new Date(ms), 'day-month-year') });
}

/** lib/owner-words.ts OWNER_WORDS_COPY.count: the words typed weren't twelve (the phone's key-lines says it the same). */
export function ownerWordsCountWords(n: number): string {
    return tn(n, "That's {n} word. Type all 12, in order.", "That's {n} words. Type all 12, in order.");
}

/**
 * lib/join-recovery.ts signInNames's list ("Google", "Google and Apple", "Google, Apple and Facebook") in the member's
 * language, as the phone's settings-lines.ts listNameWords says a list. The names are the sign-ins' own.
 */
export function signInNamesWords(english: string): string {
    const m = english.match(/^(.+) and (Google|Apple|Facebook)$/);
    return m ? t('{items} and {last}', { items: m[1], last: m[2] }) : english;
}

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

/**
 * The sentences Settings shows that its lower layers write in English, shown in the member's language.
 *
 * Code that handles keys, signatures, the 12 words or the key vault never reaches the words layer: utils/delete-here.ts
 * (signs the delete, removes the vault's copies), utils/names-list.ts (the names list's keys), utils/vault.ts and
 * utils/add-words.ts (on the 12 words' key path), utils/no-words-copy.ts (what is said about the 12 words),
 * utils/LocalAuth.ts (App Lock), utils/node-url.ts (which addresses the key signs for), utils/member-area.ts (signs the
 * area read), utils/break-glass.ts and utils/sign-out-everywhere.ts (signed admin requests), utils/node-role.ts (re-exported
 * by the signing node-admin.ts), services/pillar-sync.ts's progress lines. Settings translates their sentences here, by
 * the exact English (the key IS the English), and builds the sentences that carry a name or a plan again, word for word
 * in English.
 * Nothing here imports those files: utils/__tests__/settings-lines.test.ts holds every sentence to the constant or
 * builder it stands for, so a sentence changed there fails a test rather than quietly showing English.
 *
 * A community's or the vault's own words (a refusal's reason, a node's message) are shown exactly as they came.
 */
import { t, tn, word, type WordKey } from '@beanpool/core';
import type { DeleteOutcome, DeletePlan, KeptCommunity } from '../../utils/delete-here';
import type { ManageRole } from '../../utils/node-role';

/** Whole sentences, by their English. */
const FIXED: Readonly<Record<string, WordKey>> = {
    // utils/no-words-copy.ts: the View Recovery Phrase row, the line above the add form, the buttons to Account Protection,
    // the sign-out alert and the line before a wipe.
    'View Recovery Phrase': word('View Recovery Phrase'),
    'View your 12-word backup seed': word('View your 12-word backup seed'),
    'No copy on this phone yet. Tap to add your 12 words.': word('No copy on this phone yet. Tap to add your 12 words.'),
    'This phone has no copy of your 12 words. Typing them in checks them against this account and saves them on this phone. They are not sent anywhere.': word('This phone has no copy of your 12 words. Typing them in checks them against this account and saves them on this phone. They are not sent anywhere.'),
    'Connect a sign-in': word('Connect a sign-in'),
    'Check Account Protection first': word('Check Account Protection first'),
    'This phone was restored with a sign-in, so it has no 12 words. Without a connected sign-in, you cannot get this account back.': word('This phone was restored with a sign-in, so it has no 12 words. Without a connected sign-in, you cannot get this account back.'),
    'This removes your private key and local database from this phone. This phone was restored with a sign-in, so it has no 12 words. Without a connected sign-in, you cannot get this account back.': word('This removes your private key and local database from this phone. This phone was restored with a sign-in, so it has no 12 words. Without a connected sign-in, you cannot get this account back.'),
    // utils/add-words.ts ADD_WORDS_COPY.done: the words were just saved.
    'Your 12 words are on this phone again, and Show Recovery Phrase works. A sign-in you connected before still brings back your account without them. To include them, tap Connect again next to it under Account Protection.': word('Your 12 words are on this phone again, and Show Recovery Phrase works. A sign-in you connected before still brings back your account without them. To include them, tap Connect again next to it under Account Protection.'),
    // utils/LocalAuth.ts APP_LOCK_NEEDS_SCREEN_LOCK.
    "App Lock asks for your phone's own screen lock (a PIN, pattern, password, fingerprint or face) when BeanPool opens. This phone has no screen lock set, so there is nothing for it to ask. Set one in your phone's settings, then turn App Lock on.": word("App Lock asks for your phone's own screen lock (a PIN, pattern, password, fingerprint or face) when BeanPool opens. This phone has no screen lock set, so there is nothing for it to ask. Set one in your phone's settings, then turn App Lock on."),
    // utils/node-url.ts UNSAFE_NODE_ADDRESS_MESSAGE.
    "That community address isn't a plain web address (it has something like @ or \\ in it), so BeanPool won't connect to it or sign anything for it. Check the address with whoever gave it to you.": word("That community address isn't a plain web address (it has something like @ or \\ in it), so BeanPool won't connect to it or sign anything for it. Check the address with whoever gave it to you."),
    // utils/delete-here.ts: the Permanently Delete Account card, while the other communities are asked, and the way out.
    'Permanently deletes your account at this community. Cancels your posts there, clears its push alerts, and settles your balance with its Commons Pool. If this phone has other communities you are a member of, it keeps your key for them. At your last one, it clears this phone.': word('Permanently deletes your account at this community. Cancels your posts there, clears its push alerts, and settles your balance with its Commons Pool. If this phone has other communities you are a member of, it keeps your key for them. At your last one, it clears this phone.'),
    'Checking your other communities on this phone…': word('Checking your other communities on this phone…'),
    'To take BeanPool off this phone altogether, use Sign Out (Device Only).': word('To take BeanPool off this phone altogether, use Sign Out (Device Only).'),
    // utils/delete-here.ts vaultCopyFailure: why the vault kept its copy, said inside the brackets of vaultCopyStaysWords.
    'the vault is paused for a little while': word('the vault is paused for a little while', 'why the key vault kept its copy'),
    "its answer didn't check out: check that your phone's date and time are right": word("its answer didn't check out: check that your phone's date and time are right", 'why the key vault kept its copy'),
    "it didn't answer: check your connection": word("it didn't answer: check your connection", 'why the key vault kept its copy'),
    'too many tries just now': word('too many tries just now', 'why the key vault kept its copy'),
    "it didn't confirm the delete": word("it didn't confirm the delete", 'why the key vault kept its copy'),
    // utils/names-list.ts NAMES_COPY: Sign Out with the names list's copy not confirmed.
    'Names list': word('Names list'),
    'Try again': word('Try again'),
    'Save the names as a PDF': word('Save the names as a PDF'),
    'Sign out anyway': word('Sign out anyway'),
    'The server didn’t confirm a copy of your names-list record. After you sign in again, check codes with another admin on a call and their phone will send the keys.': word('The server didn’t confirm a copy of your names-list record. After you sign in again, check codes with another admin on a call and their phone will send the keys.'),
    // utils/member-area.ts areaRowLine, and the row's line before it answers.
    "Couldn't check right now": word("Couldn't check right now"),
    'Checking…': word('Checking…'),
    // The database rebuild's steps: Settings' own first two, then services/pillar-sync.ts performSync's.
    'Initializing Database Reset...': word('Initializing Database Reset...'),
    'Clearing Local Database Cache...': word('Clearing Local Database Cache...'),
    'Waiting for the sync already running to finish...': word('Waiting for the sync already running to finish...'),
    'Discovering Node Connection...': word('Discovering Node Connection...'),
    'Synchronizing Members & Profiles...': word('Synchronizing Members & Profiles...'),
    'Synchronizing Active Posts & Projects...': word('Synchronizing Active Posts & Projects...'),
    'Synchronizing Transactions, Ratings & Reviews...': word('Synchronizing Transactions, Ratings & Reviews...'),
    'Finalizing Local SQLite Database Cache...': word('Finalizing Local SQLite Database Cache...'),
    // utils/vault.ts VAULT_MESSAGES and its other fixed refusals: what the key vault couldn't say, under Account Protection.
    "Sign-in recovery isn't set up in this version of the app. Your 12 words work any time.": word("Sign-in recovery isn't set up in this version of the app. Your 12 words work any time."),
    'Getting back in with a sign-in is paused for a little while. Your 12 words work any time.': word('Getting back in with a sign-in is paused for a little while. Your 12 words work any time.'),
    "BeanPool's key vault is paused for a little while, so your sign-in wasn't linked. Settings offers to link it again once the vault is back. Your 12 words work any time.": word("BeanPool's key vault is paused for a little while, so your sign-in wasn't linked. Settings offers to link it again once the vault is back. Your 12 words work any time."),
    "BeanPool's key vault didn't answer. Check your connection and try again. Your 12 words work any time.": word("BeanPool's key vault didn't answer. Check your connection and try again. Your 12 words work any time."),
    "BeanPool's key vault sent an answer that didn't check out, so nothing was changed. Check that your phone's date and time are right, then try again. Your 12 words work any time.": word("BeanPool's key vault sent an answer that didn't check out, so nothing was changed. Check that your phone's date and time are right, then try again. Your 12 words work any time."),
    "BeanPool's key vault sent an answer that didn't check out, so no sign-in was started. Check that your phone's date and time are right, then try again.": word("BeanPool's key vault sent an answer that didn't check out, so no sign-in was started. Check that your phone's date and time are right, then try again."),
    "The key vault's answer didn't confirm it, so nothing is shown as done. Try again.": word("The key vault's answer didn't confirm it, so nothing is shown as done. Try again."),
    "The copy that came back doesn't make the account it belongs to, so nothing was saved. Your 12 words work any time.": word("The copy that came back doesn't make the account it belongs to, so nothing was saved. Your 12 words work any time."),
    "The copy that came back didn't open with this sign-in, so nothing was saved. Your 12 words work any time.": word("The copy that came back didn't open with this sign-in, so nothing was saved. Your 12 words work any time."),
    'This restore is no longer waiting at the key vault. Start again, or use your 12 words.': word('This restore is no longer waiting at the key vault. Start again, or use your 12 words.'),
    "BeanPool's key vault keeps no copy for this sign-in account. Your 12 words work any time.": word("BeanPool's key vault keeps no copy for this sign-in account. Your 12 words work any time."),
    'Too many tries just now. Please try again later.': word('Too many tries just now. Please try again later.'),
    "BeanPool's key vault couldn't check that sign-in, so nothing happened. Try again. Your 12 words work any time.": word("BeanPool's key vault couldn't check that sign-in, so nothing happened. Try again. Your 12 words work any time."),
    "That restore has already gone through: the other phone has your account now. If it wasn't you, someone else has your account: make sure the sign-in account it used is yours alone, and ask your community's admins for help.": word("That restore has already gone through: the other phone has your account now. If it wasn't you, someone else has your account: make sure the sign-in account it used is yours alone, and ask your community's admins for help."),
    "That restore was already stopped. It won't go through.": word("That restore was already stopped. It won't go through."),
    'That restore is no longer waiting at the key vault.': word('That restore is no longer waiting at the key vault.'),
    'A restore of this account is already waiting on another phone. It goes through there, or you can use your 12 words here.': word('A restore of this account is already waiting on another phone. It goes through there, or you can use your 12 words here.'),
    // utils/keeper-enrolment.ts disconnectSsoKeeper: no community set on this phone.
    'No node configured.': word('No node configured.'),
    // utils/break-glass.ts issueBreakGlassCode: why no code was made.
    'Set a screen lock on this phone first: a break-glass code is only shown behind it.': word('Set a screen lock on this phone first: a break-glass code is only shown behind it.'),
    'The phone was not unlocked, so no code was made.': word('The phone was not unlocked, so no code was made.'),
    'Could not reach the community. No code was made.': word('Could not reach the community. No code was made.'),
    'A break-glass code is already being made.': word('A break-glass code is already being made.'),
    // utils/sign-out-everywhere.ts: why it didn't sign out, and signOutEverywhereDone's two answers.
    'Could not reach the community, so you may still be signed in elsewhere. Try again when you are online.': word('Could not reach the community, so you may still be signed in elsewhere. Try again when you are online.'),
    'Already signing you out everywhere.': word('Already signing you out everywhere.'),
    'Every Settings sign-in of yours has ended. Your break-glass code no longer works: make a new one with Break-glass code. Automation tokens still work: check them with Manage, under Access & Security.': word('Every Settings sign-in of yours has ended. Your break-glass code no longer works: make a new one with Break-glass code. Automation tokens still work: check them with Manage, under Access & Security.'),
    'Every Settings sign-in of yours has ended.': word('Every Settings sign-in of yours has ended.'),
};

/** Sentences with a number in them, by their English pattern. */
const FILLED: ReadonlyArray<{ pattern: RegExp; words: (m: RegExpMatchArray) => string }> = [
    // utils/names-list.ts NAMES_COPY.signOutOnlyCopy / signOutMaybeOnlyCopy: the names list's key by its number.
    {
        pattern: /^This phone holds the only copy of the names list’s key (\d+), and the server didn’t confirm its copy\. If you sign out now, the names written under it can’t be opened again\.$/,
        words: (m) => t('This phone holds the only copy of the names list’s key {n}, and the server didn’t confirm its copy. If you sign out now, the names written under it can’t be opened again.', { n: Number(m[1]) }),
    },
    {
        pattern: /^The server didn’t answer, so this phone can’t tell whether another admin still holds the names list’s key (\d+)\. If none does and you sign out now, the names written under it can’t be opened again\.$/,
        words: (m) => t('The server didn’t answer, so this phone can’t tell whether another admin still holds the names list’s key {n}. If none does and you sign out now, the names written under it can’t be opened again.', { n: Number(m[1]) }),
    },
    // utils/vault.ts: a refusal the vault gave no word for, with its status.
    {
        pattern: /^BeanPool's key vault couldn't do that \((\d+)\)\. Try again later\. Your 12 words work any time\.$/,
        words: (m) => t("BeanPool's key vault couldn't do that ({status}). Try again later. Your 12 words work any time.", { status: m[1] }),
    },
    // utils/sign-out-everywhere.ts and utils/break-glass.ts: a community's refusal with no words of its own, by its status.
    {
        pattern: /^The community did not sign you out \((\d+)\)\.$/,
        words: (m) => t('The community did not sign you out ({status}).', { status: m[1] }),
    },
    {
        pattern: /^The community said no \((\d+)\)\.$/,
        words: (m) => t('The community said no ({status}).', { status: m[1] }),
    },
];

/**
 * One of the sentences above in the member's language; anything else (a node's or the vault's own words, a member's) is
 * shown exactly as given.
 */
export function settingsLineWords(english: string): string {
    if (Object.prototype.hasOwnProperty.call(FIXED, english)) return t(FIXED[english]);
    for (const { pattern, words } of FILLED) {
        const m = english.match(pattern);
        if (m) return words(m);
    }
    return english;
}

// ── Account Deletion: utils/delete-here.ts's sentences, built again from the same plan ────────────────────────────

/** delete-here.ts listNames: "A", "A and B", "A, B and C". */
export function listNameWords(names: readonly string[]): string {
    if (names.length <= 1) return names[0] ?? '';
    return t('{items} and {last}', { items: names.slice(0, -1).join(', '), last: names[names.length - 1] });
}

/** delete-here.ts unaskedLine: the communities that couldn't be asked, said as kept; null when every one answered. */
function unaskedWords(keeps: readonly KeptCommunity[]): string | null {
    const unasked = keeps.filter((c) => c.membership === 'unreachable').map((c) => c.name);
    if (unasked.length === 0) return null;
    return tn(unasked.length,
        "{names} couldn't be reached, so it counts as a community you are still in.",
        "{names} couldn't be reached, so they count as communities you are still in.",
        { names: listNameWords(unasked) });
}

/** delete-here.ts keepsKeyLine: what stays when other communities keep the key. Whole sentences, one after another. */
export function keepsKeyWords(plan: Extract<DeletePlan, { kind: 'this-one' }>, hasWords: boolean): string {
    const communities = listNameWords(plan.keeps.map((c) => c.name));
    const kept = hasWords
        ? t('Your key and 12 words stay on this phone, for {communities}.', { communities })
        : t('Your key stays on this phone, for {communities}.', { communities });
    const moves = t("{here} goes from this phone's list, with its copy on this phone, and the app opens {next}.", { here: plan.hereName, next: plan.next.name });
    const both = t('{sentence} {next}', { sentence: kept, next: moves });
    const unasked = unaskedWords(plan.keeps);
    return unasked ? t('{sentence} {next}', { sentence: both, next: unasked }) : both;
}

/** delete-here.ts lastCommunityLine: the last community on the phone; `withVault` is the build's hasVault(). */
export function lastCommunityWords(plan: Extract<DeletePlan, { kind: 'last' }>, hasWords: boolean, withVault: boolean): string {
    const line = hasWords
        ? t("{here} is the last community on this phone where you are a member, so this phone's key and 12 words go too. Only go ahead if you have written your 12 words down: they are the way back into any other community you belong to.", { here: plan.hereName })
        : t("{here} is the last community on this phone where you are a member, so this phone's key goes too.", { here: plan.hereName });
    if (!withVault) return line;
    return t('{sentence} {next}', { sentence: line, next: t("If BeanPool's key vault keeps a locked copy of your key, from a sign-in you linked, it is removed first.") });
}

/** delete-here.ts vaultCopyStaysLine: the account is deleted, the vault kept its copy, the key is still on the phone. */
export function vaultCopyStaysWords(hereName: string, outcome: Extract<DeleteOutcome, { kind: 'vault-copy-stays' }>): string {
    const values = { here: hereName, reason: settingsLineWords(outcome.reason) };
    return outcome.copyKnown
        ? t("Your account at {here} was deleted, but BeanPool's key vault still keeps a locked copy of your key, from a sign-in you linked: it couldn't be removed ({reason}). Only your key can remove it, and your key is still on this phone, so you can try again.\n\nDelete Anyway takes your key off this phone and leaves that copy at the vault, locked to your sign-in. To remove it later, you would need your key back (with your 12 words or that sign-in) and a community that has you, to reach Settings → Account Protection → Disconnect.", values)
        : t("Your account at {here} was deleted, but BeanPool's key vault may keep a locked copy of your key, if you linked Google, Apple or Facebook: it couldn't be removed ({reason}). Only your key can remove it, and your key is still on this phone, so you can try again.\n\nDelete Anyway takes your key off this phone and leaves that copy at the vault, locked to your sign-in. To remove it later, you would need your key back (with your 12 words or that sign-in) and a community that has you, to reach Settings → Account Protection → Disconnect.", values);
}

/** delete-here.ts deletedButLine: the node deleted the account, the phone could not finish. */
export function deletedButWords(hereName: string, reason: string, keyStays: boolean, hasWords: boolean): string {
    const values = { here: hereName, reason };
    if (!keyStays) return t("Your account at {here} was deleted, but this phone couldn't be cleared ({reason}). Use Sign Out (Device Only) to finish.", values);
    return hasWords
        ? t("Your account at {here} was deleted, but this phone couldn't finish moving on ({reason}). This phone's key and 12 words are still on it.", values)
        : t("Your account at {here} was deleted, but this phone couldn't finish moving on ({reason}). This phone's key is still on it.", values);
}

/** delete-here.ts deleteFailedLine: the node did not delete the account; `reason` is its own words, or Settings'. */
export function deleteFailedWords(reason: string, hasWords: boolean): string {
    return hasWords
        ? t("{reason}\n\nThis phone's key and 12 words were not touched.", { reason })
        : t("{reason}\n\nThis phone's key was not touched.", { reason });
}

/** delete-here.ts deletePlanFailedLine: the other communities couldn't be asked; nothing has been deleted. */
export function deletePlanFailedWords(reason: string): string {
    return t("Couldn't check your other communities on this phone ({reason}). Nothing has been deleted. Try again.", { reason });
}

// ── Community admin: utils/node-role.ts's labels, LocalAuth.ts's and sign-out-everywhere.ts's sentences with a name ──

/** node-role.ts manageLabel: the button that opens the community's Settings. */
export function manageLabelWords(role: ManageRole, communityName: string): string {
    return role === 'moderator' ? t('Moderate {name}', { name: communityName }) : t('Manage {name}', { name: communityName });
}

/** node-role.ts manageSubtitle: the line under it. */
export function manageSubtitleWords(role: ManageRole): string {
    if (role === 'moderator') return t("You're a moderator · opens the reports to review, signed in as you");
    return role === 'owner'
        ? t("You're an owner · opens the node's settings, signed in as you")
        : t("You're an admin · opens the node's settings, signed in as you");
}

/** node-role.ts computerSigninLabel: the row that signs a computer's browser into the community's Settings. */
export function computerSigninLabelWords(role: ManageRole): string {
    return role === 'moderator' ? t('Moderate this community from a computer') : t('Manage this community from a computer');
}

/** LocalAuth.ts APP_LOCK_ON_FOR_ROLE: App Lock was turned on for someone who helps run the community. */
export function appLockOnForRoleWords(communityName: string): string {
    return t("App Lock is on. You help run {name}, so BeanPool now asks for your phone's own lock (fingerprint, face or PIN) when it opens. Your phone's lock is what keeps your role safe if someone else picks it up. You can turn it off in Settings → App Lock.", { name: communityName });
}

/** sign-out-everywhere.ts signOutEverywhereWarning: what Sign out everywhere ends; an owner's also retires the code. */
export function signOutEverywhereWarningWords(communityName: string, isOwner: boolean): string {
    return isOwner
        ? t("This signs you out of {name}'s Settings on every computer and phone, and retires your break-glass code. Your key stays on this phone: Manage signs you in again. Automation tokens keep working: press Manage, then Automation tokens under Access & Security, and revoke any you didn't make.", { name: communityName })
        : t("This signs you out of {name}'s Settings on every computer and phone. Your key stays on this phone: Manage signs you in again.", { name: communityName });
}

// ── Event reminders: utils/event-extras.ts reminderOffsetLabel's offsets, as "… before" ─────────────────────────

/** One reminder offset as Settings' tick row says it: "1 day before". */
export function reminderBeforeWords(minutes: number): string {
    switch (minutes) {
        case 10080: return t('1 week before');
        case 1440: return t('1 day before');
        case 120: return t('2 hours before');
        case 60: return t('1 hour before');
        case 30: return t('30 minutes before');
        // event-extras writes any other offset as "{n} minutes", one form for both.
        default: return tn(minutes, '{n} minutes before', '{n} minutes before');
    }
}

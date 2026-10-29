/**
 * The sentences the welcome screen and its onboarding steps show that their lower layers write in English, shown in the
 * member's language. The panels welcome shares with Settings (KeeperProtectionPanel, SsoEnrolSheet, RecoveryKitButtons,
 * WordsOnScreen's notes) read their lower layers' sentences here too.
 *
 * Code that handles keys, signatures, the 12 words or the key vault never reaches the words layer: utils/global-join.ts
 * (makes the door's key and signs the join), utils/door-work.ts (the work signed with that key), utils/sso-recovery.ts
 * (turns a sign-in copy into the key), utils/sso-signin.ts, utils/sso-sheet-connect.ts and utils/keeper-enrolment.ts
 * (seal the account to a sign-in), utils/join-link.ts (adds a sign-in to the account), utils/no-words-copy.ts (what is
 * said about the 12 words), utils/words-on-screen.ts and utils/words-clipboard.ts (the words on screen and on the
 * clipboard), utils/recovery-kit.ts (the printed words), utils/protection-state.ts (what protects the account, beside the
 * keeper enrolment). utils/db.ts redeemInvite (signs the invite's redeem) writes its failures in English too: invite-next.ts
 * reads them. Welcome translates their sentences here, by the exact English
 * (the key IS the English), and builds the sentences that carry a name, a count or a time again, word for word in
 * English. A sentence not here goes on to Settings' table (components/settings/settings-lines.ts: the key vault's
 * sentences, an unsafe community address), and otherwise shows exactly as it came: a community's own words, a sign-in
 * provider's own error.
 * Nothing here imports those files at runtime: utils/__tests__/welcome-lines.test.ts holds every sentence to the
 * constant, literal or builder it stands for, so a sentence changed there fails a test rather than quietly showing
 * English.
 */
import { t, tn, word, type WordKey } from '@beanpool/core';
import type { DoorAnswer, NameCheck } from '../../utils/global-join';
import type { LinkAnswer } from '../../utils/join-link';
import { SSO_PROVIDER_NAMES } from '../../utils/sso-providers';
import { signInCopiesAt } from '../../utils/vault-config';
import { settingsLineWords } from '../settings/settings-lines';

/** Whole sentences, by their English. */
const FIXED: Readonly<Record<string, WordKey>> = {
    // utils/node-profile.ts GLOBAL_DOOR_MESSAGES, which utils/global-join.ts DOOR_MESSAGES repeats: the global community's
    // door, on arrival and in its answers.
    "Can't reach the global community right now. Try again, or join with an invite.": word("Can't reach the global community right now. Try again, or join with an invite."),
    "The global community isn't available right now. You can still join a community with an invite.": word("The global community isn't available right now. You can still join a community with an invite."),
    "The global community isn't taking new members right now. You can still join a community with an invite.": word("The global community isn't taking new members right now. You can still join a community with an invite."),
    'This community is in a private preview. Ask its owner for an invite.': word('This community is in a private preview. Ask its owner for an invite.'),
    // utils/global-join.ts DOOR_MESSAGES: what the door answered.
    'This sign-in already has a BeanPool identity in the global community. Restore it with your 12 words or your sign-in instead.': word('This sign-in already has a BeanPool identity in the global community. Restore it with your 12 words or your sign-in instead.'),
    "This account's place in the global community was closed, so it can't join again.": word("This account's place in the global community was closed, so it can't join again."),
    "The BeanPool identity this sign-in joined with was removed from the global community, so it can't join again. You can still join a community with an invite.": word("The BeanPool identity this sign-in joined with was removed from the global community, so it can't join again. You can still join a community with an invite."),
    "This phone's key was replaced by a new one, so it can't join. Use the device or the 12 words that hold the new key.": word("This phone's key was replaced by a new one, so it can't join. Use the device or the 12 words that hold the new key."),
    'Too many new accounts have joined from this network. Please try again later.': word('Too many new accounts have joined from this network. Please try again later.'),
    'This community needs a sign-in to join: Google, Apple or Facebook. You can sign in below.': word('This community needs a sign-in to join: Google, Apple or Facebook. You can sign in below.'),
    'Your sign-in could not be used. Please sign in again.': word('Your sign-in could not be used. Please sign in again.'),
    "The global community couldn't accept this because your phone's date and time look wrong. Check them in your phone's settings (set them to automatic), then try again.": word("The global community couldn't accept this because your phone's date and time look wrong. Check them in your phone's settings (set them to automatic), then try again."),
    'Your join could not be completed, and nothing was saved. Please try again in a minute.': word('Your join could not be completed, and nothing was saved. Please try again in a minute.'),
    'Checking your sign-in another way…': word('Checking your sign-in another way…'),
    // utils/global-join.ts WORK_MESSAGES: the door's work refused twice.
    "Setting up your account didn't finish. Please try again.": word("Setting up your account didn't finish. Please try again."),
    "Setting up your account didn't work out. Please try again.": word("Setting up your account didn't work out. Please try again."),
    "That took a while, so setting up your account had to start again, and it didn't finish. Please try again.": word("That took a while, so setting up your account had to start again, and it didn't finish. Please try again."),
    // utils/global-join.ts: the door's sign-in and join refused on the phone.
    "That sign-in did not say who you are, so it can't be used. Try again.": word("That sign-in did not say who you are, so it can't be used. Try again."),
    'This phone holds a different BeanPool account, so the join was not sent.': word('This phone holds a different BeanPool account, so the join was not sent.'),
    'This phone holds a different BeanPool account, so the join was not saved here.': word('This phone holds a different BeanPool account, so the join was not saved here.'),
    // utils/door-work.ts DOOR_WORK_MESSAGES.solverUnavailable.
    "This phone can't finish setting up a 12-words account right now. Try again, or sign in.": word("This phone can't finish setting up a 12-words account right now. Try again, or sign in."),
    // utils/db.ts redeemInvite: the invite join's redeem with no answer in time (REDEEM_NO_ANSWER), a node that is down (a
    // page came back in place of its answer), an answer that didn't say the join was taken, and no key to redeem with.
    'No answer from the community node in time. Check your connection and try again.': word('No answer from the community node in time. Check your connection and try again.'),
    'Relay Node Offline: The selected community node is currently unreachable.': word('Relay Node Offline: The selected community node is currently unreachable.'),
    'The community node did not confirm the invite. Please try again.': word('The community node did not confirm the invite. Please try again.'),
    'No identity to register': word('No identity to register'),
    // utils/sso-recovery.ts recoverAccountWithSso: its progress, and why it stopped.
    'Connecting to node recovery session...': word('Connecting to node recovery session...'),
    'Requesting secure sign-in challenge...': word('Requesting secure sign-in challenge...'),
    'Verifying sign-in with node...': word('Verifying sign-in with node...'),
    'Downloading recovery fragments...': word('Downloading recovery fragments...'),
    'Reconstructing account identity...': word('Reconstructing account identity...'),
    'Collecting node fragment...': word('Collecting node fragment...'),
    'Account restored successfully!': word('Account restored successfully!'),
    'Could not determine user identifier for this sign-in.': word('Could not determine user identifier for this sign-in.'),
    // utils/vault.ts subjectOf: the key vault's restore, from a sign-in whose token names no account.
    "That sign-in didn't say which account it was, so it can't be used. Try again.": word("That sign-in didn't say which account it was, so it can't be used. Try again."),
    'Sign-in token does not contain a valid subject claim (sub).': word('Sign-in token does not contain a valid subject claim (sub).'),
    "Your community's copy didn't open on this phone, so nothing was changed. Start again, or use your 12 words.": word("Your community's copy didn't open on this phone, so nothing was changed. Start again, or use your 12 words."),
    "Getting back in with a sign-in goes through BeanPool's key vault in this version of the app. Your 12 words work any time.": word("Getting back in with a sign-in goes through BeanPool's key vault in this version of the app. Your 12 words work any time."),
    'Enter your callsign to recover your account.': word('Enter your callsign to recover your account.'),
    'Enter your community node address.': word('Enter your community node address.'),
    "That node address doesn't look right. Use something like node.yourcommunity.org": word("That node address doesn't look right. Use something like node.yourcommunity.org"),
    'That node address is insecure (http on a public host). Use https:// instead.': word('That node address is insecure (http on a public host). Use https:// instead.'),
    'Node did not return a valid recovery session ID.': word('Node did not return a valid recovery session ID.'),
    'Node returned an empty sign-in nonce.': word('Node returned an empty sign-in nonce.'),
    'Sign-in recovery piece was not returned by the node.': word('Sign-in recovery piece was not returned by the node.'),
    'Sign-in piece is missing derivation parameters (kdfParams).': word('Sign-in piece is missing derivation parameters (kdfParams).'),
    'Decrypted recovery seed has invalid length.': word('Decrypted recovery seed has invalid length.'),
    'Hub recovery piece was not returned by the node.': word('Hub recovery piece was not returned by the node.'),
    'Failed to combine recovery fragments.': word('Failed to combine recovery fragments.'),
    // utils/sso-signin.ts: a sign-in that didn't finish on this phone.
    'Your node did not send a sign-in nonce.': word('Your node did not send a sign-in nonce.'),
    'Apple completed the sign-in but returned no token.': word('Apple completed the sign-in but returned no token.'),
    'Apple Sign-In requires an active Apple ID in device or simulator settings (Settings → Apple ID).': word('Apple Sign-In requires an active Apple ID in device or simulator settings (Settings → Apple ID).'),
    'Google Sign-In requires Google Play Services and an active Google account on this device / emulator.': word('Google Sign-In requires Google Play Services and an active Google account on this device / emulator.'),
    'This device cannot sign in with Apple.': word('This device cannot sign in with Apple.'),
    'This device or build cannot sign in with Google.': word('This device or build cannot sign in with Google.'),
    "Google signed you in but did not include this sign-in's security code, so your community would refuse it. Try again.": word("Google signed you in but did not include this sign-in's security code, so your community would refuse it. Try again."),
    'This version of BeanPool cannot sign in with Google. Update BeanPool and try again.': word('This version of BeanPool cannot sign in with Google. Update BeanPool and try again.'),
    'Google completed the sign-in but returned no token.': word('Google completed the sign-in but returned no token.'),
    "Google's answer did not belong to this sign-in. Try again.": word("Google's answer did not belong to this sign-in. Try again."),
    "Google's sign-in page could not open on this phone. Try again.": word("Google's sign-in page could not open on this phone. Try again."),
    "Facebook didn't finish the sign-in. Try again, or choose another way.": word("Facebook didn't finish the sign-in. Try again, or choose another way."),
    // utils/sso-sheet-connect.ts and utils/keeper-enrolment.ts: linking a sign-in that didn't go through.
    'ID token missing subject claim (sub).': word('ID token missing subject claim (sub).'),
    "The phone's lock was not passed, so no sign-in was linked.": word("The phone's lock was not passed, so no sign-in was linked."),
    "That sign-in didn't say which account it was, so nothing was linked. Try again.": word("That sign-in didn't say which account it was, so nothing was linked. Try again."),
    // utils/sso-sheet-connect.ts CONNECT_RULE_MESSAGES: the community's rule for copies said no, couldn't be asked, or
    // sends the copy somewhere other than the screen said (VR2).
    "Your community keeps no copies of members' accounts, so no sign-in was linked. Your 12 words are your way back there.": word("Your community keeps no copies of members' accounts, so no sign-in was linked. Your 12 words are your way back there."),
    "Your community couldn't be asked where it keeps copies, so no sign-in was linked. Try again when you're connected.": word("Your community couldn't be asked where it keeps copies, so no sign-in was linked. Try again when you're connected."),
    'Your community changed where it keeps copies, so no sign-in was linked. Close this to see where a copy goes now, then link it again.': word('Your community changed where it keeps copies, so no sign-in was linked. Close this to see where a copy goes now, then link it again.'),
    'No node configured yet.': word('No node configured yet.'),
    'The sign-in could not be linked.': word('The sign-in could not be linked.'),
    // utils/protection-state.ts KEEPER_LABELS: what holds a piece, on the covered panel.
    'Your community hub': word('Your community hub'),
    'A trusted friend': word('A trusted friend'),
    'Your sign-in account': word('Your sign-in account'),
    // utils/no-words-copy.ts: a phone with no 12 words, and a sign-in that brings them back.
    'This phone was restored with a sign-in, so it has no 12 words. A connected sign-in is how you get back in.': word('This phone was restored with a sign-in, so it has no 12 words. A connected sign-in is how you get back in.'),
    'A sign-in connected on this version of the app brings your 12 words back too. One connected on an earlier version brings back your account without them: tap Connect again to include them.': word('A sign-in connected on this version of the app brings your 12 words back too. One connected on an earlier version brings back your account without them: tap Connect again to include them.'),
    // utils/words-on-screen.ts NO_SCREEN_LOCK_LINE and utils/words-clipboard.ts COPY_CLEARS_LINE: under the words.
    "This phone has no screen lock, so anyone holding it can open these words. You can set one in the phone's settings.": word("This phone has no screen lock, so anyone holding it can open these words. You can set one in the phone's settings."),
    'The copy clears from your clipboard after a minute. If you leave BeanPool first, it clears when you come back.': word('The copy clears from your clipboard after a minute. If you leave BeanPool first, it clears when you come back.'),
    // utils/recovery-kit.ts: the kit's two buttons, its question before Save as PDF, and its one failure.
    'Print your recovery kit': word('Print your recovery kit'),
    'Save as PDF': word('Save as PDF'),
    'Keep this file off cloud backups and chats. Anyone who has it can sign in as you.': word('Keep this file off cloud backups and chats. Anyone who has it can sign in as you.'),
    'The recovery kit couldn’t be made on this phone. Write the 12 words down instead.': word('The recovery kit couldn’t be made on this phone. Write the 12 words down instead.'),
    Cancel: word('Cancel'),
    Save: word('Save'),
};

/** The English of every whole sentence above: what welcome-lines.test.ts holds to the sources. */
export const WELCOME_FIXED_LINES: readonly string[] = Object.freeze(Object.keys(FIXED));

/** "in a minute", "in 5 minutes", "in about an hour", "in about 3 hours": utils/global-join.ts tryAgainIn, said again. */
export function tryAgainWords(seconds: number): string {
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    if (minutes < 60) return tn(minutes, 'in a minute', 'in {n} minutes');
    return tn(Math.round(minutes / 60), 'in about an hour', 'in about {n} hours');
}

/** One of tryAgainIn's phrases (or global-join's "later", for no time given), back in the member's language. */
function whenWords(phrase: string): string {
    if (phrase === 'later') return t('later', undefined, 'when to try again: "Please try again later."');
    const minutes = phrase === 'in a minute' ? 1 : Number(phrase.match(/^in (\d+) minutes$/)?.[1] ?? NaN);
    if (Number.isFinite(minutes)) return tryAgainWords(minutes * 60);
    const hours = phrase === 'in about an hour' ? 1 : Number(phrase.match(/^in about (\d+) hours$/)?.[1] ?? NaN);
    if (Number.isFinite(hours)) return tryAgainWords(hours * 3600);
    return phrase;
}

/** "about a second", "about 20 seconds", "about a minute", "about 4 minutes": utils/door-work.ts aboutHowLong's phrases. */
function aboutWords(phrase: string): string {
    const seconds = phrase === 'about a second' ? 1 : Number(phrase.match(/^about (\d+) seconds$/)?.[1] ?? NaN);
    if (Number.isFinite(seconds)) return tn(seconds, 'about a second', 'about {n} seconds');
    const minutes = phrase === 'about a minute' ? 1 : Number(phrase.match(/^about (\d+) minutes$/)?.[1] ?? NaN);
    if (Number.isFinite(minutes)) return tn(minutes, 'about a minute', 'about {n} minutes');
    return phrase;
}

/** Sentences with a name, a number or a time in them, by their English pattern. */
const FILLED: ReadonlyArray<{ pattern: RegExp; words: (m: RegExpMatchArray) => string }> = [
    // utils/global-join.ts busyAnswer: a 429 that names its door, and the door's own limiter.
    {
        pattern: /^A very large number of 12-words accounts were made from your network today\. Sign in to join now, or try again (.+)\.$/,
        words: (m) => t('A very large number of 12-words accounts were made from your network today. Sign in to join now, or try again {when}.', { when: whenWords(m[1]) }),
    },
    {
        pattern: /^A very large number of 12-words accounts were made from your network in the last hour\. Sign in to join now, or try again (.+)\.$/,
        words: (m) => t('A very large number of 12-words accounts were made from your network in the last hour. Sign in to join now, or try again {when}.', { when: whenWords(m[1]) }),
    },
    {
        pattern: /^Too many new accounts have joined from your network today\. Please try again (.+)\.$/,
        words: (m) => t('Too many new accounts have joined from your network today. Please try again {when}.', { when: whenWords(m[1]) }),
    },
    {
        pattern: /^Too many new accounts have joined from your network in the last hour\. Please try again (.+)\.$/,
        words: (m) => t('Too many new accounts have joined from your network in the last hour. Please try again {when}.', { when: whenWords(m[1]) }),
    },
    {
        pattern: /^There were too many tries in a short time\. Please try again (.+)\.$/,
        words: (m) => t('There were too many tries in a short time. Please try again {when}.', { when: whenWords(m[1]) }),
    },
    // utils/global-join.ts: a provider the global community's list leaves out (its key, as the node names it).
    {
        pattern: /^The global community does not accept (\w+) sign-in\.$/,
        words: (m) => t('The global community does not accept {provider} sign-in.', { provider: m[1] }),
    },
    // utils/door-work.ts busyLevelSentence: the door is busy, with this phone's own estimate.
    {
        pattern: /^Lots of people are joining right now\. Setting up a 12-words account will take (.+) on this phone\. Or sign in to join now\.$/,
        words: (m) => t('Lots of people are joining right now. Setting up a 12-words account will take {time} on this phone. Or sign in to join now.', { time: aboutWords(m[1]) }),
    },
    // utils/sso-recovery.ts: the sign-in under way, and a community's refusal with no words of its own, by its status.
    {
        pattern: /^Signing in with (Apple|Google|Facebook)\.\.\.$/,
        words: (m) => t('Signing in with {provider}...', { provider: m[1] }),
    },
    { pattern: /^Failed to fetch fragments \((\d+)\)$/, words: (m) => t('Failed to fetch fragments ({status})', { status: m[1] }) },
    { pattern: /^Could not open recovery session \((\d+)\)$/, words: (m) => t('Could not open recovery session ({status})', { status: m[1] }) },
    { pattern: /^Could not obtain sign-in challenge \((\d+)\)$/, words: (m) => t('Could not obtain sign-in challenge ({status})', { status: m[1] }) },
    { pattern: /^Sign-in verification failed \((\d+)\)$/, words: (m) => t('Sign-in verification failed ({status})', { status: m[1] }) },
    { pattern: /^Hub release failed \((\d+)\)$/, words: (m) => t('Hub release failed ({status})', { status: m[1] }) },
    // utils/sso-signin.ts: a sign-in that didn't finish, with the node's or the provider's own words after it.
    { pattern: /^Could not reach your node: ([\s\S]*)$/, words: (m) => t('Could not reach your node: {reason}', { reason: m[1] }) },
    {
        pattern: /^Your node would not start a sign-in \((\d+)\): ([\s\S]*)$/,
        words: (m) => t('Your node would not start a sign-in ({status}): {reason}', { status: m[1], reason: m[2] }),
    },
    { pattern: /^Apple could not sign you in: ([\s\S]*)$/, words: (m) => t('Apple could not sign you in: {reason}', { reason: m[1] }) },
    { pattern: /^Google could not sign you in: ([\s\S]*)$/, words: (m) => t('Google could not sign you in: {reason}', { reason: m[1] }) },
    { pattern: /^Your node does not accept (\w+) sign-in\.$/, words: (m) => t('Your node does not accept {provider} sign-in.', { provider: m[1] }) },
    { pattern: /^Provider (\w+) is not supported on this device\.$/, words: (m) => t('Provider {provider} is not supported on this device.', { provider: m[1] }) },
    // utils/sso-signin.ts: the provider's page gave no answer in time (the provider's key, as it writes it).
    { pattern: /^(\w+) sign-in timed out\.$/, words: (m) => t('{provider} sign-in timed out.', { provider: m[1] }) },
    // utils/db.ts redeemInvite: the node down, by its status, and a refusal with no words of the node's own (any text it sent
    // instead follows, as it came).
    {
        pattern: /^Relay Node Offline: The selected community node is currently unreachable \(HTTP (\d+)\)\.$/,
        words: (m) => t('Relay Node Offline: The selected community node is currently unreachable (HTTP {status}).', { status: m[1] }),
    },
    { pattern: /^Failed to redeem invite \(HTTP (\d+)\)$/, words: (m) => t('Failed to redeem invite (HTTP {status})', { status: m[1] }) },
    { pattern: /^Failed to redeem invite \(HTTP (\d+)\): ([\s\S]*)$/, words: (m) => t('Failed to redeem invite (HTTP {status}): {reason}', { status: m[1], reason: m[2] }) },
    // utils/keeper-enrolment.ts: the account couldn't be sealed to the sign-in, with why.
    {
        pattern: /^Your account couldn't be locked to this sign-in \(([\s\S]*)\)\. Nothing was linked\.$/,
        words: (m) => t("Your account couldn't be locked to this sign-in ({reason}). Nothing was linked.", { reason: m[1] }),
    },
];

/**
 * One of the sentences above in the member's language; then Settings' (the key vault's, an unsafe address); anything
 * else (a community's own words, a sign-in provider's) exactly as given.
 */
export function welcomeLineWords(english: string): string {
    if (Object.prototype.hasOwnProperty.call(FIXED, english)) return t(FIXED[english]);
    for (const { pattern, words } of FILLED) {
        const m = english.match(pattern);
        if (m) return words(m);
    }
    return settingsLineWords(english);
}

/** utils/global-join.ts doorMessage: what the door answered, with when to try again if the node said. */
export function doorAnswerWords(answer: Exclude<DoorAnswer, { kind: 'joined' }>): string {
    if (answer.kind === 'rate_limited' && answer.retryAfterSeconds && !answer.timed) {
        return t('{reason} (Try again {when}.)', { reason: welcomeLineWords(answer.message), when: tryAgainWords(answer.retryAfterSeconds) });
    }
    return welcomeLineWords(answer.message);
}

/** utils/global-join.ts nameCheckMessage: the door's name step, said again from the same check. */
export function nameCheckWords(name: string, check: NameCheck): string {
    switch (check.kind) {
        case 'timed_out':
            return t("The global community didn't answer in time, so your name wasn't checked and nothing was sent. Check your connection, then tap Join to try again, or go back.");
        case 'taken':
            if (check.suggestionsTimedOut) {
                return t('"{name}" is already taken in the global community, and suggestions didn\'t load in time. Choose another name, then tap Join.', { name });
            }
            return check.suggestions.length > 0
                ? t('"{name}" is already taken in the global community. Pick one of the suggestions below, or choose another name.', { name })
                : t('"{name}" is already taken in the global community. Choose another name.', { name });
        default:
            return '';
    }
}

/**
 * utils/join-link.ts linkedNotice: a sign-in added at Safety Backup, said again from the same answer. `community` as
 * linkedNotice takes it: another community's name, whose open door the wizard came in by (slice S2); absent, the global
 * community.
 */
export function linkedNoticeWords(answer: Extract<LinkAnswer, { kind: 'linked' }>, community?: string): string {
    // linkedNotice's own fallback for a provider it has no name for, as it says it.
    const name = SSO_PROVIDER_NAMES[answer.provider] ?? t('Your sign-in');
    if (!answer.enrolment) {
        // The door's community keeps no copies (its rule, vault rethink VR2): none was made, by design.
        if (answer.noCopies) {
            return community
                ? t("Your {name} sign-in is added: your account now has the usual new-account limits. {community} keeps no copies of members' accounts, so your 12 words are still your way back.", { name, community })
                : t("Your {name} sign-in is added: your account now has the usual new-account limits. The global community keeps no copies of members' accounts, so your 12 words are still your way back.", { name });
        }
        return t("Your {name} sign-in is added: your account now has the usual new-account limits. It couldn't keep a copy of your account right now, so for getting back in, your 12 words are still the way: Account Protection in Settings can link it again.", { name });
    }
    // As utils/join-link.ts linkedAtVault: where the deposit said, else this build's place.
    if (answer.enrolment.keptAt ? answer.enrolment.keptAt === 'vault' : signInCopiesAt() === 'vault') {
        return t('Your {name} sign-in is added: your account now has the usual new-account limits. If you lose this phone, sign in with {name} to get back in.', { name });
    }
    return community
        ? t('Your {name} sign-in is added: your account now has the usual new-account limits. If you lose this phone, sign in with {name} to get back into {community}.', { name, community })
        : t('Your {name} sign-in is added: your account now has the usual new-account limits. If you lose this phone, sign in with {name} to get back into the global community.', { name });
}

/** utils/no-words-copy.ts signInReplacedNote. */
export function signInReplacedWords(providerName: string): string {
    return t('This {provider} account used to protect a different BeanPool account. It protects this one now, and that one has only its 12 words.', { provider: providerName });
}

/** utils/no-words-copy.ts noWordsBeforeWipe, for the account by its name (Settings' table has the one with none). */
export function noWordsBeforeWipeWords(name?: string): string {
    return name
        ? t('This phone was restored with a sign-in, so it has no 12 words for {name}. Without a connected sign-in, you cannot get {name} back.', { name })
        : settingsLineWords('This phone was restored with a sign-in, so it has no 12 words. Without a connected sign-in, you cannot get this account back.');
}

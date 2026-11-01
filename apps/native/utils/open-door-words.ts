/**
 * What the door screen (app/join-open-door.tsx) says, by the community it is for (utils/open-door.ts): the global
 * community's door says exactly what it said before slice P5; another community's door says the same things under that
 * community's own name (DESIGN-global-entry-fable.md §E: "the node's own name for anyone else's"), through the words layer.
 *
 * The phone's own sentences about a refusal name the global community (utils/global-join.ts DOOR_MESSAGES, shared with the
 * first screen's door); at another community's door each is said again with its name. What a node says itself in its
 * answer (open-join.ts: "this community", "here") is shown as it came, at any door.
 *
 * The global community's door says its sentences in the member's language too. The phone's own fixed sentences that
 * global-join.ts, global-join-existing.ts and door-work.ts write (they sign the join and hold the key, so they stay off
 * the words layer: core recovery-path-files' rule) are translated here, by their exact English (PHONE_DOOR_LINES;
 * utils/__tests__/join-door-words-render.test.ts holds the table to them both ways: each entry is one of their
 * sentences, and each fixed sentence they write is an entry or is named there with why not). A node's own sentence, and
 * one with a time or a sign-in's name in it, is shown as it came.
 */
import { t, word, type WordKey } from '@beanpool/core';
import {
    DOOR_MESSAGES, doorMessage, nameCheckMessage, type DoorAnswer, type NameCheck,
} from './global-join';
import { accountDoorMessage } from './global-join-existing';
import { GLOBAL_DOOR_MESSAGES, type GlobalDoorRefusal } from './node-profile';
import { communityName } from './community-name';
import type { SignInCopies } from './vault-config';

/** The phone's fixed door sentences by their exact English: see the note above. */
const PHONE_DOOR_LINES: Readonly<Record<string, WordKey>> = {
    "This account's place in the global community was closed, so it can't join again.": word("This account's place in the global community was closed, so it can't join again."),
    "The BeanPool identity this sign-in joined with was removed from the global community, so it can't join again. You can still join a community with an invite.": word("The BeanPool identity this sign-in joined with was removed from the global community, so it can't join again. You can still join a community with an invite."),
    "This phone's key was replaced by a new one, so it can't join. Use the device or the 12 words that hold the new key.": word("This phone's key was replaced by a new one, so it can't join. Use the device or the 12 words that hold the new key."),
    'Too many new accounts have joined from this network. Please try again later.': word('Too many new accounts have joined from this network. Please try again later.'),
    'This community needs a sign-in to join: Google, Apple or Facebook. You can sign in below.': word('This community needs a sign-in to join: Google, Apple or Facebook. You can sign in below.'),
    'Your sign-in could not be used. Please sign in again.': word('Your sign-in could not be used. Please sign in again.'),
    "The global community couldn't accept this because your phone's date and time look wrong. Check them in your phone's settings (set them to automatic), then try again.": word("The global community couldn't accept this because your phone's date and time look wrong. Check them in your phone's settings (set them to automatic), then try again."),
    'Your join could not be completed, and nothing was saved. Please try again in a minute.': word('Your join could not be completed, and nothing was saved. Please try again in a minute.'),
    'Checking your sign-in another way…': word('Checking your sign-in another way…'),
    // global-join.ts WORK_MESSAGES: the door work didn't count twice in a row.
    "Setting up your account didn't finish. Please try again.": word("Setting up your account didn't finish. Please try again."),
    "Setting up your account didn't work out. Please try again.": word("Setting up your account didn't work out. Please try again."),
    "That took a while, so setting up your account had to start again, and it didn't finish. Please try again.": word("That took a while, so setting up your account had to start again, and it didn't finish. Please try again."),
    'This sign-in already joined the global community with a different BeanPool account. To join as the account on this phone, use a different sign-in.': word('This sign-in already joined the global community with a different BeanPool account. To join as the account on this phone, use a different sign-in.'),
    'This phone has no BeanPool account now, so nothing was sent. Go back and start again from the first screen.': word('This phone has no BeanPool account now, so nothing was sent. Go back and start again from the first screen.'),
    "This phone can't finish setting up a 12-words account right now. Try again, or sign in.": word("This phone can't finish setting up a 12-words account right now. Try again, or sign in."),
    // global-join.ts DOOR_MESSAGES and door-work.ts DOOR_WORK_MESSAGES: the person check on a busy day.
    'Lots of people are joining right now, so a 12-words account starts with a quick check. Sign in to join now, or try again later.': word('Lots of people are joining right now, so a 12-words account starts with a quick check. Sign in to join now, or try again later.'),
    "That check didn't pass. Try again, or sign in to join now.": word("That check didn't pass. Try again, or sign in to join now."),
    "The quick check didn't work on this phone. Try again, or sign in to join now.": word("The quick check didn't work on this phone. Try again, or sign in to join now."),
    'Lots of people are joining right now, so this way starts with a quick check from Cloudflare. Or sign in to join now.': word('Lots of people are joining right now, so this way starts with a quick check from Cloudflare. Or sign in to join now.'),
    // door-key.ts commitDoorKey and keepJoinedIdentity: since S2 a phone with no account joins at another community's door
    // too (utils/open-door-key.ts), and a key the phone stored meanwhile is never written over.
    'This phone holds a different BeanPool account, so the join was not sent.': word('This phone holds a different BeanPool account, so the join was not sent.'),
    'This phone holds a different BeanPool account, so the join was not saved here.': word('This phone holds a different BeanPool account, so the join was not saved here.'),
    "You're in the global community": word("You're in the global community"),
    'Your key and your 12 words are the same as before, and nothing changed in your other communities: your posts, chats and trades stay in each one.': word('Your key and your 12 words are the same as before, and nothing changed in your other communities: your posts, chats and trades stay in each one.'),
    [GLOBAL_DOOR_MESSAGES.unreachable]: GLOBAL_DOOR_MESSAGES.unreachable,
    [GLOBAL_DOOR_MESSAGES.door_closed]: GLOBAL_DOOR_MESSAGES.door_closed,
    // global-join.ts PRIVATE_PREVIEW_MESSAGE, the same English as the server's own sentence.
    [GLOBAL_DOOR_MESSAGES.private_preview]: GLOBAL_DOOR_MESSAGES.private_preview,
};

/** One of the phone's fixed door sentences in the member's language; anything else (a node's own) exactly as given. */
export function phoneDoorLineWords(english: string): string {
    return Object.prototype.hasOwnProperty.call(PHONE_DOOR_LINES, english) ? t(PHONE_DOOR_LINES[english]) : english;
}

/**
 * global-join-existing.ts joinedGlobalNotice's body, paragraph by paragraph: what came with the member, what their sign-in
 * now does for the account (by the sign-in's name), and, when it had, whose account it used to protect (no-words-copy.ts
 * signInReplacedNote). A paragraph read no other way is shown as given.
 */
export function joinedGlobalBodyWords(body: string): string {
    return body.split('\n\n').map((paragraph) => {
        const everywhere = paragraph.match(/^Your (.+) sign-in is now also a way back into your account, in every community\.$/);
        if (everywhere) return t('Your {name} sign-in is now also a way back into your account, in every community.', { name: everywhere[1] });
        const here = paragraph.match(/^Your (.+) sign-in is now also a way back into your account here\.$/);
        if (here) return t('Your {name} sign-in is now also a way back into your account here.', { name: here[1] });
        const replaced = paragraph.match(/^This (.+) account used to protect a different BeanPool account\. It protects this one now, and that one has only its 12 words\.$/);
        if (replaced) return t('This {provider} account used to protect a different BeanPool account. It protects this one now, and that one has only its 12 words.', { provider: replaced[1] });
        return phoneDoorLineWords(paragraph);
    }).join('\n\n');
}

/** The community a door is for, as the screen names it. */
export interface DoorPlace {
    /** The global community: every sentence as it was. */
    global: boolean;
    /** Its own name (its answer, else this phone's saved name for it, else its host). Not read for the global community. */
    name: string;
    /** Its host, shown under the title at another community's door, so the member sees where they are joining. */
    host: string;
}

/** The screen's fixed words. */
export function doorScreenWords(place: DoorPlace) {
    const name = place.name;
    return place.global
        ? {
            header: t('Global community'),
            title: t('🌍 Join the global community'),
            connecting: t('Connecting to the global community…'),
            intro: t('Meet people from everywhere and find communities near you, as the account on this phone. Your key and your 12 words stay the same, and nothing changes in your other communities.'),
            nameLabel: t('Your name in the global community'),
            joining: t('Joining the global community…'),
            notOpened: t('You joined the global community, but the app could not open it. Open it from Your communities in the BeanPool sheet (tap the bean).'),
        }
        : {
            header: name,
            title: t('Join {name}', { name }),
            connecting: t('Connecting to {name}…', { name }),
            intro: t('{name} lets anyone join. Join as the account on this phone: your key and your 12 words stay the same, and nothing changes in your other communities.', { name }),
            nameLabel: t('Your name in {name}', { name }),
            joining: t('Joining {name}…', { name }),
            notOpened: t('You joined {name}, but the app could not open it. Open it from Your communities in the BeanPool sheet (tap the bean).', { name }),
        };
}

/**
 * What another community's door says to a phone with no account (DESIGN-account-without-global-fable.md §4, slice S2): the
 * join makes a new BeanPool account on this phone, there (utils/open-door-key.ts). Never said at the global community's
 * door, which with no account is the first screen's.
 */
export function newPhoneDoorWords(place: DoorPlace) {
    const name = place.name;
    return {
        /** Under the title, above the two ways in. */
        intro: t('Join {name} with a new BeanPool account on this phone: 12 words, or a sign-in.', { name }),
        /** A door that takes a sign-in only. */
        introSignIn: t('Join {name} with a new BeanPool account on this phone.', { name }),
        /** The name step, the 12-words way: the words are new, and come after the photo (as at the first screen's door). */
        wordsName: t('🔑 An account with 12 secret words. They come next, after your photo.'),
        /** 409 `already_joined`: this sign-in has an account there already, made on another phone. */
        alreadyJoined: t('This sign-in already has a BeanPool account in {name}. Restore it with your 12 words or your sign-in instead.', { name }),
        /** In, but the phone couldn't write the wizard's next step. */
        notSaved: t("{name} let you in, but this phone couldn't save that yet. Try again.", { name }),
    };
}

/**
 * Who keeps a copy of the account for the door's sign-in, said beside the sign-in buttons: `choose` under the two ways in,
 * `signIn` above the buttons. The global community's door as before. At another community's door, a build without the
 * key vault sends the copy in the join and that community keeps it; a build with the vault deposits it there only where
 * the door lists the vault's ticket keys (global-join.ts doorTicketKeys), which is not known until the sign-in starts.
 * A door whose community keeps no copies (its rule, vault rethink VR2: `none`) says so: the sign-in only joins.
 */
export function doorKeeperWords(place: DoorPlace, copiesAt: SignInCopies): { choose: string; signIn: string } {
    if (copiesAt === 'none') {
        const name = place.global ? t('The global community') : place.name;
        return {
            choose: t("{name} keeps no copies of members' accounts, so the sign-in only lets you in: your 12 words are your way back. BeanPool never sees your password and never posts anything for you.", { name }),
            signIn: t("To keep out fake accounts, sign in once with an account you already have. {name} keeps no copies of members' accounts, so the sign-in only lets you in: your 12 words are your way back. BeanPool never sees your password and never posts anything for you.", { name }),
        };
    }
    if (place.global) {
        return copiesAt === 'vault'
            ? {
                choose: t('BeanPool keeps a locked copy of your account for it, and BeanPool can open that copy. BeanPool never sees your password and never posts anything for you.'),
                signIn: t('To keep out fake accounts, sign in once with an account you already have. That sign-in also becomes a way back into your account if you lose this phone: BeanPool keeps a locked copy of your account for it, and BeanPool can open that copy. BeanPool never sees your password and never posts anything for you.'),
            }
            : {
                choose: t('The global community keeps a locked copy of your account for it, and the people who run it can open that copy. BeanPool never sees your password and never posts anything for you.'),
                signIn: t('To keep out fake accounts, sign in once with an account you already have. That sign-in also becomes a way back into your account if you lose this phone: the global community keeps a locked copy of your account for it, and the people who run it can open that copy. BeanPool never sees your password and never posts anything for you.'),
            };
    }
    const name = place.name;
    return copiesAt === 'vault'
        ? {
            choose: t('If {name} works with the BeanPool key vault, the sign-in also becomes a way back into your account: BeanPool keeps a locked copy of your account for it, and BeanPool can open that copy. BeanPool never sees your password and never posts anything for you.', { name }),
            signIn: t('To keep out fake accounts, sign in once with an account you already have. If {name} works with the BeanPool key vault, that sign-in also becomes a way back into your account: BeanPool keeps a locked copy of your account for it, and BeanPool can open that copy. BeanPool never sees your password and never posts anything for you.', { name }),
        }
        : {
            choose: t('The sign-in also becomes a way back into your account if you lose this phone: {name} keeps a locked copy of your account for it, and the people who run it can open that copy. BeanPool never sees your password and never posts anything for you.', { name }),
            signIn: t('To keep out fake accounts, sign in once with an account you already have. That sign-in also becomes a way back into your account if you lose this phone: {name} keeps a locked copy of your account for it, and the people who run it can open that copy. BeanPool never sees your password and never posts anything for you.', { name }),
        };
}

/** Why the door can't be used now, from its check (node-profile.ts checkGlobalDoor). */
export function doorRefusalWords(reason: GlobalDoorRefusal, place: DoorPlace): string {
    if (place.global) return t(GLOBAL_DOOR_MESSAGES[reason]);
    const name = place.name;
    switch (reason) {
        case 'unreachable': return t("Can't reach {name} right now. Check your connection and try again.", { name });
        case 'not_global': return t("{name} joins people by invite, so it can't be joined here. Ask one of its members for an invite.", { name });
        case 'door_closed': return t("{name} isn't taking new members right now. You can still join a community with an invite.", { name });
        case 'private_preview': return t('This community is in a private preview. Ask its owner for an invite.');
    }
}

/** What the screen says for an answer that isn't `joined` (global-join-existing.ts accountDoorMessage, by name). */
export function doorAnswerWords(answer: Exclude<DoorAnswer, { kind: 'joined' }>, place: DoorPlace): string {
    if (place.global) return phoneDoorLineWords(accountDoorMessage(answer));
    const name = place.name;
    switch (answer.kind) {
        case 'already_joined':
            return t('This sign-in already joined {name} with a different BeanPool account. To join as the account on this phone, use a different sign-in.', { name });
        case 'account_closed':
            return t("This account's place in {name} was closed, so it can't join again.", { name });
        case 'phone_clock':
            return t("{name} couldn't accept this because your phone's date and time look wrong. Check them in your phone's settings (set them to automatic), then try again.", { name });
        case 'unreachable':
            return doorRefusalWords('unreachable', place);
        case 'door_closed':
            // The node's own sentence (a private preview says why) stays; the phone's, for a 403 or 404 that said none, is renamed.
            return answer.message === DOOR_MESSAGES.doorClosed ? doorRefusalWords('door_closed', place) : answer.message;
        case 'removed':
            return answer.message === DOOR_MESSAGES.removed
                ? t("The BeanPool identity this sign-in joined with was removed from {name}, so it can't join again. You can still join a community with an invite.", { name })
                : answer.message;
        default:
            return phoneDoorLineWords(doorMessage(answer));
    }
}

/** What the name step says when its check doesn't lead to the join (global-join.ts nameCheckMessage, by name). */
export function doorNameCheckWords(name: string, check: NameCheck, place: DoorPlace): string {
    if (place.global) {
        // nameCheckMessage's sentences (global-join.ts), in the member's language; the tests hold the two to the same English.
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
                return nameCheckMessage(name, check);
        }
    }
    const community = place.name;
    switch (check.kind) {
        case 'timed_out':
            return t("{community} didn't answer in time, so your name wasn't checked and nothing was sent. Check your connection, then tap Join to try again, or go back.", { community });
        case 'taken':
            if (check.suggestionsTimedOut) {
                return t('"{name}" is already taken in {community}, and suggestions didn\'t load in time. Choose another name, then tap Join.', { name, community });
            }
            return check.suggestions.length > 0
                ? t('"{name}" is already taken in {community}. Pick one of the suggestions below, or choose another name.', { name, community })
                : t('"{name}" is already taken in {community}. Choose another name.', { name, community });
        default:
            return '';
    }
}

/** "You're in": the title over global-join-existing.ts joinedGlobalNotice's body, by name. */
export function joinedTitle(place: DoorPlace, globalTitle: string): string {
    return place.global ? phoneDoorLineWords(globalTitle) : t("You're in {name}", { name: place.name });
}

function hostOf(url: string): string {
    return url.replace(/^https?:\/\//i, '');
}

/** The global community's place. */
export function globalPlace(url: string): DoorPlace {
    return { global: true, name: t('the global community'), host: hostOf(url) };
}

/** Another community's place, before it has answered: the phone's saved name for it, or its host. */
export function placeAt(url: string, savedName?: string | null): DoorPlace {
    return { global: false, name: communityName({ url, alias: savedName ?? null }), host: hostOf(url) };
}

/**
 * What the door screen (app/join-open-door.tsx) says, by the community it is for (utils/open-door.ts): the global
 * community's door says exactly what it said before slice P5; another community's door says the same things under that
 * community's own name (DESIGN-global-entry-fable.md §E: "the node's own name for anyone else's"), through the words layer.
 *
 * The phone's own sentences about a refusal name the global community (utils/global-join.ts DOOR_MESSAGES, shared with the
 * first screen's door); at another community's door each is said again with its name. What a node says itself in its
 * answer (open-join.ts: "this community", "here") is shown as it came, at any door.
 */
import { t } from '@beanpool/core';
import {
    DOOR_MESSAGES, doorMessage, nameCheckMessage, type DoorAnswer, type NameCheck,
} from './global-join';
import { accountDoorMessage } from './global-join-existing';
import { GLOBAL_DOOR_MESSAGES, type GlobalDoorRefusal } from './node-profile';
import { communityName } from './community-name';

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
 * Who keeps a copy of the account for the door's sign-in, said beside the sign-in buttons: `choose` under the two ways in,
 * `signIn` above the buttons. The global community's door as before. At another community's door, a build without the
 * key vault sends the copy in the join and that community keeps it; a build with the vault deposits it there only where
 * the door lists the vault's ticket keys (global-join.ts doorTicketKeys), which is not known until the sign-in starts.
 */
export function doorKeeperWords(place: DoorPlace, copiesAt: 'vault' | 'community'): { choose: string; signIn: string } {
    if (place.global) {
        const keeper = copiesAt === 'vault'
            ? 'BeanPool keeps a locked copy of your account for it, and BeanPool can open that copy.'
            : 'the global community keeps a locked copy of your account for it, and the people who run it can open that copy.';
        return {
            choose: `${keeper.charAt(0).toUpperCase()}${keeper.slice(1)} BeanPool never sees your password and never posts anything for you.`,
            signIn: 'To keep out fake accounts, sign in once with an account you already have. That sign-in also becomes '
                + `a way back into your account if you lose this phone: ${keeper} BeanPool never sees your password and never posts anything for you.`,
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
    if (place.global) return GLOBAL_DOOR_MESSAGES[reason];
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
    if (place.global) return accountDoorMessage(answer);
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
            return doorMessage(answer);
    }
}

/** What the name step says when its check doesn't lead to the join (global-join.ts nameCheckMessage, by name). */
export function doorNameCheckWords(name: string, check: NameCheck, place: DoorPlace): string {
    if (place.global) return nameCheckMessage(name, check);
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
    return place.global ? globalTitle : t("You're in {name}", { name: place.name });
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

/**
 * The words for a re-keyed member's old contacts list (private contacts C6, DESIGN-private-contacts-fable.md §6.2), on the
 * phone (apps/native app/contacts.tsx's notice, app/old-words-unlock.tsx) and the web (apps/pwa pages/ContactsPage.tsx).
 *
 * Kept apart from the phone's apps/native utils/contacts-former.ts, which turns the old 12 words into a key: nothing on the
 * 12 words' key path may reach the words layer (core __tests__/recovery-path-files.test.ts), and these are words a member
 * reads, so they go through it here.
 */
import { t, tn } from './words.js';

/** What the old words did (apps/native utils/contacts-former.ts openFormerWithWords). */
export type FormerOutcome =
    /** No community answered: try again when connected. */
    | { kind: 'no_answer' }
    /** No community keeps an old list for this account. */
    | { kind: 'none' }
    /** Not 12 listed words, or not the key any old list is locked with. */
    | { kind: 'not_the_key' }
    /** The old list's people merged into the list: `added` new to it, of `people` in the old one. */
    | { kind: 'merged'; added: number; people: number };

/** The Contacts notice, its Delete, and the old-words screen opened for the old list. */
export const formerContactsWords = {
    notice: () => t('Your contacts are locked with your old key. If you ever find your old 12 words, you can open them here.'),
    /** The notice once this phone merged the old list in: the community still keeps the old copy until it is deleted. */
    merged: () => t('Your old contacts list is in your contacts now. Its old locked copy is still kept here.'),
    /** The web's notice: the old words open it in the phone app. */
    web: () => t('Your contacts are locked with your old key. If you ever find your old 12 words, you can open them in the BeanPool phone app.'),
    open: () => t('Open with my old 12 words'),
    remove: () => t('Delete it', undefined, 'button: delete the old locked contacts list'),
    /** The one action the notice keeps after a merge on the phone, and the web's (a signed DELETE, after removeTitle's question). */
    removeOld: () => t('Delete the old copy'),
    removeTitle: () => t('Delete your old contacts list?'),
    removeAsk: () => t("Only your old 12 words can open it. Once it's deleted, nobody can ever open it again."),
    removeFailed: () => t("Some of your communities didn't answer. Your old contacts list is still kept there. Try again later."),
    /** The web's: it asks the one community it is on. */
    removeFailedHere: () => t("This community didn't answer. Your old contacts list is still kept here. Try again later."),
    title: () => t('Your old contacts list'),
    body: () => t('Type the 12 words of the key this account used before. They open your old contacts list on this phone and are never sent or kept.'),
    button: () => t('Open my old contacts'),
    busy: () => t('Opening your old contacts...'),
};

/** What the old-words screen says when it is done with the old list. */
export function formerContactsEndWords(r: FormerOutcome): { text: string; ok: boolean } {
    switch (r.kind) {
        case 'merged':
            if (r.added === 0) return { text: t('Done. Everyone in your old contacts list was already in your contacts.'), ok: true };
            return {
                text: tn(r.added, 'Done. {n} person from your old contacts list is back in your contacts.', 'Done. {n} people from your old contacts list are back in your contacts.'),
                ok: true,
            };
        case 'not_the_key':
            return { text: t("These words don't open your old contacts list. Check each word, and that they are the words of the key you had before."), ok: false };
        case 'none':
            return { text: t('None of your communities keeps an old contacts list for you.'), ok: true };
        case 'no_answer':
            return { text: t("Your communities didn't answer. Try again when you're connected."), ok: false };
    }
}

/** "Add people I've chatted with and my friends" (design §3.6's ⋯, §6.2). */
export const addPeopleWords = {
    row: () => t("Add people I've chatted with and my friends"),
    ask: (n: number, community: string) => tn(n,
        "Add {n} person you've chatted with or added as a friend in {community}? Only you see your contacts, and nobody is told.",
        "Add {n} people you've chatted with or added as friends in {community}? Only you see your contacts, and nobody is told.",
        { community }),
    yes: (n: number) => tn(n, 'Add {n} person', 'Add {n} people'),
    none: () => t("Everyone you've chatted with or added as a friend here is already in your contacts."),
    unread: () => t("Couldn't read your chats on this phone. Try again."),
};

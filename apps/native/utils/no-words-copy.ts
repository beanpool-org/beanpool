/**
 * What the app says when this phone holds no 12 words.
 *
 * A phone restored with a sign-in whose copy was made before copies carried the words has none:
 * sso-recovery.ts can only save what the copy holds, and the words can't be rebuilt from the seed. Every
 * screen that talks about the words asks `hasMnemonic` first and says one of these instead. Such a member
 * is never offered words that don't exist, never told they can come back with them, and never left at a
 * dead end: components/NoWordsNotice.tsx carries a way on to Account Protection wherever the screen has
 * one, and View Recovery Phrase (Settings, and Account Protection's Show My 12 Recovery Words) opens the
 * add form for a member with the words on paper (utils/add-words.ts), under {@link NO_WORDS_VIEW_LINE}.
 */

/** Where a member with words is told "your 12 words are your primary recovery". */
export const NO_WORDS_WAY_BACK =
    'This phone was restored with a sign-in, so it has no 12 words. A connected sign-in is how you get back in.';

/**
 * Before anything that takes the account off this phone: signing out, deleting, replacing it with another.
 * `name` is for a screen that names the account it is about to remove.
 */
export function noWordsBeforeWipe(name?: string): string {
    return name
        ? `This phone was restored with a sign-in, so it has no 12 words for ${name}. Without a connected sign-in, you cannot get ${name} back.`
        : 'This phone was restored with a sign-in, so it has no 12 words. Without a connected sign-in, you cannot get this account back.';
}

/** Settings → Account & Identity: the row on a phone with words. */
export const VIEW_WORDS_MENU = { title: 'View Recovery Phrase', sub: 'View your 12-word backup seed' } as const;

/**
 * The same row on a phone without words (Marty, 2026-09-25): it stays, under the same name, and opens the add
 * form. The line under it says there is no copy here, so it never promises words that aren't there.
 */
export const NO_WORDS_MENU = { title: VIEW_WORDS_MENU.title, sub: 'No copy on this phone yet. Tap to add your 12 words.' } as const;

/**
 * The one plain line above the add form when View Recovery Phrase (or Show My 12 Recovery Words) is tapped on a
 * phone without words, and under that button in Account Protection.
 */
export const NO_WORDS_VIEW_LINE =
    'This phone has no copy of your 12 words. Typing them in checks them against this account and saves them on this phone. They are not sent anywhere.';

/** The buttons that take a words-less member to Account Protection (NoWordsNotice adds the shield). */
export const NO_WORDS_CONNECT = 'Connect a sign-in';
export const NO_WORDS_CHECK_FIRST = 'Check Account Protection first';

/** Settings → sign out of this phone only, the confirming alert. */
export const NO_WORDS_SIGN_OUT_ALERT =
    `This removes your private key and local database from this phone. ${noWordsBeforeWipe()}`;

/**
 * Account Protection, on a phone WITH words: what a connected sign-in gives back. A sign-in connected from a
 * phone with the words seals them with the key (keeper-crypto.ts sealSeedToSso); one connected on an earlier
 * version sealed the key alone, and connecting it again replaces that copy (KeeperProtectionPanel).
 */
export const SSO_WORDS_NOTE =
    'A sign-in connected on this version of the app brings your 12 words back too. One connected on an earlier version brings back your account without them: tap Connect again to include them.';

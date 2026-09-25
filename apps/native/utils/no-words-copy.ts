/**
 * What the app says when this phone holds no 12 words.
 *
 * A phone restored with a sign-in has none: sso-recovery.ts saves the identity without them, and they
 * can't be rebuilt from the seed. Every screen that talks about the words asks `hasMnemonic` first and
 * says one of these instead. Such a member is never offered words that don't exist, never told they can
 * come back with them, and never left at a dead end: components/NoWordsNotice.tsx carries a way on to
 * Account Protection wherever the screen has one.
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

/** Settings → Account & Identity: the Recovery Phrase row, which must not offer words that aren't there. */
export const NO_WORDS_MENU = { title: 'Recovery Phrase', sub: 'This phone has no 12 words' } as const;

/** The buttons that take a words-less member to Account Protection (NoWordsNotice adds the shield). */
export const NO_WORDS_CONNECT = 'Connect a sign-in';
export const NO_WORDS_CHECK_FIRST = 'Check Account Protection first';

/** Settings → sign out of this phone only, the confirming alert. */
export const NO_WORDS_SIGN_OUT_ALERT =
    `This removes your private key and local database from this phone. ${noWordsBeforeWipe()}`;

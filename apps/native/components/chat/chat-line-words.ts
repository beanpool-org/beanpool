/**
 * The chat lines this phone's lower layers write in English, shown in the member's language.
 *
 * utils/db.ts (which also encrypts and opens DMs) and core's dm-crypto.ts (the DM line checks) write a few fixed
 * sentences: a conversation's preview when there are no words to show, a trade's lines in its chat ("5 Beans held in
 * trust."), and the marks that stand in for a DM line that didn't open. Neither file reaches the words layer (code that
 * handles keys or encryption never does), so the screens that show those sentences translate them here, by the exact
 * English sentence (the key IS the English), as the node's words will be translated on their way out (design §3).
 * Anything else, a member's words above all, is shown exactly as written. A sentence a lower layer changes simply shows
 * in English until this table follows it.
 */
import { t, tn, word, type WordKey, DM_LINE_DELETED_TEXT, DM_LINE_NOT_ENCRYPTED_TEXT, DM_LINE_NOT_VERIFIED_TEXT } from '@beanpool/core';

/** Whole sentences, by their English. */
const FIXED: Readonly<Record<string, WordKey>> = {
    // utils/db.ts getConversations: a row with no words to show.
    '[Message]': word('[Message]'),
    'Started conversation': word('Started conversation'),
    '🔒 Encrypted message': word('🔒 Encrypted message'),
    '[Unreadable message]': word('[Unreadable message]'),
    '[Encrypted — update your app to read]': word('[Encrypted — update your app to read]'),
    // utils/db.ts formatSystemMessage: a trade's lines.
    'Beans held in trust.': word('Beans held in trust.'),
    'Payment of Beans released to you.': word('Payment of Beans released to you.'),
    'Payment of Beans released to the provider.': word('Payment of Beans released to the provider.'),
    'Trust hold cancelled and funds refunded.': word('Trust hold cancelled and funds refunded.'),
    // core dm-crypto.ts: what stands in for a DM line, and the one line under a marked one.
    [DM_LINE_NOT_VERIFIED_TEXT]: word("🔒 This message couldn't be verified, so it isn't shown."),
    [DM_LINE_NOT_ENCRYPTED_TEXT]: word("⚠️ This message wasn't encrypted, so BeanPool can't confirm who wrote it. It isn't shown."),
    [DM_LINE_DELETED_TEXT]: word('This message was deleted'),
    "Sent from an older version of the app: BeanPool can't confirm who wrote it.": word("Sent from an older version of the app: BeanPool can't confirm who wrote it."),
    'Shown out of the order it was written in.': word('Shown out of the order it was written in.'),
    'Moved here from another conversation.': word('Moved here from another conversation.'),
    "From your community's admins. Not a private message: the community's server can read it.": word("From your community's admins. Not a private message: the community's server can read it."),
    // core dm-crypto.ts dmQuoteLabel: who a quote is from when it isn't its named author.
    "Your community's admins": word("Your community's admins"),
    'Notice': word('Notice', 'chat line from the node'),
    'Not confirmed': word('Not confirmed', 'chat line'),
};

/** "<label>: <words>" (db.ts: the node's notice in a DM's preview; the admins' message). */
const PREFIXED: ReadonlyArray<[string, (text: string) => string]> = [
    ["From your community's admins: ", (text) => t("From your community's admins: {text}", { text })],
    ['Notice: ', (text) => t('Notice: {text}', { text })],
];

/** A trade's lines with an amount in them (db.ts formatSystemMessage); English writes one form for both. */
const AMOUNTS: ReadonlyArray<[RegExp, (n: number) => string]> = [
    [/^(\d+(?:\.\d+)?) Beans held in trust\.$/, (n) => tn(n, '{n} Beans held in trust.', '{n} Beans held in trust.')],
    [/^Payment of (\d+(?:\.\d+)?) Beans released to you\.$/, (n) => tn(n, 'Payment of {n} Beans released to you.', 'Payment of {n} Beans released to you.')],
    [/^Payment of (\d+(?:\.\d+)?) Beans released to the provider\.$/, (n) => tn(n, 'Payment of {n} Beans released to the provider.', 'Payment of {n} Beans released to the provider.')],
];

/** A line a lower layer wrote, in the member's language; anything it doesn't know, exactly as given. */
export function chatLineWords(text: string | null | undefined): string {
    if (!text) return text ?? '';
    if (Object.prototype.hasOwnProperty.call(FIXED, text)) return t(FIXED[text]);
    for (const [prefix, say] of PREFIXED) {
        if (text.startsWith(prefix)) return say(chatLineWords(text.slice(prefix.length)));
    }
    for (const [pattern, say] of AMOUNTS) {
        const m = pattern.exec(text);
        if (m) return say(Number(m[1]));
    }
    return text;
}

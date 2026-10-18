/**
 * The chat lines this phone's lower layers write in English, shown in the member's language.
 *
 * Code that handles keys or encryption never reaches the words layer: utils/db.ts (which also encrypts and opens DMs),
 * core's dm-crypto.ts (the DM line checks), and the group chat's key and line code (group-chat-keys.ts,
 * group-chat-lines.ts, group-line-display.ts, group-history-unlock.ts on the 12 words' key path, name-key-memory.ts).
 * They write a few fixed sentences: a conversation's preview when there are no words to show, a trade's lines in its
 * chat ("5 Beans held in trust."), what stands in for a line that didn't open or isn't here yet, why nothing was sent,
 * the notice above a group chat's box. The screens that show those sentences translate them here, by the exact English
 * sentence (the key IS the English), as the node's words will be translated on their way out (design §3). Nothing here
 * imports those files: the English is written again, and utils/__tests__/chat-line-words.test.ts holds every one to the
 * constant it stands for, so a sentence changed there fails a test rather than quietly showing English.
 *
 * Anything else, a member's words above all, is shown exactly as written.
 */
import { t, tn, word, type WordKey, DM_LINE_DELETED_TEXT, DM_LINE_NOT_ENCRYPTED_TEXT, DM_LINE_NOT_VERIFIED_TEXT } from '@beanpool/core';

/** utils/name-key-memory.ts markKeyChanged: the details line, alone or after a note the line already had. */
const KEY_CHANGED_DETAILS = "This phone knew this name on another key, and the new key hasn't confirmed it was theirs.";

/** Whole sentences, by their English. */
const FIXED: Readonly<Record<string, WordKey>> = {
    // utils/db.ts getConversations: a row with no words to show; getMessages: a line this phone can't open.
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
    // core dm-crypto.ts: what stands in for a DM line, the one line under a marked one, and who a quote is from.
    [DM_LINE_NOT_VERIFIED_TEXT]: word("🔒 This message couldn't be verified, so it isn't shown."),
    [DM_LINE_NOT_ENCRYPTED_TEXT]: word("⚠️ This message wasn't encrypted, so BeanPool can't confirm who wrote it. It isn't shown."),
    [DM_LINE_DELETED_TEXT]: word('This message was deleted'),
    "Sent from an older version of the app: BeanPool can't confirm who wrote it.": word("Sent from an older version of the app: BeanPool can't confirm who wrote it."),
    'Shown out of the order it was written in.': word('Shown out of the order it was written in.'),
    'Moved here from another conversation.': word('Moved here from another conversation.'),
    "From your community's admins. Not a private message: the community's server can read it.": word("From your community's admins. Not a private message: the community's server can read it."),
    "Your community's admins": word("Your community's admins"),
    'Notice': word('Notice', 'chat line from the node'),
    'Not confirmed': word('Not confirmed', 'chat line'),
    // utils/group-chat-lines.ts: the notice above a group chat's box, and why a line wasn't sent or changed.
    "This community's node is older and can read this group's chat. It will be locked once the node is updated.": word("This community's node is older and can read this group's chat. It will be locked once the node is updated."),
    "End-to-end encrypted: only this group's members can read it. The node sees who wrote, when, mentions, what each line answers, and reactions.": word("End-to-end encrypted: only this group's members can read it. The node sees who wrote, when, mentions, what each line answers, and reactions."),
    "This node now says this chat isn't locked. This phone has held its keys, so it still locks every message, and sends nothing it can't lock.": word("This node now says this chat isn't locked. This phone has held its keys, so it still locks every message, and sends nothing it can't lock."),
    'Only members of this group can open its chat': word('Only members of this group can open its chat'),
    "This phone knows this conversation as a direct message, not a group's chat. Nothing was sent.": word("This phone knows this conversation as a direct message, not a group's chat. Nothing was sent."),
    "This message's key isn't on this phone, so it can't be edited here.": word("This message's key isn't on this phone, so it can't be edited here."),
    'This message is no longer in this chat.': word('This message is no longer in this chat.'),
    'Failed to edit message.': word('Failed to edit message.'),
    "It isn't sealed, so nothing shows who wrote it.": word("It isn't sealed, so nothing shows who wrote it."),
    // utils/group-line-display.ts: a sealed line that names nobody, or names someone no longer in the group.
    'Unverified': word('Unverified', 'chat line'),
    "This message couldn't be verified.": word("This message couldn't be verified."),
    'The signature inside this message matches nobody the node names as its sender.': word('The signature inside this message matches nobody the node names as its sender.'),
    'A former member': word('A former member'),
    'no longer in this group': word('no longer in this group'),
    'Waiting for the key to this message.': word('Waiting for the key to this message.'),
    // utils/group-chat-keys.ts: the chat's keys, and why nothing was sent.
    'This node is serving an older key than one this app already holds.': word('This node is serving an older key than one this app already holds.'),
    "Waiting for the group's next key.": word("Waiting for the group's next key."),
    "This chat's key hasn't reached this phone yet. Another member's phone hands it over when they next open the chat.": word("This chat's key hasn't reached this phone yet. Another member's phone hands it over when they next open the chat."),
    "This device can't open your keys.": word("This device can't open your keys."),
    "This node says someone holds this chat's key who isn't in its members list. Nothing was sent.": word("This node says someone holds this chat's key who isn't in its members list. Nothing was sent."),
    "This phone couldn't check who is in this group just now. Nothing was sent; try again in a moment.": word("This phone couldn't check who is in this group just now. Nothing was sent; try again in a moment."),
    "This phone couldn't check this chat's keys just now. Nothing was sent; try again in a moment.": word("This phone couldn't check this chat's keys just now. Nothing was sent; try again in a moment."),
    // utils/group-history-unlock.ts: the lines from before this member changed phones.
    'Messages from before you changed phones': word('Messages from before you changed phones'),
    "They were locked to your old phone's key. They come back only with your old 12 words, or when a member of the group confirms this phone in person. Your own messages from then show under your name, without their words, until they do.": word("They were locked to your old phone's key. They come back only with your old 12 words, or when a member of the group confirms this phone in person. Your own messages from then show under your name, without their words, until they do."),
    'Your message from before you changed phones. Its words come back when you unlock them.': word('Your message from before you changed phones. Its words come back when you unlock them.'),
    'I have my old phone or old 12 words': word('I have my old phone or old 12 words'),
    'Ask a member of the group to confirm this phone': word('Ask a member of the group to confirm this phone'),
    'Keep them locked': word('Keep them locked'),
    'Confirm new phone': word('Confirm new phone'),
    // utils/name-key-memory.ts: beside a name this phone saw on another key, and the details line under it.
    '(key changed)': word('(key changed)'),
    [KEY_CHANGED_DETAILS]: word("This phone knew this name on another key, and the new key hasn't confirmed it was theirs."),
};

/**
 * "<label>: <words>" (db.ts: the admins' message, the node's notice in a DM's preview). Translated only when the words
 * after the label are themselves a line this table knows: a member who types "Notice: bring gloves" is shown exactly
 * that, never a translated label over their words (and the node's own words after a label stay its words, slice S4).
 */
const PREFIXED: ReadonlyArray<[string, (text: string) => string]> = [
    ["From your community's admins: ", (text) => t("From your community's admins: {text}", { text })],
    ['Notice: ', (text) => t('Notice: {text}', { text })],
];

const NUMBER = String.raw`(\d+(?:\.\d+)?)`;
/** Sentences with a number in them; English writes one form for both where it always has. */
const COUNTED: ReadonlyArray<[RegExp, (n: number) => string]> = [
    // utils/db.ts formatSystemMessage.
    [new RegExp(`^${NUMBER} Beans held in trust\\.$`), (n) => tn(n, '{n} Beans held in trust.', '{n} Beans held in trust.')],
    [new RegExp(`^Payment of ${NUMBER} Beans released to you\\.$`), (n) => tn(n, 'Payment of {n} Beans released to you.', 'Payment of {n} Beans released to you.')],
    [new RegExp(`^Payment of ${NUMBER} Beans released to the provider\\.$`), (n) => tn(n, 'Payment of {n} Beans released to the provider.', 'Payment of {n} Beans released to the provider.')],
    // utils/group-history-unlock.ts lockedHistoryRowText.
    [new RegExp(`^🔒 ${NUMBER} messages? from before you changed phones\\. Unlock →$`), (n) => tn(n, '🔒 {n} message from before you changed phones. Unlock →', '🔒 {n} messages from before you changed phones. Unlock →')],
];

/** Sentences with a name, a date or a status code in them. */
const FILLED: ReadonlyArray<[RegExp, (m: RegExpExecArray) => string]> = [
    // utils/group-line-display.ts earlierKeyDetails: the date is core's, already in the member's language.
    [/^Sent from an earlier key of (.+)'s, replaced earlier\.$/s, (m) => t("Sent from an earlier key of {name}'s, replaced earlier.", { name: m[1] })],
    [/^Sent from an earlier key of (.+)'s, replaced (.+)\.$/s, (m) => t("Sent from an earlier key of {name}'s, replaced {date}.", { name: m[1], date: m[2] })],
    // utils/group-chat-lines.ts and group-chat-keys.ts: a refusal the node sent no words for.
    [/^The node answered (\d+)\.$/, (m) => t('The node answered {status}.', { status: m[1] })],
];

/** A whole line this table knows, in the member's language, or null. */
function knownLine(text: string): string | null {
    if (Object.prototype.hasOwnProperty.call(FIXED, text)) return t(FIXED[text]);
    for (const [pattern, say] of COUNTED) {
        const m = pattern.exec(text);
        if (m) return say(Number(m[1]));
    }
    for (const [pattern, say] of FILLED) {
        const m = pattern.exec(text);
        if (m) return say(m);
    }
    return null;
}

/** A line a lower layer wrote, in the member's language; anything it doesn't know, exactly as given. */
export function chatLineWords(text: string): string;
export function chatLineWords(text: string | null | undefined): string | null | undefined;
export function chatLineWords(text: string | null | undefined): string | null | undefined {
    if (!text) return text;
    // "<note> <details>": both sentences, and only when the first is a line this table knows. Peeled off first, so the
    // details never end up inside the first sentence's {date}.
    const details = ` ${KEY_CHANGED_DETAILS}`;
    if (text.endsWith(details)) {
        const before = knownLine(text.slice(0, -details.length));
        if (before !== null) return t('{note} {details}', { note: before, details: t(FIXED[KEY_CHANGED_DETAILS]) }, 'two notes under a chat line, one after the other');
    }
    const known = knownLine(text);
    if (known !== null) return known;
    for (const [prefix, say] of PREFIXED) {
        if (!text.startsWith(prefix)) continue;
        const rest = knownLine(text.slice(prefix.length));
        if (rest !== null) return say(rest);
    }
    return text;
}

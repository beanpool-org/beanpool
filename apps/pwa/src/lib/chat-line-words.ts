/**
 * The chat lines the web's group chat and DM code writes in English, shown in the member's language (the phone's
 * utils/chat-line-words.ts, with "phone" said as "browser" where the web says it so).
 *
 * The code that seals, opens and checks lines writes a few fixed sentences of its own: the notice above a group chat's
 * box, what stands in for a line that didn't open or isn't here yet and whose it isn't, why nothing was sent, a DM's
 * marks and quote names (lib/group-chat-keys.ts, group-chat-lines.ts, group-line-display.ts, group-hold.ts, dm-lock.ts,
 * chat-image-transfer.ts, core's dm-crypto.ts). That code stays as it is; the screens translate its sentences here, by
 * the exact English (the key IS the English) or by its English with a name or a number in it. Nothing here imports
 * those files: the English is written again, and lib/chat-line-words.test.ts holds every one to the constant or builder
 * it stands for, so a sentence changed there fails a test rather than quietly showing English.
 *
 * Anything else, a member's words above all and the node's own, is shown exactly as given. Only what the code writes is
 * passed here (the screens never pass a line a member wrote).
 */
import { t, word, type WordKey } from '@beanpool/core';

/** Whole sentences, by their English. */
const FIXED: Readonly<Record<string, WordKey>> = {
    // lib/group-chat-keys.ts: the chat's keys, and why nothing was sent.
    'This node is serving an older key than one this app already holds.': word('This node is serving an older key than one this app already holds.'),
    "Waiting for the group's next key.": word("Waiting for the group's next key."),
    "This chat's key hasn't reached this browser yet. Another member's app hands it over when they next open the chat.": word("This chat's key hasn't reached this browser yet. Another member's app hands it over when they next open the chat."),
    "This device can't open your keys.": word("This device can't open your keys."),
    "This node says someone holds this chat's key who isn't in its members list. Nothing was sent.": word("This node says someone holds this chat's key who isn't in its members list. Nothing was sent."),
    "This browser couldn't check who is in this group just now. Nothing was sent; try again in a moment.": word("This browser couldn't check who is in this group just now. Nothing was sent; try again in a moment."),
    "This browser couldn't check this chat's keys just now. Nothing was sent; try again in a moment.": word("This browser couldn't check this chat's keys just now. Nothing was sent; try again in a moment."),
    'Only members of this group can open its chat': word('Only members of this group can open its chat'),
    // lib/group-chat-lines.ts: the notice above the box, and why a line wasn't sent or changed.
    "This community's node is older and can read this group's chat. It will be locked once the node is updated.": word("This community's node is older and can read this group's chat. It will be locked once the node is updated."),
    "End-to-end encrypted: only this group's members can read it. The node sees who wrote, when, and who was mentioned.": word("End-to-end encrypted: only this group's members can read it. The node sees who wrote, when, and who was mentioned."),
    "This node now says this chat isn't locked. This browser has held its keys, so it still locks every message, and sends nothing it can't lock.": word("This node now says this chat isn't locked. This browser has held its keys, so it still locks every message, and sends nothing it can't lock."),
    "This browser couldn't check whether this chat is locked just now. Nothing was sent; try again in a moment.": word("This browser couldn't check whether this chat is locked just now. Nothing was sent; try again in a moment."),
    'Photos can only be sent in direct messages': word('Photos can only be sent in direct messages'),
    "It isn't sealed, so nothing shows who wrote it.": word("It isn't sealed, so nothing shows who wrote it."),
    "This message's key isn't in this browser, so it can't be edited here.": word("This message's key isn't in this browser, so it can't be edited here."),
    'Failed to edit message.': word('Failed to edit message.'),
    'This message was deleted': word('This message was deleted'),
    'Removed by a convenor': word('Removed by a convenor'),
    // lib/group-line-display.ts: a sealed line that names nobody, or names someone no longer in the group.
    'Unverified': word('Unverified', 'chat line'),
    "This message couldn't be verified.": word("This message couldn't be verified."),
    'The signature inside this message matches nobody the node names as its sender.': word('The signature inside this message matches nobody the node names as its sender.'),
    'A former member': word('A former member'),
    'no longer in this group': word('no longer in this group'),
    'Waiting for the key to this message.': word('Waiting for the key to this message.'),
    // lib/group-hold.ts: a chat this browser holds locked, and its record unread.
    "This browser couldn't check its record of locked group chats just now. Nothing was sent; try again in a moment.": word("This browser couldn't check its record of locked group chats just now. Nothing was sent; try again in a moment."),
    "This browser couldn't check its record of locked group chats just now, so this chat didn't open. Try again in a moment.": word("This browser couldn't check its record of locked group chats just now, so this chat didn't open. Try again in a moment."),
    "This is a locked group chat, and this screen can't lock messages. Nothing was sent; open it from Messages.": word("This is a locked group chat, and this screen can't lock messages. Nothing was sent; open it from Messages."),
    "This node answered with a locked group's chat, not a direct message, so nothing opened.": word("This node answered with a locked group's chat, not a direct message, so nothing opened."),
    'This chat holds private messages, so it stays a direct message. Nothing was sent; send it again here.': word('This chat holds private messages, so it stays a direct message. Nothing was sent; send it again here.'),
    // lib/chat-image-transfer.ts: a picked file that isn't a picture.
    'That file is not a picture.': word('That file is not a picture.'),
    // core dm-crypto.ts: what stands in for a DM line, the one line under a marked one, and who a quote is from.
    "🔒 This message couldn't be verified, so it isn't shown.": word("🔒 This message couldn't be verified, so it isn't shown."),
    "⚠️ This message wasn't encrypted, so BeanPool can't confirm who wrote it. It isn't shown.": word("⚠️ This message wasn't encrypted, so BeanPool can't confirm who wrote it. It isn't shown."),
    "Sent from an older version of the app: BeanPool can't confirm who wrote it.": word("Sent from an older version of the app: BeanPool can't confirm who wrote it."),
    'Shown out of the order it was written in.': word('Shown out of the order it was written in.'),
    'Moved here from another conversation.': word('Moved here from another conversation.'),
    "From your community's admins. Not a private message: the community's server can read it.": word("From your community's admins. Not a private message: the community's server can read it."),
    "Your community's admins": word("Your community's admins"),
    'Notice': word('Notice', 'chat line from the node'),
    'Not confirmed': word('Not confirmed', 'chat line'),
};

/** Sentences with a name, a date or a number in them, by their English pattern. */
const FILLED: ReadonlyArray<{ pattern: RegExp; words: (m: RegExpMatchArray) => string }> = [
    // lib/group-line-display.ts earlierKeyDetails.
    { pattern: /^Sent from an earlier key of (.+)'s, replaced (.+)\.$/, words: (m) => t("Sent from an earlier key of {name}'s, replaced {date}.", { name: m[1], date: m[2] }) },
    // lib/dm-lock.ts dmNotLockedLine, by the other person's name.
    {
        pattern: /^This message couldn't be locked for (.+) yet, so it wasn't sent\. Try again in a moment\.$/,
        words: (m) => (m[1] === 'the other person'
            ? t("This message couldn't be locked for the other person yet, so it wasn't sent. Try again in a moment.")
            : t("This message couldn't be locked for {name} yet, so it wasn't sent. Try again in a moment.", { name: m[1] })),
    },
    // lib/chat-image-transfer.ts chatImageRefusal: a picture over the size it takes.
    { pattern: /^That picture is bigger than (.+)\. Try a smaller one\.$/, words: (m) => t('That picture is bigger than {size}. Try a smaller one.', { size: m[1] }) },
    // lib/group-chat-keys.ts and group-chat-lines.ts: a refusal with no words of the node's own, by its status.
    { pattern: /^The node answered (\d+)\.$/, words: (m) => t('The node answered {status}.', { status: m[1] }) },
];

/** The whole sentences this table knows by their English (its test holds each to the file that writes it). */
export function knownChatLines(): string[] {
    return Object.keys(FIXED);
}

/** One of the sentences above in the member's language; anything else (the node's own words) exactly as given. */
export function chatLineWords(english: string): string;
export function chatLineWords(english: string | null | undefined): string | null | undefined;
export function chatLineWords(english: string | null | undefined): string | null | undefined {
    if (typeof english !== 'string') return english;
    if (Object.prototype.hasOwnProperty.call(FIXED, english)) return t(FIXED[english]);
    for (const f of FILLED) {
        const m = english.match(f.pattern);
        if (m) return f.words(m);
    }
    return english;
}

/**
 * The sentences the Channels screen and the Pulse tab show that their lower layers write in English, shown in the
 * member's language.
 *
 * utils/pulse-oauth.ts (keeps a platform's token on this phone, signs the connect), utils/pulse.ts (signs a hide or a
 * report) and utils/node-url.ts (which addresses the key signs for) never reach the words layer. The screens translate those files' sentences here, by the exact English (the
 * key IS the English), and the ones that carry a platform's name, a handle or a status by their English pattern.
 * Nothing here imports those files: utils/__tests__/pulse-lines.test.ts holds every sentence to the source that writes
 * it, so a sentence changed there fails a test rather than quietly showing English.
 *
 * A community's or a platform's own words (a node's refusal, a provider's error, the phone's network error) are shown
 * exactly as they came, and a platform's name (TikTok, Instagram) as it is written.
 */
import { t, word, type WordKey } from '@beanpool/core';

/** Whole sentences, by their English. */
const FIXED: Readonly<Record<string, WordKey>> = {
    // utils/pulse-oauth.ts: why a channel didn't connect, sync or disconnect.
    'Connection was cancelled.': word('Connection was cancelled.'),
    'Update BeanPool to connect this channel.': word('Update BeanPool to connect this channel.'),
    'Too many connection attempts. Try again in an hour.': word('Too many connection attempts. Try again in an hour.'),
    'This channel is not on your profile any more. Reload and try again.': word('This channel is not on your profile any more. Reload and try again.'),
    'TikTok connection is not configured on this community node.': word('TikTok connection is not configured on this community node.'),
    'TikTok connection was cancelled.': word('TikTok connection was cancelled.'),
    'TikTok authorization completed without a code.': word('TikTok authorization completed without a code.'),
    'Instagram Creator connection is pending Meta app review on this node.': word('Instagram Creator connection is pending Meta app review on this node.'),
    'Instagram Creator connection was cancelled or refused.': word('Instagram Creator connection was cancelled or refused.'),
    'Instagram access token has expired. Please reconnect.': word('Instagram access token has expired. Please reconnect.'),
    'Token expired and no refresh token is stored.': word('Token expired and no refresh token is stored.'),
    'Refresh token expired. Please reconnect.': word('Refresh token expired. Please reconnect.'),
    'Cannot refresh TikTok token without a client key.': word('Cannot refresh TikTok token without a client key.'),
    'Failed to refresh TikTok token. Please reconnect.': word('Failed to refresh TikTok token. Please reconnect.'),
    'Failed to disconnect channel.': word('Failed to disconnect channel.'),
    // utils/node-url.ts UNSAFE_NODE_ADDRESS_MESSAGE: the signing of every request here refuses such an address.
    "That community address isn't a plain web address (it has something like @ or \\ in it), so BeanPool won't connect to it or sign anything for it. Check the address with whoever gave it to you.": word("That community address isn't a plain web address (it has something like @ or \\ in it), so BeanPool won't connect to it or sign anything for it. Check the address with whoever gave it to you."),
    // utils/pulse.ts: the feed's page, a hide, a report.
    'Invalid feed response from server': word('Invalid feed response from server'),
    'Identity required to mute items.': word('Identity required to mute items.'),
    'Item ID is required.': word('Item ID is required.'),
    'Identity required to report items.': word('Identity required to report items.'),
    'An item and a reason are required.': word('An item and a reason are required.'),
    'Not connected to a node.': word('Not connected to a node.'),
};

/** The platform names utils/pulse-oauth.ts puts in its sentences: brands, written as they are. */
const PLATFORM = '(TikTok|Instagram Creator|Instagram)';

/** Sentences with a name, a handle, a status or someone else's words in them, by their English pattern. */
const FILLED: ReadonlyArray<{ pattern: RegExp; words: (m: RegExpMatchArray) => string }> = [
    // utils/pulse-oauth.ts openAuthSessionWithFallback: the platform's sign-in never came back.
    { pattern: new RegExp(`^${PLATFORM} connection timed out\\.$`), words: (m) => t('{platform} connection timed out.', { platform: m[1] }) },
    // utils/pulse-oauth.ts connectRefusal: the node's finding about the account the member signed in to.
    {
        pattern: new RegExp(`^The ${PLATFORM} account you signed in to is not the account on this channel\\. Sign in to that account and connect again\\.$`),
        words: (m) => t('The {platform} account you signed in to is not the account on this channel. Sign in to that account and connect again.', { platform: m[1] }),
    },
    {
        pattern: new RegExp(`^The ${PLATFORM} account you signed in to is not (.+)\\. Sign in to that account and connect again\\.$`, 's'),
        words: (m) => t('The {platform} account you signed in to is not {handle}. Sign in to that account and connect again.', { platform: m[1], handle: m[2] }),
    },
    {
        pattern: new RegExp(`^BeanPool can only verify a ${PLATFORM} channel added as @handle\\. Remove this one and add it again as @handle\\.$`),
        words: (m) => t('BeanPool can only verify a {platform} channel added as @handle. Remove this one and add it again as @handle.', { platform: m[1] }),
    },
    {
        pattern: new RegExp(`^${PLATFORM} did not say which account you signed in to\\. Try again\\.$`),
        words: (m) => t('{platform} did not say which account you signed in to. Try again.', { platform: m[1] }),
    },
    { pattern: new RegExp(`^Could not connect ${PLATFORM}\\.$`), words: (m) => t('Could not connect {platform}.', { platform: m[1] }) },
    // utils/pulse-oauth.ts relayConnect: the phone's own network error, as the phone gave it; a sentence of this file's
    // (node-url.ts's refusal, which signedPost throws there before sending) in the member's language.
    { pattern: /^Could not reach your community node: (.*)$/s, words: (m) => t('Could not reach your community node: {reason}', { reason: pulseLineWords(m[1]) }) },
    // utils/pulse-oauth.ts: TikTok's own error code, as TikTok gave it.
    { pattern: /^TikTok returned error: (.*)$/s, words: (m) => t('TikTok returned error: {error}', { error: m[1] }) },
    // utils/pulse.ts: the node's status when it gave no words of its own.
    { pattern: /^Failed to load feed page \((\d+)\)$/, words: (m) => t('Failed to load feed page ({status})', { status: m[1] }) },
    { pattern: /^Failed to update mute status \((\d+)\)$/, words: (m) => t('Failed to update mute status ({status})', { status: m[1] }) },
    { pattern: /^Failed to report item \((\d+)\)$/, words: (m) => t('Failed to report item ({status})', { status: m[1] }) },
];

/** One of those files' sentences in the member's language; anything else (a node's or a platform's words) as it came. */
export function pulseLineWords(english: string): string {
    if (Object.prototype.hasOwnProperty.call(FIXED, english)) return t(FIXED[english]);
    for (const { pattern, words } of FILLED) {
        const m = english.match(pattern);
        if (m) return words(m);
    }
    return english;
}

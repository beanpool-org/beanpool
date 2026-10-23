/**
 * What utils/db.ts throws on its own when a signed send or read fails, in the member's language (words S3l).
 *
 * Every signed send and read goes through db.ts (_signedRequest, signedRequestWithMethod, signedGet, and the sends that
 * sign for themselves: a post, a poll vote, a new chat, an initiative's cancel, …), signed with the member's key, so it
 * never reaches the words layer. With no community set, no key, a send that failed without a reason, or a refusal with
 * no body, it throws its own English sentence; the screens that show it word it here by the exact sentence
 * (components/event-lines.ts hands on what it doesn't know; the Treasury, groups, Decisions, polls, friends, a DM's
 * start). The chat's own sentences are utils/chat-line-words.ts's, which this hands on to. db.ts is not touched. A
 * node's own words (a refusal's reason) are shown exactly as given (slice S4): the node writes them in the language the
 * phone sends. utils/__tests__/events-words-render.test.ts and shared-sentences-words.test.ts hold each to the throw in
 * db.ts it stands for.
 */
import { t, word, type WordKey } from '@beanpool/core';
import { chatLineWords } from '../utils/chat-line-words';

const FIXED: Readonly<Record<string, WordKey>> = {
    // _signedRequest: no community set, no key, and a send that failed without a reason.
    'You are off-grid. Please connect to a BeanPool Node to perform this action.': word('You are off-grid. Please connect to a BeanPool Node to perform this action.'),
    'No identity found. You must be logged in.': word('No identity found. You must be logged in.'),
    'Network request failed. You must be connected to a node.': word('Network request failed. You must be connected to a node.'),
    // The sends that sign for themselves (createPost, votePoll, closePoll, rsvpEvent, updatePost, …): no community set, no key.
    'You are currently offline.': word('You are currently offline.'),
    'No identity found.': word('No identity found.'),
    'Not logged in. Identity required.': word('Not logged in. Identity required.'),
    // createPost: no community set, a refusal without the node's words, and a send that failed without a reason.
    'You are currently offline. Please connect to a BeanPool Node to broadcast your post.': word('You are currently offline. Please connect to a BeanPool Node to broadcast your post.'),
    'Network request failed or server rejected the post.': word('Network request failed or server rejected the post.'),
    'Network request failed. You must be connected to a node to post.': word('Network request failed. You must be connected to a node to post.'),
    // votePoll and closePoll: a refusal without the node's words.
    'Failed to record vote': word('Failed to record vote'),
    'Failed to close poll': word('Failed to close poll'),
    // createConversationApi (a DM's start): no community set, a refusal without the node's words, a send that failed.
    'You are off-grid. Please connect to a node first.': word('You are off-grid. Please connect to a node first.'),
    'Failed to create conversation thread.': word('Failed to create conversation thread.'),
    'Network request failed when creating thread.': word('Network request failed when creating thread.'),
    // deleteCrowdfundProjectApi (an initiative's cancel): no community set, and a send that failed without a reason.
    'You are currently offline. Please connect to a BeanPool Node to cancel your initiative.': word('You are currently offline. Please connect to a BeanPool Node to cancel your initiative.'),
    'Network request failed. You must be connected to a node to cancel initiatives.': word('Network request failed. You must be connected to a node to cancel initiatives.'),
    // addFriendLocal and removeFriendOnNode: a refusal without the node's words, and a removal the node never heard.
    'Your community did not add them.': word('Your community did not add them.'),
    'Couldn’t reach your community, so they are still your friend. Check your connection and try again.': word('Couldn’t reach your community, so they are still your friend. Check your connection and try again.'),
    // getGroupForLanding: no answer the phone can read.
    'Could not reach the node.': word('Could not reach the node.'),
};

/** db.ts's sentences with a status or the node's answer in them. */
const FILLED: ReadonlyArray<[RegExp, (m: RegExpExecArray) => string]> = [
    // _signedRequest: a refusal with no body at all.
    [/^Server returned (\d+)$/, (m) => t('Server returned {status}', { status: m[1] })],
    // getEnterpriseLedger: a refusal without the node's words.
    [/^Could not load enterprise ledger \((\d+)\)$/, (m) => t('Could not load enterprise ledger ({status})', { status: m[1] })],
    // deleteCrowdfundProjectApi: the node's answer as it came, after db.ts's sentence.
    [/^Failed to cancel initiative: ([\s\S]*)$/, (m) => t('Failed to cancel initiative: {reason}', { reason: m[1] })],
];

/** One of db.ts's sentences in the member's language; a node's own words, or anything else, exactly as given. */
export function signedRequestWords(english: string): string {
    if (Object.prototype.hasOwnProperty.call(FIXED, english)) return t(FIXED[english]);
    for (const [pattern, say] of FILLED) {
        const m = pattern.exec(english);
        if (m) return say(m);
    }
    // signedGet's and signedRequestWithMethod's, and a chat's (a line not sent, a chat not opened): the chat's table.
    return chatLineWords(english);
}

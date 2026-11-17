import { t } from '@beanpool/core';

/**
 * An Alert's message in two paragraphs, a blank line between: the first leads (a question, a name, an address), the second
 * says the rest.
 *
 * An Alert's words go in its message, under a short title (utils/__tests__/alert-words-in-message.test.ts): Android cuts a
 * title at two lines, and at 320 dp with large text that is about 36 characters (emulator walk, 17 Nov). So a question
 * that names someone, or an address, moves from the title to the top of the message, where it wraps. The join goes through
 * the words layer, as one string with placeholders, so a language can lay the two out its own way.
 */
export function twoParagraphs(first: string, then: string): string {
    return t('{first}\n\n{then}', { first, then });
}

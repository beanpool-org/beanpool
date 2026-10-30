/**
 * What a member is told once they're in a second community (join-another-community.ts joinedNudge), in their language.
 *
 * join-another-community.ts redeems the invite with the member's key, so it never reaches the words layer: its English
 * nudge is worded again here, chosen by which nudge it is (`kind`: one that offers to protect the new community, one for
 * a community that keeps no copies, or the key vault's), with both paragraphs of the body in one sentence key.
 * utils/__tests__/joined-nudge-words.test.ts holds the two to the same English in both kinds of build.
 */
import { t } from '@beanpool/core';
import type { JoinedNudge } from './join-another-community';

export function joinedNudgeWords(nudge: JoinedNudge, name: string): JoinedNudge {
    if (nudge.kind === 'community') {
        return {
            title: t("You're in {name}", { name }),
            body: t('Your key and your 12 words came with you, and so does your name. Your posts, chats and trades stay in each community.\n\nA sign-in that protects your account is kept by each community, so protect your account in {name} too.', { name }),
            later: t('Later'),
            protect: t('Protect it'),
            kind: nudge.kind,
        };
    }
    if (nudge.kind === 'none') {
        return {
            title: t("You're in {name}", { name }),
            body: t("Your key and your 12 words came with you, and so does your name. Your posts, chats and trades stay in each community.\n\n{name} keeps no copies of members' accounts, so your 12 words are your way back there. A copy you made before, in another community, is still yours.", { name }),
            later: t('Next'),
            kind: nudge.kind,
        };
    }
    return {
        title: t("You're in {name}", { name }),
        body: t('Your key and your 12 words came with you, and so does your name. Your posts, chats and trades stay in each community.\n\nA sign-in you linked to get back into your account works here too: BeanPool keeps one copy for all your communities.'),
        later: t('Next'),
        kind: nudge.kind,
    };
}

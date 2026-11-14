/**
 * Local knowledge in the bell (slice K4; DESIGN-local-knowledge-fable.md §5.1, amended §A5): "Local knowledge to check: 3" lands on
 * To check in Learn; a push or kept notice about a suggestion lands on To check (an owner or admin) or My suggestions (its
 * writer). The phone's landings are the same (apps/native utils/push-notice-check.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import { knowledgeToCheckLine } from '@beanpool/core';
import { WEB_NEEDS_PRIORITY, goToNoticeTarget, goToWebNeedsTarget, noticeHasDestination } from './NeedsYouIcons';

describe('the bell and Local knowledge', () => {
    it('the needs line "Local knowledge to check" opens To check', () => {
        const nav = vi.fn();
        goToWebNeedsTarget({ to: 'learn-check' }, nav, 'learn');
        expect(nav).toHaveBeenCalledWith('learn-check');
    });

    it('ranks after a member\'s ask and before a deal, as the node orders it', () => {
        expect(WEB_NEEDS_PRIORITY.indexOf('learn')).toBe(WEB_NEEDS_PRIORITY.indexOf('ask') + 1);
        expect(WEB_NEEDS_PRIORITY.indexOf('learn')).toBeLessThan(WEB_NEEDS_PRIORITY.indexOf('deal'));
    });

    it('says the line in the member\'s words, a count and never a name', () => {
        expect(knowledgeToCheckLine(3)).toBe('Local knowledge to check: 3');
    });

    it('a suggestion to check lands on To check; an answer to one\'s own lands on My suggestions; both have somewhere to go', () => {
        const nav = vi.fn();
        goToNoticeTarget('community.knowledge', { screen: 'learn-check', draftId: 'd1' }, nav);
        expect(nav).toHaveBeenLastCalledWith('learn-check');
        goToNoticeTarget('community.knowledge-answer', { screen: 'learn-mine', draftId: 'd1', postId: 'p1' }, nav);
        expect(nav).toHaveBeenLastCalledWith('learn-mine');
        expect(noticeHasDestination('community.knowledge', { screen: 'learn-check' })).toBe(true);
        expect(noticeHasDestination('community.knowledge-answer', { screen: 'learn-mine' })).toBe(true);
    });
});

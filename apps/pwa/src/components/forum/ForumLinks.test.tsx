/**
 * What a forum topic links, on the web (slice F9; DESIGN-forums-fable.md §10.2 to §10.5): the invariant is that a link never
 * shows its reader anything they could not already see, so the page draws exactly what the node answered (apps/server
 * engine/forum-links.ts) and nothing else.
 *
 *  1. Close the class: ONE table over (link kind: group, listing, event, Learn page) x (shown, placeholder) and the listing's
 *     own cases (a Need its writer made, a Need someone else made, an Offer of the writer's) -> what the chip says, whether it
 *     can be tapped, and where a tap goes. A placeholder that (wrongly) carried a title or an id still draws its kind alone.
 *  2. The topics that link one thing: the node's rows, or nothing at all for [] and for a failed read.
 *  3. Make this a Need's draft: the topic's title and words cut to the Market form's limits, and the topic it links back to.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForumLink } from '@beanpool/core';

const node = vi.hoisted(() => ({ linked: null as null | unknown[] | Error, calls: [] as string[] }));
vi.mock('../../lib/api', async (orig) => ({
    ...(await orig<typeof import('../../lib/api')>()),
    request: vi.fn(async (_m: string, path: string) => {
        node.calls.push(path);
        if (node.linked instanceof Error) throw node.linked;
        return { topics: node.linked };
    }),
}));

import { ForumLinkChips, ForumLinkedTopics, linkDoor, linksTaken, needDraftOf } from './ForumLinks';
import { COMPOSER_DESCRIPTION_CHARS, COMPOSER_TITLE_CHARS } from '../../tools/builder';

afterEach(cleanup);
beforeEach(() => { node.linked = []; node.calls.length = 0; });

const shown = (kind: ForumLink['kind'], over: Partial<Extract<ForumLink, { shown: true }>> = {}): ForumLink => ({
    kind, shown: true, id: `${kind}-1`, title: `The ${kind}`, photo: null, listingType: null, startAt: null, byWriter: false, ...over,
});

type Row = { name: string; link: ForumLink; says: string; tappable: boolean; door: [string, string] | null };
const TABLE: Row[] = [
    { name: 'group shown', link: shown('group'), says: '👥The group›', tappable: true, door: ['group', 'group-1'] },
    { name: 'group placeholder', link: { kind: 'group', shown: false }, says: 'Linked: a group', tappable: false, door: null },
    { name: 'listing shown (an Offer of the writer)', link: shown('listing', { listingType: 'offer', byWriter: true }), says: '🛍️The listing›', tappable: true, door: ['marketplace', 'listing-1'] },
    { name: 'listing shown (a Need its writer made)', link: shown('listing', { listingType: 'need', byWriter: true }), says: '🛍️Posted as a Need ›', tappable: true, door: ['marketplace', 'listing-1'] },
    { name: 'listing shown (a Need someone else made)', link: shown('listing', { listingType: 'need', byWriter: false }), says: '🛍️The listing›', tappable: true, door: ['marketplace', 'listing-1'] },
    { name: 'listing placeholder', link: { kind: 'listing', shown: false }, says: 'Linked: a listing', tappable: false, door: null },
    { name: 'event shown', link: shown('event', { startAt: '2026-12-01T09:00:00Z' }), says: '📅The event›', tappable: true, door: ['marketplace', 'event-1'] },
    { name: 'event placeholder', link: { kind: 'event', shown: false }, says: 'Linked: an event', tappable: false, door: null },
    { name: 'Learn page shown', link: shown('learn'), says: '📖The learn›', tappable: true, door: ['learn-page', 'learn-1'] },
    { name: 'Learn page placeholder', link: { kind: 'learn', shown: false }, says: 'Linked: a Learn page', tappable: false, door: null },
];

describe('1. a chip shows exactly what the node answered (kind x shown/placeholder)', () => {
    it.each(TABLE)('$name', ({ link, says, tappable, door }) => {
        const open = vi.fn();
        render(<ForumLinkChips links={[link]} onOpen={open} />);
        const chips = screen.getByTestId('forum-link-chips');
        expect(chips.textContent).toBe(says);
        const button = chips.querySelector('button');
        expect(!!button).toBe(tappable);
        if (button) {
            fireEvent.click(button);
            expect(open).toHaveBeenCalledWith(link);
        }
        expect(linkDoor(link)).toEqual(door);
    });

    it('a placeholder that carried a title, an id or a photo (it never should) still draws its kind alone, and opens nothing', () => {
        const leaky = { kind: 'listing', shown: false, id: 'secret-id', title: 'Secret couch', photo: '/p.jpg' } as unknown as ForumLink;
        render(<ForumLinkChips links={[leaky]} onOpen={vi.fn()} />);
        const chips = screen.getByTestId('forum-link-chips');
        expect(chips.textContent).toBe('Linked: a listing');
        expect(chips.innerHTML).not.toMatch(/Secret couch|secret-id|p\.jpg/);
        expect(chips.querySelector('button, a, img')).toBeNull();
        expect(linkDoor(leaky)).toBeNull();
    });

    it('several links keep the node\'s order; no links draws nothing', () => {
        const { rerender, container } = render(<ForumLinkChips links={[shown('group'), { kind: 'event', shown: false }, shown('listing')]} />);
        expect(Array.from(screen.getByTestId('forum-link-chips').children).map((li) => li.textContent)).toEqual(['👥The group›', 'Linked: an event', '🛍️The listing›']);
        rerender(<ForumLinkChips links={[]} />);
        expect(container.innerHTML).toBe('');
        rerender(<ForumLinkChips links={undefined} />);
        expect(container.innerHTML).toBe('');
    });

    it('the room a topic has counts every link the node sent, placeholders too, and the Decision chip', () => {
        expect(linksTaken({ links: [shown('group'), { kind: 'event', shown: false }], decision: null })).toBe(2);
        expect(linksTaken({ links: [shown('group')], decision: { id: 'd', title: 'D', status: 'open' } })).toBe(2);
        expect(linksTaken({})).toBe(0);
    });
});

describe('2. the topics that link one thing', () => {
    const row = { id: 'ft-1', sectionId: 's', title: 'Who has a trailer?', replyCount: 3, lastActivityAt: new Date().toISOString() };

    it('draws the node\'s rows under the heading; a tap anywhere opens the topic', async () => {
        node.linked = [row];
        const open = vi.fn();
        render(<ForumLinkedTopics kind="listing" id="post 1" heading="Talked about in the forum" onOpenTopic={open} />);
        const item = await screen.findByTestId('forum-linked-topic');
        expect(node.calls).toEqual(['/api/forum/linked?kind=listing&id=post%201']);
        expect(screen.getByTestId('forum-linked-listing')).toHaveTextContent('Talked about in the forum');
        expect(item).toHaveTextContent('Who has a trailer?');
        expect(item).toHaveTextContent('3 replies');
        fireEvent.click(item);
        expect(open).toHaveBeenCalledWith('ft-1');
    });

    it.each([['the node answers []', [] as unknown[]], ['the read fails', new Error('offline')]])('nothing at all where %s', async (_name, answer) => {
        node.linked = answer as unknown[] | Error;
        const { container } = render(<ForumLinkedTopics kind="group" id="g-1" heading="Topics about this group" onOpenTopic={vi.fn()} />);
        await waitFor(() => expect(node.calls).toHaveLength(1));
        await new Promise((r) => setTimeout(r, 0));
        expect(container.innerHTML).toBe('');
    });
});

describe('3. Make this a Need: the draft', () => {
    it('holds the topic\'s title and words, cut to the Market form\'s limits, as a Need with no price, and names the topic', () => {
        const title = 'T'.repeat(COMPOSER_TITLE_CHARS + 30);
        const words = `  ${'w'.repeat(COMPOSER_DESCRIPTION_CHARS + 500)}  `;
        const draft = needDraftOf({ id: 'ft-7', title }, words);
        expect(draft).toMatchObject({ type: 'need', credits: null, priceType: null, category: null, forumTopicId: 'ft-7' });
        expect(Array.from(draft.title)).toHaveLength(COMPOSER_TITLE_CHARS);
        expect(Array.from(draft.description)).toHaveLength(COMPOSER_DESCRIPTION_CHARS);
        expect(needDraftOf({ id: 'ft-7', title: 'Seed swap' }, '🌱 '.repeat(3)).description).toBe('🌱 🌱 🌱');
    });
});

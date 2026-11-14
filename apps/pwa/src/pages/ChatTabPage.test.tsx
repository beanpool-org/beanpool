/**
 * The Chat tab's top on the web (slice T0; scratch/fable-design/DESIGN-forums-messaging-joint-fable.md §2.1), the phone's
 * words and rules: Chats · Forum where the community's forum is on, handed to MessagesPage for the top of its list; the
 * Forum's empty page under the same switch; no switch where the forum is off, unsaid, or not known yet. MessagesPage is stood
 * in for here (MessagesPage.test.tsx draws the real one with the switch).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { BeanPoolIdentity } from '../lib/identity';
import { backToEnglish, showIn, xx } from '../words-xx.test-support';

const info = vi.hoisted(() => ({ now: null as null | { features?: Record<string, unknown> } }));
vi.mock('../lib/features', async (orig) => ({
    ...(await orig<typeof import('../lib/features')>()),
    useCommunityInfo: () => info.now,
}));
const seen = vi.hoisted(() => ({ props: [] as Array<{ openConversationId?: string | null; frame?: ReactNode }> }));
vi.mock('./MessagesPage', () => ({
    MessagesPage: (props: { openConversationId?: string | null; frame?: ReactNode }) => {
        seen.props.push(props);
        return <div data-testid="messages-page">{props.frame}<span>the list</span></div>;
    },
}));

import { ChatTabPage } from './ChatTabPage';

const ME: BeanPoolIdentity = { publicKey: 'my-pubkey', privateKey: 'my-privkey', callsign: 'Alice', createdAt: '2026-09-14T00:00:00Z' };
const LOCAL = { beans: true, invites: true };

beforeEach(() => { info.now = { features: { ...LOCAL, forum: true } }; seen.props.length = 0; });
afterEach(() => { cleanup(); backToEnglish(); });

const tablist = () => screen.queryByRole('tablist');
const tabs = () => screen.queryAllByRole('tab');
const selected = () => tabs().map((tb) => tb.getAttribute('aria-selected'));
/** The box MessagesPage sits in: `contents` adds none, `none` hides it while the Forum shows. */
const chatsBox = () => screen.getByTestId('chat-side-chats-page').style.display;

describe('the Chat tab where the forum is on', () => {
    it('opens on Chats: the switch at the top of the Messages list, with no Forum page', () => {
        render(<ChatTabPage identity={ME} />);
        expect(tablist()).toHaveAttribute('aria-label', 'Chat');
        expect(tabs().map((tb) => tb.textContent)).toEqual(['Chats', 'Forum']);
        expect(selected()).toEqual(['true', 'false']);
        // Handed to MessagesPage, which draws it above its list.
        expect(screen.getByTestId('messages-page')).toContainElement(tablist());
        expect(chatsBox()).toBe('contents');
        expect(screen.queryByTestId('forum-page')).toBeNull();
        // Each side is a 44 px target.
        for (const tb of tabs()) expect(tb.style.minHeight).toBe('44px');
    });

    it('Forum: the Forum\'s empty page under the same switch, the list kept but hidden; Chats brings it back', () => {
        render(<ChatTabPage identity={ME} />);
        fireEvent.click(screen.getByRole('tab', { name: 'Forum' }));
        expect(selected()).toEqual(['false', 'true']);
        const forum = screen.getByTestId('forum-page');
        // Empty: slice F4 fills it.
        expect(forum.childNodes.length).toBe(0);
        expect(tablist()!.compareDocumentPosition(forum) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(screen.getByTestId('messages-page')).not.toContainElement(tablist());
        expect(chatsBox()).toBe('none');
        // Still mounted: back on Chats the list, its chip and its scroll are as they were.
        expect(screen.getByTestId('messages-page')).toBeInTheDocument();
        // One switch in the page, hidden copies counted: the hidden list is not handed one (the real browser found two).
        expect(document.querySelectorAll('[role="tablist"]')).toHaveLength(1);
        expect(seen.props.at(-1)?.frame).toBeUndefined();

        fireEvent.click(screen.getByRole('tab', { name: 'Chats' }));
        expect(selected()).toEqual(['true', 'false']);
        expect(chatsBox()).toBe('contents');
        expect(screen.queryByTestId('forum-page')).toBeNull();
        expect(screen.getByTestId('messages-page')).toContainElement(tablist());
    });

    it('a conversation opened from elsewhere (a notice, a profile\'s Message) shows Chats', () => {
        const { rerender } = render(<ChatTabPage identity={ME} openConversationId={null} />);
        fireEvent.click(screen.getByRole('tab', { name: 'Forum' }));
        rerender(<ChatTabPage identity={ME} openConversationId="conv-1" />);
        expect(selected()).toEqual(['true', 'false']);
        expect(chatsBox()).toBe('contents');
        expect(seen.props.at(-1)?.openConversationId).toBe('conv-1');
    });

    it('in the pseudo-locale: both names and the switch\'s spoken name came through t()', async () => {
        await act(async () => { await showIn('xx'); });
        render(<ChatTabPage identity={ME} />);
        expect(tabs().map((tb) => tb.textContent)).toEqual([xx('Chats'), xx('Forum')]);
        expect(tablist()).toHaveAttribute('aria-label', xx('Chat'));
    });
});

describe('the Chat tab where the forum is off: MessagesPage as before, no switch', () => {
    const cases: Array<[string, null | { features?: Record<string, unknown> }]> = [
        ['switched off by its owners (the server leaves `forum` out)', { features: LOCAL }],
        ['a node that sends it as anything but true', { features: { ...LOCAL, forum: 'yes' } }],
        ['the community\'s info not known yet, or not readable', null],
    ];
    for (const [what, answer] of cases) {
        it(what, () => {
            info.now = answer;
            render(<ChatTabPage identity={ME} />);
            expect(tablist()).toBeNull();
            expect(tabs()).toEqual([]);
            expect(seen.props.at(-1)?.frame).toBeUndefined();
            expect(chatsBox()).toBe('contents');
            expect(screen.queryByTestId('forum-page')).toBeNull();
        });
    }

    it('a member on the Forum side when the forum goes off is back on Chats', () => {
        const { rerender } = render(<ChatTabPage identity={ME} />);
        fireEvent.click(screen.getByRole('tab', { name: 'Forum' }));
        info.now = { features: LOCAL };
        rerender(<ChatTabPage identity={ME} />);
        expect(tablist()).toBeNull();
        expect(chatsBox()).toBe('contents');
        expect(screen.queryByTestId('forum-page')).toBeNull();
    });
});

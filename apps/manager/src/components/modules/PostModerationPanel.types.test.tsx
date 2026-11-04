import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AssistantTakedownsPanel } from './AssistantTakedownsPanel';
import { CHILD_SAFETY_OPEN } from '../../lib/takedown-words';
import { PostModerationPanel, heldTakedowns, takenDownWords, putBackWords, chipClassFor, isCopy, type PostModerationItem } from './PostModerationPanel';

/**
 * The posts screen's Type Filter, its chips and its "taken down" line (MCP-MODERATION S4,
 * scratch/fable-design/DESIGN-mcp-moderation-fable.md §3.13, pick 7). The node API is a stubbed fetch: nothing here talks to a node.
 */

const NODE = { id: 'n1', url: 'https://node.example', name: 'Node' } as any;
const FINAL = '2026-11-08T10:00:00.000Z';

const POSTS: PostModerationItem[] = [
    { id: 'p-offer', type: 'offer', title: 'Sourdough', authorCallsign: 'Bob', createdAt: '2026-11-01T08:00:00.000Z' },
    { id: 'p-need', type: 'need', title: 'A garden tiller', authorCallsign: 'Gina', createdAt: '2026-11-01T09:00:00.000Z' },
    { id: 'p-event', type: 'event', title: 'Seed swap at the hall', authorCallsign: 'Sam', hiddenByReportsAt: '2026-11-01T10:00:00.000Z' },
    { id: 'p-poll', type: 'poll', title: 'Which night for the market?', authorCallsign: 'Mia' },
    // A copy of an event from another community: the server marks every copy, and hides its author.
    { id: 'p-copy-event', type: 'event', title: 'Shared harvest picnic', authorCallsign: '', shownCopy: true, shownFrom: { name: 'Castlemaine' } },
    { id: 'p-copy-offer', type: 'offer', title: 'Shared lemons', authorCallsign: '', shownCopy: true },
    { id: 'p-down', type: 'offer', title: 'Cheap watches', authorCallsign: 'Sam Spam', hiddenByReportsAt: '2026-11-01T10:00:00.000Z' },
];

const CALL = {
    id: 't1', grantId: 'g1', grantName: 'Spam sweeper', member: 'Olive', at: '2026-11-01T10:00:00.000Z', reasonLabel: 'spam or a scam',
    why: 'looks like spam', via: 'ids', finalAfter: FINAL,
    posts: [
        { id: 'p-down', title: 'Cheap watches', author: 'Sam Spam', type: 'offer', state: 'hidden' },
        { id: 'p-event', title: 'Seed swap at the hall', author: 'Sam', type: 'event', state: 'left_hidden', leftFor: 'deal' },
        { id: 'p-offer', title: 'Sourdough', author: 'Bob', type: 'offer', state: 'put_back' },
        { id: 'p-need', title: 'A garden tiller', author: 'Gina', type: 'need', state: 'final' },
    ],
};

type Served = { url: string; method: string; body: any };
/** Answers the takedown list with `list` (a status and a body), and Put back with `putBack`. Every request is recorded. */
function serve(list: { status?: number; body: any }, putBack: { status?: number; body: any } = { body: { back: ['p-down'], stillHidden: [], gone: 0 } }) {
    const served: Served[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        served.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const answer = method === 'POST' ? putBack : list;
        return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
    }));
    return served;
}

const OWNER = { kind: 'password' } as const;
const row = (title: string) => screen.getByText(title).closest('[class*="flex-col"]') as HTMLElement;

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Type Filter (pick 7: Events, Polls, Shown from another community)', () => {
    it('lists All, Offers, Needs, Events, Polls and Shown from another community', () => {
        render(<PostModerationPanel posts={POSTS} activeNode={NODE} onRefresh={vi.fn()} />);
        const options = within(screen.getByLabelText(/Type Filter/i)).getAllByRole('option').map((o) => [(o as HTMLOptionElement).value, o.textContent]);
        expect(options).toEqual([
            ['all', 'All Types'], ['offer', 'Offers'], ['need', 'Needs'], ['event', 'Events'], ['poll', 'Polls'], ['copy', 'Shown from another community'],
        ]);
    });

    it('Events picks every event, a copy of one included; Polls picks the poll', async () => {
        render(<PostModerationPanel posts={POSTS} activeNode={NODE} onRefresh={vi.fn()} />);
        const select = screen.getByLabelText(/Type Filter/i);
        await userEvent.selectOptions(select, 'event');
        expect(screen.getByText('2 of 7 posts')).toBeInTheDocument();
        expect(screen.getByText('Seed swap at the hall')).toBeInTheDocument();
        expect(screen.getByText('Shared harvest picnic')).toBeInTheDocument();
        expect(screen.queryByText('Sourdough')).not.toBeInTheDocument();
        await userEvent.selectOptions(select, 'poll');
        expect(screen.getByText('1 of 7 posts')).toBeInTheDocument();
        expect(screen.getByText('Which night for the market?')).toBeInTheDocument();
    });

    it('Shown from another community picks the copies, whatever they copy, and nothing else', async () => {
        render(<PostModerationPanel posts={POSTS} activeNode={NODE} onRefresh={vi.fn()} />);
        await userEvent.selectOptions(screen.getByLabelText(/Type Filter/i), 'copy');
        expect(screen.getByText('2 of 7 posts')).toBeInTheDocument();
        expect(screen.getByText('Shared harvest picnic')).toBeInTheDocument();
        expect(screen.getByText('Shared lemons')).toBeInTheDocument();
        expect(screen.queryByText('Seed swap at the hall')).not.toBeInTheDocument();
        expect(screen.queryByText('Sourdough')).not.toBeInTheDocument();
    });

    it('Offers and Needs still pick by type, and a post is only a copy by the server\'s mark', async () => {
        render(<PostModerationPanel posts={POSTS} activeNode={NODE} onRefresh={vi.fn()} />);
        const select = screen.getByLabelText(/Type Filter/i);
        await userEvent.selectOptions(select, 'need');
        expect(screen.getByText('1 of 7 posts')).toBeInTheDocument();
        await userEvent.selectOptions(select, 'offer');
        // Three: Sourdough, the lemons (a copy is still an Offer), and the watches.
        expect(screen.getByText('3 of 7 posts')).toBeInTheDocument();
        expect(isCopy({ id: 'x', type: 'offer', title: 'Shown from another community' })).toBe(false);
        expect(isCopy({ id: 'x', type: 'offer', shownCopy: true })).toBe(true);
        expect(isCopy({ id: 'x', type: 'offer', shownFrom: { name: 'Castlemaine' } })).toBe(true);
    });
});

describe('Chips: one per type, from the central brand colours', () => {
    it('Offer, Need, event and poll each take their own role, and none is a raw Tailwind shade', () => {
        const classes = ['offer', 'need', 'event', 'poll'].map((t) => chipClassFor(t));
        expect(classes[0]).toContain('bg-bp-chip-ok-tint text-bp-chip-ok-ink');
        expect(classes[1]).toContain('bg-bp-chip-need-tint text-bp-chip-need-ink');
        expect(classes[2]).toContain('bg-bp-tile-event-tint text-bp-tile-event-ink');
        expect(classes[3]).toContain('bg-bp-chip-accent-tint text-bp-chip-accent-ink');
        expect(new Set(classes).size).toBe(4);
        for (const c of [...classes, chipClassFor(undefined), chipClassFor(99)]) expect(c).not.toMatch(/\b(?:sky|emerald|orange|red|amber|violet)-\d/);
    });

    it('an event is no longer drawn in the Need colour, and a copy says so on its row', () => {
        render(<PostModerationPanel posts={POSTS} activeNode={NODE} onRefresh={vi.fn()} />);
        const chipOf = (title: string) => within(row(title)).getByTestId('post-type-chip');
        expect(chipOf('A garden tiller').className).toContain('bg-bp-chip-need-tint');
        expect(chipOf('Seed swap at the hall').className).toContain('bg-bp-tile-event-tint');
        expect(chipOf('Seed swap at the hall').className).not.toContain('bg-bp-chip-need-tint');
        expect(chipOf('Which night for the market?').className).toContain('bg-bp-chip-accent-tint');
        expect(within(row('Shared harvest picnic')).getByTestId('post-copy-chip').textContent).toBe('Shown from another community');
        expect(within(row('Sourdough')).queryByTestId('post-copy-chip')).toBeNull();
    });
});

describe('The "taken down" line', () => {
    it('says who took a post down, that it is hidden now, and the day it goes for good; Put back sits beside Delete', async () => {
        serve({ body: { takedowns: [CALL] } });
        render(<PostModerationPanel posts={POSTS} activeNode={NODE} onRefresh={vi.fn()} viewer={OWNER} />);
        const line = await within(row('Cheap watches')).findByTestId('post-taken-down');
        expect(line.textContent).toMatch(/^Taken down by Spam sweeper: hidden now, and removed for good on .+ unless put back\.$/);
        expect(line.textContent).toContain(String(new Date(FINAL).getFullYear()));
        const buttons = within(row('Cheap watches')).getAllByRole('button').map((b) => b.textContent);
        expect(buttons).toEqual(['Put back', '🗑️Delete']);
    });

    it('a post taken down with a Child safety report open says a report holds it, in the words "Taken down by assistants" uses', async () => {
        const call = { ...CALL, posts: [{ id: 'p-down', title: 'Cheap watches', author: 'Sam Spam', type: 'offer', state: 'hidden', leftFor: null, childSafetyOpen: true }] };
        serve({ body: { takedowns: [call] } });
        render(<PostModerationPanel posts={POSTS} activeNode={NODE} onRefresh={vi.fn()} viewer={OWNER} />);
        const line = await within(row('Cheap watches')).findByTestId('post-taken-down');
        expect(line.textContent).toBe(`Taken down by Spam sweeper: hidden now, because ${CHILD_SAFETY_OPEN}. It is not removed for good until a person decides.`);
        expect(line.textContent).not.toMatch(/removed for good on|unless put back/);
        // The card on the same page words the same post with the same phrase.
        cleanup();
        serve({ body: { canActOnMany: true, takedowns: [call] } });
        render(<AssistantTakedownsPanel activeNode={NODE} viewer={OWNER} />);
        fireEvent.click(await screen.findByText('Show its posts'));
        expect(screen.getByText(new RegExp(`Hidden: ${CHILD_SAFETY_OPEN}`))).toBeTruthy();
    });

    it('a post left hidden says why, and one put back or already final has no line', async () => {
        serve({ body: { takedowns: [CALL] } });
        render(<PostModerationPanel posts={POSTS} activeNode={NODE} onRefresh={vi.fn()} viewer={OWNER} />);
        const left = await within(row('Seed swap at the hall')).findByTestId('post-taken-down');
        expect(left.textContent).toBe('Taken down by Spam sweeper: left hidden, because a deal is in escrow. It is not removed for good until a person decides.');
        expect(within(row('Sourdough')).queryByTestId('post-taken-down')).toBeNull();
        expect(within(row('A garden tiller')).queryByTestId('post-taken-down')).toBeNull();
        expect(within(row('Shared lemons')).queryByTestId('post-taken-down')).toBeNull();
        expect(screen.getAllByTestId('post-taken-down')).toHaveLength(2);
    });

    it("draws the assistant's name as text, never as markup", async () => {
        serve({ body: { takedowns: [{ ...CALL, grantName: '<img src=x onerror="window.__pwned=1"> sweeper' }] } });
        render(<PostModerationPanel posts={POSTS} activeNode={NODE} onRefresh={vi.fn()} viewer={OWNER} />);
        const line = await within(row('Cheap watches')).findByTestId('post-taken-down');
        expect(line.textContent).toContain('<img src=x');
        expect(line.querySelector('img')).toBeNull();
        expect((window as any).__pwned).toBeUndefined();
    });

    it('asks the owner\'s and an admin\'s session for the record, and a moderator\'s or an unnamed viewer\'s nothing', async () => {
        const served = serve({ body: { takedowns: [CALL] } });
        render(<PostModerationPanel posts={POSTS} activeNode={NODE} onRefresh={vi.fn()} viewer={{ kind: 'key', memberPubkey: 'k', role: 'moderator' }} />);
        render(<PostModerationPanel posts={POSTS} activeNode={NODE} onRefresh={vi.fn()} />);
        await new Promise((r) => setTimeout(r, 30));
        expect(served).toHaveLength(0);
        expect(screen.queryAllByTestId('post-taken-down')).toHaveLength(0);
        cleanup();
        render(<PostModerationPanel posts={POSTS} activeNode={NODE} onRefresh={vi.fn()} viewer={{ kind: 'key', memberPubkey: 'k', role: 'admin' }} />);
        await waitFor(() => expect(served.filter((s) => s.method === 'GET')).toHaveLength(1));
        expect(served[0].url).toMatch(/\/api\/local\/admin\/agent\/takedowns$/);
    });

    it('says nothing on a node with no such route (404) or when the session may not read it (403), and says so on any other failure', async () => {
        serve({ status: 404, body: { error: 'not found' } });
        const a = render(<PostModerationPanel posts={POSTS} activeNode={NODE} onRefresh={vi.fn()} viewer={OWNER} />);
        await waitFor(() => expect(fetch).toHaveBeenCalled());
        await new Promise((r) => setTimeout(r, 20));
        expect(screen.queryByTestId('post-takedown-note')).toBeNull();
        a.unmount();
        serve({ status: 403, body: { error: 'no' } });
        const b = render(<PostModerationPanel posts={POSTS} activeNode={NODE} onRefresh={vi.fn()} viewer={OWNER} />);
        await waitFor(() => expect(fetch).toHaveBeenCalled());
        await new Promise((r) => setTimeout(r, 20));
        expect(screen.queryByTestId('post-takedown-note')).toBeNull();
        b.unmount();
        serve({ status: 500, body: { error: 'the database is busy' } });
        render(<PostModerationPanel posts={POSTS} activeNode={NODE} onRefresh={vi.fn()} viewer={OWNER} />);
        expect((await screen.findByTestId('post-takedown-note')).textContent).toBe('Which posts an assistant took down could not be listed: the database is busy');
        // The list of posts itself is untouched.
        expect(screen.getByText('7 of 7 posts')).toBeInTheDocument();
    });

    it('Put back sends the one post to the route "Taken down by assistants" uses, says what it did, and refreshes the list', async () => {
        const served = serve({ body: { takedowns: [CALL] } });
        const onRefresh = vi.fn();
        render(<PostModerationPanel posts={POSTS} activeNode={NODE} onRefresh={onRefresh} viewer={OWNER} />);
        fireEvent.click(await within(row('Cheap watches')).findByTestId('post-put-back'));
        await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
        const post = served.find((s) => s.method === 'POST')!;
        expect(post.url).toMatch(/\/api\/local\/admin\/agent\/takedowns\/put-back$/);
        expect(post.body).toEqual({ postId: 'p-down' });
        expect(await screen.findByRole('status')).toHaveTextContent('Put back: its author is told, and everyone sees it again. Any reports the takedown closed are open again.');
        // The record is read again, so the line follows what the server now says.
        await waitFor(() => expect(served.filter((s) => s.method === 'GET').length).toBeGreaterThanOrEqual(2));
    });

    it('Put back that the server refuses shows its words and leaves the post as it was', async () => {
        serve({ body: { takedowns: [CALL] } }, { status: 404, body: { error: 'Nothing here is waiting to be put back: it was put back already, or it is final' } });
        const onRefresh = vi.fn();
        render(<PostModerationPanel posts={POSTS} activeNode={NODE} onRefresh={onRefresh} viewer={OWNER} />);
        fireEvent.click(await within(row('Cheap watches')).findByTestId('post-put-back'));
        expect(await screen.findByRole('alert')).toHaveTextContent('Failed to put the post back: Nothing here is waiting to be put back');
        expect(onRefresh).not.toHaveBeenCalled();
    });
});

describe('heldTakedowns, takenDownWords, putBackWords', () => {
    it('keeps the newest call for a post held twice, skips put back and final, and ignores what is not in shape', () => {
        const older = { ...CALL, id: 'old', grantName: 'Older helper', posts: [{ id: 'p-down', state: 'hidden' }, { id: 'p-x', state: 'hidden' }] };
        const held = heldTakedowns([CALL, older, null, { posts: 'nope' }, { grantName: 'No posts' }, { grantName: 7, finalAfter: FINAL, posts: [{ id: 'p-y', state: 'hidden' }, { id: 5, state: 'hidden' }, { id: 'p-z', state: 'weird' }] }]);
        expect([...held.keys()].sort()).toEqual(['p-down', 'p-event', 'p-x', 'p-y']);
        expect(held.get('p-down')?.grantName).toBe('Spam sweeper');
        expect(held.get('p-x')?.grantName).toBe('Older helper');
        expect(held.get('p-y')?.grantName).toBe('an assistant');
        expect(heldTakedowns('not a list').size).toBe(0);
        expect(heldTakedowns(undefined).size).toBe(0);
    });

    it('words a hide by its state and its date, and does not promise a date it does not have', () => {
        const now = Date.parse('2026-11-04T00:00:00.000Z');
        const base = { grantName: 'Helper', finalAfter: FINAL, state: 'hidden' as const, leftFor: null, childSafetyOpen: false };
        expect(takenDownWords(base, now)).toMatch(/^Taken down by Helper: hidden now, and removed for good on .+ unless put back\.$/);
        expect(takenDownWords({ ...base, finalAfter: '2026-11-03T00:00:00.000Z' }, now)).toBe('Taken down by Helper: hidden now, and due to be removed for good.');
        expect(takenDownWords({ ...base, finalAfter: '' }, now)).toBe('Taken down by Helper: hidden now, and removed for good after 7 days unless put back.');
        expect(takenDownWords({ ...base, state: 'left_hidden', leftFor: 'child_safety' }, now)).toBe('Taken down by Helper: left hidden, because a Child safety report is open. It is not removed for good until a person decides.');
        expect(takenDownWords({ ...base, state: 'left_hidden' }, now)).toBe('Taken down by Helper: left hidden. It is not removed for good until a person decides.');
    });

    it('carries childSafetyOpen from the server, only when it is true', () => {
        const held = heldTakedowns([{ ...CALL, posts: [
            { id: 'p-cs', state: 'hidden', childSafetyOpen: true },
            { id: 'p-no', state: 'hidden', childSafetyOpen: false },
            { id: 'p-odd', state: 'hidden', childSafetyOpen: 'yes' },
            { id: 'p-none', state: 'hidden' },
            { id: 'p-both', state: 'left_hidden', leftFor: 'deal', childSafetyOpen: true },
        ] }]);
        expect(['p-cs', 'p-no', 'p-odd', 'p-none', 'p-both'].map((id) => held.get(id)?.childSafetyOpen)).toEqual([true, false, false, false, true]);
    });

    it('a post still only hidden, with a Child safety report open, is never promised a day it goes for good', () => {
        const now = Date.parse('2026-11-04T00:00:00.000Z');
        const csHidden = { grantName: 'Helper', finalAfter: FINAL, state: 'hidden' as const, leftFor: null, childSafetyOpen: true };
        const line = takenDownWords(csHidden, now);
        expect(line).toBe(`Taken down by Helper: hidden now, because ${CHILD_SAFETY_OPEN}. It is not removed for good until a person decides.`);
        expect(line).not.toMatch(/removed for good on|due to be removed|after 7 days|unless put back/);
        // The same on the day the 7 days are up, and with no date at all: the sweep skips it either way.
        expect(takenDownWords({ ...csHidden, finalAfter: '2026-11-03T00:00:00.000Z' }, now)).toBe(line);
        expect(takenDownWords({ ...csHidden, finalAfter: '' }, now)).toBe(line);
        // Left hidden for a Child safety report says it in the same words, and a deal as well says both.
        expect(takenDownWords({ ...csHidden, state: 'left_hidden', leftFor: 'child_safety' }, now))
            .toBe(`Taken down by Helper: left hidden, because ${CHILD_SAFETY_OPEN}. It is not removed for good until a person decides.`);
        expect(takenDownWords({ ...csHidden, state: 'left_hidden', leftFor: 'deal' }, now))
            .toBe(`Taken down by Helper: left hidden, because a deal is in escrow, and ${CHILD_SAFETY_OPEN}. It is not removed for good until a person decides.`);
    });

    it('puts back in the same words "Taken down by assistants" uses, and tells a post that stays hidden or has gone', () => {
        expect(putBackWords({ back: ['a'], stillHidden: [], gone: 0 })).toMatch(/^Put back: its author is told, and everyone sees it again\./);
        expect(putBackWords({ back: ['a'], stillHidden: ['a'], gone: 0 })).toMatch(/^Put back, but it stays hidden for the moderators/);
        expect(putBackWords({ back: [], stillHidden: [], gone: 1 })).toMatch(/^That post had gone already/);
        expect(putBackWords({})).toMatch(/^That post had gone already/);
    });
});

/**
 * A followed topic on the web's forum, notifications (scratch/fable-design/DESIGN-notify-and-backup-asks-fable-amend2.md
 * §12.3 slice N5b; the phone's N2b): following a topic may bring "Hear when someone replies here." [Tell me] under the bell,
 * by core's rule, while the topic stays followed; never on a closed topic, which takes no replies (the node refuses them,
 * apps/server/src/engine/forum.ts). The forum's canReply flag (sweep-8) is not on main: the topic's closed state gates it.
 *
 * Table, each row red without its line: (topic: open / closed) x (browser) x (the rule's state) -> the line or none, the
 * browser's prompt never at the follow. Then: unfollow, a refused follow, another topic opened in its place; 320 px at 130%,
 * light and dark. The ForumPage over a stand-in node, as ForumPage.test.tsx stands one in.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    BROWSERS, CAN_OFFER, RECORDS, clearBrowser, expectLineFits, keepRecord, oldPhone, resetScreen, standBrowser, type BrowserKind, type RecordKind,
} from '../components/notify-lines.test-support';

type Call = { method: string; path: string; body?: any };
const node = vi.hoisted(() => ({ answer: null as null | ((c: Call) => unknown) }));
vi.mock('../lib/api', async (orig) => ({
    ...(await orig<typeof import('../lib/api')>()),
    request: vi.fn(async (method: string, path: string, body?: unknown) => {
        const out = node.answer!({ method, path, body });
        if (out instanceof Error) throw out;
        return out;
    }),
    myNodeRoleOnce: vi.fn(async () => 'member'),
    getNodeApiUrl: () => '',
}));
vi.mock('../lib/identity', async () => {
    const actual = await vi.importActual('../lib/identity');
    return { ...actual, loadIdentity: vi.fn(async () => ({ publicKey: 'a'.repeat(64), privateKey: '00'.repeat(48), callsign: 'Me', createdAt: '2026-09-27T00:00:00.000Z' })) };
});

import { ForumPage } from './ForumPage';
import { forgetForum } from '../lib/forum';
import { readNotifyAsk } from '../lib/web-push';

const ME = 'a'.repeat(64);
const AT = new Date(Date.now() - 3600_000).toISOString();
const LINE = 'Hear when someone replies here.';
const SECTIONS = [{ id: 's-general', starter: 'general', name: null, about: null, position: 0, starts: 'members', listed: false, archived: false }];
const topic = (id: string, title: string, over: Record<string, unknown> = {}) => ({
    id, sectionId: 's-general', title, writer: { publicKey: 'b'.repeat(64), name: 'Asha' }, place: null, lang: 'en', replyCount: 1, lastActivityAt: AT,
    createdAt: AT, pinned: false, closed: null, removed: false, hidden: false, follow: null, unread: false, ...over,
});
const post = (number: number, words: string) => ({
    id: `fp-${number}`, topicId: 'ft-1', number, writer: { publicKey: 'b'.repeat(64), name: 'Asha' }, words, quotes: null, lang: 'en', createdAt: AT,
    editedAt: null, removed: null, photos: 0, hidden: false, linksOn: true,
});

let state: { topics: any[]; refuseFollow: boolean };
function standIn(c: Call): unknown {
    const p = c.path.split('?')[0];
    if (c.method === 'GET' && p === '/api/forum') return { sections: SECTIONS, public: false, told: true, moderator: false, firstLooksWaiting: null, firstTopicWaits: false, linksOn: true };
    if (c.method === 'GET' && p === '/api/forum/topics') return { topics: state.topics, next: null };
    const read = /^\/api\/forum\/topics\/(ft-\d)$/.exec(p);
    if (c.method === 'GET' && read) return { topic: state.topics.find((x) => x.id === read[1]), posts: [post(1, 'Who has beans to swap?')], next: null, lastRead: 1 };
    const follow = /^\/api\/forum\/topics\/(ft-\d)\/follow$/.exec(p);
    if (c.method === 'POST' && follow) {
        if (state.refuseFollow) return Object.assign(new Error('Could not follow this topic.'), { status: 503 });
        state.topics = state.topics.map((x) => (x.id === follow[1] ? { ...x, follow: c.body.follow } : x));
        return { follow: c.body.follow };
    }
    if (c.method === 'POST' && /\/read$/.test(p)) return { lastRead: c.body.upTo };
    if (c.method === 'GET' && p === '/api/forum/first-looks/mine') return { waiting: null, usuallyWithinHours: 5 };
    return { ok: true };
}

async function openAndFollow(closed = false) {
    state.topics = [topic('ft-1', 'Seed swap ideas', closed ? { closed: AT } : {}), topic('ft-2', 'Welcome: start here')];
    render(<ForumPage me={ME} />);
    fireEvent.click(await screen.findByText('Seed swap ideas'));
    await screen.findByTestId('forum-topic-title');
    fireEvent.click(screen.getByTestId('forum-follow'));
    await waitFor(() => expect(screen.getByTestId('forum-follow')).toHaveAttribute('aria-pressed', 'true'));
    await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
    forgetForum();
    node.answer = standIn;
    state = { topics: [], refuseFollow: false };
    localStorage.clear();
});
afterEach(() => {
    cleanup();
    clearBrowser();
    resetScreen();
});

describe("following a topic: open or closed x browser x the rule's state -> the line or none", () => {
    for (const closed of [false, true]) {
        for (const b of BROWSERS) {
            for (const [rec, { offers, pins }] of Object.entries(RECORDS) as [RecordKind, { offers: boolean; pins: string }][]) {
                if (b !== 'default' && rec !== 'fresh') continue;
                const shows = !closed && CAN_OFFER[b as BrowserKind] && offers;
                it(`${closed ? 'closed' : 'open'} topic, ${b}, ${rec} -> ${shows ? `"${LINE}" [Tell me]` : 'no line'} (pins: ${closed ? 'a closed topic takes no replies' : pins})`, async () => {
                    const ask = standBrowser(b, ME);
                    keepRecord(ME, rec, 'follow');
                    await openAndFollow(closed);
                    if (shows) {
                        const line = await screen.findByTestId('forum-follow-line');
                        expect(line).toHaveTextContent(LINE);
                        expect(readNotifyAsk(ME).lines).toEqual(['follow']);
                    } else {
                        expect(screen.queryByTestId('forum-follow-line')).toBeNull();
                        expect(screen.queryByTestId('notify-line')).toBeNull();
                    }
                    expect(ask).not.toHaveBeenCalled();
                });
            }
        }
    }
});

describe('the line after the follow', () => {
    for (const dark of [false, true]) {
        it(`320 px at 130%${dark ? ', dark' : ''}: wraps under the bell and keeps its target`, async () => {
            oldPhone(dark);
            standBrowser('default', ME);
            await openAndFollow();
            expectLineFits(await screen.findByTestId('notify-line'));
        });
    }

    it('unfollowed: the line goes', async () => {
        standBrowser('default', ME);
        await openAndFollow();
        await screen.findByTestId('forum-follow-line');
        fireEvent.click(screen.getByTestId('forum-follow'));
        await waitFor(() => expect(screen.queryByTestId('forum-follow-line')).toBeNull());
    });

    it('a follow the node refused: no line, and the kind left unspent', async () => {
        standBrowser('default', ME);
        state.topics = [topic('ft-1', 'Seed swap ideas'), topic('ft-2', 'Welcome: start here')];
        state.refuseFollow = true;
        render(<ForumPage me={ME} />);
        fireEvent.click(await screen.findByText('Seed swap ideas'));
        await screen.findByTestId('forum-topic-title');
        fireEvent.click(screen.getByTestId('forum-follow'));
        await screen.findByText('Could not follow this topic.');
        expect(screen.queryByTestId('notify-line')).toBeNull();
        expect(readNotifyAsk(ME).lines).toBeUndefined();
    });

    it("Tell me: the browser's prompt once, at the tap; a no kept apart, the line gone without a word", async () => {
        const ask = standBrowser('default', ME, 'denied');
        await openAndFollow();
        fireEvent.click(await screen.findByTestId('notify-line-tell-me'));
        await waitFor(() => expect(screen.queryByTestId('notify-line')).toBeNull());
        expect(ask).toHaveBeenCalledTimes(1);
        expect(readNotifyAsk(ME).phoneNoAt).toEqual(expect.any(Number));
    });
});

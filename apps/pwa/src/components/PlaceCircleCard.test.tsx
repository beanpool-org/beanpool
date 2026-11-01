/**
 * A place circle's card on the web (Lounge L2, §3.3), at 320 px with the text at 130%, in both themes: its three rows, a
 * count below 3 never said, and Ask to join: nothing leaves this browser for the community until the tap, and the tap sends
 * exactly one knock, to the community.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PLACE_CIRCLE_WORDS, t, type CircleCard } from '@beanpool/core';
import { PlaceCircleCard } from './PlaceCircleCard';
import { MarketCircleLine } from './MarketCircleLine';
import { circleIntents, knockForCircle, setCircleIntent } from '../lib/circle-intent';
import { cancelKnock, rememberKnock, rememberedKnocks } from '../lib/knock';
import type { BeanPoolIdentity } from '../lib/identity';

const ME: BeanPoolIdentity = { publicKey: 'a'.repeat(64), privateKey: '00'.repeat(32), callsign: 'Ana', createdAt: '2026-01-01T00:00:00.000Z' } as BeanPoolIdentity;
const OPEN: CircleCard = { people: 4, starting: null, doneAt: null, community: null };
const THRISSUR = { key: 'thrissur', name: 'Thrissur Commons', url: 'https://thrissur.beanpool.org', acceptingKnocks: true };

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
    // 320 px, the text at 130%, as the small-screen floor asks.
    document.documentElement.style.fontSize = '130%';
    document.body.style.width = '320px';
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    document.documentElement.style.fontSize = '';
    document.body.style.width = '';
    document.documentElement.classList.remove('dark');
});

describe.each([['light', false], ['dark', true]])('the card in the %s theme at 320 px × 1.3', (_name, dark) => {
    beforeEach(() => { document.documentElement.classList.toggle('dark', dark); });

    it('shows its three rows, each a wrapping 44 px target with a role in both themes', () => {
        const { container } = render(<PlaceCircleCard id="c1" circle={OPEN} identity={ME} onStart={() => {}} />);
        expect(screen.getByTestId('circle-people').textContent).toBe('4 people here');
        expect(screen.getByRole('button', { name: 'Start a community' })).toBeTruthy();
        expect(screen.getByRole('button', { name: "I'm starting one here" })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Remind me to join when it starts' })).toBeTruthy();
        for (const b of Array.from(container.querySelectorAll('button'))) {
            expect(b.className).toContain('min-h-[44px]');
            expect(b.className).toContain('break-words');
            expect(b.className).toContain('dark:text-white');
        }
    });

    it('a retired circle says what started and how long its chat stays, with one Ask to join and no rows', async () => {
        const { container } = render(<PlaceCircleCard id="c1" circle={{ ...OPEN, doneAt: '2026-11-01T00:00:00.000Z', community: THRISSUR }} identity={ME} onStart={() => {}} />);
        expect(screen.getByTestId('circle-started-line').textContent).toBe('A community has started near you: Thrissur Commons.');
        expect(screen.getByText('This circle did its job. Its chat stays for 30 days.')).toBeTruthy();
        const ask = await screen.findByRole('button', { name: 'Ask to join' });
        expect(ask.className).toContain('min-h-[44px]');
        expect(ask.className).toContain('break-words');
        expect(ask.className).toContain('bg-bp-commit-fill');
        expect(container.querySelectorAll('button')).toHaveLength(1);
    });
});

describe('what the card says', () => {
    it('says no count below 3, whatever the node sent', () => {
        render(<PlaceCircleCard id="c1" circle={{ ...OPEN, people: 2 }} identity={ME} onStart={() => {}} />);
        expect(screen.queryByTestId('circle-people')).toBeNull();
    });

    it("someone else starting takes the row away, and the words say so", () => {
        render(<PlaceCircleCard id="c1" circle={{ ...OPEN, starting: 'someone' }} identity={ME} onStart={() => {}} />);
        expect(screen.getByText('Someone is starting a community near you.')).toBeTruthy();
        expect(screen.queryByRole('button', { name: "I'm starting one here" })).toBeNull();
    });

    it("I'm starting one here asks the node and shows the card it answers with", async () => {
        const stub = vi.fn(async () => json(200, { success: true, circle: { ...OPEN, starting: 'you' } }));
        vi.stubGlobal('fetch', stub);
        const onChange = vi.fn();
        render(<PlaceCircleCard id="c1" circle={OPEN} identity={ME} onStart={() => {}} onChange={onChange} />);
        fireEvent.click(screen.getByTestId('circle-starting'));
        await waitFor(() => expect(onChange).toHaveBeenCalled());
        expect(onChange.mock.calls[0][0].starting).toBe('you');
    });

    it('the reminder is kept on this browser and nowhere else', () => {
        const stub = vi.fn();
        vi.stubGlobal('fetch', stub);
        render(<PlaceCircleCard id="c1" circle={OPEN} identity={ME} onStart={() => {}} />);
        fireEvent.click(screen.getByTestId('circle-join-when'));
        expect(circleIntents(ME.publicKey)).toEqual(['c1']);
        expect(stub).not.toHaveBeenCalled();
    });
});

describe('the reminder, when the card moves on', () => {
    it('says the wish of the circle it is drawn for, not of the one before it', () => {
        setCircleIntent(ME.publicKey, 'c1', true);
        const { rerender } = render(<PlaceCircleCard id="c1" circle={OPEN} identity={ME} onStart={() => {}} />);
        expect(screen.getByTestId('circle-join-when')).toHaveAttribute('aria-pressed', 'true');
        rerender(<PlaceCircleCard id="c2" circle={OPEN} identity={ME} onStart={() => {}} />);
        expect(screen.getByTestId('circle-join-when')).toHaveAttribute('aria-pressed', 'false');
    });

    it('reads the wish once the account is known', () => {
        setCircleIntent(ME.publicKey, 'c1', true);
        const { rerender } = render(<PlaceCircleCard id="c1" circle={OPEN} identity={null} onStart={() => {}} />);
        expect(screen.getByTestId('circle-join-when')).toHaveAttribute('aria-pressed', 'false');
        rerender(<PlaceCircleCard id="c1" circle={OPEN} identity={ME} onStart={() => {}} />);
        expect(screen.getByTestId('circle-join-when')).toHaveAttribute('aria-pressed', 'true');
    });
});

describe('Ask to join on a retired circle', () => {
    const retired = { ...OPEN, doneAt: '2026-11-01T00:00:00.000Z', community: THRISSUR };
    const KNOCK = 'https://thrissur.beanpool.org/api/join/knock';
    /** Every address this browser asks, whoever it is. */
    function wire(answer: () => Response | Promise<Response>): string[] {
        const asked: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => { asked.push(String(input)); return answer(); }));
        return asked;
    }
    const settle = () => act(async () => { await new Promise(r => setTimeout(r, 20)); });

    it('sends nothing before the tap, wish or no wish, however often the card is read', async () => {
        const asked = wire(() => json(201, {}));
        setCircleIntent(ME.publicKey, 'c1', true);
        const { rerender } = render(<PlaceCircleCard id="c1" circle={retired} identity={ME} />);
        await screen.findByTestId('circle-ask-join');
        rerender(<PlaceCircleCard id="c1" circle={{ ...retired }} identity={ME} />);
        await settle();
        expect(asked).toEqual([]);
        expect(circleIntents(ME.publicKey)).toEqual(['c1']);
        expect(await rememberedKnocks(ME.publicKey)).toEqual([]);
    });

    it('one tap sends one knock, to the community, remembers it, and ends the wish', async () => {
        const asked = wire(() => json(201, { knock: { status: 'pending' } }));
        setCircleIntent(ME.publicKey, 'c1', true);
        const onAsked = vi.fn();
        render(<PlaceCircleCard id="c1" circle={retired} identity={ME} onAsked={onAsked} />);
        fireEvent.click(await screen.findByTestId('circle-ask-join'));
        await waitFor(() => expect(onAsked).toHaveBeenCalledTimes(1));
        expect(asked).toEqual([KNOCK]);
        expect((await rememberedKnocks(ME.publicKey)).map(k => k.url)).toEqual(['https://thrissur.beanpool.org']);
        expect(circleIntents(ME.publicKey)).toEqual([]);
        expect(screen.queryByTestId('circle-ask-join')).toBeNull();
    });

    it('takes no wish: a member who never set the reminder asks with the same tap', async () => {
        const asked = wire(() => json(201, { knock: { status: 'pending' } }));
        render(<PlaceCircleCard id="c1" circle={retired} identity={ME} />);
        fireEvent.click(await screen.findByTestId('circle-ask-join'));
        await screen.findByTestId('circle-asked');
        expect(asked).toEqual([KNOCK]);
    });

    it('a second tap while the first is out sends nothing', async () => {
        let answer: (r: Response) => void = () => {};
        const asked = wire(() => new Promise<Response>(resolve => { answer = resolve; }));
        render(<PlaceCircleCard id="c1" circle={retired} identity={ME} />);
        const ask = await screen.findByTestId('circle-ask-join');
        fireEvent.click(ask);
        fireEvent.click(ask);
        await waitFor(() => expect(asked).toEqual([KNOCK]));
        expect(await knockForCircle(ME, { id: 'c1', ...retired })).toEqual({ sent: false, trouble: null, said: null });
        answer(json(201, { knock: { status: 'pending' } }));
        await screen.findByTestId('circle-asked');
        expect(asked).toEqual([KNOCK]);
    });

    it('the reminder line is for someone who set it, beside the button', async () => {
        wire(() => json(201, {}));
        const { unmount } = render(<PlaceCircleCard id="c1" circle={retired} identity={ME} />);
        await screen.findByTestId('circle-ask-join');
        expect(screen.queryByTestId('circle-reminded')).toBeNull();
        unmount();
        setCircleIntent(ME.publicKey, 'c1', true);
        render(<PlaceCircleCard id="c1" circle={retired} identity={ME} />);
        expect(await screen.findByTestId('circle-reminded')).toHaveTextContent(t(PLACE_CIRCLE_WORDS.reminded));
    });

    it('where Home draws the request, the card adds no line of its own; on the sheet it says where to look', async () => {
        wire(() => json(201, {}));
        await rememberKnock(ME.publicKey, { url: THRISSUR.url, name: THRISSUR.name, key: THRISSUR.key });
        const { unmount } = render(<PlaceCircleCard id="c1" circle={retired} identity={ME} />);
        expect(await screen.findByTestId('circle-asked')).toHaveTextContent(t(PLACE_CIRCLE_WORDS.asked));
        unmount();
        render(<PlaceCircleCard id="c1" circle={retired} identity={ME} onAsked={() => {}} />);
        await settle();
        expect(screen.queryByTestId('circle-asked')).toBeNull();
    });

    it.each([502, 503, 429])('a %i says nothing about this person: the wish and the button stay, the card says so, and only another tap sends', async status => {
        const asked = wire(() => new Response('<html>busy</html>', { status }));
        setCircleIntent(ME.publicKey, 'c1', true);
        const { rerender } = render(<PlaceCircleCard id="c1" circle={retired} identity={ME} />);
        fireEvent.click(await screen.findByTestId('circle-ask-join'));
        expect(await screen.findByTestId('circle-knock-line')).toHaveTextContent(t(PLACE_CIRCLE_WORDS.knockLater));
        expect(circleIntents(ME.publicKey)).toEqual(['c1']);
        rerender(<PlaceCircleCard id="c1" circle={{ ...retired }} identity={ME} />);
        await settle();
        expect(asked).toEqual([KNOCK]);
        const askedAgain = wire(() => json(201, { knock: { status: 'pending' } }));
        fireEvent.click(await screen.findByTestId('circle-ask-join'));
        await screen.findByTestId('circle-asked');
        expect(askedAgain).toEqual([KNOCK]);
        expect(circleIntents(ME.publicKey)).toEqual([]);
        expect(screen.queryByTestId('circle-knock-line')).toBeNull();
    });

    it('no answer at all is the same: the button stays, and the card says so', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
        setCircleIntent(ME.publicKey, 'c1', true);
        render(<PlaceCircleCard id="c1" circle={retired} identity={ME} />);
        fireEvent.click(await screen.findByTestId('circle-ask-join'));
        expect(await screen.findByTestId('circle-knock-line')).toHaveTextContent(t(PLACE_CIRCLE_WORDS.knockLater));
        expect(circleIntents(ME.publicKey)).toEqual(['c1']);
        expect(screen.getByTestId('circle-ask-join')).toBeInTheDocument();
    });

    it('a refusal ends the wish, takes the button, and every later read still says so, in a region a screen reader hears', async () => {
        const asked = wire(() => json(403, { error: 'This key’s account in this community was closed.', code: 'account_closed' }));
        setCircleIntent(ME.publicKey, 'c1', true);
        const { unmount } = render(<PlaceCircleCard id="c1" circle={retired} identity={ME} />);
        const region = screen.getByTestId('circle-card-done').querySelector('[role="status"]');
        fireEvent.click(await screen.findByTestId('circle-ask-join'));
        await waitFor(() => expect(region).toHaveTextContent(t(PLACE_CIRCLE_WORDS.knockRefused)));
        expect(circleIntents(ME.publicKey)).toEqual([]);
        expect(screen.queryByTestId('circle-ask-join')).toBeNull();
        unmount();
        render(<PlaceCircleCard id="c1" circle={retired} identity={ME} />);
        expect(await screen.findByTestId('circle-knock-line')).toHaveTextContent(t(PLACE_CIRCLE_WORDS.knockRefused));
        expect(screen.queryByTestId('circle-ask-join')).toBeNull();
        expect(asked).toEqual([KNOCK]);
    });

    it('someone already a member there hears so, and has nothing left to tap', async () => {
        wire(() => json(409, { error: 'You are already a member of this community.', code: 'already_member' }));
        render(<PlaceCircleCard id="c1" circle={retired} identity={ME} />);
        fireEvent.click(await screen.findByTestId('circle-ask-join'));
        expect(await screen.findByTestId('circle-knock-said')).toHaveTextContent('You are already a member of this community.');
        expect(screen.queryByTestId('circle-ask-join')).toBeNull();
    });

    it('a community that already said yes is remembered, so Home can show the invite', async () => {
        wire(() => json(409, { error: 'They said yes.', code: 'knock_approved' }));
        const onAsked = vi.fn();
        render(<PlaceCircleCard id="c1" circle={retired} identity={ME} onAsked={onAsked} />);
        fireEvent.click(await screen.findByTestId('circle-ask-join'));
        await waitFor(() => expect(onAsked).toHaveBeenCalledTimes(1));
        expect((await rememberedKnocks(ME.publicKey)).map(k => k.url)).toEqual(['https://thrissur.beanpool.org']);
    });

    it.each([
        ['takes no requests', { ...retired, community: { ...THRISSUR, acceptingKnocks: false } }],
        ['has left the directory', { ...retired, community: null }],
        ['has no address', { ...retired, community: { ...THRISSUR, url: null } }],
    ])('no button for a community that %s: nothing on the card would work', async (_why, circle) => {
        const asked = wire(() => json(201, {}));
        setCircleIntent(ME.publicKey, 'c1', true);
        const { container } = render(<PlaceCircleCard id="c1" circle={circle as CircleCard} identity={ME} />);
        await settle();
        expect(container.querySelector('button')).toBeNull();
        expect(screen.queryByTestId('circle-reminded')).toBeNull();
        expect(asked).toEqual([]);
    });

    it('no button with no account', async () => {
        render(<PlaceCircleCard id="c1" circle={retired} identity={null} />);
        await settle();
        expect(screen.queryByTestId('circle-ask-join')).toBeNull();
    });

    it('no button a community would refuse: a request cancelled within the day, as Ask to join anywhere', async () => {
        wire(() => json(200, {}));
        await rememberKnock(ME.publicKey, { url: THRISSUR.url, name: THRISSUR.name, key: THRISSUR.key });
        await cancelKnock(THRISSUR.url, ME);
        expect(await rememberedKnocks(ME.publicKey)).toEqual([]);
        render(<PlaceCircleCard id="c1" circle={retired} identity={ME} />);
        await settle();
        expect(screen.queryByTestId('circle-ask-join')).toBeNull();
    });

    it('the send itself refuses a community that takes no requests', async () => {
        const asked = wire(() => json(201, {}));
        expect(await knockForCircle(ME, { id: 'c1', ...retired, community: { ...THRISSUR, acceptingKnocks: false } })).toEqual({ sent: false, trouble: null, said: null });
        expect(asked).toEqual([]);
    });
});

describe('a finished circle, once its group has closed', () => {
    const retired = { ...OPEN, doneAt: '2026-10-01T00:00:00.000Z', community: THRISSUR };

    it('says nothing about 30 days: the sheet\'s closed note is the one true thing', async () => {
        render(<PlaceCircleCard id="c1" circle={retired} identity={ME} closed />);
        await screen.findByTestId('circle-ask-join');
        expect(screen.queryByTestId('circle-chat-stays')).toBeNull();
        expect(document.body.textContent).not.toContain(t(PLACE_CIRCLE_WORDS.done));
    });

    it('still says it while its 30 days run', () => {
        render(<PlaceCircleCard id="c1" circle={retired} identity={ME} />);
        expect(screen.getByTestId('circle-chat-stays')).toHaveTextContent(t(PLACE_CIRCLE_WORDS.done));
    });
});

describe('what can send a knock', () => {
    it('nothing calls knockForCircle but the card: no read of Home, no return to the app, no notice', () => {
        const src = path.resolve(__dirname, '..');
        const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) return walk(full);
            return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [full] : [];
        });
        const callers = walk(src).filter(f => /knockForCircle\(/.test(fs.readFileSync(f, 'utf-8'))).map(f => path.relative(src, f)).sort();
        expect(callers).toEqual(['components/PlaceCircleCard.tsx', 'lib/circle-intent.ts']);
    });
});

describe('a sheet with nowhere to send Start a community', () => {
    it('draws no row, so nothing on the card is a button that does nothing', () => {
        render(<PlaceCircleCard id="c1" circle={OPEN} identity={ME} />);
        expect(screen.queryByTestId('circle-start')).toBeNull();
        expect(screen.getByRole('button', { name: "I'm starting one here" })).toBeTruthy();
    });
});

describe('the empty Market line', () => {
    it('says the count from 3 with Meet them', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => json(200, { demand: { waiting: 5, helping: null } })));
        const onMeet = vi.fn();
        render(<MarketCircleLine onMeet={onMeet} />);
        expect((await screen.findByTestId('market-circle-line')).textContent).toContain('5 people near you are waiting for a community too.');
        fireEvent.click(screen.getByTestId('market-meet-them'));
        expect(onMeet).toHaveBeenCalled();
    });

    it('says nothing at all below 3, even if a node sent one', async () => {
        const stub = vi.fn(async () => json(200, { demand: { waiting: 2, helping: null } }));
        vi.stubGlobal('fetch', stub);
        const { container } = render(<MarketCircleLine onMeet={() => {}} />);
        await waitFor(() => expect(stub).toHaveBeenCalled());
        await new Promise(r => setTimeout(r, 20));
        expect(container.textContent).toBe('');
    });
});

/**
 * A place circle's card on the web (Lounge L2, §3.3), at 320 px with the text at 130%, in both themes: its three rows, a
 * count below 3 never said, and "Join when it starts" sending exactly one knock, to the community, from this browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CircleCard } from '@beanpool/core';
import { PlaceCircleCard } from './PlaceCircleCard';
import { MarketCircleLine } from './MarketCircleLine';
import { circleIntents, knockForCircle, setCircleIntent } from '../lib/circle-intent';
import { rememberedKnocks } from '../lib/knock';
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
        const { container } = render(<PlaceCircleCard id="c1" circle={OPEN} myPubkey={ME.publicKey} onStart={() => {}} />);
        expect(screen.getByTestId('circle-people').textContent).toBe('4 people here');
        expect(screen.getByRole('button', { name: 'Start a community' })).toBeTruthy();
        expect(screen.getByRole('button', { name: "I'm starting one here" })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Join when it starts' })).toBeTruthy();
        for (const b of Array.from(container.querySelectorAll('button'))) {
            expect(b.className).toContain('min-h-[44px]');
            expect(b.className).toContain('break-words');
            expect(b.className).toContain('dark:text-white');
        }
    });

    it('a retired circle says what started and how long its chat stays, with no rows', () => {
        const { container } = render(<PlaceCircleCard id="c1" circle={{ ...OPEN, doneAt: '2026-11-01T00:00:00.000Z', community: THRISSUR }} myPubkey={ME.publicKey} onStart={() => {}} />);
        expect(screen.getByTestId('circle-started-line').textContent).toBe('A community has started near you: Thrissur Commons.');
        expect(screen.getByText('This circle did its job. Its chat stays for 30 days.')).toBeTruthy();
        expect(container.querySelector('button')).toBeNull();
    });
});

describe('what the card says', () => {
    it('says no count below 3, whatever the node sent', () => {
        render(<PlaceCircleCard id="c1" circle={{ ...OPEN, people: 2 }} myPubkey={ME.publicKey} onStart={() => {}} />);
        expect(screen.queryByTestId('circle-people')).toBeNull();
    });

    it("someone else starting takes the row away, and the words say so", () => {
        render(<PlaceCircleCard id="c1" circle={{ ...OPEN, starting: 'someone' }} myPubkey={ME.publicKey} onStart={() => {}} />);
        expect(screen.getByText('Someone is starting a community near you.')).toBeTruthy();
        expect(screen.queryByRole('button', { name: "I'm starting one here" })).toBeNull();
    });

    it("I'm starting one here asks the node and shows the card it answers with", async () => {
        const stub = vi.fn(async () => json(200, { success: true, circle: { ...OPEN, starting: 'you' } }));
        vi.stubGlobal('fetch', stub);
        const onChange = vi.fn();
        render(<PlaceCircleCard id="c1" circle={OPEN} myPubkey={ME.publicKey} onStart={() => {}} onChange={onChange} />);
        fireEvent.click(screen.getByTestId('circle-starting'));
        await waitFor(() => expect(onChange).toHaveBeenCalled());
        expect(onChange.mock.calls[0][0].starting).toBe('you');
    });

    it('Join when it starts is kept on this browser and nowhere else', () => {
        const stub = vi.fn();
        vi.stubGlobal('fetch', stub);
        render(<PlaceCircleCard id="c1" circle={OPEN} myPubkey={ME.publicKey} onStart={() => {}} />);
        fireEvent.click(screen.getByTestId('circle-join-when'));
        expect(circleIntents(ME.publicKey)).toEqual(['c1']);
        expect(stub).not.toHaveBeenCalled();
    });
});

describe('the knock when a community starts', () => {
    const retired = { id: 'c1', ...OPEN, doneAt: '2026-11-01T00:00:00.000Z', community: THRISSUR };

    it('goes once, to the community, and is remembered', async () => {
        const urls: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => { urls.push(String(input)); return json(201, { knock: { status: 'pending' } }); }));
        setCircleIntent(ME.publicKey, 'c1', true);
        expect(await knockForCircle(ME, retired)).toBe(true);
        expect(await knockForCircle(ME, retired)).toBe(false);
        expect(urls).toEqual(['https://thrissur.beanpool.org/api/join/knock']);
        expect((await rememberedKnocks(ME.publicKey)).map(k => k.url)).toEqual(['https://thrissur.beanpool.org']);
    });

    it('goes for nobody who did not ask, and not to a community that takes no requests', async () => {
        const stub = vi.fn();
        vi.stubGlobal('fetch', stub);
        expect(await knockForCircle(ME, retired)).toBe(false);
        setCircleIntent(ME.publicKey, 'c1', true);
        expect(await knockForCircle(ME, { ...retired, community: { ...THRISSUR, acceptingKnocks: false } })).toBe(false);
        expect(stub).not.toHaveBeenCalled();
    });

    it('is kept for the next read when the community could not be reached', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
        setCircleIntent(ME.publicKey, 'c1', true);
        expect(await knockForCircle(ME, retired)).toBe(false);
        expect(circleIntents(ME.publicKey)).toEqual(['c1']);
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

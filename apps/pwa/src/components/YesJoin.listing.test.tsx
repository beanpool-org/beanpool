/**
 * Back to the listing after the join, the web's holding half (list on global G4, DESIGN-list-on-global-fable.md §6 steps 4
 * and 7): the copy's door keeps the listing it stands for at its community; the yes's Join puts it in the address of that
 * community's page (an id, beside the handoff), and forgets it here once that page says the account joined. A Join that
 * couldn't open the page keeps it for another tap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const handoff = vi.hoisted(() => ({ end: null as null | string }));
vi.mock('../lib/handoff', async (actual) => {
    const real = await actual<typeof import('../lib/handoff')>();
    return {
        ...real,
        holderPhoto: async () => null,
        // The community's page, as far as the holder hears it: it answers at once with the end this test names.
        runHandoff: (opts: Parameters<typeof real.runHandoff>[0]) => {
            if (handoff.end) opts.onEnd(handoff.end as never);
            return { cancel() {} };
        },
    };
});
vi.mock('../lib/knock', async (actual) => ({ ...(await actual<Record<string, unknown>>()), forgetKnock: vi.fn(async () => {}) }));

import { YesJoin } from './YesJoin';
import { EventCopyDoor } from './EventCopyDoor';
import { keepLinkedPost, keptLinkedPostAt } from '../lib/visitor-lobby';
import type { BeanPoolIdentity } from '../lib/identity';

const BYRON = 'https://byron.example.org';
const POST = '3f2b8c1e-5d4a-4e7b-9a10-0c6d2e8f1a34';
const ME = { publicKey: 'ab'.repeat(32), privateKey: 'cd'.repeat(32), callsign: 'CJ', createdAt: '2026-11-14T00:00:00Z' } as BeanPoolIdentity;
const KNOCK = { url: BYRON, name: 'Byron Shire BeanPool', key: null, sentAt: '2026-11-14T00:00:00Z', callsign: 'CJ Asked' };
const FROM = { host: 'byron.example.org', postId: POST, name: 'Byron Shire BeanPool', url: BYRON, door: 'ask' as const };

beforeEach(() => { localStorage.clear(); handoff.end = null; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

describe("a copy's door keeps the listing it stands for", () => {
    it('Ask to join keeps the listing at its community, and still goes to the Find card', () => {
        render(<EventCopyDoor copy={{ from: FROM }} />);
        const ask = screen.getByTestId('event-copy-ask');
        expect(ask.getAttribute('href')).toBe('/?ask=byron.example.org');
        // The keep is what the tap does before the browser follows the link (jsdom can't follow it, so it is held here).
        ask.addEventListener('click', (e) => e.preventDefault());
        fireEvent.click(ask);
        expect(keptLinkedPostAt('byron.example.org')).toBe(POST);
    });

    it('a copy that names no listing keeps nothing', () => {
        render(<EventCopyDoor copy={{ from: { ...FROM, postId: null } }} />);
        const ask = screen.getByTestId('event-copy-ask');
        ask.addEventListener('click', (e) => e.preventDefault());
        fireEvent.click(ask);
        expect(localStorage.length).toBe(0);
    });
});

describe("the yes's Join carries it to the community's page", () => {
    it('in the address, beside the handoff: an id and nothing else; forgotten here once the account joined', async () => {
        keepLinkedPost(POST, Date.now(), 'byron.example.org');
        handoff.end = 'joined';
        const open = vi.spyOn(window, 'open').mockReturnValue({ closed: false } as Window);
        render(<YesJoin knock={KNOCK} name={KNOCK.name} identity={ME} testId="t" />);
        fireEvent.click(screen.getByTestId(`t-join-${BYRON}`));
        const url = new URL(String(open.mock.calls[0][0]));
        expect(url.origin).toBe(BYRON);
        expect(url.searchParams.get('door')).toBe('handoff');
        expect(url.searchParams.get('listing')).toBe(POST);
        expect(url.href).not.toContain(ME.privateKey);
        await screen.findByTestId(`t-joined-${BYRON}`);
        expect(keptLinkedPostAt('byron.example.org')).toBeNull();
    });

    it('a Join that could not open the page keeps it for the next tap', async () => {
        keepLinkedPost(POST, Date.now(), 'byron.example.org');
        const open = vi.spyOn(window, 'open').mockReturnValue(null);
        render(<YesJoin knock={KNOCK} name={KNOCK.name} identity={ME} testId="t" />);
        fireEvent.click(screen.getByTestId(`t-join-${BYRON}`));
        await screen.findByTestId(`t-fallback-${BYRON}`);
        expect(new URL(String(open.mock.calls[0][0])).searchParams.get('listing')).toBe(POST);
        expect(keptLinkedPostAt('byron.example.org')).toBe(POST);
    });

    it('no listing kept for that community: the address is the handoff alone', () => {
        keepLinkedPost(POST, Date.now(), 'mullum.example.org');
        const open = vi.spyOn(window, 'open').mockReturnValue(null);
        render(<YesJoin knock={KNOCK} name={KNOCK.name} identity={ME} testId="t" />);
        fireEvent.click(screen.getByTestId(`t-join-${BYRON}`));
        expect(new URL(String(open.mock.calls[0][0])).searchParams.has('listing')).toBe(false);
        expect(keptLinkedPostAt('mullum.example.org')).toBe(POST);
    });
});

/**
 * Home's Find card opened on the community a stranger came to ask to join (`/?ask=<host>`, front doors S15): named from
 * the global community's own list, with Ask to join it right here (front doors S2: before, "open Find a community in the
 * BeanPool app"), and never a link back to the community's address (the card they came from, whose Ask to join brought
 * them here).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { t } from '@beanpool/core';
import { AskedCommunity } from './AskedCommunity';
import { KNOCK_MESSAGES } from '../lib/knock';
import type { BeanPoolIdentity } from '../lib/identity';

const ME: BeanPoolIdentity = { publicKey: 'a'.repeat(64), privateKey: '00'.repeat(32), callsign: 'Ana', createdAt: '2026-01-01T00:00:00.000Z' } as BeanPoolIdentity;
const notAsked = () => false;

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubList(communities: unknown[]) {
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        asked.push(String(input));
        if (String(input).endsWith('/api/join/knock')) return json(201, { knock: { status: 'pending' } });
        return json(200, { communities, total: communities.length });
    }));
    return asked;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('the asked community on the Find card', () => {
    it('is looked up by its host and named, with Ask to join it here, and no link to its address', async () => {
        const asked = stubList([{ key: 'k1', name: 'Castlemaine BeanPool', url: 'https://castlemaine.beanpool.org', memberCount: 9 }]);
        const { container } = render(<AskedCommunity host="castlemaine.beanpool.org" identity={ME} asked={notAsked} onClose={() => {}} />);
        expect(await screen.findByRole('button', { name: 'Ask to join Castlemaine BeanPool' })).toBeTruthy();
        expect(screen.getByText('Castlemaine BeanPool')).toBeTruthy();
        expect(screen.getByText('9 members')).toBeTruthy();
        expect(asked.some(p => p.endsWith('/api/global/communities?host=castlemaine.beanpool.org&limit=1'))).toBe(true);
        expect(container.querySelector('a')).toBeNull();
        // The S15 stand-in is gone: the web asks by itself now.
        expect(screen.queryByText(/open Find a community in the BeanPool app/)).toBeNull();
    });

    it('Ask to join → the form → "You asked to join", sent to that community and nowhere else', async () => {
        const asked = stubList([{ key: 'k1', name: 'Castlemaine BeanPool', url: 'https://castlemaine.beanpool.org', memberCount: 9 }]);
        const onAsked = vi.fn();
        render(<AskedCommunity host="castlemaine.beanpool.org" identity={ME} asked={notAsked} onAsked={onAsked} onClose={() => {}} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Ask to join Castlemaine BeanPool' }));
        fireEvent.change(screen.getByLabelText('A few words about yourself'), { target: { value: 'I live in Chewton.' } });
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        expect(await screen.findByRole('status')).toHaveTextContent(t(KNOCK_MESSAGES.waiting));
        expect(asked.filter(p => p.endsWith('/api/join/knock'))).toEqual(['https://castlemaine.beanpool.org/api/join/knock']);
        expect(onAsked).toHaveBeenCalledTimes(1);
    });

    it('already asked from this browser: no second Ask to join', async () => {
        stubList([{ key: 'k1', name: 'Castlemaine BeanPool', url: 'https://castlemaine.beanpool.org', memberCount: 9 }]);
        render(<AskedCommunity host="castlemaine.beanpool.org" identity={ME} asked={url => url === 'https://castlemaine.beanpool.org'} onClose={() => {}} />);
        await screen.findByText('9 members');
        expect(screen.queryByRole('button', { name: /Ask to join/ })).toBeNull();
    });

    it('not in the list (yet): its host, and what to do', async () => {
        stubList([]);
        render(<AskedCommunity host="new.example.org" identity={ME} asked={notAsked} onClose={() => {}} />);
        expect(await screen.findByText("new.example.org isn't in the list of communities yet. Try again in an hour, or ask one of its members for an invite.")).toBeTruthy();
        expect(screen.queryByRole('button', { name: /Ask to join/ })).toBeNull();
    });

    it('its ✕ puts the Find card back as usual', async () => {
        stubList([]);
        const onClose = vi.fn();
        render(<AskedCommunity host="new.example.org" identity={ME} asked={notAsked} onClose={onClose} />);
        fireEvent.click(screen.getByTestId('home-find-asked-close'));
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});

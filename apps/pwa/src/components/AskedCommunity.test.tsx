/**
 * Home's Find card opened on the community a stranger came to ask to join (`/?ask=<host>`, front doors S15): named from
 * the global community's own list, with how to ask it today, and never a link back to the community's address (the
 * card they came from, whose Ask to join brought them here).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AskedCommunity } from './AskedCommunity';

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubList(communities: unknown[]) {
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        asked.push(String(input));
        return json(200, { communities, total: communities.length });
    }));
    return asked;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the asked community on the Find card', () => {
    it('is looked up by its host and named, with how to ask it, and no link to its address', async () => {
        const asked = stubList([{ key: 'k1', name: 'Castlemaine BeanPool', url: 'https://castlemaine.beanpool.org', memberCount: 9 }]);
        const { container } = render(<AskedCommunity host="castlemaine.beanpool.org" onClose={() => {}} />);
        expect(await screen.findByText('To ask Castlemaine BeanPool to join, open Find a community in the BeanPool app and choose Castlemaine BeanPool.')).toBeTruthy();
        expect(screen.getByText('Castlemaine BeanPool')).toBeTruthy();
        expect(screen.getByText('9 members')).toBeTruthy();
        expect(asked.some(p => p.endsWith('/api/global/communities?host=castlemaine.beanpool.org&limit=1'))).toBe(true);
        expect(container.querySelector('a')).toBeNull();
    });

    it('not in the list (yet): its host, and what to do', async () => {
        stubList([]);
        render(<AskedCommunity host="new.example.org" onClose={() => {}} />);
        expect(await screen.findByText("new.example.org isn't in the list of communities yet. Try again in an hour, or ask one of its members for an invite.")).toBeTruthy();
    });

    it('its ✕ puts the Find card back as usual', async () => {
        stubList([]);
        const onClose = vi.fn();
        render(<AskedCommunity host="new.example.org" onClose={onClose} />);
        fireEvent.click(screen.getByTestId('home-find-asked-close'));
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});

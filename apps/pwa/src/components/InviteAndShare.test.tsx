import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

/**
 * "Invite and share" on a listing, on the web (components/InviteAndShare.tsx): who is offered the button, what a tap makes
 * (the node's invite, and nothing on it about vouching: the reset, R0), what is handed to the share sheet (the listing's
 * title and `{community}/?invite={code}&post={id}`), and what it never makes (an offline ticket). Fake node: the api is
 * stubbed and nothing leaves the test.
 */

const { generateInvite, getBalance, request, communityInfoOnce, loadIdentity } = vi.hoisted(() => ({
    generateInvite: vi.fn(), getBalance: vi.fn(), request: vi.fn(), communityInfoOnce: vi.fn(), loadIdentity: vi.fn(),
}));

vi.mock('../lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/api')>();
    return { ...actual, generateInvite, getBalance, request };
});
vi.mock('../lib/visitor-lobby-gate', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/visitor-lobby-gate')>();
    return { ...actual, communityInfoOnce };
});
vi.mock('../lib/identity', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/identity')>();
    return { ...actual, loadIdentity };
});

import { useInviteAndShare } from './InviteAndShare';

/**
 * The Invite and share part on its own, as the Share menu draws it (components/SharePost.tsx useShare): its choice and
 * the sentence under it, then what it leaves under the row. It is offered here as core's shareSays offers it, so what
 * is proved is the part's OWN gate (the community's invites, the door, the member's key and role). The menu around it,
 * and shareSays' rows, are proved in SharePost.test.tsx and ShareMenu.test.tsx.
 */
function InviteOnly({ post }: { post: { id: string; title: string } }) {
    const part = useInviteAndShare(post, true);
    if (!part) return null;
    const c = part.choice;
    return (
        <>
            <button type="button" data-testid={c.testId} aria-expanded={c.expanded} onClick={c.onSelect}>{c.label}</button>
            <span data-testid={c.lineTestId}>{c.line}</span>
            {part.after}
        </>
    );
}

const POST = { id: '3f2b8c1e-5d4a-4e7b-9a10-0c6d2e8f1a34', title: 'Ladder for borrowing' };
const IDENTITY = { publicKey: 'pk-me', privateKey: 'sk', callsign: 'Ana', createdAt: '2026-09-27T00:00:00.000Z' };
const ORIGIN = window.location.origin;
const shares: Array<{ title?: string; text?: string; url?: string }> = [];

async function open(info: unknown = { features: { invites: true, door: 'members' } }, opts: { role?: string | null } = {}) {
    communityInfoOnce.mockResolvedValue(info);
    request.mockResolvedValue({ role: opts.role ?? null });
    render(<InviteOnly post={POST} />);
    await waitFor(() => expect(communityInfoOnce).toHaveBeenCalled());
}
const tap = (id: string) => fireEvent.click(screen.getByTestId(id));

beforeEach(() => {
    shares.length = 0;
    generateInvite.mockReset(); getBalance.mockReset(); request.mockReset(); communityInfoOnce.mockReset(); loadIdentity.mockReset();
    loadIdentity.mockResolvedValue(IDENTITY);
    (navigator as any).share = vi.fn(async (d: any) => { shares.push(d); });
});
afterEach(() => { cleanup(); delete (navigator as any).share; });

describe('who is offered the button', () => {
    it('a member where the community takes invites: the button, and the line that says one invite is for one person', async () => {
        await open();
        await waitFor(() => expect(screen.getByTestId('invite-and-share-button')).toBeTruthy());
        expect(screen.getByTestId('invite-and-share-button').textContent).toBe('Invite and share');
        expect(screen.getByTestId('invite-and-share-line').textContent).toBe('One invite, for one person: a code works once.');
    });

    it('no button where the community takes no invites, or with no key', async () => {
        await open({ features: { invites: false } });
        await new Promise((r) => setTimeout(r, 20));
        expect(screen.queryByTestId('invite-and-share-button')).toBeNull();
        cleanup();
        loadIdentity.mockResolvedValue(null);
        await open();
        await new Promise((r) => setTimeout(r, 20));
        expect(screen.queryByTestId('invite-and-share-button')).toBeNull();
    });

    it('where only admins invite: a plain member has none (and asked for their role), an admin has it', async () => {
        await open({ features: { invites: true, door: 'admins' } }, { role: null });
        await waitFor(() => expect(request).toHaveBeenCalledWith('GET', '/api/node-admin/me'));
        await new Promise((r) => setTimeout(r, 20));
        expect(screen.queryByTestId('invite-and-share-button')).toBeNull();
        cleanup();
        await open({ features: { invites: true, door: 'admins' } }, { role: 'admin' });
        await waitFor(() => expect(screen.getByTestId('invite-and-share-button')).toBeTruthy());
    });
});

describe('what a tap makes and hands over', () => {
    it('the node\'s invite, shared with the listing\'s title and the link that lands on it', async () => {
        generateInvite.mockResolvedValue({ success: true, invite: { code: 'INV-AB12-CD34' } });
        await open();
        await waitFor(() => screen.getByTestId('invite-and-share-button'));
        tap('invite-and-share-button');
        expect(screen.getByTestId('invite-and-share-panel').textContent).toContain('lands on this listing');
        // Nothing is made until the member says so.
        expect(generateInvite).not.toHaveBeenCalled();
        tap('invite-and-share-make');
        await waitFor(() => expect(shares).toHaveLength(1));
        expect(generateInvite).toHaveBeenCalledWith('pk-me');
        expect(shares[0]).toEqual({ title: POST.title, text: POST.title, url: `${ORIGIN}/?invite=INV-AB12-CD34&post=${POST.id}` });
        expect(screen.queryByTestId('invite-and-share-panel')).toBeNull();
    });

    it('nothing on it says vouch (the reset, R0): on a community with Beans the panel has no choice, the invite carries only the key, and no balance is asked', async () => {
        generateInvite.mockResolvedValue({ success: true, invite: { code: 'INV-AB12-CD34' } });
        await open({ features: { invites: true, beans: true, door: 'members' } });
        await waitFor(() => screen.getByTestId('invite-and-share-button'));
        tap('invite-and-share-button');
        expect(screen.getByTestId('invite-and-share-panel')).toBeTruthy();
        expect(screen.queryByRole('radio')).toBeNull();
        expect(document.body.textContent).not.toMatch(/vouch/i);
        tap('invite-and-share-make');
        await waitFor(() => expect(shares).toHaveLength(1));
        expect(generateInvite).toHaveBeenCalledWith('pk-me');
        expect(getBalance).not.toHaveBeenCalled();
        expect(document.body.textContent).not.toMatch(/vouch/i);
    });
});

describe('what it never makes', () => {
    it('with no answer from the node: no ticket, nothing shared, the member is told', async () => {
        generateInvite.mockRejectedValue(new TypeError('Failed to fetch'));
        await open();
        await waitFor(() => screen.getByTestId('invite-and-share-button'));
        tap('invite-and-share-button');
        tap('invite-and-share-make');
        await waitFor(() => expect(screen.getByTestId('invite-and-share-note').textContent).toContain('needs a connection'));
        expect(shares).toEqual([]);
    });

    it('a refusal says the community\'s words and shares nothing', async () => {
        generateInvite.mockRejectedValue(Object.assign(new Error('Only admins invite here.'), { status: 403, code: 'admins_only' }));
        await open();
        await waitFor(() => screen.getByTestId('invite-and-share-button'));
        tap('invite-and-share-button');
        tap('invite-and-share-make');
        await waitFor(() => expect(screen.getByTestId('invite-and-share-note').textContent).toBe('Only admins invite here.'));
        expect(shares).toEqual([]);
    });

    it('a link that could be neither shared nor copied is shown to copy by hand, never lost', async () => {
        generateInvite.mockResolvedValue({ success: true, invite: { code: 'INV-AB12-CD34' } });
        delete (navigator as any).share;
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => { throw new Error('denied'); }) }, configurable: true });
        (document as any).execCommand = vi.fn(() => false);
        await open();
        await waitFor(() => screen.getByTestId('invite-and-share-button'));
        tap('invite-and-share-button');
        tap('invite-and-share-make');
        await waitFor(() => expect(screen.getByTestId('invite-and-share-link')).toBeTruthy());
        expect((screen.getByTestId('invite-and-share-link') as HTMLInputElement).value).toBe(`${ORIGIN}/?invite=INV-AB12-CD34&post=${POST.id}`);
        expect(screen.getByTestId('invite-and-share-note').textContent).toBe('Could not copy the link.');
    });
});

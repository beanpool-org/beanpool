/**
 * The web's "Invited by" and "Brought in n people ›" (components/InvitedByCard.tsx; DESIGN-invites-vouching-review-fable.md
 * slice I3), with the phone's words (core invitedByLines): parity with apps/native utils/__tests__/invited-by-card-render.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const tree = vi.hoisted(() => ({ calls: [] as (string | undefined)[], body: [] as any[] }));
vi.mock('../lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/api')>();
    return { ...actual, getInviteTree: vi.fn(async (root?: string) => { tree.calls.push(root); return tree.body; }) };
});
vi.mock('./MemberAvatar', () => ({ MemberAvatar: () => <span data-testid="avatar" /> }));

import { InvitedByCard } from './InvitedByCard';

const MIA = 'a1'.repeat(32);
const OLIVE = 'b2'.repeat(32);
const member = (role: 'owner' | 'admin' | null) => ({ kind: 'member' as const, publicKey: OLIVE, callsign: 'Olive', avatarUrl: null, tier: 'Elder', role });
const GONE = ['Invited directly by the system admin', 'Vetted by the admin at sign-up'];

describe('InvitedByCard (web)', () => {
    beforeEach(() => { tree.calls = []; tree.body = []; });

    it('names the inviter with the role word, and opens their profile', () => {
        const open = vi.fn();
        const { container, rerender } = render(<InvitedByCard vouchedInBy={member('owner')} isSelf={false} targetPubkey={MIA} onOpenProfile={open} />);
        expect(container.textContent).toContain('🌱 Invited by Olive · owner');
        fireEvent.click(screen.getByRole('button', { name: /Invited by Olive/ }));
        expect(open).toHaveBeenCalledWith(OLIVE);
        rerender(<InvitedByCard vouchedInBy={member('admin')} isSelf={false} targetPubkey={MIA} />);
        expect(container.textContent).toContain('🌱 Invited by Olive · admin');
        rerender(<InvitedByCard vouchedInBy={member(null)} isSelf={false} targetPubkey={MIA} />);
        expect(container.textContent).toContain('🌱 Invited by Olive');
        expect(container.textContent).not.toContain('· owner');
        rerender(<InvitedByCard vouchedInBy={member('owner')} isSelf targetPubkey={MIA} />);
        expect(container.textContent).toContain('🌱 You were invited by Olive · owner');
    });

    it('a card and the founder name nobody; the old sentences never show', () => {
        const { container, rerender } = render(<InvitedByCard vouchedInBy={{ kind: 'card', publicKey: null, callsign: null, avatarUrl: null, tier: null, role: null }} isSelf={false} targetPubkey={MIA} />);
        expect(container.textContent).toContain('Invited with an owner’s invite card');
        for (const g of GONE) expect(container.textContent).not.toContain(g);
        rerender(<InvitedByCard vouchedInBy={{ kind: 'founder', publicKey: null, callsign: null, avatarUrl: null, tier: null, role: null }} isSelf={false} targetPubkey={MIA} />);
        expect(container.textContent).toContain('Founding member');
        for (const g of GONE) expect(container.textContent).not.toContain(g);
    });

    it('nothing when the server sent neither line', () => {
        const { container } = render(<InvitedByCard vouchedInBy={null} isSelf={false} targetPubkey={MIA} />);
        expect(container.querySelector('[data-testid="profile-invited-by"]')).toBeNull();
    });

    it('Brought in: only when sent, closed at first, opens to the branch', async () => {
        const { container, rerender } = render(<InvitedByCard vouchedInBy={member(null)} isSelf={false} targetPubkey={MIA} />);
        expect(container.textContent).not.toContain('Brought in');
        tree.body = [{ publicKey: MIA, callsign: 'Mia', children: [
            { publicKey: 'c3'.repeat(32), callsign: 'Ben', joinedAt: '2026-10-01T00:00:00.000Z', status: 'active', children: [] },
            { publicKey: 'd4'.repeat(32), callsign: 'Gil', joinedAt: '2026-09-01T00:00:00.000Z', status: 'pruned', children: [] },
        ] }];
        rerender(<InvitedByCard vouchedInBy={null} broughtIn={2} isSelf targetPubkey={MIA} />);
        const row = screen.getByTestId('profile-brought-in');
        expect(row.textContent).toContain('Brought in 2 people ›');
        expect(row.getAttribute('aria-expanded')).toBe('false');
        expect(tree.calls).toEqual([]);
        fireEvent.click(row);
        await waitFor(() => expect(container.textContent).toContain('Ben'));
        expect(tree.calls).toEqual([MIA]);
        expect(container.textContent).toContain('Still here');
        expect(container.textContent).toContain('No longer a member');
    });
});

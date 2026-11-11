import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AdminLoginCard } from './AdminLoginCard';
import * as nodeClaim from '../../lib/node-claim';
import { STANDBY_RECOVER_COMMAND } from '../../lib/node-claim';

// A node has no admin password: the card is the phone sign-in alone (PhoneSignIn), the claim card while the node has no
// owner, and a note on a standby. The claim check (useClaimState) is answered here without a request, so each test sees
// only what the card itself asks. AdminLoginCard.claim.test.tsx covers the check itself, with the real route.
vi.mock('../../lib/node-claim', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../lib/node-claim')>()),
    fetchClaimState: vi.fn(async () => ({ kind: 'claimed' })),
    fetchCommunityInfo: vi.fn(async () => ({ primaryAddress: null, addresses: [] })),
}));

// The phone sign-in's own behaviour is PhoneSignIn.test.tsx's; here it is a stand-in that can hand a session up.
vi.mock('./PhoneSignIn', () => ({
    PhoneSignIn: ({ onSignedIn, ...rest }: { onSignedIn: (s: { memberPubkey: string; role: 'owner' }, csrf: string) => void }) => (
        <section data-testid="phone-signin-stub" data-props={Object.keys(rest).join(',')}>
            <button type="button" onClick={() => onSignedIn({ memberPubkey: 'f'.repeat(64), role: 'owner' }, 'csrf-abc')}>stub: phone approves</button>
        </section>
    ),
}));

// The claim card draws a QR; its picture does not matter here.
vi.mock('../../lib/qr', () => ({ generateOfflineQrUrl: (text: string) => `data:text/plain,${encodeURIComponent(text)}` }));

describe('AdminLoginCard component', () => {
    const onKeySession = vi.fn();
    const nodeUrl = 'http://localhost:3000';

    beforeEach(() => {
        vi.clearAllMocks();
        sessionStorage.clear();
        localStorage.clear();
        vi.mocked(nodeClaim.fetchClaimState).mockResolvedValue({ kind: 'claimed' });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    /** Every key and value this origin's web storage holds. */
    function storedText(): string {
        const out: string[] = [];
        for (const store of [sessionStorage, localStorage]) {
            for (let i = 0; i < store.length; i++) {
                const key = store.key(i)!;
                out.push(`${key}=${store.getItem(key)}`);
            }
        }
        return out.join('\n');
    }

    it('renders the Node Settings title and the phone sign-in', () => {
        render(<AdminLoginCard nodeUrl={nodeUrl} onKeySession={onKeySession} />);
        expect(screen.getByText('Node Settings')).toBeInTheDocument();
        expect(screen.getByTestId('phone-signin')).toContainElement(screen.getByTestId('phone-signin-stub'));
    });

    it('draws no password form: no password field, no Unlock Settings button, no 2FA field, no fold', async () => {
        const { container } = render(<AdminLoginCard nodeUrl={nodeUrl} onKeySession={onKeySession} />);
        // After the claim check has answered too, not only before it.
        await waitFor(() => expect(nodeClaim.fetchClaimState).toHaveBeenCalled());
        expect(screen.queryByPlaceholderText('Password')).toBeNull();
        expect(screen.queryByPlaceholderText(/6-digit code/)).toBeNull();
        expect(screen.queryByRole('button', { name: /Unlock Settings/i })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Show' })).toBeNull();
        expect(screen.queryByTestId('admin-password-field')).toBeNull();
        expect(screen.queryByTestId('claim-password-fold')).toBeNull();
        expect(container.querySelector('form')).toBeNull();
        expect(container.querySelector('input')).toBeNull();
        expect(container.querySelector('details')).toBeNull();
        expect(container.textContent).not.toMatch(/admin password/i);
    });

    it('gives PhoneSignIn nothing but its way to hand a session up (no "use the password" option)', () => {
        render(<AdminLoginCard nodeUrl={nodeUrl} onKeySession={onKeySession} />);
        expect(screen.getByTestId('phone-signin-stub').getAttribute('data-props')).toBe('');
    });

    it('hands the key session and its CSRF token up when the phone signs in', () => {
        render(<AdminLoginCard nodeUrl={nodeUrl} onKeySession={onKeySession} />);
        fireEvent.click(screen.getByRole('button', { name: 'stub: phone approves' }));
        expect(onKeySession).toHaveBeenCalledTimes(1);
        expect(onKeySession).toHaveBeenCalledWith({ memberPubkey: 'f'.repeat(64), role: 'owner' }, 'csrf-abc');
        expect(storedText()).not.toContain('csrf-abc');
    });

    it('makes no sign-in request of its own: it asks the node nothing but the claim check', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        render(<AdminLoginCard nodeUrl={nodeUrl} onKeySession={onKeySession} />);
        await waitFor(() => expect(nodeClaim.fetchClaimState).toHaveBeenCalled());
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('where the caller cannot take a key session (fleet mode), draws no sign-in and says what to use', () => {
        render(<AdminLoginCard nodeUrl={nodeUrl} />);
        expect(screen.queryByTestId('phone-signin-stub')).toBeNull();
        expect(screen.getByTestId('phone-signin')).toHaveTextContent("Open this server's own /settings page to sign in with your phone, or use an automation token.");
        expect(screen.queryByPlaceholderText('Password')).toBeNull();
    });

    it('on a standby with no owner of its own, says how an owner makes one, above the phone sign-in', async () => {
        vi.mocked(nodeClaim.fetchClaimState).mockResolvedValue({ kind: 'claimed', standby: true });
        render(<AdminLoginCard nodeUrl={nodeUrl} onKeySession={onKeySession} />);
        const note = await screen.findByTestId('standby-signin-note');
        expect(note).toHaveTextContent(STANDBY_RECOVER_COMMAND);
        expect(note.compareDocumentPosition(screen.getByTestId('phone-signin')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(screen.getByTestId('phone-signin-stub')).toBeInTheDocument();
    });

    it('says nothing of a standby on a node with an owner', async () => {
        render(<AdminLoginCard nodeUrl={nodeUrl} onKeySession={onKeySession} />);
        await waitFor(() => expect(nodeClaim.fetchClaimState).toHaveBeenCalled());
        expect(screen.queryByTestId('standby-signin-note')).toBeNull();
    });

    it('on an unclaimed node, shows the claim card instead of the phone sign-in', async () => {
        vi.mocked(nodeClaim.fetchClaimState).mockResolvedValue({
            kind: 'unclaimed', codeId: 'a1b2c3d4', communityName: 'Test Town', primaryAddress: null, address: null, addresses: [],
        });
        render(<AdminLoginCard nodeUrl={nodeUrl} onKeySession={onKeySession} />);
        expect(await screen.findByTestId('claim-card')).toBeInTheDocument();
        expect(screen.queryByTestId('phone-signin-stub')).toBeNull();
        expect(screen.queryByPlaceholderText('Password')).toBeNull();
        expect(screen.queryByTestId('claim-password-fold')).toBeNull();
    });
});

import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NodeProfile } from '../../lib/profiles';

vi.mock('../../lib/node-client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../lib/node-client')>();
    return { ...actual, fetchNodeRoles: vi.fn(async () => []), getTfaSessionToken: vi.fn(() => undefined) };
});

import { setKeySessionCsrfToken } from '../../lib/node-client';
import { SignOutEverywhere, SIGN_OUT_EVERYWHERE_WARNING } from './SignOutEverywhere';
import { NodeRolesPanel, type RolesViewer } from './NodeRolesPanel';

const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
const click = async (el: HTMLElement) => { await act(async () => { fireEvent.click(el); }); };

describe('SignOutEverywhere (Settings, a key session)', () => {
    const fetchMock = vi.fn();
    beforeEach(() => {
        fetchMock.mockReset();
        vi.stubGlobal('fetch', fetchMock);
        setKeySessionCsrfToken('csrf-1');
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        setKeySessionCsrfToken(null);
    });

    it('asks first, in plain words, and Cancel sends nothing', async () => {
        const onSignedOut = vi.fn();
        render(<SignOutEverywhere onSignedOut={onSignedOut} />);
        expect(screen.queryByText(SIGN_OUT_EVERYWHERE_WARNING)).toBeNull();
        await click(screen.getByRole('button', { name: 'Sign out everywhere' }));
        expect(screen.getByText(SIGN_OUT_EVERYWHERE_WARNING)).toBeInTheDocument();
        await click(screen.getByRole('button', { name: 'Cancel' }));
        expect(fetchMock).not.toHaveBeenCalled();
        expect(onSignedOut).not.toHaveBeenCalled();
    });

    it("on yes, asks the node to end the caller's own sessions (no one named), then shows the sign-in screen", async () => {
        fetchMock.mockResolvedValue(reply(200, { success: true, memberPubkey: 'a1', sessionEpoch: 2, breakGlassCodeRetired: true }));
        const onSignedOut = vi.fn();
        render(<SignOutEverywhere onSignedOut={onSignedOut} />);
        await click(screen.getByRole('button', { name: 'Sign out everywhere' }));
        await click(screen.getByRole('button', { name: 'Yes, sign me out everywhere' }));
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/local/admin/auth/revoke-all');
        expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', body: '{}' });
        expect(init.headers['X-CSRF-Token']).toBe('csrf-1');
        expect(init.headers['X-Admin-Password']).toBeUndefined();
        expect(init.headers['Authorization']).toBeUndefined();
        expect(onSignedOut).toHaveBeenCalledTimes(1);
    });

    it.each([
        [401, { error: 'Unauthorized: valid admin session or signature required' }, /Unauthorized: valid admin session or signature required\. Sign in again/],
        [403, { error: 'Invalid or expired CSRF token' }, /^Invalid or expired CSRF token$/],
        [500, {}, /did not sign you out \(500\)/],
    ])('a %i shows the node\'s words (or a plain line) and never claims success', async (status, body, words) => {
        fetchMock.mockResolvedValue(reply(status, body));
        const onSignedOut = vi.fn();
        render(<SignOutEverywhere onSignedOut={onSignedOut} />);
        await click(screen.getByRole('button', { name: 'Sign out everywhere' }));
        await click(screen.getByRole('button', { name: 'Yes, sign me out everywhere' }));
        expect(screen.getByRole('alert').textContent).toMatch(words);
        expect(onSignedOut).not.toHaveBeenCalled();
    });

    it('a 200 that does not say success is not taken as one', async () => {
        fetchMock.mockResolvedValue(reply(200, {}));
        const onSignedOut = vi.fn();
        render(<SignOutEverywhere onSignedOut={onSignedOut} />);
        await click(screen.getByRole('button', { name: 'Sign out everywhere' }));
        await click(screen.getByRole('button', { name: 'Yes, sign me out everywhere' }));
        expect(onSignedOut).not.toHaveBeenCalled();
        expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    it('a network failure says so plainly, and does not sign this browser out', async () => {
        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
        const onSignedOut = vi.fn();
        render(<SignOutEverywhere onSignedOut={onSignedOut} />);
        await click(screen.getByRole('button', { name: 'Sign out everywhere' }));
        await click(screen.getByRole('button', { name: 'Yes, sign me out everywhere' }));
        expect(screen.getByRole('alert').textContent).toMatch(/Could not reach the node, so you may still be signed in elsewhere/);
        expect(onSignedOut).not.toHaveBeenCalled();
    });
});

describe('Owners & admins offers it only to a key session', () => {
    const node: NodeProfile = { id: 'local-node', name: 'Test', url: 'https://node.test', adminPassword: 'pw' };
    const renderPanel = async (viewer: RolesViewer, onSignedOutEverywhere?: () => void) => {
        await act(async () => {
            render(<NodeRolesPanel activeNode={node} members={[]} viewer={viewer} onSignedOutEverywhere={onSignedOutEverywhere} />);
        });
    };

    it('the password (and every fleet profile, which Settings shows as the password) never sees it', async () => {
        await renderPanel({ kind: 'password' }, vi.fn());
        expect(screen.queryByRole('button', { name: 'Sign out everywhere' })).toBeNull();
    });

    it('a key session sees it', async () => {
        await renderPanel({ kind: 'key', memberPubkey: 'a1'.repeat(32), role: 'admin' }, vi.fn());
        expect(screen.getByRole('button', { name: 'Sign out everywhere' })).toBeInTheDocument();
    });

    it('not without somewhere to go afterwards (App passes it only for a key session outside fleet mode)', async () => {
        await renderPanel({ kind: 'key', memberPubkey: 'a1'.repeat(32), role: 'owner' });
        expect(screen.queryByRole('button', { name: 'Sign out everywhere' })).toBeNull();
    });
});

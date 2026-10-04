import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App } from './App';

/**
 * A node answering as if this browser holds a live password session (the httpOnly cookie the password sign-in sets):
 * /auth/session says so, /csrf-token gives its token. `onAdmin` sees every other request.
 */
function stubPasswordSession(onAdmin?: (url: string, opts?: any) => unknown) {
    const fetchMock = vi.fn().mockImplementation((url: string, opts?: any) => {
        if (String(url).includes('/api/local/admin/auth/session')) {
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ authenticated: true, isKeySession: false, isPasswordSession: true, role: 'owner', memberPubkey: null }),
            });
        }
        if (String(url).includes('/api/local/admin/csrf-token')) {
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ csrfToken: 'csrf-session' }) });
        }
        const custom = onAdmin?.(String(url), opts);
        if (custom) return custom;
        return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ success: true, health: { flags: [] }, reports: [] }),
        });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

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

describe('App Component', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
            if (url.includes('/api/local/admin/gateway')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () =>
                        Promise.resolve({
                            features: { marketplace: true, messaging: true },
                            corsAllowedOrigins: ['*'],
                            rateLimiting: { enabled: true },
                        }),
                });
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ success: true, health: { flags: [] }, reports: [] }),
            });
        }));
    });

    describe('Fleet Mode (isFleetMode = true)', () => {
        it('renders App with FleetSidebar and default Overview module', async () => {
            await act(async () => {
                render(<App isFleetMode={true} />);
            });

            expect(screen.getByText('BeanPool')).toBeInTheDocument();
            expect(screen.getByText('Fleet Manager v1.2')).toBeInTheDocument();
            expect(screen.getAllByRole('button', { name: /fleet telemetry/i }).length).toBeGreaterThanOrEqual(1);
            expect(document.title).toBe('BeanPool Fleet Manager — Control Plane');
            expect(document.title).toContain('Fleet');
            const favicon = document.querySelector("link[rel~='icon']");
            if (favicon) {
                expect(favicon.getAttribute('aria-label')).toBeNull();
            }
        });

        it('switches tabs when tab navigation buttons are clicked', async () => {
            await act(async () => {
                render(<App isFleetMode={true} />);
            });

            const gatewayTab = screen.getByRole('button', { name: /gateway security/i });
            await act(async () => {
                fireEvent.click(gatewayTab);
            });

            expect(screen.getByText('Target Control Node:')).toBeInTheDocument();
        });

        it('opens Add Node modal when clicking + Add Node button in sidebar', async () => {
            await act(async () => {
                render(<App isFleetMode={true} />);
            });

            const addButton = screen.getByRole('button', { name: /\+ add node/i });
            await act(async () => {
                fireEvent.click(addButton);
            });

            expect(screen.getByText('Connect Sovereign Node')).toBeInTheDocument();
        });

        it('navigates to members tab and renders members management in Fleet Mode', async () => {
            await act(async () => {
                render(<App isFleetMode={true} />);
            });

            const membersTab = screen.getByRole('button', { name: /trust & members/i });
            await act(async () => {
                fireEvent.click(membersTab);
            });

            expect(screen.getByText(/Community Treasuries & Enterprises/i)).toBeInTheDocument();
        });
    });

    describe('Single Node Mode (isFleetMode = false)', () => {
        it('renders AdminLoginCard when unauthenticated', async () => {
            sessionStorage.clear();
            await act(async () => {
                render(<App isFleetMode={false} />);
            });

            expect(screen.getByText('Node Settings')).toBeInTheDocument();
            expect(screen.getByPlaceholderText('Password')).toBeInTheDocument();
            expect(screen.getByRole('button', { name: /unlock settings/i })).toBeInTheDocument();
            expect(screen.getByText('Switch to Legacy Settings Page')).toHaveAttribute('href', '/settings-legacy');
            expect(document.title).not.toContain('Fleet');
            expect(document.title).not.toMatch(/fleet/i);
            expect(document.title).toBe('BeanPool — Node Settings');
        });

        /**
         * Queue item 26 (2026-10-04): an Android Custom Tab brought back to the front loads the app's new link into the
         * /settings page it still shows (signed out by a node restart or the phone idle). Only the fragment changes, so
         * nothing reloads: the page must read the link from the hashchange, not leave the password form up.
         */
        it('a phone link that reaches the page already open (fragment change only) signs in, or says why not', async () => {
            sessionStorage.clear();
            window.history.replaceState(null, '', '/settings');
            await act(async () => {
                render(<App isFleetMode={false} />);
            });
            expect(screen.getByPlaceholderText('Password')).toBeInTheDocument();

            let exchange: 'ok' | 'expired' = 'ok';
            const fetchMock = vi.fn().mockImplementation((url: string) => {
                if (String(url).includes('/api/local/admin/auth/exchange')) {
                    return Promise.resolve(exchange === 'ok'
                        ? { ok: true, status: 200, json: () => Promise.resolve({ success: true, role: 'owner', memberPubkey: 'ab'.repeat(32), csrfToken: 'csrf-link' }) }
                        : { ok: false, status: 401, json: () => Promise.resolve({ error: 'x', expired: true }) });
                }
                if (String(url).includes('/api/local/admin/auth/session')) {
                    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ authenticated: false }) });
                }
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, health: { flags: [] }, reports: [] }) });
            });
            vi.stubGlobal('fetch', fetchMock);

            // A spent link first: said, in plain words, above the password form.
            exchange = 'expired';
            await act(async () => {
                window.history.replaceState(null, '', `/settings#handoff=${'c'.repeat(64)}&section=home&from=app`);
                window.dispatchEvent(new HashChangeEvent('hashchange'));
            });
            expect(screen.getByRole('alert')).toHaveTextContent(/sign-in link from your phone has expired.*Tap Manage again/);
            expect(window.location.hash).toBe('');

            // A fresh one: signed in, no password asked.
            exchange = 'ok';
            await act(async () => {
                window.history.replaceState(null, '', `/settings#handoff=${'d'.repeat(64)}&section=home&from=app`);
                window.dispatchEvent(new HashChangeEvent('hashchange'));
            });
            expect(screen.queryByPlaceholderText('Password')).not.toBeInTheDocument();
            expect(screen.getByRole('button', { name: /people & safety/i })).toBeInTheDocument();
            const posted = fetchMock.mock.calls.filter(([u]) => String(u).includes('/auth/exchange')).map(([, o]) => JSON.parse(o.body).token);
            expect(posted).toEqual(['c'.repeat(64), 'd'.repeat(64)]);
        });

        it('verifies document title does not contain "Fleet" in single-node mode', async () => {
            stubPasswordSession();
            await act(async () => {
                render(<App isFleetMode={false} />);
            });
            expect(document.title).not.toContain('Fleet');
            expect(document.title).not.toMatch(/fleet/i);
        });

        it('renders single-node shell with HomeScreen when authenticated', async () => {
            stubPasswordSession();
            await act(async () => {
                render(<App isFleetMode={false} />);
            });

            expect(screen.getByText('BeanPool')).toBeInTheDocument();
            expect(screen.getByText('Node Settings')).toBeInTheDocument();
            expect(screen.getByRole('button', { name: /home/i })).toBeInTheDocument();
            expect(screen.getByRole('button', { name: /people & safety/i })).toBeInTheDocument();
            expect(screen.getByRole('button', { name: /shared projects & economy/i })).toBeInTheDocument();
            expect(screen.getByRole('button', { name: /bulletin & news/i })).toBeInTheDocument();
            expect(screen.getByRole('button', { name: /appliance & data/i })).toBeInTheDocument();

            // Home screen elements from settings-ia.md §2
            expect(screen.getByText('Action Required')).toBeInTheDocument();
            expect(screen.getByText('Quick Actions')).toBeInTheDocument();
            expect(screen.getByRole('button', { name: /invite a member/i })).toBeInTheDocument();
            expect(screen.getByRole('button', { name: /create an enterprise/i })).toBeInTheDocument();
            expect(screen.getByRole('button', { name: /run ledger audit/i })).toBeInTheDocument();
            expect(screen.getByRole('button', { name: /download backup/i })).toBeInTheDocument();
        });

        it('navigates across the 4 plain-English sections', async () => {
            stubPasswordSession();
            await act(async () => {
                render(<App isFleetMode={false} />);
            });

            // Navigate to People & Safety
            const peopleTab = screen.getByRole('button', { name: /people & safety/i });
            await act(async () => {
                fireEvent.click(peopleTab);
            });
            expect(screen.getByText(/member directory, trust tiers/i)).toBeInTheDocument();

            // Navigate to Shared Projects & Economy
            const economyTab = screen.getByRole('button', { name: /shared projects & economy/i });
            await act(async () => {
                fireEvent.click(economyTab);
            });
            expect(screen.getByText(/commons pool, shared enterprises/i)).toBeInTheDocument();

            // Navigate to Bulletin & News
            const bulletinTab = screen.getByRole('button', { name: /bulletin & news/i });
            await act(async () => {
                fireEvent.click(bulletinTab);
            });
            expect(screen.getByText(/announcements with severity/i)).toBeInTheDocument();

            // Navigate to Appliance & Data
            const applianceTab = screen.getByRole('button', { name: /appliance & data/i });
            await act(async () => {
                fireEvent.click(applianceTab);
            });
            expect(screen.getByText(/backups & restore wizard/i)).toBeInTheDocument();
        });

        it('logs out: the node ends the session (with its CSRF token) and the sign-in card is back', async () => {
            const fetchMock = stubPasswordSession();
            await act(async () => {
                render(<App isFleetMode={false} />);
            });

            const logoutBtn = screen.getByRole('button', { name: /log out/i });
            await act(async () => {
                fireEvent.click(logoutBtn);
            });

            expect(screen.getByText(/unlock settings/i)).toBeInTheDocument();
            const logout = fetchMock.mock.calls.find((call: any[]) => String(call[0]).includes('/api/local/admin/auth/logout'));
            expect(logout).toBeTruthy();
            expect(logout![1].headers['X-CSRF-Token']).toBe('csrf-session');
            expect(sessionStorage.getItem('bp-admin-token')).toBeNull();
        });

        // Fable's web review, M1: the members' web app shares this origin, so a password kept in its storage is one
        // script away from it. Until 2026-10-01 this test asserted the password and its 2FA session WERE kept in
        // sessionStorage after sign-in.
        it('signing in with the password leaves no admin secret in the origin\'s storage, and no password on later requests', async () => {
            sessionStorage.clear();
            localStorage.clear();
            await act(async () => {
                render(<App isFleetMode={false} />);
            });

            const passInput = screen.getByPlaceholderText('Password');
            const unlockBtn = screen.getByRole('button', { name: /unlock settings/i });

            const adminCalls: Array<{ url: string; headers: Record<string, string> }> = [];
            vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, opts?: any) => {
                if (String(url).includes('/api/local/admin/auth/password')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: () => Promise.resolve({ success: true, role: 'owner', csrfToken: 'csrf-from-signin' }),
                    });
                }
                if (String(url).includes('/api/local/admin/')) adminCalls.push({ url: String(url), headers: opts?.headers || {} });
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({ success: true, health: { flags: [] }, reports: [] }),
                });
            }));

            await act(async () => {
                fireEvent.change(passInput, { target: { value: 'secret-pass-123' } });
                fireEvent.click(unlockBtn);
            });

            expect(screen.getByRole('button', { name: /appliance & data/i })).toBeInTheDocument();
            expect(storedText()).not.toContain('secret-pass-123');
            expect(sessionStorage.getItem('bp-admin-token')).toBeNull();
            expect(sessionStorage.getItem('bp_tfa_session_local-node')).toBeNull();
            expect(sessionStorage.getItem('bp-2fa-session')).toBeNull();
            // Later admin requests ride the cookie, with the session's CSRF token, and never carry the password.
            const auditBtn = screen.getByRole('button', { name: /run ledger audit/i });
            await act(async () => {
                fireEvent.click(auditBtn);
            });
            const audit = adminCalls.find(c => c.url.includes('/api/local/admin/ledger-audit'));
            expect(audit).toBeTruthy();
            expect(audit!.headers['X-Admin-Password']).toBeUndefined();
            expect(audit!.headers['X-CSRF-Token']).toBe('csrf-from-signin');
            expect(adminCalls.length).toBeGreaterThan(0);
            for (const c of adminCalls) expect(JSON.stringify(c.headers)).not.toContain('secret-pass-123');
        });

        it('a session the node has ended (idle, restarted, password changed) sends the operator back to sign-in, saying so', async () => {
            stubPasswordSession((url) => (url.includes('/api/local/admin/diagnostics')
                ? Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ error: 'Session expired (2h idle timeout)', sessionExpired: true }) })
                : undefined));
            await act(async () => {
                render(<App isFleetMode={false} />);
            });
            expect(screen.getByRole('button', { name: /unlock settings/i })).toBeInTheDocument();
            expect(screen.getByRole('alert')).toHaveTextContent(/signed out \(Session expired \(2h idle timeout\)\)\. Sign in again\./);
        });

        // Design step 6 (D3): on a node with 2FA off the password opens the 2FA card and nothing else until a code is
        // confirmed; confirming opens Settings in the same session.
        it('a password sign-in on a node with 2FA off lands on the 2FA card only, saying why; a confirmed code opens Settings', async () => {
            sessionStorage.clear();
            await act(async () => {
                render(<App isFleetMode={false} />);
            });
            const codes = ['aaaa-1111', 'bbbb-2222', 'cccc-3333', 'dddd-4444', 'eeee-5555', 'ffff-6666', 'gggg-7777', 'hhhh-8888'];
            const gatedCalls: string[] = [];
            let confirmed = false;
            vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, opts?: any) => {
                const u = String(url);
                const json = (status: number, body: unknown) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
                if (u.includes('/api/local/admin/auth/password')) {
                    return json(200, { success: true, role: 'owner', csrfToken: 'csrf-gated', totpSetupRequired: true });
                }
                if (u.includes('/api/local/admin/2fa/setup')) {
                    expect(opts?.headers?.['X-CSRF-Token']).toBe('csrf-gated');
                    return json(200, { success: true, secret: 'JBSWY3DPEHPK3PXP', formattedSecret: 'JBSW Y3DP EHPK 3PXP', backupCodes: codes });
                }
                if (u.includes('/api/local/admin/2fa/verify')) {
                    const code = JSON.parse(opts?.body || '{}').code;
                    if (code !== '123456') return json(400, { success: false, error: 'Invalid 6-digit 2FA code — check authenticator app time sync' });
                    confirmed = true;
                    return json(200, { success: true, totpEnabled: true });
                }
                if (u.includes('/api/local/admin/') && !confirmed) {
                    gatedCalls.push(u);
                    return json(403, { error: 'Set up two-factor sign-in to open Settings: the admin password alone is not enough.', code: 'totp_setup_required', totpSetupRequired: true });
                }
                return json(200, { success: true, health: { flags: [] }, reports: [] });
            }));

            await act(async () => {
                fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: 'pw' } });
                fireEvent.click(screen.getByRole('button', { name: /unlock settings/i }));
            });
            expect(screen.getByTestId('totp-setup-gate')).toBeInTheDocument();
            expect(screen.getByText('Set up two-factor sign-in to open Settings: the admin password alone is not enough.')).toBeInTheDocument();
            expect(screen.queryByRole('button', { name: /appliance & data/i })).toBeNull();
            expect(gatedCalls).toEqual([]);

            await act(async () => {
                fireEvent.click(screen.getByRole('button', { name: /set up two-factor sign-in/i }));
            });
            const shown = screen.getByTestId('totp-gate-backup-codes');
            for (const c of codes) expect(shown).toHaveTextContent(c);
            expect(screen.getByTestId('totp-gate-secret')).toHaveTextContent('JBSW Y3DP EHPK 3PXP');

            await act(async () => {
                fireEvent.change(screen.getByLabelText(/type the 6-digit code/i), { target: { value: '000000' } });
                fireEvent.click(screen.getByRole('button', { name: /confirm and open settings/i }));
            });
            expect(screen.getByRole('alert')).toHaveTextContent(/Invalid 6-digit 2FA code/);
            expect(screen.queryByRole('button', { name: /appliance & data/i })).toBeNull();

            await act(async () => {
                fireEvent.change(screen.getByLabelText(/type the 6-digit code/i), { target: { value: '123456' } });
                fireEvent.click(screen.getByRole('button', { name: /confirm and open settings/i }));
            });
            expect(screen.queryByTestId('totp-setup-gate')).toBeNull();
            expect(screen.getByRole('button', { name: /appliance & data/i })).toBeInTheDocument();
            expect(gatedCalls).toEqual([]);
        });

        it('a reload with a password session the node still holds to the 2FA card shows that card, not Settings', async () => {
            const fetchMock = vi.fn().mockImplementation((url: string) => {
                const u = String(url);
                if (u.includes('/api/local/admin/auth/session')) {
                    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ authenticated: true, isKeySession: false, isPasswordSession: true, role: 'owner', memberPubkey: null, totpSetupRequired: true }) });
                }
                if (u.includes('/api/local/admin/csrf-token')) {
                    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ csrfToken: 'csrf-session' }) });
                }
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, health: { flags: [] }, reports: [] }) });
            });
            vi.stubGlobal('fetch', fetchMock);
            await act(async () => {
                render(<App isFleetMode={false} />);
            });
            expect(screen.getByTestId('totp-setup-gate')).toBeInTheDocument();
            expect(screen.queryByRole('button', { name: /appliance & data/i })).toBeNull();
            // Signing out from the card ends the session.
            await act(async () => {
                fireEvent.click(screen.getByRole('button', { name: /sign out/i }));
            });
            expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/local/admin/auth/logout'))).toBe(true);
            expect(screen.getByRole('button', { name: /unlock settings/i })).toBeInTheDocument();
        });

        it('a password session the node starts refusing with totp_setup_required (2FA turned off) is shown the 2FA card', async () => {
            stubPasswordSession((url) => (url.includes('/api/local/admin/diagnostics')
                ? Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({ error: 'Set up two-factor sign-in to open Settings: the admin password alone is not enough.', code: 'totp_setup_required', totpSetupRequired: true }) })
                : undefined));
            await act(async () => {
                render(<App isFleetMode={false} />);
            });
            expect(screen.getByTestId('totp-setup-gate')).toBeInTheDocument();
        });

        it('what an older build stored (the password, its 2FA session, a profile password) is removed on load and never sent', async () => {
            sessionStorage.clear();
            localStorage.clear();
            localStorage.setItem('bp_fleet_profiles', JSON.stringify([{
                id: 'local-node',
                name: 'Local Sovereign Node',
                url: 'http://localhost',
                adminPassword: 'stale-password-from-storage',
                replicationToken: 'stale-replication-token',
            }]));
            sessionStorage.setItem('bp-admin-token', 'old-build-password');
            sessionStorage.setItem('bp-2fa-session', 'old-2fa-session');
            sessionStorage.setItem('bp_tfa_session_local-node', 'old-2fa-session');

            let lastAdminHeaders: Record<string, string> = {};
            stubPasswordSession((url, opts) => {
                if (url.includes('/api/local/admin/ledger-audit')) {
                    lastAdminHeaders = opts?.headers || {};
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ success: true, ok: true, drift: 0 }),
                    });
                }
                return undefined;
            });

            await act(async () => {
                render(<App isFleetMode={false} />);
            });

            for (const secret of ['stale-password-from-storage', 'stale-replication-token', 'old-build-password', 'old-2fa-session']) {
                expect(storedText()).not.toContain(secret);
            }

            const auditBtn = screen.getByRole('button', { name: /run ledger audit/i });
            await act(async () => {
                fireEvent.click(auditBtn);
            });

            expect(lastAdminHeaders['X-Admin-Password']).toBeUndefined();
            expect(lastAdminHeaders['X-Admin-2FA-Session']).toBeUndefined();
            expect(lastAdminHeaders['X-CSRF-Token']).toBe('csrf-session');
        });

        /**
         * The onboarding funnel is an owner/admin screen: the server keeps
         * /api/local/admin/onboarding-funnel out of MODERATOR_ROUTES
         * (apps/server/src/admin-auth.ts), so a moderator's session is answered 403 before the route runs. Settings
         * must not offer them a tab that can only fail, and it hides it the way it hides every other owner screen:
         * a moderator key session gets ModeratorView instead of the sections, never People & Safety.
         */
        it('hides the Onboarding Funnel from a moderator session, with the rest of People & Safety', async () => {
            sessionStorage.clear();
            localStorage.clear();
            vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
                if (String(url).includes('/api/local/admin/auth/session')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: () => Promise.resolve({
                            authenticated: true,
                            isKeySession: true,
                            role: 'moderator',
                            memberPubkey: 'ab'.repeat(32),
                        }),
                    });
                }
                if (String(url).includes('/api/local/admin/csrf-token')) {
                    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ csrfToken: 'csrf-mod' }) });
                }
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({ success: true, health: { flags: [] }, reports: [], pendingCount: 0 }),
                });
            }));

            await act(async () => {
                render(<App isFleetMode={false} />);
            });

            expect(screen.queryByRole('button', { name: /^Onboarding Funnel$/ })).not.toBeInTheDocument();
            expect(document.querySelector('[data-subtab="funnel"]')).toBeNull();
            // Not a special case for this one tab: the whole section is gone, and so is any way to reach it.
            expect(screen.queryByRole('button', { name: /people & safety/i })).not.toBeInTheDocument();
            expect(screen.queryByText(/member directory, trust tiers/i)).not.toBeInTheDocument();
            // No funnel request was even attempted under that session.
            const tried = (globalThis.fetch as any).mock.calls.filter(([u]: [string]) => String(u).includes('onboarding-funnel'));
            expect(tried).toHaveLength(0);
        });
    });
});

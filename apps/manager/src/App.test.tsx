import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App } from './App';

/**
 * A node answering as if this browser holds a live key session (the httpOnly cookie a phone sign-in sets):
 * /auth/session says so, /csrf-token gives its token. `onAdmin` sees every other request.
 */
/** The pages the console reads after the node's summary (members, then posts): one member, so the node is not a brand-new one. */
function pagedAnswer(url: string) {
    const page = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    if (url.endsWith('/api/local/admin/data/members')) return page({ members: [{ publicKey: 'aa'.repeat(32), callsign: 'Ana', isTreasury: false }], profiles: [], memberStats: {}, nextCursor: null, total: 1 });
    if (url.endsWith('/api/local/admin/data/posts')) return page({ posts: [], nextCursor: null });
    return null;
}

/**
 * The phone sign-in's own requests (a pairing, then a poll the node holds open), answered so the card shows its QR. The
 * card is the page's only sign-in now, so it asks whenever the page shows it; a bare `{ success: true }` here would make it
 * say the node did not answer, in an alert of its own beside the page's notices.
 */
function pairingAnswer(url: string): Promise<unknown> | null {
    const u = String(url);
    if (/\/api\/local\/admin\/auth\/pairing$/.test(u)) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ pairingId: 'a'.repeat(64), shortCode: 'K7F3QX', ttlMs: 120_000 }) });
    }
    if (/\/api\/local\/admin\/auth\/pairing\/[0-9a-f]{64}\/wait$/.test(u)) return new Promise(() => { /* held open, as the node does */ });
    return null;
}

function stubKeySession(onAdmin?: (url: string, opts?: any) => unknown) {
    const fetchMock = vi.fn().mockImplementation((url: string, opts?: any) => {
        const pairing = pairingAnswer(url);
        if (pairing) return pairing;
        if (String(url).includes('/api/local/admin/auth/session')) {
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ authenticated: true, isKeySession: true, role: 'owner', memberPubkey: 'ab'.repeat(32) }),
            });
        }
        if (String(url).includes('/api/local/admin/csrf-token')) {
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ csrfToken: 'csrf-session' }) });
        }
        const custom = onAdmin?.(String(url), opts);
        if (custom) return custom;
        const paged = pagedAnswer(String(url));
        if (paged) return paged;
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
            const paged = pagedAnswer(url);
            if (paged) return paged;
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

        it("a saved tab that no longer exists (the retired copilot's) opens the Overview instead of nothing", async () => {
            localStorage.setItem('bp_fleet_active_tab', 'ai');
            await act(async () => {
                render(<App isFleetMode={true} />);
            });
            expect(localStorage.getItem('bp_fleet_active_tab')).toBe('overview');
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
            // The phone is the only sign-in: no password field, no Unlock button, no 2FA field.
            expect(screen.getByRole('heading', { name: 'Sign in with your phone' })).toBeInTheDocument();
            expect(screen.queryByPlaceholderText('Password')).not.toBeInTheDocument();
            expect(screen.queryByRole('button', { name: /unlock settings/i })).not.toBeInTheDocument();
            expect(screen.queryByPlaceholderText(/6-digit code/)).not.toBeInTheDocument();
            // The old static Settings page is gone (design case 18, D9): no link to it.
            expect(screen.queryByText(/legacy settings/i)).not.toBeInTheDocument();
            expect(document.querySelector('a[href="/settings-legacy"]')).toBeNull();
            expect(document.title).not.toContain('Fleet');
            expect(document.title).not.toMatch(/fleet/i);
            expect(document.title).toBe('BeanPool — Node Settings');
        });

        /**
         * Queue item 26 (2026-10-04): an Android Custom Tab brought back to the front loads the app's new link into the
         * /settings page it still shows (signed out by a node restart or the phone idle). Only the fragment changes, so
         * nothing reloads: the page must read the link from the hashchange, not leave the sign-in screen up.
         */
        it('a phone link that reaches the page already open (fragment change only) signs in, or says why not', async () => {
            sessionStorage.clear();
            window.history.replaceState(null, '', '/settings');
            vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => pairingAnswer(url)
                ?? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ authenticated: false }) })));
            await act(async () => {
                render(<App isFleetMode={false} />);
            });
            expect(screen.getByRole('heading', { name: 'Sign in with your phone' })).toBeInTheDocument();

            let exchange: 'ok' | 'expired' = 'ok';
            const fetchMock = vi.fn().mockImplementation((url: string) => {
                const pairing = pairingAnswer(url);
                if (pairing) return pairing;
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

            // A spent link first: said, in plain words, above the phone sign-in, with no word of a password to fall back on.
            exchange = 'expired';
            await act(async () => {
                window.history.replaceState(null, '', `/settings#handoff=${'c'.repeat(64)}&section=home&from=app`);
                window.dispatchEvent(new HashChangeEvent('hashchange'));
            });
            expect(screen.getByRole('alert')).toHaveTextContent(/sign-in link from your phone has expired.*Tap Manage again/);
            expect(screen.getByRole('alert')).not.toHaveTextContent(/password/i);
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

        /**
         * PR #1592 review (r4176289097): a refused phone link must not quietly open an earlier sign-in still live in the
         * browser. The same key's: carried on, and said on the page. Anyone else's: not opened; named, with Sign out.
         */
        it("a refused phone link carries on the same account's live sign-in with a note, and never opens someone else's", async () => {
            sessionStorage.clear();
            let live = { memberPubkey: 'ab'.repeat(32), callsign: 'Ada' };
            const fetchMock = vi.fn().mockImplementation((url: string) => {
                const pairing = pairingAnswer(url);
                if (pairing) return pairing;
                if (String(url).includes('/api/local/admin/auth/exchange')) {
                    return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ error: 'x', replay: true, mintedFor: 'ab'.repeat(32) }) });
                }
                if (String(url).includes('/api/local/admin/auth/session')) {
                    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ authenticated: true, isKeySession: true, role: 'owner', ...live }) });
                }
                if (String(url).includes('/api/local/admin/csrf-token')) {
                    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ csrfToken: 'csrf-live' }) });
                }
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, health: { flags: [] }, reports: [] }) });
            });
            vi.stubGlobal('fetch', fetchMock);

            // Same key: signed in, and the page says the link itself wasn't used.
            window.history.replaceState(null, '', `/settings#handoff=${'c'.repeat(64)}&section=home&from=app`);
            await act(async () => {
                render(<App isFleetMode={false} />);
            });
            expect(screen.getByRole('button', { name: /people & safety/i })).toBeInTheDocument();
            expect(screen.getByText(/link from your phone was already used.*same account/i)).toBeInTheDocument();

            // Another key: the earlier session is not opened; who it is, and Sign out.
            live = { memberPubkey: 'cd'.repeat(32), callsign: 'Bea' };
            await act(async () => {
                window.history.replaceState(null, '', `/settings#handoff=${'d'.repeat(64)}&section=home&from=app`);
                window.dispatchEvent(new HashChangeEvent('hashchange'));
            });
            expect(screen.queryByRole('button', { name: /people & safety/i })).not.toBeInTheDocument();
            expect(screen.getByRole('alert')).toHaveTextContent("You're still signed in here as Bea — not the account your phone just sent. Sign out, then tap Manage again.");
            await act(async () => {
                fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
            });
            const logout = fetchMock.mock.calls.find(([u]) => String(u).includes('/api/local/admin/auth/logout'));
            expect(logout?.[1]?.headers?.['X-CSRF-Token']).toBe('csrf-live');
            expect(screen.getByRole('heading', { name: 'Sign in with your phone' })).toBeInTheDocument();
            expect(screen.queryByPlaceholderText('Password')).not.toBeInTheDocument();
            expect(screen.getByRole('alert')).toHaveTextContent(/Signed out\. Tap Manage again/);
        });

        it('verifies document title does not contain "Fleet" in single-node mode', async () => {
            stubKeySession();
            await act(async () => {
                render(<App isFleetMode={false} />);
            });
            expect(document.title).not.toContain('Fleet');
            expect(document.title).not.toMatch(/fleet/i);
        });

        it('renders single-node shell with HomeScreen when authenticated', async () => {
            stubKeySession();
            await act(async () => {
                render(<App isFleetMode={false} />);
            });
            await screen.findByText('Action Required');

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

        it.each([
            ['a locked file', 'yes', 'bpsealed', 'downloadedAt'],
            ['an unlocked file (no recovery code yet: no keys)', 'no', 'tar.gz', 'downloadedPlainAt'],
        ])('a download of %s is noted for "Ready for the hall", in this browser, under its own kind', async (_what, locked, ext, key) => {
            const blob = new Blob(['backup']);
            stubKeySession((url) => (url.endsWith('/api/local/admin/backup')
                ? Promise.resolve({
                    ok: true,
                    status: 200,
                    blob: () => Promise.resolve(blob),
                    headers: new Headers({ 'Content-Disposition': `attachment; filename="beanpool.${ext}"`, 'X-Backup-Locked': locked }),
                })
                : undefined));
            vi.stubGlobal('alert', vi.fn());
            URL.createObjectURL = vi.fn(() => 'blob:backup');
            URL.revokeObjectURL = vi.fn();
            await act(async () => {
                render(<App isFleetMode={false} />);
            });
            await screen.findByText('Action Required');
            await act(async () => {
                fireEvent.click(screen.getByRole('button', { name: /download backup/i }));
            });
            const notes = Object.entries(localStorage)
                .filter(([k]) => k.startsWith('bp_hall_ready:'))
                .map(([, v]) => JSON.parse(v));
            expect(notes).toHaveLength(1);
            expect(Object.keys(notes[0])).toEqual([key]);
            expect(Math.abs(notes[0][key] - Date.now())).toBeLessThan(60_000);
        });

        it('a download that fails is not noted', async () => {
            stubKeySession((url) => (url.endsWith('/api/local/admin/backup')
                ? Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }), headers: new Headers() })
                : undefined));
            vi.stubGlobal('alert', vi.fn());
            await act(async () => {
                render(<App isFleetMode={false} />);
            });
            await screen.findByText('Action Required');
            await act(async () => {
                fireEvent.click(screen.getByRole('button', { name: /download backup/i }));
            });
            expect(Object.keys(localStorage).filter((k) => k.startsWith('bp_hall_ready:'))).toEqual([]);
        });

        it('navigates across the 4 plain-English sections', async () => {
            stubKeySession();
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
            const fetchMock = stubKeySession();
            await act(async () => {
                render(<App isFleetMode={false} />);
            });

            const logoutBtn = screen.getByRole('button', { name: /log out/i });
            await act(async () => {
                fireEvent.click(logoutBtn);
            });

            expect(screen.getByRole('heading', { name: 'Sign in with your phone' })).toBeInTheDocument();
            expect(screen.queryByText(/unlock settings/i)).not.toBeInTheDocument();
            const logout = fetchMock.mock.calls.find((call: any[]) => String(call[0]).includes('/api/local/admin/auth/logout'));
            expect(logout).toBeTruthy();
            expect(logout![1].headers['X-CSRF-Token']).toBe('csrf-session');
            expect(sessionStorage.getItem('bp-admin-token')).toBeNull();
        });

        // Fable's web review, M1: the members' web app shares this origin, so a credential kept in its storage is one
        // script away from it. A phone sign-in keeps nothing there: the session is an httpOnly cookie, and its CSRF
        // token lives in memory only.
        it('signing in with the phone leaves no sign-in secret in the origin\'s storage, and no password on later requests', async () => {
            sessionStorage.clear();
            localStorage.clear();
            window.history.replaceState(null, '', '/settings');
            await act(async () => {
                render(<App isFleetMode={false} />);
            });
            expect(screen.queryByPlaceholderText('Password')).not.toBeInTheDocument();

            const adminCalls: Array<{ url: string; headers: Record<string, string> }> = [];
            vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, opts?: any) => {
                if (String(url).includes('/api/local/admin/auth/exchange')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: () => Promise.resolve({ success: true, role: 'owner', memberPubkey: 'ab'.repeat(32), csrfToken: 'csrf-from-signin' }),
                    });
                }
                if (String(url).includes('/api/local/admin/')) adminCalls.push({ url: String(url), headers: opts?.headers || {} });
                const paged = pagedAnswer(String(url));
                if (paged) return paged;
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({ success: true, health: { flags: [] }, reports: [] }),
                });
            }));

            await act(async () => {
                window.history.replaceState(null, '', `/settings#handoff=${'e'.repeat(64)}&section=home&from=app`);
                window.dispatchEvent(new HashChangeEvent('hashchange'));
            });

            expect(screen.getByRole('button', { name: /appliance & data/i })).toBeInTheDocument();
            for (const secret of ['csrf-from-signin', 'e'.repeat(64)]) expect(storedText()).not.toContain(secret);
            expect(sessionStorage.getItem('bp-admin-token')).toBeNull();
            expect(sessionStorage.getItem('bp_tfa_session_local-node')).toBeNull();
            expect(sessionStorage.getItem('bp-2fa-session')).toBeNull();
            // Later admin requests ride the cookie, with the session's CSRF token, and never carry a password or a token.
            const auditBtn = screen.getByRole('button', { name: /run ledger audit/i });
            await act(async () => {
                fireEvent.click(auditBtn);
            });
            const audit = adminCalls.find(c => c.url.includes('/api/local/admin/ledger-audit'));
            expect(audit).toBeTruthy();
            expect(audit!.headers['X-Admin-Password']).toBeUndefined();
            expect(audit!.headers['X-Admin-2FA-Session']).toBeUndefined();
            expect(audit!.headers['Authorization']).toBeUndefined();
            expect(audit!.headers['X-CSRF-Token']).toBe('csrf-from-signin');
            expect(adminCalls.length).toBeGreaterThan(0);
            for (const c of adminCalls) expect(JSON.stringify(c.headers)).not.toMatch(/X-Admin-Password|X-Admin-2FA-Session|Authorization/i);
        });

        it('a session the node has ended (idle or restarted) sends the operator back to sign-in, saying so', async () => {
            stubKeySession((url) => (url.includes('/api/local/admin/diagnostics')
                ? Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ error: 'Session expired (2h idle timeout)', sessionExpired: true }) })
                : undefined));
            await act(async () => {
                render(<App isFleetMode={false} />);
            });
            expect(screen.getByRole('heading', { name: 'Sign in with your phone' })).toBeInTheDocument();
            expect(screen.queryByRole('button', { name: /unlock settings/i })).not.toBeInTheDocument();
            expect(screen.getByRole('alert')).toHaveTextContent(/signed out \(Session expired \(2h idle timeout\)\)\. Sign in again\./);
        });

        // A node has no admin password and no 2FA: a cookie that is not a key session is never resumed, and there is no
        // 2FA card to land on.
        it('a /auth/session answer that is not a key session is never resumed: the phone sign-in shows, not Settings', async () => {
            const fetchMock = vi.fn().mockImplementation((url: string) => {
                const u = String(url);
                if (u.includes('/api/local/admin/auth/session')) {
                    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ authenticated: true, isKeySession: false, isPasswordSession: true, role: 'owner', memberPubkey: null }) });
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
            expect(screen.getByRole('heading', { name: 'Sign in with your phone' })).toBeInTheDocument();
            expect(screen.queryByRole('button', { name: /appliance & data/i })).toBeNull();
            expect(screen.queryByTestId('totp-setup-gate')).toBeNull();
            // It did not even ask for a CSRF token to carry on with that session.
            expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/local/admin/csrf-token'))).toBe(false);
        });

        it('a refusal that once sent the operator to the 2FA card is just a refusal now: there is no 2FA card', async () => {
            stubKeySession((url) => (url.includes('/api/local/admin/diagnostics')
                ? Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({ error: 'Set up two-factor sign-in to open Settings.', code: 'totp_setup_required', totpSetupRequired: true }) })
                : undefined));
            await act(async () => {
                render(<App isFleetMode={false} />);
            });
            expect(screen.queryByTestId('totp-setup-gate')).toBeNull();
            expect(screen.queryByRole('button', { name: /set up two-factor sign-in/i })).toBeNull();
        });

        it('what an older build stored in a fleet profile (a password, a replication token) is removed on load and never sent', async () => {
            sessionStorage.clear();
            localStorage.clear();
            localStorage.setItem('bp_fleet_profiles', JSON.stringify([{
                id: 'local-node',
                name: 'Local Sovereign Node',
                url: 'http://localhost',
                adminPassword: 'stale-password-from-storage',
                replicationToken: 'stale-replication-token',
            }]));

            let lastAdminHeaders: Record<string, string> = {};
            stubKeySession((url, opts) => {
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
            await screen.findByText('Action Required');

            for (const secret of ['stale-password-from-storage', 'stale-replication-token']) {
                expect(storedText()).not.toContain(secret);
            }

            const auditBtn = screen.getByRole('button', { name: /run ledger audit/i });
            await act(async () => {
                fireEvent.click(auditBtn);
            });

            expect(lastAdminHeaders['X-Admin-Password']).toBeUndefined();
            expect(lastAdminHeaders['X-Admin-2FA-Session']).toBeUndefined();
            expect(lastAdminHeaders['Authorization']).toBeUndefined();
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

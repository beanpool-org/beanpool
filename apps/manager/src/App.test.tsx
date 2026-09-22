import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App } from './App';

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

        it('verifies document title does not contain "Fleet" in single-node mode', async () => {
            sessionStorage.setItem('bp-admin-token', 'mock-password');
            await act(async () => {
                render(<App isFleetMode={false} />);
            });
            expect(document.title).not.toContain('Fleet');
            expect(document.title).not.toMatch(/fleet/i);
        });

        it('renders single-node shell with HomeScreen when authenticated', async () => {
            sessionStorage.setItem('bp-admin-token', 'mock-password');
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
            sessionStorage.setItem('bp-admin-token', 'mock-password');
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

        it('logs out and clears session token', async () => {
            sessionStorage.setItem('bp-admin-token', 'mock-password');
            await act(async () => {
                render(<App isFleetMode={false} />);
            });

            const logoutBtn = screen.getByRole('button', { name: /log out/i });
            await act(async () => {
                fireEvent.click(logoutBtn);
            });

            expect(screen.getByText(/unlock settings/i)).toBeInTheDocument();
            expect(sessionStorage.getItem('bp-admin-token')).toBeNull();
        });

        it('authenticating via AdminLoginCard in single-node mode keeps credentials in session storage without writing password to localStorage', async () => {
            sessionStorage.clear();
            localStorage.clear();
            await act(async () => {
                render(<App isFleetMode={false} />);
            });

            const passInput = screen.getByPlaceholderText('Password');
            const unlockBtn = screen.getByRole('button', { name: /unlock settings/i });

            vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
                if (url.includes('/api/local/verify-password')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: () => Promise.resolve({ success: true, sessionToken: 'tfa-session-xyz' }),
                    });
                }
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

            expect(screen.getByText('Node Settings')).toBeInTheDocument();
            expect(sessionStorage.getItem('bp-admin-token')).toBe('secret-pass-123');
            expect(sessionStorage.getItem('bp_tfa_session_local-node')).toBe('tfa-session-xyz');
            const profilesRaw = localStorage.getItem('bp_fleet_profiles');
            if (profilesRaw) {
                const profiles = JSON.parse(profilesRaw);
                expect(profiles.some((p: any) => p.adminPassword === 'secret-pass-123')).toBe(false);
            }
        });

        it('prioritizes session adminToken over stale localStorage profile password in single-node mode', async () => {
            sessionStorage.clear();
            localStorage.clear();
            // Pre-seed localStorage with a stale password
            localStorage.setItem('bp_fleet_profiles', JSON.stringify([{
                id: 'local-node',
                name: 'Local Sovereign Node',
                url: 'http://localhost',
                adminPassword: 'stale-password-from-storage',
            }]));
            sessionStorage.setItem('bp-admin-token', 'fresh-authenticated-password');

            let lastAdminHeaders: Record<string, string> = {};
            vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, opts?: any) => {
                if (url.includes('/api/local/admin/ledger-audit')) {
                    lastAdminHeaders = opts?.headers || {};
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ success: true, ok: true, drift: 0 }),
                    });
                }
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ success: true, health: { flags: [] }, reports: [] }),
                });
            }));

            await act(async () => {
                render(<App isFleetMode={false} />);
            });

            const auditBtn = screen.getByRole('button', { name: /run ledger audit/i });
            await act(async () => {
                fireEvent.click(auditBtn);
            });

            expect(lastAdminHeaders['X-Admin-Password']).toBe('fresh-authenticated-password');
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

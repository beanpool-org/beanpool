import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NodeIdentityPanel } from './NodeIdentityPanel';
import type { NodeProfile } from '../../lib/profiles';
import type { DiagnosticsResponse } from '../../lib/node-client';

const mockProfile: NodeProfile = {
    id: 'test-node',
    name: 'Test Node',
    url: 'https://test-node.local',
    adminPassword: 'test-admin-password',
};

const mockDiag: DiagnosticsResponse = {
    status: 'healthy',
    uptimeSeconds: 7200,
    totalMemoryMb: 1024,
    callsign: 'mullum-callsign',
    communityName: 'Mullumbimby Commons',
    cpuLoadPercent: 10,
    memoryUsageMb: 120,
    dbSizeBytes: 1024 * 1024,
    walSizeBytes: 512,
    activeWsConnections: 3,
    p2pActivePeers: 1,
};

describe('NodeIdentityPanel Component', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
            if (url.includes('/api/local/community-info')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({
                        communityName: 'Hydrated Community',
                        contactEmail: 'contact@hydrated.org',
                        contactPhone: '+61 400 000 000',
                        callsign: 'hydrated-callsign',
                    }),
                });
            }
            if (url.includes('/api/node/config')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({
                        publishLocation: true,
                        publishMembers: true,
                        publishContacts: false,
                        publishHealth: true,
                        directoryPushIntervalHours: 6,
                        lastDirectoryPush: 1700000000000,
                        serviceRadius: { lat: -28.55, lng: 153.50, radiusKm: 25 },
                    }),
                });
            }
            if (url.includes('/api/local/update-identity')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ success: true }),
                });
            }
            if (url.includes('/api/local/admin/node/config')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ success: true }),
                });
            }
            if (url.includes('/api/local/admin/directory/push')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ success: true, timestamp: 1710000000000 }),
                });
            }
            if (url.includes('nominatim.openstreetmap.org')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve([
                        {
                            display_name: 'Byron Bay, NSW, Australia',
                            lat: '-28.6474',
                            lon: '153.6120',
                            type: 'town',
                        },
                    ]),
                });
            }
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ success: true }),
            });
        }));
    });

    it('renders all node identity fields, Leaflet map, service radius, and directory publishing controls', async () => {
        await act(async () => {
            render(
                <NodeIdentityPanel
                    activeNode={mockProfile}
                    diag={mockDiag}
                    onRefreshDiag={vi.fn()}
                />
            );
        });

        // Heading & description
        expect(screen.getByText('Node Identity')).toBeInTheDocument();
        expect(screen.getByText(/Update the public identity, geographic location/i)).toBeInTheDocument();

        // Callsign & Community Name
        const callsignInput = screen.getByLabelText(/Callsign \(Short Name\)/i);
        expect(callsignInput).toBeInTheDocument();
        expect(callsignInput).toHaveAttribute('maxLength', '20');
        expect(screen.getByLabelText(/Community Name/i)).toBeInTheDocument();

        // Location search & Leaflet Map container
        expect(screen.getByPlaceholderText(/Search for a location.../i)).toBeInTheDocument();
        expect(document.getElementById('settings-map')).toBeInTheDocument();

        // Radius slider & KM input
        const radiusSlider = document.getElementById('radius-slider') as HTMLInputElement;
        const radiusKmInput = document.getElementById('radius-km') as HTMLInputElement;
        expect(radiusSlider).toBeInTheDocument();
        expect(radiusSlider).toHaveAttribute('max', '500');
        expect(radiusSlider).toHaveAttribute('aria-label', 'Service radius slider in kilometers');
        expect(radiusKmInput).toBeInTheDocument();
        expect(radiusKmInput).toHaveAttribute('max', '500');
        expect(radiusKmInput).toHaveAttribute('aria-label', 'Service radius in kilometers');

        // Directory publishing & preview link
        expect(screen.getByRole('heading', { level: 4, name: 'Directory Publishing' })).toBeInTheDocument();
        const previewLink = screen.getByRole('link', { name: /preview public output/i });
        expect(previewLink).toHaveAttribute('href', expect.stringContaining('/api/directory/info'));
        expect(previewLink).toHaveAttribute('target', '_blank');

        // Schedule select & publish now button
        expect(document.getElementById('directory-push-interval')).toBeInTheDocument();
        expect(document.getElementById('publish-now-btn')).toBeInTheDocument();

        // Checkboxes
        expect(document.getElementById('publish-location')).toBeInTheDocument();
        expect(document.getElementById('publish-members')).toBeInTheDocument();
        expect(document.getElementById('publish-contacts')).toBeInTheDocument();
        expect(document.getElementById('publish-health')).toBeInTheDocument();

        // Community contacts
        expect(screen.getByRole('heading', { level: 4, name: 'Community Contacts' })).toBeInTheDocument();
        expect(screen.getByLabelText(/Contact Email/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/Contact Phone/i)).toBeInTheDocument();

        // Save button
        expect(screen.getByRole('button', { name: /save identity/i })).toBeInTheDocument();
    });

    it('hydrates initial values correctly from /api/local/community-info and /api/node/config', async () => {
        await act(async () => {
            render(
                <NodeIdentityPanel
                    activeNode={mockProfile}
                    diag={mockDiag}
                    onRefreshDiag={vi.fn()}
                />
            );
        });

        // Wait for async load to finish populating
        await waitFor(() => {
            expect(screen.getByDisplayValue('Hydrated Community')).toBeInTheDocument();
            expect(screen.getByDisplayValue('hydrated-callsign')).toBeInTheDocument();
            expect(screen.getByDisplayValue('contact@hydrated.org')).toBeInTheDocument();
            expect(screen.getByDisplayValue('+61 400 000 000')).toBeInTheDocument();
        });

        const radiusInput = document.getElementById('radius-km') as HTMLInputElement;
        expect(radiusInput.value).toBe('25');

        const scheduleSelect = document.getElementById('directory-push-interval') as HTMLSelectElement;
        expect(scheduleSelect.value).toBe('6');

        const publishContactsCheckbox = document.getElementById('publish-contacts') as HTMLInputElement;
        expect(publishContactsCheckbox.checked).toBe(false);
    });

    it('syncs service radius slider and km input', async () => {
        await act(async () => {
            render(
                <NodeIdentityPanel
                    activeNode={mockProfile}
                    diag={mockDiag}
                    onRefreshDiag={vi.fn()}
                />
            );
        });

        const slider = document.getElementById('radius-slider') as HTMLInputElement;
        const kmInput = document.getElementById('radius-km') as HTMLInputElement;

        await act(async () => {
            fireEvent.change(slider, { target: { value: '45' } });
        });
        expect(kmInput.value).toBe('45');

        await act(async () => {
            fireEvent.change(kmInput, { target: { value: '150' } });
        });
        expect(slider.value).toBe('150');
    });

    it('performs nominatim place search and updates coordinates on selection', async () => {
        await act(async () => {
            render(
                <NodeIdentityPanel
                    activeNode={mockProfile}
                    diag={mockDiag}
                    onRefreshDiag={vi.fn()}
                />
            );
        });

        const searchInput = screen.getByPlaceholderText(/Search for a location.../i);
        expect(searchInput).toHaveAttribute('role', 'combobox');
        expect(searchInput).toHaveAttribute('aria-autocomplete', 'list');
        expect(searchInput).toHaveAttribute('aria-expanded', 'false');

        await act(async () => {
            fireEvent.change(searchInput, { target: { value: 'Byron Bay' } });
        });

        // Advance debounce timer (1000ms debounce)
        await act(async () => {
            await new Promise((r) => setTimeout(r, 1100));
        });

        await waitFor(() => {
            expect(screen.getByText('Byron Bay, NSW, Australia')).toBeInTheDocument();
        });
        expect(searchInput).toHaveAttribute('aria-expanded', 'true');
        expect(document.getElementById('location-result-0')).toHaveAttribute('tabindex', '-1');

        const resultItem = screen.getByText('Byron Bay, NSW, Australia');
        await act(async () => {
            fireEvent.click(resultItem);
        });

        expect((document.getElementById('cfg-lat') as HTMLInputElement).value).toBe('-28.6474');
        expect((document.getElementById('cfg-lng') as HTMLInputElement).value).toBe('153.612');
    });

    it('sends the same Nominatim request it always has (now through the shared @beanpool/core lookup)', async () => {
        await act(async () => {
            render(<NodeIdentityPanel activeNode={mockProfile} diag={mockDiag} onRefreshDiag={vi.fn()} />);
        });
        await act(async () => {
            fireEvent.change(screen.getByPlaceholderText(/Search for a location.../i), { target: { value: 'Byron Bay' } });
        });
        await act(async () => {
            await new Promise((r) => setTimeout(r, 1100));
        });
        const calls = (global.fetch as any).mock.calls.filter((c: any[]) => String(c[0]).includes('nominatim'));
        expect(calls).toHaveLength(1);
        expect(calls[0][0]).toBe('https://nominatim.openstreetmap.org/search?format=json&q=Byron%20Bay&limit=5');
        expect(calls[0][1].signal).toBeInstanceOf(AbortSignal);
    });

    it('a failed search stops the spinner and shows no list, as before', async () => {
        vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
            if (url.includes('nominatim.openstreetmap.org')) return Promise.reject(new TypeError('offline'));
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
        }));
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await act(async () => {
                render(<NodeIdentityPanel activeNode={mockProfile} diag={mockDiag} onRefreshDiag={vi.fn()} />);
            });
            const searchInput = screen.getByPlaceholderText(/Search for a location.../i);
            await act(async () => {
                fireEvent.change(searchInput, { target: { value: 'Byron Bay' } });
            });
            expect(screen.getByText('🔄')).toBeInTheDocument();
            await act(async () => {
                await new Promise((r) => setTimeout(r, 1100));
            });
            expect(screen.queryByText('🔄')).not.toBeInTheDocument();
            expect(searchInput).toHaveAttribute('aria-expanded', 'false');
        } finally {
            consoleError.mockRestore();
        }
    });

    it('clears searching spinner when query characters are deleted below threshold', async () => {
        await act(async () => {
            render(
                <NodeIdentityPanel
                    activeNode={mockProfile}
                    diag={mockDiag}
                    onRefreshDiag={vi.fn()}
                />
            );
        });

        const searchInput = screen.getByPlaceholderText(/Search for a location.../i);

        // Type 3 characters: searching spinner appears
        await act(async () => {
            fireEvent.change(searchInput, { target: { value: 'Syd' } });
        });
        expect(screen.getByText('🔄')).toBeInTheDocument();

        // Delete back to 2 characters before debounce completes: searching spinner clears immediately
        await act(async () => {
            fireEvent.change(searchInput, { target: { value: 'Sy' } });
        });
        expect(screen.queryByText('🔄')).not.toBeInTheDocument();
    });

    it('prevents accidental form submission on Enter in location search and supports arrow key navigation', async () => {
        const onRefreshDiag = vi.fn();
        await act(async () => {
            render(
                <NodeIdentityPanel
                    activeNode={mockProfile}
                    diag={mockDiag}
                    onRefreshDiag={onRefreshDiag}
                />
            );
        });

        const searchInput = screen.getByPlaceholderText(/Search for a location.../i);

        // Pressing Enter before searching does not submit form
        await act(async () => {
            fireEvent.keyDown(searchInput, { key: 'Enter', code: 'Enter' });
        });
        expect(onRefreshDiag).not.toHaveBeenCalled();

        await act(async () => {
            fireEvent.change(searchInput, { target: { value: 'Byron Bay' } });
        });

        await act(async () => {
            await new Promise((r) => setTimeout(r, 1100));
        });

        await waitFor(() => {
            expect(screen.getByText('Byron Bay, NSW, Australia')).toBeInTheDocument();
        });

        // Navigate suggestions with ArrowDown and select with Enter
        await act(async () => {
            fireEvent.keyDown(searchInput, { key: 'ArrowDown', code: 'ArrowDown' });
        });
        await act(async () => {
            fireEvent.keyDown(searchInput, { key: 'Enter', code: 'Enter' });
        });

        expect((document.getElementById('cfg-lat') as HTMLInputElement).value).toBe('-28.6474');
        expect((document.getElementById('cfg-lng') as HTMLInputElement).value).toBe('153.612');
        // Form was not submitted
        expect(onRefreshDiag).not.toHaveBeenCalled();
    });

    it('triggers manual directory push when Publish Now button is clicked', async () => {
        await act(async () => {
            render(
                <NodeIdentityPanel
                    activeNode={mockProfile}
                    diag={mockDiag}
                    onRefreshDiag={vi.fn()}
                />
            );
        });

        const publishNowBtn = document.getElementById('publish-now-btn')!;

        await act(async () => {
            fireEvent.click(publishNowBtn);
        });

        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('/api/local/admin/directory/push'),
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ password: mockProfile.adminPassword }),
            })
        );

        await waitFor(() => {
            expect(screen.getByText(/Published!/i)).toBeInTheDocument();
        });
    });

    it('clears the publish status timer on unmount so no state update fires afterwards', async () => {
        const { unmount } = render(
            <NodeIdentityPanel
                activeNode={mockProfile}
                diag={mockDiag}
                onRefreshDiag={vi.fn()}
            />
        );
        await act(async () => {});

        vi.useFakeTimers();
        const consoleError = vi.spyOn(console, 'error');
        try {
            await act(async () => {
                fireEvent.click(document.getElementById('publish-now-btn')!);
            });
            expect(screen.getByText(/Published!/i)).toBeInTheDocument();
            const pendingBeforeUnmount = vi.getTimerCount();
            expect(pendingBeforeUnmount).toBeGreaterThan(0);

            unmount();

            // The 3s reset timer must be gone, not merely harmless.
            expect(vi.getTimerCount()).toBe(0);
            act(() => {
                vi.advanceTimersByTime(5000);
            });
            expect(consoleError).not.toHaveBeenCalled();
        } finally {
            consoleError.mockRestore();
            vi.useRealTimers();
        }
    });

    // The node holds update-identity to 2FA now, like every admin route: the save must carry the 2FA session.
    it('sends the 2FA session with the identity save', async () => {
        sessionStorage.setItem(`bp_tfa_session_${mockProfile.id}`, 'tfa-identity-token');
        try {
            await act(async () => {
                render(<NodeIdentityPanel activeNode={mockProfile} diag={mockDiag} onRefreshDiag={vi.fn()} />);
            });
            await act(async () => {
                fireEvent.click(screen.getByRole('button', { name: /save identity/i }));
            });
            const updateCall = (global.fetch as any).mock.calls.find((call: any[]) =>
                call[0].includes('/api/local/update-identity')
            );
            expect(updateCall).toBeDefined();
            expect(updateCall[1].headers['X-Admin-2FA-Session']).toBe('tfa-identity-token');
            expect(updateCall[1].headers['X-Admin-Password']).toBe(mockProfile.adminPassword);
        } finally {
            sessionStorage.removeItem(`bp_tfa_session_${mockProfile.id}`);
        }
    });

    it('saves identity and node config with full payload parity when submitting form', async () => {
        const onRefreshDiag = vi.fn();
        await act(async () => {
            render(
                <NodeIdentityPanel
                    activeNode={mockProfile}
                    diag={mockDiag}
                    onRefreshDiag={onRefreshDiag}
                />
            );
        });

        // Set inputs
        const callsignInput = screen.getByLabelText(/Callsign \(Short Name\)/i);
        const communityNameInput = screen.getByLabelText(/Community Name/i);
        const contactEmailInput = screen.getByLabelText(/Contact Email/i);
        const contactPhoneInput = screen.getByLabelText(/Contact Phone/i);
        const radiusInput = document.getElementById('radius-km')!;
        const scheduleSelect = document.getElementById('directory-push-interval')!;

        await act(async () => {
            fireEvent.change(callsignInput, { target: { value: 'mullum-prime' } });
            fireEvent.change(communityNameInput, { target: { value: 'Mullumbimby Food Exchange' } });
            fireEvent.change(contactEmailInput, { target: { value: 'admin@mullum.org' } });
            fireEvent.change(contactPhoneInput, { target: { value: '+61 411 222 333' } });
            fireEvent.change(radiusInput, { target: { value: '50' } });
            fireEvent.change(scheduleSelect, { target: { value: '24' } });
        });

        const saveBtn = screen.getByRole('button', { name: /save identity/i });
        await act(async () => {
            fireEvent.click(saveBtn);
        });

        // Check update-identity call
        const updateCall = (global.fetch as any).mock.calls.find((call: any[]) =>
            call[0].includes('/api/local/update-identity')
        );
        expect(updateCall).toBeDefined();
        expect(JSON.parse(updateCall[1].body)).toEqual({
            password: mockProfile.adminPassword,
            callsign: 'mullum-prime',
            lat: -28.55,
            lng: 153.5,
            communityName: 'Mullumbimby Food Exchange',
            contactEmail: 'admin@mullum.org',
            contactPhone: '+61 411 222 333',
        });

        // Check node/config call
        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('/api/local/admin/node/config'),
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    password: mockProfile.adminPassword,
                    publishLocation: true,
                    publishMembers: true,
                    publishContacts: false,
                    publishHealth: true,
                    directoryPushIntervalHours: 24,
                    serviceRadius: { lat: -28.55, lng: 153.5, radiusKm: 50 },
                }),
            })
        );

        await waitFor(() => {
            expect(screen.getByText(/Saved!/i)).toBeInTheDocument();
            const statusEl = document.getElementById('identity-status');
            expect(statusEl).toHaveAttribute('role', 'status');
            expect(statusEl).toHaveAttribute('aria-live', 'polite');
            expect(onRefreshDiag).toHaveBeenCalled();
        });
    });

    it('omits lat and lng from update-identity payload when coordinates are unset', async () => {
        // Mock node config without coordinates
        vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
            if (url.includes('/api/local/community-info')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({
                        communityName: 'Unlocated Node',
                        callsign: 'unlocated',
                    }),
                });
            }
            if (url.includes('/api/node/config')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({
                        publishLocation: true,
                        directoryPushIntervalHours: 12,
                        serviceRadius: null,
                    }),
                });
            }
            if (url.includes('/api/local/update-identity')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ success: true }),
                });
            }
            if (url.includes('/api/local/admin/node/config')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ success: true }),
                });
            }
            return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
        }));

        await act(async () => {
            render(
                <NodeIdentityPanel
                    activeNode={mockProfile}
                    diag={null}
                    onRefreshDiag={vi.fn()}
                />
            );
        });

        const saveBtn = screen.getByRole('button', { name: /save identity/i });
        await act(async () => {
            fireEvent.click(saveBtn);
        });

        const updateCall = (global.fetch as any).mock.calls.find((call: any[]) =>
            call[0].includes('/api/local/update-identity')
        );
        expect(updateCall).toBeDefined();
        const payload = JSON.parse(updateCall[1].body);
        expect(payload).toEqual({
            password: mockProfile.adminPassword,
            callsign: 'unlocated',
            communityName: 'Unlocated Node',
            contactEmail: '',
            contactPhone: '',
        });
        expect('lat' in payload).toBe(false);
        expect('lng' in payload).toBe(false);
    });

    it('displays 2FA session expired error when identity succeeds but config fails with totpRequired', async () => {
        const onRefreshDiag = vi.fn();
        vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
            if (url.includes('/api/local/community-info')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ communityName: 'Test' }),
                });
            }
            if (url.includes('/api/node/config')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({}),
                });
            }
            if (url.includes('/api/local/update-identity')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ success: true }),
                });
            }
            if (url.includes('/api/local/admin/node/config')) {
                return Promise.resolve({
                    ok: false,
                    status: 403,
                    json: () => Promise.resolve({ error: '2FA required', totpRequired: true }),
                });
            }
            return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
        }));

        await act(async () => {
            render(
                <NodeIdentityPanel
                    activeNode={mockProfile}
                    diag={null}
                    onRefreshDiag={onRefreshDiag}
                />
            );
        });

        const saveBtn = screen.getByRole('button', { name: /save identity/i });
        await act(async () => {
            fireEvent.click(saveBtn);
        });

        await waitFor(() => {
            expect(screen.getByText(/2FA session expired. Please re-authenticate./i)).toBeInTheDocument();
            const statusEl = document.getElementById('identity-status');
            expect(statusEl).toHaveAttribute('role', 'alert');
            expect(statusEl).toHaveAttribute('aria-live', 'assertive');
            expect(onRefreshDiag).not.toHaveBeenCalled();
        });
    });

    describe('Bucket 2 Item 5: Service Radius Slider and Number Input', () => {
        it('renders with real payload and synchronizes dual slider and number input on change', async () => {
            const fetchMock = vi.fn().mockImplementation((url: string) => {
                if (url.includes('/api/local/community-info')) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ communityName: 'Byron Hub' }),
                    });
                }
                if (url.includes('/api/node/config')) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({
                            serviceRadius: { lat: -28.64, lng: 153.61, radiusKm: 35 },
                        }),
                    });
                }
                if (url.includes('/api/local/update-identity') || url.includes('/api/local/admin/node/config')) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ success: true }),
                    });
                }
                return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
            });
            vi.stubGlobal('fetch', fetchMock);

            await act(async () => {
                render(
                    <NodeIdentityPanel
                        activeNode={mockProfile}
                        diag={null}
                        onRefreshDiag={vi.fn()}
                    />
                );
            });

            // Verify initial values from payload
            const slider = screen.getByLabelText(/Service radius slider in kilometers/i) as HTMLInputElement;
            const numberInput = screen.getByLabelText(/Service radius in kilometers/i) as HTMLInputElement;

            await waitFor(() => {
                expect(slider.value).toBe('35');
                expect(numberInput.value).toBe('35');
            });

            // Adjust slider -> number input updates
            await act(async () => {
                fireEvent.change(slider, { target: { value: '75' } });
            });
            expect(slider.value).toBe('75');
            expect(numberInput.value).toBe('75');

            // Adjust number input -> slider updates
            await act(async () => {
                fireEvent.change(numberInput, { target: { value: '120' } });
            });
            expect(slider.value).toBe('120');
            expect(numberInput.value).toBe('120');

            // Save and verify payload sent
            const saveBtn = screen.getByRole('button', { name: /save identity/i });
            await act(async () => {
                fireEvent.click(saveBtn);
            });

            await waitFor(() => {
                expect(fetchMock).toHaveBeenCalledWith(
                    expect.stringContaining('/api/local/admin/node/config'),
                    expect.objectContaining({
                        method: 'POST',
                        body: expect.stringContaining('"radiusKm":120'),
                    })
                );
            });
        });

        it('renders safely with an empty payload for service radius defaulting to 0', async () => {
            vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
                if (url.includes('/api/local/community-info') || url.includes('/api/node/config')) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({}),
                    });
                }
                return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
            }));

            await act(async () => {
                render(
                    <NodeIdentityPanel
                        activeNode={mockProfile}
                        diag={null}
                        onRefreshDiag={vi.fn()}
                    />
                );
            });

            const slider = screen.getByLabelText(/Service radius slider in kilometers/i) as HTMLInputElement;
            const numberInput = screen.getByLabelText(/Service radius in kilometers/i) as HTMLInputElement;

            expect(slider.value).toBe('0');
            expect(numberInput.value).toBe('0');
        });

        it('renders safely with wrong-typed and malformed service radius payload', async () => {
            vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
                if (url.includes('/api/node/config')) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({
                            serviceRadius: {
                                radiusKm: 'not-a-number',
                                lat: 'invalid-lat',
                                lng: null,
                            },
                        }),
                    });
                }
                return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
            }));

            await act(async () => {
                render(
                    <NodeIdentityPanel
                        activeNode={mockProfile}
                        diag={null}
                        onRefreshDiag={vi.fn()}
                    />
                );
            });

            const slider = screen.getByLabelText(/Service radius slider in kilometers/i) as HTMLInputElement;
            const numberInput = screen.getByLabelText(/Service radius in kilometers/i) as HTMLInputElement;

            // Safe fallback to 0
            expect(slider.value).toBe('0');
            expect(numberInput.value).toBe('0');
        });
    });

    describe('Bucket 2 Item 6: Community Public Contact Details (Email & Phone)', () => {
        it('renders with real payload and updates contact email, phone and community name on save', async () => {
            const fetchMock = vi.fn().mockImplementation((url: string) => {
                if (url.includes('/api/local/community-info')) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({
                            communityName: 'Northern Rivers Eco',
                            contactEmail: 'info@eco.org',
                            contactPhone: '+61 400 999 888',
                            callsign: 'nrivers',
                        }),
                    });
                }
                if (url.includes('/api/node/config')) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({
                            serviceRadius: { lat: -28.64, lng: 153.61, radiusKm: 20 },
                        }),
                    });
                }
                if (url.includes('/api/local/update-identity') || url.includes('/api/local/admin/node/config')) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ success: true }),
                    });
                }
                return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
            });
            vi.stubGlobal('fetch', fetchMock);

            await act(async () => {
                render(
                    <NodeIdentityPanel
                        activeNode={mockProfile}
                        diag={null}
                        onRefreshDiag={vi.fn()}
                    />
                );
            });

            const nameInput = document.getElementById('community-name') as HTMLInputElement;
            const emailInput = document.getElementById('contact-email') as HTMLInputElement;
            const phoneInput = document.getElementById('contact-phone') as HTMLInputElement;

            await waitFor(() => {
                expect(nameInput.value).toBe('Northern Rivers Eco');
                expect(emailInput.value).toBe('info@eco.org');
                expect(phoneInput.value).toBe('+61 400 999 888');
            });

            // Update contact fields
            await act(async () => {
                fireEvent.change(nameInput, { target: { value: 'Northern Rivers Exchange' } });
                fireEvent.change(emailInput, { target: { value: 'admin@eco.org' } });
                fireEvent.change(phoneInput, { target: { value: '+61 411 222 333' } });
            });

            expect(nameInput.value).toBe('Northern Rivers Exchange');
            expect(emailInput.value).toBe('admin@eco.org');
            expect(phoneInput.value).toBe('+61 411 222 333');

            // Save
            const saveBtn = screen.getByRole('button', { name: /save identity/i });
            await act(async () => {
                fireEvent.click(saveBtn);
            });

            await waitFor(() => {
                expect(fetchMock).toHaveBeenCalledWith(
                    expect.stringContaining('/api/local/update-identity'),
                    expect.objectContaining({
                        method: 'POST',
                        body: expect.stringContaining('"communityName":"Northern Rivers Exchange"'),
                    })
                );
                expect(fetchMock).toHaveBeenCalledWith(
                    expect.stringContaining('/api/local/update-identity'),
                    expect.objectContaining({
                        method: 'POST',
                        body: expect.stringContaining('"contactEmail":"admin@eco.org"'),
                    })
                );
                expect(fetchMock).toHaveBeenCalledWith(
                    expect.stringContaining('/api/local/update-identity'),
                    expect.objectContaining({
                        method: 'POST',
                        body: expect.stringContaining('"contactPhone":"+61 411 222 333"'),
                    })
                );
            });
        });

        it('renders safely with an empty payload for contact fields', async () => {
            vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
                if (url.includes('/api/local/community-info') || url.includes('/api/node/config')) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({}),
                    });
                }
                return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
            }));

            await act(async () => {
                render(
                    <NodeIdentityPanel
                        activeNode={mockProfile}
                        diag={null}
                        onRefreshDiag={vi.fn()}
                    />
                );
            });

            const nameInput = document.getElementById('community-name') as HTMLInputElement;
            const emailInput = document.getElementById('contact-email') as HTMLInputElement;
            const phoneInput = document.getElementById('contact-phone') as HTMLInputElement;

            expect(nameInput.value).toBe('');
            expect(emailInput.value).toBe('');
            expect(phoneInput.value).toBe('');
        });

        it('renders safely with wrong-typed contact payload', async () => {
            vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
                if (url.includes('/api/local/community-info')) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({
                            communityName: 99999,
                            contactEmail: true,
                            contactPhone: { nested: 'phone-obj' },
                        }),
                    });
                }
                return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
            }));

            await act(async () => {
                render(
                    <NodeIdentityPanel
                        activeNode={mockProfile}
                        diag={null}
                        onRefreshDiag={vi.fn()}
                    />
                );
            });

            const nameInput = document.getElementById('community-name') as HTMLInputElement;
            const emailInput = document.getElementById('contact-email') as HTMLInputElement;
            const phoneInput = document.getElementById('contact-phone') as HTMLInputElement;

            // Handled safely without throwing
            expect(nameInput).toBeInTheDocument();
            expect(emailInput).toBeInTheDocument();
            expect(phoneInput).toBeInTheDocument();
        });
    });
});



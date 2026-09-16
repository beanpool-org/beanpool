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
        expect(screen.getByLabelText(/Callsign \(Short Name\)/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/Community Name/i)).toBeInTheDocument();

        // Location search & Leaflet Map container
        expect(screen.getByPlaceholderText(/Search for a location.../i)).toBeInTheDocument();
        expect(document.getElementById('settings-map')).toBeInTheDocument();

        // Radius slider & KM input
        expect(document.getElementById('radius-slider')).toBeInTheDocument();
        expect(document.getElementById('radius-km')).toBeInTheDocument();

        // Directory publishing & preview link
        expect(screen.getByText('Directory Publishing')).toBeInTheDocument();
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

        await act(async () => {
            fireEvent.change(searchInput, { target: { value: 'Byron Bay' } });
        });

        // Advance debounce timer
        await act(async () => {
            await new Promise((r) => setTimeout(r, 400));
        });

        await waitFor(() => {
            expect(screen.getByText('Byron Bay, NSW, Australia')).toBeInTheDocument();
        });

        const resultItem = screen.getByText('Byron Bay, NSW, Australia');
        await act(async () => {
            fireEvent.click(resultItem);
        });

        expect((document.getElementById('cfg-lat') as HTMLInputElement).value).toBe('-28.6474');
        expect((document.getElementById('cfg-lng') as HTMLInputElement).value).toBe('153.612');
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
        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('/api/local/update-identity'),
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    password: mockProfile.adminPassword,
                    callsign: 'mullum-prime',
                    lat: -28.55,
                    lng: 153.5,
                    communityName: 'Mullumbimby Food Exchange',
                    contactEmail: 'admin@mullum.org',
                    contactPhone: '+61 411 222 333',
                }),
            })
        );

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
            expect(onRefreshDiag).toHaveBeenCalled();
        });
    });
});

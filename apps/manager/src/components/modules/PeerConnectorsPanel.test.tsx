import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PeerConnectorsPanel } from './PeerConnectorsPanel';
import type { NodeProfile } from '../../lib/profiles';

const mockActiveNode: NodeProfile = {
    id: 'local-node',
    name: 'Mullumbimby Node',
    url: 'http://localhost:8080',
    adminPassword: 'test-password',
};

describe('PeerConnectorsPanel Component', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('renders with a real payload (active connectors, dual active collision, and dual passive deadlock)', async () => {
        const realConnectors = [
            {
                address: 'wss://byron.beanpool.org:8443',
                callsign: 'Byron Hub',
                trustLevel: 'peer',
                remoteTrustLevel: 'peer',
                enabled: true,
                remoteActive: false,
                connected: true,
                mutualTrust: true,
                latencyMs: 42,
            },
            {
                address: 'wss://sydney.beanpool.org:8443',
                callsign: 'Sydney Node',
                trustLevel: 'peer',
                remoteTrustLevel: 'peer',
                enabled: true,
                remoteActive: true, // Collision!
                connected: true,
                mutualTrust: false,
                latencyMs: 120,
            },
            {
                address: 'wss://melb.beanpool.org:8443',
                callsign: 'Melbourne Node',
                trustLevel: 'peer',
                remoteTrustLevel: 'peer',
                enabled: false, // Passive
                remoteActive: false, // Deadlock!
                connected: true,
                mutualTrust: true,
                latencyMs: null,
            },
        ];

        vi.spyOn(global, 'fetch').mockImplementation((url) => {
            const strUrl = String(url);
            if (strUrl.includes('/api/local/connectors')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve(realConnectors),
                } as Response);
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({}),
            } as Response);
        });

        render(<PeerConnectorsPanel activeNode={mockActiveNode} activeWsConnections={3} p2pActivePeers={3} />);

        await waitFor(() => {
            expect(screen.getByText('Byron Hub')).toBeInTheDocument();
            expect(screen.getByText('Sydney Node')).toBeInTheDocument();
            expect(screen.getByText('Melbourne Node')).toBeInTheDocument();
        });

        // Mutual trust badge
        expect(screen.getAllByText('Mutual Trust').length).toBeGreaterThanOrEqual(1);

        // Collision detection and alert
        expect(screen.getByText('Collision')).toBeInTheDocument();
        expect(screen.getByText(/Dual Active Collision!/i)).toBeInTheDocument();

        // Deadlock detection and alert
        expect(screen.getByText('Deadlock')).toBeInTheDocument();
        expect(screen.getByText(/Dual Passive Deadlock!/i)).toBeInTheDocument();

        // Connection Mode Guide
        expect(screen.getByText(/💡 Connection Mode Guide/i)).toBeInTheDocument();

        // Latency
        expect(screen.getByText('42ms')).toBeInTheDocument();
        expect(screen.getByText('— (Inbound Verified)')).toBeInTheDocument();
    });

    it('renders with an empty payload without crashing', async () => {
        vi.spyOn(global, 'fetch').mockImplementation((url) => {
            const strUrl = String(url);
            if (strUrl.includes('/api/local/connectors')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve([]),
                } as Response);
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({}),
            } as Response);
        });

        render(<PeerConnectorsPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByText(/No connectors configured/i)).toBeInTheDocument();
        });

        // Add Connector form is present
        expect(screen.getByLabelText(/Peer Address/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Add Peer/i })).toBeInTheDocument();
    });

    it('renders safely with wrong-typed fields without throwing', async () => {
        const malformedConnectors = [
            {
                address: 12345, // should be string
                callsign: { complex: 'object' }, // should be string
                trustLevel: false, // should be string
                enabled: 'not-a-bool', // should be boolean
                remoteActive: 'yes', // should be boolean
                connected: 1, // should be boolean
                latencyMs: 'fast', // should be number
            },
        ];

        vi.spyOn(global, 'fetch').mockImplementation((url) => {
            const strUrl = String(url);
            if (strUrl.includes('/api/local/connectors')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve(malformedConnectors),
                } as Response);
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({}),
            } as Response);
        });

        render(<PeerConnectorsPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByTestId('peer-connectors-panel')).toBeInTheDocument();
        });

        expect(screen.getByTestId('connectors-list')).toBeInTheDocument();
    });

    it('connects and disconnects a peer connector', async () => {
        const testConnectors = [
            {
                address: 'wss://brisbane.beanpool.org:8443',
                callsign: 'Brisbane',
                connected: false,
                enabled: true,
            },
        ];

        let connectCalled = false;
        let disconnectCalled = false;

        vi.spyOn(global, 'fetch').mockImplementation((url, opts) => {
            const strUrl = String(url);
            if (strUrl.includes('/api/local/connectors/connect') && opts?.method === 'POST') {
                connectCalled = true;
                testConnectors[0].connected = true;
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({ success: true }),
                } as Response);
            }
            if (strUrl.includes('/api/local/connectors/disconnect') && opts?.method === 'POST') {
                disconnectCalled = true;
                testConnectors[0].connected = false;
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({ success: true }),
                } as Response);
            }
            if (strUrl.includes('/api/local/connectors')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve(testConnectors),
                } as Response);
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({}),
            } as Response);
        });

        render(<PeerConnectorsPanel activeNode={mockActiveNode} />);

        // Connect button
        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
        });

        fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

        await waitFor(() => {
            expect(connectCalled).toBe(true);
            expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
        });

        // Disconnect button
        fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

        await waitFor(() => {
            expect(disconnectCalled).toBe(true);
        });
    });

    it('toggles active and passive dialer roles', async () => {
        const testConnectors = [
            {
                address: 'wss://hobart.beanpool.org:8443',
                callsign: 'Hobart',
                enabled: true, // Active
                connected: true,
            },
        ];

        let toggleBody: any = null;

        vi.spyOn(global, 'fetch').mockImplementation((url, opts) => {
            const strUrl = String(url);
            if (strUrl.endsWith('/api/local/connectors') && opts?.method === 'POST') {
                toggleBody = JSON.parse(String(opts?.body));
                testConnectors[0].enabled = toggleBody.enabled;
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({ success: true }),
                } as Response);
            }
            if (strUrl.includes('/api/local/connectors')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve(testConnectors),
                } as Response);
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({}),
            } as Response);
        });

        render(<PeerConnectorsPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByRole('button', { name: /💤 Make Passive/i })).toBeInTheDocument();
        });

        // Make passive
        fireEvent.click(screen.getByRole('button', { name: /💤 Make Passive/i }));

        await waitFor(() => {
            expect(toggleBody).not.toBeNull();
            expect(toggleBody.enabled).toBe(false);
            expect(screen.getByRole('button', { name: /⚡ Make Active/i })).toBeInTheDocument();
        });

        // Make active
        fireEvent.click(screen.getByRole('button', { name: /⚡ Make Active/i }));

        await waitFor(() => {
            expect(toggleBody.enabled).toBe(true);
        });
    });

    it('requires confirmation step before removing a dead peer', async () => {
        const testConnectors = [
            {
                address: 'wss://deadpeer.beanpool.org:8443',
                callsign: 'Dead Peer',
                connected: false,
                enabled: true,
            },
        ];

        let removeCalled = false;

        vi.spyOn(global, 'fetch').mockImplementation((url, opts) => {
            const strUrl = String(url);
            if (strUrl.includes('/api/local/connectors/remove') && opts?.method === 'POST') {
                removeCalled = true;
                testConnectors.length = 0;
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({ success: true }),
                } as Response);
            }
            if (strUrl.includes('/api/local/connectors')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve(testConnectors),
                } as Response);
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({}),
            } as Response);
        });

        render(<PeerConnectorsPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
        });

        // Click remove
        fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

        // Confirmation modal appears
        expect(screen.getByRole('heading', { name: /Remove Peer Connector/i })).toBeInTheDocument();
        expect(screen.getAllByText(/wss:\/\/deadpeer\.beanpool\.org:8443/i).length).toBe(2);
        expect(removeCalled).toBe(false);

        // Click Remove Connector inside modal
        const confirmBtn = screen.getByRole('button', { name: 'Remove Connector' });
        fireEvent.click(confirmBtn);

        await waitFor(() => {
            expect(removeCalled).toBe(true);
            expect(screen.queryByText('Dead Peer')).not.toBeInTheDocument();
        });
    });

    it('resolves collision using the quick-action button in the collision alert', async () => {
        const testConnectors = [
            {
                address: 'wss://collision.beanpool.org:8443',
                callsign: 'Colliding Node',
                enabled: true,
                remoteActive: true,
                connected: true,
            },
        ];

        let updatedToPassive = false;

        vi.spyOn(global, 'fetch').mockImplementation((url, opts) => {
            const strUrl = String(url);
            if (strUrl.endsWith('/api/local/connectors') && opts?.method === 'POST') {
                const b = JSON.parse(String(opts?.body));
                if (b.enabled === false) updatedToPassive = true;
                testConnectors[0].enabled = b.enabled;
                testConnectors[0].remoteActive = false; // Collision resolved
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({ success: true }),
                } as Response);
            }
            if (strUrl.includes('/api/local/connectors')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve(testConnectors),
                } as Response);
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({}),
            } as Response);
        });

        render(<PeerConnectorsPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByText(/Dual Active Collision!/i)).toBeInTheDocument();
        });

        // Click quick-action Make Passive in alert
        const quickPassiveBtn = screen.getAllByRole('button', { name: /Make Passive/i })[0];
        fireEvent.click(quickPassiveBtn);

        await waitFor(() => {
            expect(updatedToPassive).toBe(true);
            expect(screen.queryByText(/Dual Active Collision!/i)).not.toBeInTheDocument();
        });
    });

    it('adds a new connector with trust level, mode, callsign, and public url', async () => {
        let addBody: any = null;

        vi.spyOn(global, 'fetch').mockImplementation((url, opts) => {
            const strUrl = String(url);
            if (strUrl.endsWith('/api/local/connectors') && opts?.method === 'POST') {
                addBody = JSON.parse(String(opts?.body));
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({ success: true }),
                } as Response);
            }
            if (strUrl.includes('/api/local/connectors/connect')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({ success: true }),
                } as Response);
            }
            if (strUrl.includes('/api/local/connectors')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve([]),
                } as Response);
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({}),
            } as Response);
        });

        render(<PeerConnectorsPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByLabelText(/Peer Address/i)).toBeInTheDocument();
        });

        fireEvent.change(screen.getByLabelText(/Peer Address/i), {
            target: { value: 'us.beanpool.org:4001' },
        });
        fireEvent.change(screen.getByLabelText(/Callsign/i), {
            target: { value: 'US Node' },
        });
        fireEvent.change(screen.getByLabelText(/Trust Level/i), {
            target: { value: 'peer' },
        });
        fireEvent.change(screen.getByLabelText(/Connection Mode/i), {
            target: { value: 'active' },
        });
        fireEvent.change(screen.getByLabelText(/Public URL/i), {
            target: { value: 'https://us.beanpool.org:8450' },
        });

        fireEvent.click(screen.getByRole('button', { name: /Add Peer/i }));

        await waitFor(() => {
            expect(addBody).not.toBeNull();
            expect(addBody.address).toBe('us.beanpool.org:4001');
            expect(addBody.callsign).toBe('US Node');
            expect(addBody.trustLevel).toBe('peer');
            expect(addBody.enabled).toBe(true);
            expect(addBody.publicUrl).toBe('https://us.beanpool.org:8450');
            expect(addBody.password).toBe('test-password');
        });
    });

    it('surfaces connection error when dialing peer returns HTTP 200 with success: false', async () => {
        const testConnectors = [
            {
                address: 'wss://unreachable.beanpool.org:8443',
                callsign: 'Unreachable Peer',
                connected: false,
                enabled: true,
            },
        ];

        vi.spyOn(global, 'fetch').mockImplementation((url, opts) => {
            const strUrl = String(url);
            if (strUrl.includes('/api/local/connectors/connect') && opts?.method === 'POST') {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({ success: false, error: 'Peer connection refused' }),
                } as Response);
            }
            if (strUrl.includes('/api/local/connectors')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve(testConnectors),
                } as Response);
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({}),
            } as Response);
        });

        render(<PeerConnectorsPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
        });

        fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

        await waitFor(() => {
            expect(screen.getByText(/Peer connection refused/i)).toBeInTheDocument();
        });
    });

    it('handles legacy url-keyed connectors in handleToggleMode and remove confirmation', async () => {
        const testConnectors = [
            {
                url: 'wss://legacy.beanpool.org:8443',
                callsign: 'Legacy Node',
                enabled: false, // Passive
                connected: false,
            },
        ];

        let toggleBody: any = null;

        vi.spyOn(global, 'fetch').mockImplementation((url, opts) => {
            const strUrl = String(url);
            if (strUrl.endsWith('/api/local/connectors') && opts?.method === 'POST') {
                toggleBody = JSON.parse(String(opts?.body));
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({ success: true }),
                } as Response);
            }
            if (strUrl.includes('/api/local/connectors')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve(testConnectors),
                } as Response);
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({}),
            } as Response);
        });

        render(<PeerConnectorsPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByText('Legacy Node')).toBeInTheDocument();
            expect(screen.getByRole('button', { name: /⚡ Make Active/i })).toBeInTheDocument();
        });

        // Toggle mode on url-keyed connector
        fireEvent.click(screen.getByRole('button', { name: /⚡ Make Active/i }));

        await waitFor(() => {
            expect(toggleBody).not.toBeNull();
            expect(toggleBody.address).toBe('wss://legacy.beanpool.org:8443');
        });

        // Request remove confirmation on url-keyed connector
        const removeBtn = screen.getByRole('button', { name: 'Remove' });
        fireEvent.click(removeBtn);

        expect(screen.getByRole('heading', { name: /Remove Peer Connector/i })).toBeInTheDocument();
        expect(screen.getAllByText(/wss:\/\/legacy\.beanpool\.org:8443/i).length).toBeGreaterThanOrEqual(1);
    });

    it('detects deadlock when both nodes are passive even when disconnected', async () => {
        const deadlockConnectors = [
            {
                address: 'wss://deadlock.beanpool.org:8443',
                callsign: 'Deadlock Peer',
                enabled: false, // Local is passive
                remoteActive: false, // Remote is passive
                connected: false, // Disconnected!
            },
        ];

        vi.spyOn(global, 'fetch').mockImplementation((url) => {
            const strUrl = String(url);
            if (strUrl.includes('/api/local/connectors')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve(deadlockConnectors),
                } as Response);
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({}),
            } as Response);
        });

        render(<PeerConnectorsPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByText('Deadlock')).toBeInTheDocument();
            expect(screen.getByText(/Dual Passive Deadlock!/i)).toBeInTheDocument();
        });
    });

    it('dismisses remove confirmation modal on Escape key press and backdrop click', async () => {
        const testConnectors = [
            {
                address: 'wss://escape.beanpool.org:8443',
                callsign: 'Escape Peer',
                connected: true,
                enabled: true,
            },
        ];

        vi.spyOn(global, 'fetch').mockImplementation((url) => {
            const strUrl = String(url);
            if (strUrl.includes('/api/local/connectors')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve(testConnectors),
                } as Response);
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({}),
            } as Response);
        });

        render(<PeerConnectorsPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
        });

        // Open modal
        fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
        expect(screen.getByRole('dialog')).toBeInTheDocument();

        // Dismiss via Escape key
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

        // Open modal again
        fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
        const dialog = screen.getByRole('dialog');
        expect(dialog).toBeInTheDocument();

        // Dismiss via backdrop click
        fireEvent.click(dialog);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('handles connector removal failure when server returns success: false with 200 OK', async () => {
        const testConnectors = [
            {
                address: 'wss://fail-remove.beanpool.org:8443',
                callsign: 'Fail Remove Peer',
                connected: true,
                enabled: true,
            },
        ];

        vi.spyOn(global, 'fetch').mockImplementation((url, opts) => {
            const strUrl = String(url);
            if (strUrl.includes('/api/local/connectors/remove') && opts?.method === 'POST') {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({ success: false, error: 'Failed to remove from config' }),
                } as Response);
            }
            if (strUrl.includes('/api/local/connectors')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve(testConnectors),
                } as Response);
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({}),
            } as Response);
        });

        render(<PeerConnectorsPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
        });

        // Open remove confirmation modal
        fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
        expect(screen.getByRole('dialog')).toBeInTheDocument();

        // Confirm removal
        const confirmBtn = screen.getByRole('button', { name: 'Remove Connector' });
        fireEvent.click(confirmBtn);

        // Expect error message and not success message
        await waitFor(() => {
            expect(screen.getByText('Failed to remove from config')).toBeInTheDocument();
        });
        expect(screen.queryByText(/Removed connector/i)).not.toBeInTheDocument();
    });

    it('applies min-h-[44px] touch targets to connector action buttons and collision/deadlock alerts', async () => {
        const testConnectors = [
            {
                address: 'wss://touch-target.beanpool.org:8443',
                callsign: 'Touch Target Peer',
                connected: true,
                enabled: true,
                remoteActive: true,
            },
        ];

        vi.spyOn(global, 'fetch').mockImplementation((url) => {
            const strUrl = String(url);
            if (strUrl.includes('/api/local/connectors')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve(testConnectors),
                } as Response);
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({}),
            } as Response);
        });

        render(<PeerConnectorsPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
        });

        const disconnectBtn = screen.getByRole('button', { name: 'Disconnect' });
        const removeBtn = screen.getByRole('button', { name: 'Remove' });

        expect(disconnectBtn.className).toContain('min-h-[44px]');
        expect(removeBtn.className).toContain('min-h-[44px]');

        // Check collision quick-action button and action row toggle button both have min-h-[44px]
        const passiveButtons = screen.getAllByRole('button', { name: /💤 Make Passive/i });
        expect(passiveButtons.length).toBe(2);
        for (const btn of passiveButtons) {
            expect(btn.className).toContain('min-h-[44px]');
        }
    });

    it('marks peer address input as required and aria-required for accessibility', async () => {
        vi.spyOn(global, 'fetch').mockImplementation(() => {
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve([]),
            } as Response);
        });

        render(<PeerConnectorsPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByLabelText(/Peer Address/i)).toBeInTheDocument();
        });

        const addressInput = screen.getByLabelText(/Peer Address/i);
        expect(addressInput).toBeRequired();
        expect(addressInput.getAttribute('aria-required')).toBe('true');
    });
});



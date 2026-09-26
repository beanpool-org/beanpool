import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppAddressesPanel } from './AppAddressesPanel';
import * as nodeClient from '../../lib/node-client';
import type { NodeProfile } from '../../lib/profiles';

vi.mock('../../lib/node-client', async () => {
    const actual = await vi.importActual('../../lib/node-client');
    return {
        ...actual,
        getAppAddresses: vi.fn(),
        confirmAppAddress: vi.fn(),
        removeAppAddress: vi.fn(),
        getTfaSessionToken: vi.fn(() => undefined),
    };
});

const node: NodeProfile = { id: 'n1', name: 'Test', url: 'https://community.example.org', adminPassword: 'pw' };
const report = (over: Partial<nodeClient.AppAddressesReport> = {}): nodeClient.AppAddressesReport => ({
    addresses: [], unconfirmed: [], oldApps: { today: 0, busiestDay: 0 },
    unboundSignaturesUntil: '2026-12-15', unboundSignaturesAccepted: true, ...over,
});

describe('AppAddressesPanel (Settings → Network)', () => {
    beforeEach(() => vi.clearAllMocks());

    it('lists each address with where it comes from and how many apps used it, and the old-app count', async () => {
        vi.mocked(nodeClient.getAppAddresses).mockResolvedValue(report({
            addresses: [
                { address: 'mullum.beanpool.org', source: 'public-address', today: 12, busiestDay: 30 },
                { address: 'community.example.org', source: 'owner', today: 1, busiestDay: 2 },
            ],
            oldApps: { today: 3, busiestDay: 5 },
        }));
        render(<AppAddressesPanel activeNode={node} />);
        const rows = await screen.findAllByTestId('app-address');
        expect(rows[0].textContent).toMatch(/^mullum\.beanpool\.org · this community's web addressused by 12 apps today · most in one day this week: 30$/);
        expect(rows[1].textContent).toMatch(/confirmed in Settings/);
        // Only an owner-confirmed address can be removed here; the others are changed where they are set.
        expect(rows[0].querySelector('button')).toBeNull();
        expect(rows[1].querySelector('button')!.textContent).toBe('Remove community.example.org');
        expect(screen.getByTestId('old-apps').textContent).toMatch(/^3 apps too old to name this community reached it today \(most in one day this week: 5\)\. From .*2026 this community refuses apps that old/);
        expect(screen.queryByTestId('app-address-offer')).toBeNull();
        expect(nodeClient.getAppAddresses).toHaveBeenCalledWith('https://community.example.org', 'pw', undefined);
    });

    it('a node with no address: says so, offers what apps reached it at and this page\'s own address, and one tap confirms', async () => {
        vi.mocked(nodeClient.getAppAddresses).mockResolvedValue(report({ unconfirmed: [{ address: 'bp.example.net', today: 2, busiestDay: 4 }] }));
        vi.mocked(nodeClient.confirmAppAddress).mockResolvedValue(report({
            addresses: [{ address: 'bp.example.net', source: 'owner', today: 2, busiestDay: 4 }],
        }));
        render(<AppAddressesPanel activeNode={node} />);
        expect((await screen.findByTestId('app-addresses-none')).textContent).toMatch(/accepts any address\. After that it refuses addresses it doesn't know/);
        const offers = screen.getAllByTestId('app-address-offer').map((o) => o.textContent);
        expect(offers[0]).toMatch(/^BeanPool apps reached this community at bp\.example\.net \(4 apps on the busiest day this week\)\. Is that its address\?Yes, bp\.example\.net is its address$/);
        expect(offers[1]).toMatch(/^This page reached the community at community\.example\.org\./);
        fireEvent.click(screen.getByText('Yes, bp.example.net is its address'));
        await waitFor(() => expect(nodeClient.confirmAppAddress).toHaveBeenCalledWith('https://community.example.org', 'bp.example.net', 'pw', undefined));
        expect((await screen.findByTestId('app-address')).textContent).toMatch(/^bp\.example\.net · confirmed in Settings/);
        expect(screen.queryByTestId('app-address-offer')).toBeNull();
    });

    it("never offers this machine's or a LAN address", async () => {
        vi.mocked(nodeClient.getAppAddresses).mockResolvedValue(report());
        render(<AppAddressesPanel activeNode={{ ...node, url: 'https://192.168.1.20:8443' }} />);
        await screen.findByTestId('app-addresses-none');
        expect(screen.queryByTestId('app-address-offer')).toBeNull();
    });

    it('after the switch: old apps are refused, in plain words', async () => {
        vi.mocked(nodeClient.getAppAddresses).mockResolvedValue(report({
            addresses: [{ address: 'a.example', source: 'env', today: 0, busiestDay: 0 }], unboundSignaturesUntil: null, unboundSignaturesAccepted: false,
        }));
        render(<AppAddressesPanel activeNode={node} />);
        expect((await screen.findByTestId('old-apps')).textContent).toBe('Apps too old to name this community are refused here. Members using one see a message asking them to update BeanPool.');
    });

    it('a refused confirm shows the node\'s words', async () => {
        vi.mocked(nodeClient.getAppAddresses).mockResolvedValue(report({ unconfirmed: [{ address: 'x.example', today: 1, busiestDay: 1 }] }));
        vi.mocked(nodeClient.confirmAppAddress).mockRejectedValue(new Error('This community already has 20 confirmed addresses.'));
        render(<AppAddressesPanel activeNode={node} />);
        fireEvent.click(await screen.findByText('Yes, x.example is its address'));
        expect((await screen.findByRole('alert')).textContent).toBe('This community already has 20 confirmed addresses.');
    });

    it('an older server (404) or a moderator shows nothing rather than an alarm', async () => {
        vi.mocked(nodeClient.getAppAddresses).mockRejectedValue(new Error('HTTP 404: Not Found'));
        const { container } = render(<AppAddressesPanel activeNode={node} />);
        await waitFor(() => expect(nodeClient.getAppAddresses).toHaveBeenCalled());
        expect(container.textContent).toBe('');
    });

    it('holds at phone width: long addresses break, buttons are touch-sized, nothing fixed-width', async () => {
        vi.mocked(nodeClient.getAppAddresses).mockResolvedValue(report({
            addresses: [{ address: `${'a'.repeat(60)}.example.org`, source: 'owner', today: 0, busiestDay: 0 }],
        }));
        render(<div style={{ width: 320 }}><AppAddressesPanel activeNode={node} /></div>);
        const row = await screen.findByTestId('app-address');
        expect(row.querySelector('strong')!.className).toMatch(/break-all/);
        expect(row.querySelector('button')!.className).toMatch(/min-h-\[44px\]/);
        expect(screen.getByTestId('app-addresses').innerHTML).not.toMatch(/whitespace-nowrap|\bw-\[\d/);
    });
});

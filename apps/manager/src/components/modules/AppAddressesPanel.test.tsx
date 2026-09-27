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
        expect(offers[0]).toMatch(/^4 members' apps reached this community at bp\.example\.net on the busiest day this week\. Is that its address\?Yes, bp\.example\.net is its address$/);
        expect(offers[1]).toMatch(/^This page reached the community at community\.example\.org\./);
        fireEvent.click(screen.getByText('Yes, bp.example.net is its address'));
        await waitFor(() => expect(nodeClient.confirmAppAddress).toHaveBeenCalledWith('https://community.example.org', 'bp.example.net', 'pw', undefined));
        expect((await screen.findByTestId('app-address')).textContent).toMatch(/^bp\.example\.net · confirmed in Settings/);
        expect(screen.queryByTestId('app-address-offer')).toBeNull();
    });

    it('a node whose only listed name is localhost (an SSH tunnel) still has no address: says so, lists localhost, and offers the rest', async () => {
        vi.mocked(nodeClient.getAppAddresses).mockResolvedValue(report({
            addresses: [{ address: 'localhost', source: 'env', today: 1, busiestDay: 1 }],
            named: false,
            unconfirmed: [{ address: 'bp.example.net', today: 2, busiestDay: 4 }],
        }));
        render(<AppAddressesPanel activeNode={node} />);
        expect((await screen.findByTestId('app-addresses-none')).textContent).toMatch(/accepts any address\. After that it refuses addresses it doesn't know/);
        expect(screen.getByTestId('app-address').textContent).toMatch(/^localhost · set on the server \(BEANPOOL_ADDRESSES\)/);
        const offers = screen.getAllByTestId('app-address-offer').map((o) => o.textContent);
        expect(offers).toHaveLength(2);
        expect(offers[0]).toMatch(/^4 members' apps reached this community at bp\.example\.net /);
        expect(offers[1]).toMatch(/^This page reached the community at community\.example\.org\./);
    });

    it('a named node with localhost listed too: no "no address" note and nothing offered', async () => {
        vi.mocked(nodeClient.getAppAddresses).mockResolvedValue(report({
            addresses: [
                { address: 'tunnel.example.org', source: 'public-address', today: 3, busiestDay: 3 },
                { address: 'localhost', source: 'env', today: 1, busiestDay: 1 },
            ],
            named: true,
        }));
        render(<AppAddressesPanel activeNode={{ ...node, url: 'https://elsewhere.example.org' }} />);
        expect(await screen.findAllByTestId('app-address')).toHaveLength(2);
        expect(screen.queryByTestId('app-addresses-none')).toBeNull();
        expect(screen.queryByTestId('app-address-offer')).toBeNull();
    });

    it("says how many members' apps reached each offered address, and whether an owner's or admin's app did", async () => {
        vi.mocked(nodeClient.getAppAddresses).mockResolvedValue(report({
            unconfirmed: [
                { address: 'home.example.org', today: 1, busiestDay: 1, ownerOrAdmin: true },
                { address: 'crowd.example.org', today: 2, busiestDay: 3, ownerOrAdmin: false },
            ],
            heldBack: [],
            membersToOffer: 3,
        }));
        render(<AppAddressesPanel activeNode={{ ...node, url: 'https://192.168.1.20:8443' }} />);
        const offers = (await screen.findAllByTestId('app-address-offer')).map((o) => o.textContent);
        expect(offers).toEqual([
            "1 member's app reached this community at home.example.org on the busiest day this week, an owner's or admin's among them. Is that its address?Yes, home.example.org is its address",
            "3 members' apps reached this community at crowd.example.org on the busiest day this week. Is that its address?Yes, crowd.example.org is its address",
        ]);
        expect(screen.queryByTestId('app-address-held')).toBeNull();
    });

    it('never offers another community\'s beanpool.org name: says whose it is and not to confirm it, with no button', async () => {
        vi.mocked(nodeClient.getAppAddresses).mockResolvedValue(report({
            heldBack: [{ address: 'mullum.beanpool.org', today: 1, busiestDay: 2, ownerOrAdmin: true, reason: 'another-community' }],
            membersToOffer: 3,
        }));
        render(<AppAddressesPanel activeNode={{ ...node, url: 'https://192.168.1.20:8443' }} />);
        const held = await screen.findByTestId('app-address-held');
        expect(held.getAttribute('data-reason')).toBe('another-community');
        expect(held.textContent).toBe("2 members' apps reached this community at mullum.beanpool.org on the busiest day this week, an owner's or admin's among them."
            + "mullum.beanpool.org is the name of another BeanPool community, so it isn't offered. Confirming it would let what members' apps send "
            + "that community be copied and used here. If someone asked you to confirm it, don't.");
        expect(held.querySelector('button')).toBeNull();
        expect(screen.queryByTestId('app-address-offer')).toBeNull();
        expect(screen.queryByText(/Yes, mullum\.beanpool\.org/)).toBeNull();
    });

    it('an older server that still offers a beanpool.org name: held back here all the same', async () => {
        vi.mocked(nodeClient.getAppAddresses).mockResolvedValue(report({
            unconfirmed: [{ address: 'mullum.beanpool.org', today: 1, busiestDay: 1 }, { address: 'bp.example.net', today: 1, busiestDay: 1 }],
        }));
        render(<AppAddressesPanel activeNode={{ ...node, url: 'https://192.168.1.20:8443' }} />);
        const held = await screen.findByTestId('app-address-held');
        expect(held.getAttribute('data-reason')).toBe('another-community');
        expect(held.textContent).toMatch(/^1 member's app reached this community at mullum\.beanpool\.org on the busiest day this week\.mullum\.beanpool\.org is the name of another BeanPool community/);
        expect(screen.getAllByTestId('app-address-offer').map((o) => o.textContent)).toEqual([
            "1 member's app reached this community at bp.example.net on the busiest day this week. Is that its address?Yes, bp.example.net is its address",
        ]);
    });

    it("one or two members' apps only: listed with the count and what it takes, and nothing to confirm", async () => {
        vi.mocked(nodeClient.getAppAddresses).mockResolvedValue(report({
            heldBack: [
                { address: 'random-host.example', today: 1, busiestDay: 1, ownerOrAdmin: false, reason: 'few-members' },
                { address: 'pair.example.org', today: 0, busiestDay: 2, ownerOrAdmin: false, reason: 'few-members', directory: { name: 'Riverbend Commons' } },
            ],
            membersToOffer: 3,
        }));
        render(<AppAddressesPanel activeNode={{ ...node, url: 'https://192.168.1.20:8443' }} />);
        const box = await screen.findByTestId('app-address-few');
        expect(box.querySelector('p')!.textContent).toBe("Not offered yet: a member's app can be made to use any address. An address is offered once an owner's or admin's app, or 3 members' apps in one day, reach this community there.");
        expect(screen.getAllByTestId('app-address-held').map((h) => h.textContent)).toEqual([
            "random-host.example1 member's app on the busiest day this week",
            "pair.example.org2 members' apps on the busiest day this week. The BeanPool directory lists it as the address of Riverbend Commons.",
        ]);
        expect(box.querySelector('button')).toBeNull();
        expect(screen.queryByTestId('app-address-offer')).toBeNull();
    });

    it('a host the directory lists as a community\'s: names it, warns what confirming does, and confirms only once ticked', async () => {
        vi.mocked(nodeClient.getAppAddresses).mockResolvedValue(report({
            heldBack: [
                { address: 'riverbend.example', today: 4, busiestDay: 4, ownerOrAdmin: true, reason: 'directory', directory: { name: 'Riverbend Commons' } },
                { address: 'nameless.example', today: 3, busiestDay: 3, ownerOrAdmin: false, reason: 'directory', directory: { name: null } },
            ],
        }));
        vi.mocked(nodeClient.confirmAppAddress).mockResolvedValue(report({
            addresses: [{ address: 'riverbend.example', source: 'owner', today: 4, busiestDay: 4 }], named: true,
        }));
        render(<AppAddressesPanel activeNode={{ ...node, url: 'https://192.168.1.20:8443' }} />);
        const [river, nameless] = await screen.findAllByTestId('app-address-held');
        expect(river.textContent).toBe("4 members' apps reached this community at riverbend.example on the busiest day this week, an owner's or admin's among them."
            + 'The BeanPool directory lists riverbend.example as the address of Riverbend Commons. Confirm it only if that is this community: '
            + "if it isn't, what members' apps send Riverbend Commons could be copied and used here."
            + 'Riverbend Commons is this community'
            + 'Yes, riverbend.example is its address');
        expect(nameless.textContent).toMatch(/as the address of another community\. Confirm it only if that is this community: if it isn't, what members' apps send that community could be copied and used here\.That community is this one/);
        const confirm = screen.getByText('Yes, riverbend.example is its address') as HTMLButtonElement;
        expect(confirm.disabled).toBe(true);
        fireEvent.click(confirm);
        expect(nodeClient.confirmAppAddress).not.toHaveBeenCalled();
        fireEvent.click(screen.getByLabelText('Riverbend Commons is this community'));
        expect(confirm.disabled).toBe(false);
        expect((screen.getByText('Yes, nameless.example is its address') as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(confirm);
        await waitFor(() => expect(nodeClient.confirmAppAddress).toHaveBeenCalledWith('https://192.168.1.20:8443', 'riverbend.example', 'pw', undefined));
        expect((await screen.findByTestId('app-address')).textContent).toMatch(/^riverbend\.example · confirmed in Settings/);
    });

    it("this page's own address: offered with the members' count when only one member's app used it, never when it is a beanpool.org name", async () => {
        vi.mocked(nodeClient.getAppAddresses).mockResolvedValue(report({
            heldBack: [{ address: 'community.example.org', today: 1, busiestDay: 1, ownerOrAdmin: false, reason: 'few-members' }],
        }));
        const { unmount } = render(<AppAddressesPanel activeNode={node} />);
        const offers = (await screen.findAllByTestId('app-address-offer')).map((o) => o.textContent);
        expect(offers).toEqual([
            "This page reached the community at community.example.org, and so did 1 member's app this week. Is that the address members' apps use?Yes, community.example.org is its address",
        ]);
        expect(screen.queryByTestId('app-address-held')).toBeNull();
        unmount();

        vi.mocked(nodeClient.getAppAddresses).mockResolvedValue(report());
        render(<AppAddressesPanel activeNode={{ ...node, url: 'https://mullum.beanpool.org' }} />);
        await screen.findByTestId('app-addresses-none');
        expect(screen.queryByTestId('app-address-offer')).toBeNull();
    });

    it("this page's own address the directory lists as a community's: never one tap; named, warned, and confirmed only once ticked", async () => {
        vi.mocked(nodeClient.getAppAddresses).mockResolvedValue(report({
            heldBack: [{ address: 'community.example.org', today: 1, busiestDay: 1, ownerOrAdmin: false, reason: 'few-members', directory: { name: 'Riverbend Commons' } }],
        }));
        render(<AppAddressesPanel activeNode={node} />);
        const held = await screen.findByTestId('app-address-held');
        expect(screen.queryByTestId('app-address-offer')).toBeNull();
        expect(screen.queryByTestId('app-address-few')).toBeNull();
        expect(held.getAttribute('data-reason')).toBe('directory');
        expect(held.textContent).toMatch(/The BeanPool directory lists community\.example\.org as the address of Riverbend Commons\. Confirm it only if that is this community/);
        const confirm = screen.getByText('Yes, community.example.org is its address') as HTMLButtonElement;
        expect(confirm.disabled).toBe(true);
        fireEvent.click(confirm);
        expect(nodeClient.confirmAppAddress).not.toHaveBeenCalled();
        fireEvent.click(screen.getByLabelText('Riverbend Commons is this community'));
        expect(confirm.disabled).toBe(false);
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
        const long = `${'a'.repeat(60)}.example.org`;
        vi.mocked(nodeClient.getAppAddresses).mockResolvedValue(report({
            addresses: [{ address: long, source: 'owner', today: 0, busiestDay: 0 }],
            unconfirmed: [{ address: `b${long}`, today: 1, busiestDay: 1, ownerOrAdmin: true }],
            heldBack: [
                { address: `${'m'.repeat(60)}.beanpool.org`, today: 1, busiestDay: 1, ownerOrAdmin: false, reason: 'another-community' },
                { address: `d${long}`, today: 3, busiestDay: 3, ownerOrAdmin: false, reason: 'directory', directory: { name: 'N'.repeat(80) } },
                { address: `f${long}`, today: 1, busiestDay: 1, ownerOrAdmin: false, reason: 'few-members' },
            ],
        }));
        render(<div style={{ width: 320 }}><AppAddressesPanel activeNode={node} /></div>);
        const row = await screen.findByTestId('app-address');
        expect(row.querySelector('strong')!.className).toMatch(/break-all/);
        expect(row.querySelector('button')!.className).toMatch(/min-h-\[44px\]/);
        const panel = screen.getByTestId('app-addresses');
        // Every paragraph and button that can hold an address or a directory name breaks inside it.
        const holders = panel.querySelectorAll('[data-testid="app-address-offer"] p, li[data-testid="app-address-held"], [data-testid="app-address-held"] p, button, label');
        // One offer's text; two held cards' two texts each; the few-members line; Remove, Yes and the directory's Yes; the tick box.
        expect(holders.length).toBe(10);
        for (const el of holders) expect(el.className).toMatch(/break-(words|all)/);
        for (const el of panel.querySelectorAll('button, label')) expect(el.className).toMatch(/min-h-\[44px\]/);
        for (const el of panel.querySelectorAll('button')) expect(el.className).toMatch(/max-w-full/);
        expect(screen.getAllByTestId('app-address-held').find((h) => h.getAttribute('data-reason') === 'few-members')!.querySelector('strong')!.className).toMatch(/break-all/);
        expect(panel.innerHTML).not.toMatch(/whitespace-nowrap|\bw-\[\d/);
    });
});

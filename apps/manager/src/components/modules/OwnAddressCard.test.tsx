import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { PublicAddressPanel } from './PublicAddressPanel';
import { AppAddressesPanel } from './AppAddressesPanel';
import { domainOf } from './OwnAddressCard';
import type { NodeProfile } from '../../lib/profiles';
import type { TlsStatus } from '../../lib/node-client';

/**
 * HTTPS S4: Settings → Public Address → "Your own address" (OwnAddressCard), and removing an app address with an owner's
 * fresh proof (server app-addresses/remove requireFreshProof). The node is a fetch stub; nothing here reaches a node.
 */
const node: NodeProfile = { id: 'n1', name: 'Cairns', url: 'http://localhost:8080', adminPassword: 'pw' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const CODE_ASK = { error: 'Enter a current code from your authenticator app (or a backup code) to remove 203.0.113.5', totpRequired: true };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(Date.now() + ms).toISOString();

function tlsStatus(over: Partial<TlsStatus> = {}): TlsStatus {
    return {
        ca: "Let's Encrypt",
        testCa: false,
        orders: true,
        identifiers: [
            {
                identifier: 'beans.example.org', kind: 'name', challenge: 'http-01', source: 'public-address', ownerAdded: true, retryOnly: true, communityAddress: true,
                certificate: { issuedAt: at(-DAY), expiresAt: at(89 * DAY) }, nextRenewalAt: at(59 * DAY),
                lastAttemptAt: at(-DAY), lastSuccessAt: at(-DAY), failures: 0, lastError: null,
            },
            {
                identifier: '203.0.113.5', kind: 'ip', challenge: 'http-01', source: 'owner', ownerAdded: true, retryOnly: true, communityAddress: false,
                certificate: null, nextRenewalAt: at(4 * HOUR), lastAttemptAt: at(-HOUR), lastSuccessAt: null, failures: 2,
                lastError: 'port 80 is not reachable from the internet',
            },
            {
                identifier: 'nas.example.net', kind: 'name', challenge: 'http-01', source: 'env', ownerAdded: false, retryOnly: false, communityAddress: false,
                certificate: { issuedAt: at(-80 * DAY), expiresAt: at(10 * HOUR) }, nextRenewalAt: null,
                lastAttemptAt: null, lastSuccessAt: null, failures: 0, lastError: null,
            },
        ],
        ...over,
    };
}

type Sent = { path: string; body: Record<string, unknown> };

/**
 * fetch: tls/status answers `status()` (a Response it returns goes as it is; a throw is a fetch that fails); a POST to a
 * path in `posts` answers from its list in turn; records each POST.
 */
function mockNode(status: () => unknown, posts: Record<string, Array<[number, unknown]>>, sent: Sent[], tlsCode = 200) {
    vi.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
        const u = String(url);
        if (opts?.method === 'POST') {
            const path = Object.keys(posts).find((p) => u.includes(p));
            if (path) {
                sent.push({ path, body: JSON.parse(String(opts.body || '{}')) });
                const answers = posts[path];
                const n = sent.filter((s) => s.path === path).length;
                const [code, body] = answers[Math.min(n - 1, answers.length - 1)];
                return json(code, body);
            }
        }
        if (u.includes('/api/local/admin/tls/status')) {
            if (tlsCode !== 200) return json(tlsCode, { error: 'Only an owner of this node can see its certificates' });
            const answer = status();
            return answer instanceof Response ? answer : json(200, answer);
        }
        if (u.includes('/public-address/status')) return json(200, { status: 'none' });
        if (u.includes('/extra-names')) return json(200, { names: [] });
        return json(200, { logs: [] });
    });
}

const card = () => screen.findByTestId('own-address-card');
const row = (address: string) => screen.getAllByTestId('own-address').find((li) => li.getAttribute('data-address') === address)!;

describe('OwnAddressCard: "Your own address" (HTTPS S4)', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('an owner sees each address with its certificate: valid until and renews, or why the last try failed and when it is tried next', async () => {
        mockNode(() => tlsStatus(), {}, []);
        render(<PublicAddressPanel activeNode={node} />);
        await card();
        const domain = row('beans.example.org');
        expect(domain).toHaveTextContent("This community's address: new members are sent here.");
        expect(within(domain).getByTestId('own-address-certificate')).toHaveTextContent(/^Certificate valid until .+\. Renews about .+\.$/);
        const ip = row('203.0.113.5');
        expect(ip).toHaveTextContent('IP address');
        expect(ip).toHaveTextContent('Added in Settings or with beanpool claim.');
        expect(within(ip).getByTestId('own-address-error')).toHaveTextContent(/Last try .+: port 80 is not reachable from the internet/);
        expect(within(ip).getByTestId('own-address-error')).toHaveTextContent(/Next try .+\./);
        expect(within(ip).queryByTestId('own-address-certificate')).toBeNull();
        expect(within(ip).getByRole('button', { name: 'Try again now' })).toBeInTheDocument();
        // Set on the server: shown, but not an owner's to remove here. Under a day left: the warning colour.
        const env = row('nas.example.net');
        expect(env).toHaveTextContent('Set on the server (BEANPOOL_ADDRESSES).');
        expect(within(env).queryByRole('button')).toBeNull();
        expect(within(env).getByTestId('own-address-certificate').className).toContain('text-bp-ink-warning');
        expect(within(domain).getByTestId('own-address-certificate').className).toContain('text-bp-ink-success');
        // The one sentence the CLI, the manual and Settings all say.
        expect(screen.getByTestId('own-address-nudge')).toHaveTextContent('A name survives a change of server; a number does not.');
        expect(screen.getByTestId('own-address-card')).toHaveTextContent("from Let's Encrypt, with no Cloudflare account");
    });

    it('an admin sees no card, and its Settings never asks for the certificates', async () => {
        const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => json(200, { status: 'none', logs: [], names: [] }));
        render(<PublicAddressPanel activeNode={node} viewer={{ kind: 'key', memberPubkey: 'a'.repeat(64), role: 'admin' }} />);
        await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
        await new Promise((r) => setTimeout(r, 20));
        expect(screen.queryByTestId('own-address-card')).toBeNull();
        expect(fetchSpy.mock.calls.some(([u]) => String(u).includes('/tls/status'))).toBe(false);
    });

    it('a node that refuses the read (403) or has no such route draws nothing', async () => {
        mockNode(() => tlsStatus(), {}, [], 403);
        render(<PublicAddressPanel activeNode={node} />);
        await waitFor(() => expect(screen.getByTestId('public-address-panel')).toBeInTheDocument());
        await new Promise((r) => setTimeout(r, 20));
        expect(screen.queryByTestId('own-address-card')).toBeNull();
    });

    it('an older server without the route (404) draws nothing either', async () => {
        mockNode(() => tlsStatus(), {}, [], 404);
        render(<PublicAddressPanel activeNode={node} />);
        await waitFor(() => expect(screen.getByTestId('public-address-panel')).toBeInTheDocument());
        await new Promise((r) => setTimeout(r, 20));
        expect(screen.queryByTestId('own-address-card')).toBeNull();
    });

    it('a re-read that fails after a change keeps the card, the change\'s message and what was last read, and says it could not refresh', async () => {
        const sent: Sent[] = [];
        let reads = 0;
        // The first read answers; every later one is the server's 500 until `healed`.
        let healed = false;
        mockNode(() => (++reads === 1 || healed ? tlsStatus() : json(500, {})),
            { '/public-address/own': [[200, { success: true, address: '203.0.113.5', kind: 'ip', communityAddress: false, primaryAddress: 'beans.example.org' }]] }, sent);
        render(<PublicAddressPanel activeNode={node} />);
        await card();
        fireEvent.click(within(row('203.0.113.5')).getByRole('button', { name: 'Try again now' }));
        await waitFor(() => expect(screen.getByTestId('own-address-load-error')).toHaveTextContent("Couldn't refresh this list, so it may be out of date. Press Refresh to try again."));
        expect(sent).toHaveLength(1);
        expect(reads).toBe(2);
        // The change went through: its message stays, beside the failed refresh, and so does every address last read.
        expect(screen.getByTestId('own-address-message')).toHaveTextContent('203.0.113.5 is being tried again now.');
        expect(screen.getByTestId('own-address-load-error')).toHaveTextContent('The server answered 500.');
        expect(screen.getAllByTestId('own-address').map((li) => li.getAttribute('data-address'))).toEqual(['beans.example.org', '203.0.113.5', 'nas.example.net']);
        // Refresh is still there; once the server answers, the line goes.
        healed = true;
        fireEvent.click(within(screen.getByTestId('own-address-card')).getByRole('button', { name: 'Refresh' }));
        await waitFor(() => expect(screen.queryByTestId('own-address-load-error')).toBeNull());
        expect(reads).toBe(3);
        expect(screen.getByTestId('own-address-card')).toBeInTheDocument();
    });

    it('a re-read that cannot reach the server after Remove keeps the card and the "removed" message', async () => {
        const sent: Sent[] = [];
        let reads = 0;
        mockNode(() => { if (++reads > 1) throw new TypeError('Failed to fetch'); return tlsStatus(); },
            { '/app-addresses/remove': [[200, { addresses: [], unconfirmed: [], oldApps: { today: 0, busiestDay: 0 } }]] }, sent);
        render(<PublicAddressPanel activeNode={node} />);
        await card();
        fireEvent.click(within(row('203.0.113.5')).getByRole('button', { name: 'Remove 203.0.113.5' }));
        fireEvent.click(within(await screen.findByTestId('in-page-confirm')).getByRole('button', { name: 'Remove' }));
        await waitFor(() => expect(screen.getByTestId('own-address-load-error')).toHaveTextContent('Could not reach the server.'));
        expect(sent).toEqual([{ path: '/app-addresses/remove', body: { address: '203.0.113.5' } }]);
        expect(screen.getByTestId('own-address-message')).toHaveTextContent('203.0.113.5 removed.');
        expect(screen.getByTestId('own-address-card')).toBeInTheDocument();
    });

    it('Refresh pressed while the read answers 500 keeps the card and its Refresh button', async () => {
        let reads = 0;
        mockNode(() => (++reads === 1 ? tlsStatus() : json(500, {})), {}, []);
        render(<PublicAddressPanel activeNode={node} />);
        await card();
        fireEvent.click(within(screen.getByTestId('own-address-card')).getByRole('button', { name: 'Refresh' }));
        await waitFor(() => expect(screen.getByTestId('own-address-load-error')).toHaveTextContent('The server answered 500.'));
        expect(reads).toBe(2);
        expect(within(screen.getByTestId('own-address-card')).getByRole('button', { name: 'Refresh' })).toBeEnabled();
        expect(screen.getAllByTestId('own-address')).toHaveLength(3);
    });

    it('adds the server\'s IP, and a domain typed as a web address goes as its host', async () => {
        const sent: Sent[] = [];
        mockNode(() => tlsStatus({ identifiers: [] }), {
            '/public-address/own': [[200, { success: true, address: '203.0.113.5', kind: 'ip', communityAddress: true, primaryAddress: '203.0.113.5' }],
                [200, { success: true, address: 'beans.example.org', kind: 'own', communityAddress: true, primaryAddress: 'beans.example.org' }]],
        }, sent);
        render(<PublicAddressPanel activeNode={node} />);
        await card();
        expect(screen.getByTestId('own-address-none')).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("This server's public IP address"), { target: { value: ' 203.0.113.5 ' } });
        fireEvent.click(screen.getByRole('button', { name: 'Use this IP address' }));
        await waitFor(() => expect(screen.getByTestId('own-address-message')).toHaveTextContent("203.0.113.5 is this community's address now"));
        expect(sent[0]).toEqual({ path: '/public-address/own', body: { ip: '203.0.113.5', password: 'pw' } });
        fireEvent.change(screen.getByLabelText('Your own domain name'), { target: { value: 'https://beans.example.org/settings' } });
        fireEvent.click(screen.getByRole('button', { name: 'Use this domain' }));
        await waitFor(() => expect(sent).toHaveLength(2));
        expect(sent[1].body).toEqual({ domain: 'beans.example.org', password: 'pw' });
        expect(domainOf('HTTP://coop.example.net?x=1')).toBe('coop.example.net');
    });

    it('a refused address says the node\'s words; nothing else changes', async () => {
        const sent: Sent[] = [];
        const why = '192.168.1.20 is on a home network or this machine: nothing on the internet can reach it, so no certificate can be issued for it';
        mockNode(() => tlsStatus({ identifiers: [] }), { '/public-address/own': [[400, { error: why }]] }, sent);
        render(<PublicAddressPanel activeNode={node} />);
        await card();
        fireEvent.change(screen.getByLabelText("This server's public IP address"), { target: { value: '192.168.1.20' } });
        fireEvent.click(screen.getByRole('button', { name: 'Use this IP address' }));
        await waitFor(() => expect(screen.getByTestId('own-address-message')).toHaveTextContent(why));
        expect(screen.getByTestId('own-address-message').className).toContain('text-bp-ink-danger');
    });

    it('moving the live address to another asks the fresh proof in the card; Confirm re-sends it with the code', async () => {
        const sent: Sent[] = [];
        mockNode(() => tlsStatus(), {
            '/public-address/own': [[401, { error: "Enter a current code from your authenticator app (or a backup code) to replace this community's live address", totpRequired: true }],
                [200, { success: true, address: 'coop.example.net', kind: 'own', communityAddress: true, primaryAddress: 'coop.example.net' }]],
        }, sent);
        render(<PublicAddressPanel activeNode={node} />);
        await card();
        fireEvent.change(screen.getByLabelText('Your own domain name'), { target: { value: 'coop.example.net' } });
        fireEvent.click(screen.getByRole('button', { name: 'Use this domain' }));
        const input = await screen.findByTestId('own-address-proof-input');
        fireEvent.change(input, { target: { value: '123456' } });
        fireEvent.click(screen.getByTestId('own-address-proof-confirm'));
        await waitFor(() => expect(screen.getByTestId('own-address-message')).toHaveTextContent("coop.example.net is this community's address now"));
        expect(sent.map((s) => s.body.code)).toEqual([undefined, '123456']);
        expect(screen.queryByTestId('own-address-proof-input')).toBeNull();
    });

    it('Try again now gives the same address again (the owner\'s retry past the back-off)', async () => {
        const sent: Sent[] = [];
        mockNode(() => tlsStatus(), { '/public-address/own': [[200, { success: true, address: '203.0.113.5', kind: 'ip', communityAddress: false, primaryAddress: 'beans.example.org' }]] }, sent);
        render(<PublicAddressPanel activeNode={node} />);
        await card();
        fireEvent.click(within(row('203.0.113.5')).getByRole('button', { name: 'Try again now' }));
        await waitFor(() => expect(screen.getByTestId('own-address-message')).toHaveTextContent('203.0.113.5 is being tried again now.'));
        expect(sent[0].body).toEqual({ ip: '203.0.113.5', password: 'pw' });
    });

    it('an address that given again would become the community\'s address (retryOnly false) is offered no Try again now, only Remove', async () => {
        const sent: Sent[] = [];
        const kept = {
            identifier: 'coop.example.net', kind: 'name' as const, challenge: 'http-01' as const, source: 'owner' as const, ownerAdded: true, retryOnly: false,
            communityAddress: false, certificate: null, nextRenewalAt: at(HOUR), lastAttemptAt: at(-HOUR), lastSuccessAt: null, failures: 1,
            lastError: 'port 80 is not reachable from the internet',
        };
        mockNode(() => tlsStatus({ identifiers: [...tlsStatus().identifiers, kept] }), { '/public-address/own': [[200, { success: true }]] }, sent);
        render(<PublicAddressPanel activeNode={node} />);
        await card();
        const coop = row('coop.example.net');
        expect(within(coop).getByTestId('own-address-error')).toHaveTextContent(/Last try .+: port 80 is not reachable from the internet/);
        expect(within(coop).queryByRole('button', { name: 'Try again now' })).toBeNull();
        expect(within(coop).getByRole('button', { name: 'Remove coop.example.net' })).toBeInTheDocument();
        // The IP beside the community's domain still offers it, and nothing was sent.
        expect(within(row('203.0.113.5')).getByRole('button', { name: 'Try again now' })).toBeInTheDocument();
        expect(sent).toHaveLength(0);
    });

    it('Remove asks in the page first, then the fresh proof; Keep it sends nothing', async () => {
        const sent: Sent[] = [];
        mockNode(() => tlsStatus(), { '/app-addresses/remove': [[401, CODE_ASK], [200, { addresses: [], unconfirmed: [], oldApps: { today: 0, busiestDay: 0 } }]] }, sent);
        render(<PublicAddressPanel activeNode={node} />);
        await card();
        fireEvent.click(within(row('203.0.113.5')).getByRole('button', { name: 'Remove 203.0.113.5' }));
        expect(await screen.findByTestId('in-page-confirm')).toHaveTextContent("Members' apps that use it are refused after this.");
        fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
        await new Promise((r) => setTimeout(r, 20));
        expect(sent).toHaveLength(0);
        fireEvent.click(within(row('beans.example.org')).getByRole('button', { name: 'Remove beans.example.org' }));
        expect(await screen.findByTestId('in-page-confirm')).toHaveTextContent("It is this community's address.");
        fireEvent.click(within(screen.getByTestId('in-page-confirm')).getByRole('button', { name: 'Remove' }));
        const input = await screen.findByTestId('own-address-proof-input');
        expect(sent).toEqual([{ path: '/app-addresses/remove', body: { address: 'beans.example.org' } }]);
        fireEvent.change(input, { target: { value: '654321' } });
        fireEvent.click(screen.getByTestId('own-address-proof-confirm'));
        await waitFor(() => expect(screen.getByTestId('own-address-message')).toHaveTextContent('beans.example.org removed.'));
        expect(sent[1].body).toEqual({ address: 'beans.example.org', code: '654321' });
        // Asked once: the retry with the code is the same removal.
        expect(screen.queryByTestId('in-page-confirm')).toBeNull();
    });

    it('a test CA and a standby say so; a standby offers nothing to add or remove', async () => {
        mockNode(() => tlsStatus({ testCa: true, orders: false }), {}, []);
        render(<PublicAddressPanel activeNode={node} />);
        await card();
        expect(screen.getByTestId('own-address-test-ca')).toHaveTextContent("This server asks Let's Encrypt's test service (ACME_DIRECTORY_URL)");
        expect(screen.getByTestId('own-address-standby')).toHaveTextContent('This is a standby: it asks for no certificates.');
        expect(within(screen.getByTestId('own-address-card')).queryByRole('button', { name: /Remove|Try again|Use this/ })).toBeNull();
    });
});

describe('AppAddressesPanel: Remove asks an owner\'s fresh proof (HTTPS S4)', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('the box opens on the node\'s ask; Confirm re-sends the removal once, with the code', async () => {
        const sent: Sent[] = [];
        const report = { addresses: [{ address: 'community.example.org', source: 'owner', today: 1, busiestDay: 2 }], unconfirmed: [], heldBack: [], named: true,
            oldApps: { today: 0, busiestDay: 0 }, unboundSignaturesUntil: null, unboundSignaturesAccepted: false };
        vi.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
            if (opts?.method === 'POST' && String(url).includes('/app-addresses/remove')) {
                sent.push({ path: 'remove', body: JSON.parse(String(opts.body || '{}')) });
                return sent.length === 1 ? json(401, { ...CODE_ASK, error: CODE_ASK.error.replace('203.0.113.5', 'community.example.org') })
                    : json(200, { ...report, addresses: [], named: false });
            }
            return json(200, report);
        });
        render(<AppAddressesPanel activeNode={node} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Remove community.example.org' }));
        const input = await screen.findByTestId('app-address-proof-input');
        expect(screen.getByText(/to remove community\.example\.org/)).toBeInTheDocument();
        expect(screen.queryByRole('alert')).toBeNull();
        fireEvent.change(input, { target: { value: '112233' } });
        fireEvent.click(screen.getByTestId('app-address-proof-confirm'));
        await waitFor(() => expect(screen.queryByTestId('app-address')).toBeNull());
        expect(sent.map((s) => s.body)).toEqual([{ address: 'community.example.org' }, { address: 'community.example.org', code: '112233' }]);
        expect(screen.queryByTestId('app-address-proof-input')).toBeNull();
    });
});

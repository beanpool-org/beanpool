import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { TreasuryDetailPage } from './TreasuryDetailPage';
import * as api from '../lib/api';
import * as identityLib from '../lib/identity';

describe('Enterprise Keepers & Succession (Slice 6)', () => {
    const mockLeadIdentity = {
        publicKey: 'lead-alice-pubkey',
        callsign: 'Alice',
        tier: 'Elder',
    } as any;

    const mockApplicantIdentity = {
        publicKey: 'applicant-charlie-pubkey',
        callsign: 'Charlie',
        tier: 'Resident',
    } as any;

    const mockKeeperIdentity = {
        publicKey: 'keeper-bob-pubkey',
        callsign: 'Bob',
        tier: 'Resident',
    } as any;

    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(api, 'getBalance').mockResolvedValue({
            balance: 50,
            keeperOf: [],
        } as any);
        vi.spyOn(api, 'getEnterpriseLedger').mockResolvedValue({
            enterprise: {
                publicKey: 'enterprise-eggs-pubkey',
                name: 'Community Eggs',
                status: 'active',
                paused: false,
                balance: 100,
            },
            period: { since: null, until: null },
            summary: {
                totalIncome: 0,
                totalSpend: 0,
                netChange: 0,
                startingBalance: 100,
                endingBalance: 100,
                transactionCount: 0,
            },
            entries: [],
        } as any);
    });

    it('displays Lead keeper badge vs Keeper badge in Accountable Keepers card', async () => {
        const mockTreasury = {
            publicKey: 'enterprise-eggs-pubkey',
            name: 'Community Eggs',
            status: 'active',
            paused: false,
            balance: 100,
            keepers: [
                { publicKey: 'lead-alice-pubkey', callsign: 'Alice', role: 'lead', backing: 50 },
                { publicKey: 'keeper-bob-pubkey', callsign: 'Bob', role: 'keeper', backing: 0 },
            ],
            posts: [],
            flow: [],
        };
        vi.spyOn(api, 'getTreasury').mockResolvedValue(mockTreasury);

        render(
            <TreasuryDetailPage
                identity={mockApplicantIdentity}
                pubkey="enterprise-eggs-pubkey"
                onBack={vi.fn()}
            />
        );

        expect(await screen.findByText(/Accountable Keepers \(2\)/i)).toBeInTheDocument();
        expect(screen.getByText('Alice')).toBeInTheDocument();
        expect(screen.getByText('Bob')).toBeInTheDocument();
        expect(screen.getByText('Lead keeper')).toBeInTheDocument();
        expect(screen.getByText('Keeper')).toBeInTheDocument();
        expect(screen.getByText('+50 🫘')).toBeInTheDocument();
        // Vocabulary check: never owner, never steward
        expect(screen.queryByText(/owner/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/steward/i)).not.toBeInTheDocument();
    });

    it('opens a keeper profile when a keeper row is tapped, with a 48px target', async () => {
        vi.spyOn(api, 'getTreasury').mockResolvedValue({
            publicKey: 'enterprise-eggs-pubkey',
            name: 'Community Eggs',
            status: 'active',
            paused: false,
            balance: 100,
            keepers: [
                { publicKey: 'lead-alice-pubkey', callsign: 'Alice', role: 'lead', backing: 50 },
                // Older payloads carry the key as pubkey rather than publicKey.
                { pubkey: 'keeper-bob-pubkey', callsign: 'Bob', role: 'keeper', backing: 0 },
            ],
            posts: [],
            flow: [],
        });
        const onOpenProfile = vi.fn();

        render(
            <TreasuryDetailPage
                identity={mockApplicantIdentity}
                pubkey="enterprise-eggs-pubkey"
                onBack={vi.fn()}
                onOpenProfile={onOpenProfile}
            />
        );

        const bobRow = (await screen.findByText('Bob')).closest('button');
        expect(bobRow).not.toBeNull();
        expect(bobRow).toHaveAttribute('type', 'button');
        expect(bobRow!.className).toContain('min-h-[48px]');
        fireEvent.click(bobRow!);
        expect(onOpenProfile).toHaveBeenCalledWith('keeper-bob-pubkey');

        fireEvent.click(screen.getByText('Alice').closest('button')!);
        expect(onOpenProfile).toHaveBeenLastCalledWith('lead-alice-pubkey');
    });

    it('leaves keeper rows as plain rows when nothing can open a profile', async () => {
        vi.spyOn(api, 'getTreasury').mockResolvedValue({
            publicKey: 'enterprise-eggs-pubkey',
            name: 'Community Eggs',
            status: 'active',
            paused: false,
            balance: 100,
            keepers: [{ publicKey: 'keeper-bob-pubkey', callsign: 'Bob', role: 'keeper', backing: 0 }],
            posts: [],
            flow: [],
        });

        render(<TreasuryDetailPage identity={mockApplicantIdentity} pubkey="enterprise-eggs-pubkey" onBack={vi.fn()} />);

        expect((await screen.findByText('Bob')).closest('button')).toBeNull();
    });

    it('shows a suspended keeper labelled as suspended instead of hiding them (PR #838 B1)', async () => {
        const mockTreasury = {
            publicKey: 'enterprise-eggs-pubkey',
            name: 'Community Eggs',
            status: 'active',
            paused: false,
            balance: 100,
            keepers: [
                { publicKey: 'lead-alice-pubkey', callsign: 'Alice', role: 'lead', backing: 50, suspended: true },
                { publicKey: 'keeper-bob-pubkey', callsign: 'Bob', role: 'keeper', backing: 0, suspended: false },
            ],
            posts: [],
            flow: [],
        };
        vi.spyOn(api, 'getTreasury').mockResolvedValue(mockTreasury);

        render(
            <TreasuryDetailPage
                identity={mockApplicantIdentity}
                pubkey="enterprise-eggs-pubkey"
                onBack={vi.fn()}
            />
        );

        expect(await screen.findByText(/Accountable Keepers \(2\)/i)).toBeInTheDocument();
        expect(screen.getByText('Alice')).toBeInTheDocument();
        expect(screen.getAllByText('Suspended')).toHaveLength(1);
    });

    it('renders single control "Back this enterprise with your standing: 0 … <available>" and submits join request', async () => {
        const mockTreasury = {
            publicKey: 'enterprise-eggs-pubkey',
            name: 'Community Eggs',
            status: 'active',
            paused: false,
            balance: 100,
            availableToBack: 80,
            keepers: [
                { publicKey: 'lead-alice-pubkey', callsign: 'Alice', role: 'lead', backing: 50 },
            ],
            posts: [],
            flow: [],
        };
        vi.spyOn(api, 'getTreasury').mockResolvedValue(mockTreasury);
        const requestSpy = vi.spyOn(api, 'requestToJoinEnterprise').mockResolvedValue({
            success: true,
            request: {
                id: 'req-1',
                enterprisePubkey: 'enterprise-eggs-pubkey',
                memberPubkey: 'applicant-charlie-pubkey',
                pledgedBacking: 30,
                status: 'pending',
                createdAt: new Date().toISOString(),
            },
        });

        render(
            <TreasuryDetailPage
                identity={mockApplicantIdentity}
                pubkey="enterprise-eggs-pubkey"
                onBack={vi.fn()}
            />
        );

        expect(await screen.findByText('Ask to Join as a Keeper')).toBeInTheDocument();
        expect(screen.getByText(/Back this enterprise with your standing: 0 … 80/i)).toBeInTheDocument();

        // Change backing pledge to 30
        const input = screen.getByLabelText(/Back this enterprise with your standing: 0 … 80/i);
        fireEvent.change(input, { target: { value: '30' } });

        const submitBtn = screen.getByRole('button', { name: /request to join as keeper/i });
        fireEvent.click(submitBtn);

        await waitFor(() => {
            expect(requestSpy).toHaveBeenCalledWith('enterprise-eggs-pubkey', 30);
        });
    });

    it('renders pending keeper requests panel for lead keeper and handles approve and decline', async () => {
        const mockTreasury = {
            publicKey: 'enterprise-eggs-pubkey',
            name: 'Community Eggs',
            status: 'active',
            paused: false,
            balance: 100,
            isLeadOrSoleKeeperOrAdmin: true,
            keepers: [
                { publicKey: 'lead-alice-pubkey', callsign: 'Alice', role: 'lead', backing: 50 },
            ],
            keeperRequests: [
                {
                    id: 'req-charlie',
                    enterprisePubkey: 'enterprise-eggs-pubkey',
                    memberPubkey: 'applicant-charlie-pubkey',
                    callsign: 'Charlie',
                    pledgedBacking: 25,
                    status: 'pending',
                    createdAt: new Date().toISOString(),
                },
            ],
            posts: [],
            flow: [],
        };
        vi.spyOn(api, 'getTreasury').mockResolvedValue(mockTreasury);
        vi.spyOn(api, 'getBalance').mockResolvedValue({
            balance: 100,
            keeperOf: ['enterprise-eggs-pubkey'],
        } as any);

        const approveSpy = vi.spyOn(api, 'approveKeeperRequest').mockResolvedValue({
            success: true,
            backing: 25,
            applied: true,
            change: null,
        });
        const declineSpy = vi.spyOn(api, 'declineKeeperRequest').mockResolvedValue({
            success: true,
        });

        const { rerender } = render(
            <TreasuryDetailPage
                identity={mockLeadIdentity}
                pubkey="enterprise-eggs-pubkey"
                onBack={vi.fn()}
            />
        );

        expect(await screen.findByText(/Pending Keeper Requests \(1\)/i)).toBeInTheDocument();
        expect(screen.getByText('Charlie')).toBeInTheDocument();
        expect(screen.getByText('25 🫘')).toBeInTheDocument();

        // Click approve
        const approveBtn = screen.getByRole('button', { name: /approve/i });
        fireEvent.click(approveBtn);

        await waitFor(() => {
            expect(approveSpy).toHaveBeenCalledWith('enterprise-eggs-pubkey', 'req-charlie');
        });

        // Test decline
        rerender(
            <TreasuryDetailPage
                identity={mockLeadIdentity}
                pubkey="enterprise-eggs-pubkey"
                onBack={vi.fn()}
            />
        );
        const declineBtn = screen.getByRole('button', { name: /decline/i });
        fireEvent.click(declineBtn);

        await waitFor(() => {
            expect(declineSpy).toHaveBeenCalledWith('enterprise-eggs-pubkey', 'req-charlie');
        });
    });

    it('renders lead succession section when lead is inactive >= 30 days and allows keeper to propose or vote', async () => {
        const mockTreasury = {
            publicKey: 'enterprise-eggs-pubkey',
            name: 'Community Eggs',
            status: 'active',
            paused: false,
            balance: 100,
            keepers: [
                { publicKey: 'lead-alice-pubkey', callsign: 'Alice', role: 'lead', backing: 50 },
                { publicKey: 'keeper-bob-pubkey', callsign: 'Bob', role: 'keeper', backing: 20 },
                { publicKey: 'keeper-charlie-pubkey', callsign: 'Charlie', role: 'keeper', backing: 10 },
            ],
            leadInactivity: {
                leadPubkey: 'lead-alice-pubkey',
                leadCallsign: 'Alice',
                daysInactive: 32,
                isEligible: true,
                isEligibleForSuccession: true,
            },
            succession: {
                inactivity: {
                    leadPubkey: 'lead-alice-pubkey',
                    leadCallsign: 'Alice',
                    daysInactive: 32,
                    isEligible: true,
                    isEligibleForSuccession: true,
                },
                proposals: [],
            },
            posts: [],
            flow: [],
        };
        vi.spyOn(api, 'getTreasury').mockResolvedValue(mockTreasury);
        vi.spyOn(api, 'getBalance').mockResolvedValue({
            balance: 50,
            keeperOf: ['enterprise-eggs-pubkey'],
        } as any);

        const proposeSpy = vi.spyOn(api, 'proposeEnterpriseSuccession').mockResolvedValue({
            success: true,
            executed: false,
            proposal: {
                id: 'prop-1',
                enterprisePubkey: 'enterprise-eggs-pubkey',
                leadPubkey: 'lead-alice-pubkey',
                candidatePubkey: 'keeper-bob-pubkey',
                candidateCallsign: 'Bob',
                votesCount: 1,
                votesRequired: 2,
                status: 'active',
            } as any,
            status: 'active',
            votesCount: 1,
            votesRequired: 2,
            leadMoved: false,
        });

        render(
            <TreasuryDetailPage
                identity={mockKeeperIdentity}
                pubkey="enterprise-eggs-pubkey"
                onBack={vi.fn()}
            />
        );

        expect(await screen.findByText(/Lead Keeper Inactive \(32 days\)/i)).toBeInTheDocument();
        expect(screen.getByText('Propose an Active Keeper as Lead')).toBeInTheDocument();

        const select = screen.getByRole('combobox');
        fireEvent.change(select, { target: { value: 'keeper-bob-pubkey' } });

        const proposeBtn = screen.getByRole('button', { name: /propose lead/i });
        fireEvent.click(proposeBtn);

        await waitFor(() => {
            expect(proposeSpy).toHaveBeenCalledWith('enterprise-eggs-pubkey', 'keeper-bob-pubkey');
        });
    });
});

// A keeper sets, moves, makes approximate or clears the enterprise's own map pin (docs/the-commons.md §2.2, §10).
// The pin is public, so the keeper must see the same warning the settings app shows, with Approximate inside it.
describe('Enterprise map pin (keeper control)', () => {
    const ENTERPRISE = 'enterprise-eggs-pubkey';

    const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    const secretKey = ed25519.utils.randomSecretKey();
    const bobPublicKey = toHex(ed25519.getPublicKey(secretKey));
    const bob = { publicKey: bobPublicKey, privateKey: toHex(secretKey), callsign: 'Bob', createdAt: '2026-01-01T00:00:00.000Z' } as any;

    const enterprise = (overrides: Record<string, any> = {}) => ({
        publicKey: ENTERPRISE,
        name: 'Community Eggs',
        status: 'active',
        paused: false,
        balance: 100,
        lat: null,
        lng: null,
        keepers: [
            { publicKey: 'lead-alice-pubkey', callsign: 'Alice', role: 'lead', backing: 50, suspended: false },
            { publicKey: bobPublicKey, callsign: 'Bob', role: 'keeper', backing: 10, suspended: false },
        ],
        posts: [],
        flow: [],
        ...overrides,
    });

    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(api, 'getEnterpriseLedger').mockResolvedValue({
            enterprise: { publicKey: ENTERPRISE, name: 'Community Eggs', status: 'active', paused: false, balance: 100 },
            period: { since: null, until: null },
            summary: { totalIncome: 0, totalSpend: 0, netChange: 0, startingBalance: 100, endingBalance: 100, transactionCount: 0 },
            entries: [],
        } as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 50, keeperOf: [ENTERPRISE] } as any);
        vi.spyOn(identityLib, 'loadIdentity').mockResolvedValue(bob);
        fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
            if (String(url).endsWith(`/api/enterprise/${ENTERPRISE}/location`)) {
                const body = init?.body ? JSON.parse(String(init.body)) : {};
                const cleared = init?.method === 'DELETE';
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ success: true, lat: cleared ? null : body.lat, lng: cleared ? null : body.lng, locationAuthSigner: bobPublicKey }),
                } as any;
            }
            return { ok: true, status: 200, json: async () => ({ messages: [], readOnly: false }) } as any;
        });
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const locationCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith(`/api/enterprise/${ENTERPRISE}/location`));

    it('shows an active keeper the map pin control, with the public-visibility warning and Approximate inside it', async () => {
        vi.spyOn(api, 'getTreasury').mockResolvedValue(enterprise());

        render(<TreasuryDetailPage identity={bob} pubkey={ENTERPRISE} onBack={vi.fn()} />);

        const control = await screen.findByTestId('enterprise-map-pin-control');
        expect(within(control).getByText('Not on the map')).toBeInTheDocument();
        fireEvent.click(within(control).getByRole('button', { name: 'Set map pin' }));

        const warning = await screen.findByTestId('enterprise-location-visibility');
        expect(within(warning).getByText("Anyone who opens this node's map will see this spot.")).toBeInTheDocument();
        expect(warning).toHaveTextContent('The flock, shed, or garden is often at someone’s house. Use Approximate to round the location to roughly 100 m.'); // toHaveTextContent folds the &nbsp; to a space
        expect(within(warning).getByRole('button', { name: 'Approximate (~100m)' })).toBeInTheDocument();
    });

    it('does not offer the control to a member who is not a keeper', async () => {
        vi.spyOn(api, 'getTreasury').mockResolvedValue(enterprise({
            keepers: [{ publicKey: 'lead-alice-pubkey', callsign: 'Alice', role: 'lead', backing: 50, suspended: false }],
        }));
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 50, keeperOf: ['some-other-enterprise'] } as any);

        render(<TreasuryDetailPage identity={bob} pubkey={ENTERPRISE} onBack={vi.fn()} />);

        expect(await screen.findByText(/Accountable Keepers \(1\)/i)).toBeInTheDocument();
        expect(screen.queryByTestId('enterprise-map-pin-control')).not.toBeInTheDocument();
        expect(screen.queryByTestId('enterprise-location-visibility')).not.toBeInTheDocument();
    });

    it('does not offer the control to a suspended keeper, even when keeperOf still lists the enterprise', async () => {
        // keeperOf checks only the operator switch, not account status, so it can still name this enterprise.
        vi.spyOn(api, 'getTreasury').mockResolvedValue(enterprise({
            keepers: [
                { publicKey: 'lead-alice-pubkey', callsign: 'Alice', role: 'lead', backing: 50, suspended: false },
                { publicKey: bobPublicKey, callsign: 'Bob', role: 'keeper', backing: 10, suspended: true },
            ],
        }));

        render(<TreasuryDetailPage identity={bob} pubkey={ENTERPRISE} onBack={vi.fn()} />);

        expect(await screen.findByText(/Accountable Keepers \(2\)/i)).toBeInTheDocument();
        expect(screen.queryByTestId('enterprise-map-pin-control')).not.toBeInTheDocument();
    });

    it('does not offer the control on a completed (wound-up) enterprise', async () => {
        vi.spyOn(api, 'getTreasury').mockResolvedValue(enterprise({ status: 'completed', windUpFinalisedAt: '2026-09-01T00:00:00.000Z' }));

        render(<TreasuryDetailPage identity={bob} pubkey={ENTERPRISE} onBack={vi.fn()} />);

        expect(await screen.findByText(/Accountable Keepers \(2\)/i)).toBeInTheDocument();
        expect(screen.queryByTestId('enterprise-map-pin-control')).not.toBeInTheDocument();
    });

    it('saves an approximate pin with a request signed by the keeper, and the pin updates', async () => {
        vi.spyOn(api, 'getTreasury').mockResolvedValue(enterprise());

        render(<TreasuryDetailPage identity={bob} pubkey={ENTERPRISE} onBack={vi.fn()} />);

        const control = await screen.findByTestId('enterprise-map-pin-control');
        fireEvent.click(within(control).getByRole('button', { name: 'Set map pin' }));

        fireEvent.change(screen.getByLabelText('Latitude'), { target: { value: '-28.54937' } });
        fireEvent.change(screen.getByLabelText('Longitude'), { target: { value: '153.50061' } });
        fireEvent.click(within(screen.getByTestId('enterprise-location-visibility')).getByRole('button', { name: 'Approximate (~100m)' }));
        fireEvent.click(screen.getByRole('button', { name: 'Save Location' }));

        await waitFor(() => expect(within(control).getByText('On the map at -28.549, 153.501')).toBeInTheDocument());

        expect(locationCalls()).toHaveLength(1);
        const [url, init] = locationCalls()[0] as [string, RequestInit];
        expect(init.method).toBe('POST');
        expect(JSON.parse(String(init.body))).toEqual({ lat: -28.549, lng: 153.501 });

        const headers = init.headers as Record<string, string>;
        expect(headers['X-Public-Key']).toBe(bobPublicKey);
        const canonical = `POST\n${new URL(url, 'http://node').pathname}\n${headers['X-Timestamp']}\n${headers['X-Nonce']}\n${init.body}`;
        const signature = Uint8Array.from(atob(headers['X-Signature']), (c) => c.charCodeAt(0));
        expect(ed25519.verify(signature, new TextEncoder().encode(canonical), ed25519.getPublicKey(secretKey))).toBe(true);

        expect(screen.queryByTestId('enterprise-location-visibility')).not.toBeInTheDocument();
    });

    it('clears an existing pin with a signed DELETE, and the page shows it is off the map', async () => {
        vi.spyOn(api, 'getTreasury').mockResolvedValue(enterprise({ lat: -28.549, lng: 153.501 }));

        render(<TreasuryDetailPage identity={bob} pubkey={ENTERPRISE} onBack={vi.fn()} />);

        const control = await screen.findByTestId('enterprise-map-pin-control');
        expect(within(control).getByText('On the map at -28.549, 153.501')).toBeInTheDocument();
        fireEvent.click(within(control).getByRole('button', { name: 'Move or clear map pin' }));
        fireEvent.click(screen.getByRole('button', { name: 'Clear Location' }));

        await waitFor(() => expect(within(control).getByText('Not on the map')).toBeInTheDocument());

        expect(locationCalls()).toHaveLength(1);
        const [, init] = locationCalls()[0] as [string, RequestInit];
        expect(init.method).toBe('DELETE');
        const headers = init.headers as Record<string, string>;
        expect(headers['X-Public-Key']).toBe(bobPublicKey);
        const canonical = `DELETE\n/api/enterprise/${ENTERPRISE}/location\n${headers['X-Timestamp']}\n${headers['X-Nonce']}\n`;
        const signature = Uint8Array.from(atob(headers['X-Signature']), (c) => c.charCodeAt(0));
        expect(ed25519.verify(signature, new TextEncoder().encode(canonical), ed25519.getPublicKey(secretKey))).toBe(true);
    });

    it('keeps the web picker copy identical to the settings app picker it was ported from', () => {
        // Reference: apps/manager/src/components/modules/EnterpriseLocationPicker.tsx. Change both or neither.
        const manager = readFileSync(resolve(__dirname, '../../../manager/src/components/modules/EnterpriseLocationPicker.tsx'), 'utf8');
        const web = readFileSync(resolve(__dirname, '../components/EnterpriseLocationPicker.tsx'), 'utf8');
        const copy = [
            '<span>Enterprise Map Location</span>',
            'Anyone who opens this node&apos;s map will see this spot.',
            'The flock, shed, or garden is often at someone’s house. Use <strong>Approximate</strong> to round the location to roughly 100&nbsp;m.',
            'Approximate (~100m)',
            "'Please pick a spot on the map or enter coordinates'",
            "'Latitude must be between -90 and 90, longitude between -180 and 180'",
            "'Failed to save location'",
            "'Failed to clear location'",
            "{clearing ? 'Clearing...' : 'Clear Location'}",
            "{saving ? 'Saving...' : 'Save Location'}",
            'const approx = approximateLocation(lat, lng);',
        ];
        for (const text of copy) {
            expect(manager, `settings picker has: ${text}`).toContain(text);
            expect(web, `web picker has: ${text}`).toContain(text);
        }
        // The Approximate button lives INSIDE the warning box in both.
        const insideWarning = /data-testid="enterprise-location-visibility"[\s\S]*?Anyone who opens this node&apos;s map will see this spot\.[\s\S]*?Approximate \(~100m\)\s*<\/button>\s*<\/div>/;
        expect(manager).toMatch(insideWarning);
        expect(web).toMatch(insideWarning);
    });
});

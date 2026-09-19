import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ColdStartWizard } from './ColdStartWizard';
import type { NodeProfile } from '../../lib/profiles';
import * as nodeClient from '../../lib/node-client';

const mockProfile: NodeProfile = {
    id: 'test-node',
    name: 'Fresh Sovereign Node',
    url: 'https://mullum.local',
    adminPassword: 'admin-password',
};

const mockDiag = {
    callsign: 'mullum-node',
    communityName: 'Mullumbimby Commons',
    status: 'healthy',
    uptimeSeconds: 100,
    totalMemoryMb: 512,
    cpuLoadPercent: 5,
    memoryUsageMb: 50,
    dbSizeBytes: 1024 * 1024,
    walSizeBytes: 0,
    activeWsConnections: 1,
    p2pActivePeers: 0,
};

type Reply = { status: number; body?: unknown } | null;

function reply(r: Reply) {
    if (!r) return Promise.reject(new TypeError('Failed to fetch'));
    return Promise.resolve({
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        json: () => Promise.resolve(r.body ?? {}),
    });
}

/** Stubs fetch per route; anything not listed answers 200 { success: true }. */
function stubNode(routes: Record<string, Reply | ((init?: RequestInit) => Reply)> = {}) {
    const defaults: Record<string, Reply | ((init?: RequestInit) => Reply)> = {
        '/api/community/health': { status: 200, body: { ok: true } },
        '/api/local/update-identity': { status: 200, body: { success: true } },
        '/api/local/admin/2fa/status': { status: 200, body: { success: true, totpEnabled: false } },
        '/api/local/admin/2fa/setup': {
            status: 200,
            body: {
                success: true,
                secret: 'JBSWY3DPEHPK3PXP',
                formattedSecret: 'JBSW Y3DP EHPK 3PXP',
                qrDataUrl: 'data:image/png;base64,AAAA',
                backupCodes: ['aaaa-1111', 'bbbb-2222'],
            },
        },
        ...routes,
    };
    const fn = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        const key = Object.keys(defaults).find((k) => url.includes(k));
        if (!key) return reply({ status: 200, body: { success: true } });
        const r = defaults[key];
        return reply(typeof r === 'function' ? r(init) : r);
    });
    vi.stubGlobal('fetch', fn);
    return fn;
}

async function renderWizard(props: Partial<React.ComponentProps<typeof ColdStartWizard>> = {}) {
    let utils!: ReturnType<typeof render>;
    await act(async () => {
        utils = render(
            <ColdStartWizard
                activeNode={mockProfile}
                diag={mockDiag}
                nodeData={{ members: [] }}
                onComplete={vi.fn()}
                {...props}
            />
        );
    });
    return utils;
}

async function click(el: HTMLElement) {
    await act(async () => { fireEvent.click(el); });
}

describe('ColdStartWizard Component (settings-ia §4 & §6)', () => {
    beforeEach(() => {
        sessionStorage.clear();
        vi.clearAllMocks();
        localStorage.clear();
        vi.spyOn(nodeClient, 'createNodeTreasury').mockResolvedValue({
            success: true,
            publicKey: 'treasury_pk_first',
        });
        vi.spyOn(nodeClient, 'assignTreasuryKeeper').mockResolvedValue(['operator_key']);
        vi.spyOn(nodeClient, 'seedTreasuryOffer').mockResolvedValue({
            success: true,
            post: {},
        });
        vi.spyOn(nodeClient, 'generateNodeInvite').mockResolvedValue({
            success: true,
            code: 'FOUNDING-777',
            type: 'trusted',
        });
        stubNode();
    });

    afterEach(() => {
        sessionStorage.clear();
    });

    it('navigates through all 5 steps of the cold-start wizard and enforces invariants', async () => {
        const handleComplete = vi.fn();
        await renderWizard({ onComplete: handleComplete });

        // Step 1: Name & check
        expect(screen.getByText('Step 1: Name & Check Your Server')).toBeInTheDocument();
        await click(screen.getByRole('button', { name: /Next: Owner & 2FA/i }));

        expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/community/health'));
        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('/api/local/update-identity'),
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    password: 'admin-password',
                    communityName: 'Mullumbimby Commons',
                    callsign: 'mullum-node',
                }),
            })
        );

        // Step 2: 2FA is not on; moving on is never blocked
        expect(screen.getByText(/Step 2: Owner & Two-Factor Sign-In/i)).toBeInTheDocument();
        expect(screen.getByText('2FA is not on yet.')).toBeInTheDocument();
        await click(screen.getByRole('button', { name: /Next: Create First Enterprise/i }));

        // Step 3: Create First Enterprise from Preset & First Offer
        expect(screen.getByText(/Step 3: Establish First Community Enterprise/i)).toBeInTheDocument();
        expect(screen.getByText('Food & Produce')).toBeInTheDocument();
        expect(screen.getByText('Tools & Infrastructure')).toBeInTheDocument();
        expect(screen.getByText('Machinery & Transport')).toBeInTheDocument();
        await click(screen.getByRole('button', { name: /Tools & Infrastructure/i }));
        await click(screen.getByRole('button', { name: /Next: The Commons/i }));

        expect(nodeClient.createNodeTreasury).toHaveBeenCalled();
        expect(nodeClient.assignTreasuryKeeper).toHaveBeenCalled();
        expect(nodeClient.seedTreasuryOffer).toHaveBeenCalled();

        // Step 4: an explanation (Guard: NO Demurrage Slider per §6)
        expect(screen.getByText(/Step 4: How the Commons Fills/i)).toBeInTheDocument();
        expect(screen.getByText(/Fees are protocol rules/i)).toBeInTheDocument();
        expect(screen.queryByRole('slider')).not.toBeInTheDocument();
        expect(screen.queryByLabelText(/demurrage slider/i)).not.toBeInTheDocument();
        await click(screen.getByRole('button', { name: /Next: Founding Invites/i }));

        // Step 5: Generate Three Founding Invites & Printable Cards
        expect(screen.getByText(/Step 5: Three Founding Invites/i)).toBeInTheDocument();
        await click(screen.getByRole('button', { name: /Generate 3 Founding Invites/i }));

        expect(nodeClient.generateNodeInvite).toHaveBeenCalledTimes(3);
        expect(screen.getByText('Founding Invite #1')).toBeInTheDocument();
        expect(screen.getByText('Founding Invite #2')).toBeInTheDocument();
        expect(screen.getByText('Founding Invite #3')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Print Founding Cards/i })).toBeInTheDocument();

        // Steps that really happened carry ✓; 2FA was skipped, so step 2 does not.
        expect(screen.getByTestId('wizard-step-1')).toHaveTextContent('✓');
        expect(screen.getByTestId('wizard-step-2')).toHaveTextContent('⚠');
        expect(screen.getByTestId('wizard-step-2')).not.toHaveTextContent('✓');
        expect(screen.getByTestId('wizard-step-3')).toHaveTextContent('✓');

        await click(screen.getByRole('button', { name: /Exit to Dashboard/i }));

        expect(handleComplete).toHaveBeenCalledTimes(1);
        expect(localStorage.getItem('bp_cold_start_completed')).toBe('true');
        // This used to assert a '1/3 founding invites claimed' status that nothing on the node backed (no one had
        // claimed anything). The wizard no longer writes a made-up status for the home screen.
        expect(localStorage.getItem('bp_founding_invites_status')).toBeNull();
    });

    /** Walks steps 1–4 with the default mocks and lands on step 5. */
    async function goToStep5(onComplete = vi.fn()) {
        await renderWizard({ onComplete });
        await click(screen.getByRole('button', { name: /Next: Owner & 2FA/i }));
        await click(screen.getByRole('button', { name: /Next: Create First Enterprise/i }));
        await click(screen.getByRole('button', { name: /Next: The Commons/i }));
        await click(screen.getByRole('button', { name: /Next: Founding Invites/i }));
        expect(screen.getByText(/Step 5: Three Founding Invites/i)).toBeInTheDocument();
        return onComplete;
    }

    it("step 5: when the node refuses, shows its reason and no code, QR or print button — and setup can still finish", async () => {
        vi.mocked(nodeClient.generateNodeInvite).mockRejectedValue(new Error('Invalid password'));
        const onComplete = await goToStep5();

        await click(screen.getByRole('button', { name: /Generate 3 Founding Invites/i }));

        const alert = screen.getByRole('alert');
        expect(alert).toHaveTextContent('No founding invites were made');
        expect(alert).toHaveTextContent('Invalid password');
        // Stopped at the first refusal.
        expect(nodeClient.generateNodeInvite).toHaveBeenCalledTimes(1);

        expect(screen.queryByText(/Founding Invite #/)).not.toBeInTheDocument();
        expect(screen.queryByText(/FOUNDING-/)).not.toBeInTheDocument();
        expect(screen.queryByRole('img', { name: /Founding QR/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Print Founding Cards/i })).not.toBeInTheDocument();
        expect(screen.queryByText(/setup complete/i)).not.toBeInTheDocument();

        // No hard gate: the owner can finish setup and make invites later.
        await click(screen.getByRole('button', { name: /Finish setup without invites/i }));
        expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it('step 5: retry after a refusal part-way asks only for the missing invites and shows only real codes', async () => {
        vi.mocked(nodeClient.generateNodeInvite)
            .mockResolvedValueOnce({ success: true, code: 'INV-REAL-A', type: 'trusted' })
            .mockRejectedValueOnce(new Error('Only an owner or admin of this node can issue invites'))
            .mockResolvedValueOnce({ success: true, code: 'INV-REAL-B', type: 'trusted' })
            .mockResolvedValueOnce({ success: true, code: 'INV-REAL-C', type: 'trusted' });
        await goToStep5();

        await click(screen.getByRole('button', { name: /Generate 3 Founding Invites/i }));

        expect(screen.getByRole('alert')).toHaveTextContent('Only 1 of 3 founding invites were made');
        expect(screen.getByRole('alert')).toHaveTextContent('Only an owner or admin of this node can issue invites');
        expect(screen.getByText('INV-REAL-A')).toBeInTheDocument();
        expect(screen.queryByText('Founding Invite #2')).not.toBeInTheDocument();

        await click(screen.getByRole('button', { name: 'Try again for the other 2' }));

        expect(nodeClient.generateNodeInvite).toHaveBeenCalledTimes(4);
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(screen.getByText('INV-REAL-A')).toBeInTheDocument();
        expect(screen.getByText('INV-REAL-B')).toBeInTheDocument();
        expect(screen.getByText('INV-REAL-C')).toBeInTheDocument();
        expect(screen.getByText('Founding Invite #3')).toBeInTheDocument();
    });

    it('step 1: a failed Verify Reachable says so plainly, with what to check, and shows no ✓', async () => {
        stubNode({ '/api/community/health': { status: 503 } });
        await renderWizard();

        await click(screen.getByRole('button', { name: /Verify Reachable/i }));

        const alert = screen.getByRole('alert');
        expect(alert).toHaveTextContent('Your server did not answer at mullum.local');
        expect(alert).toHaveTextContent('HTTP 503');
        expect(alert).toHaveTextContent('docker compose ps');
        expect(screen.queryByText(/✓/)).not.toBeInTheDocument();
    });

    it('step 1: unreachable on Next stays on step 1 with Retry and Continue anyway, and never shows a ✓', async () => {
        let healthy = false;
        stubNode({ '/api/community/health': () => (healthy ? { status: 200 } : null) });
        await renderWizard();

        await click(screen.getByRole('button', { name: /Next: Owner & 2FA/i }));

        // Did not move on.
        expect(screen.getByText('Step 1: Name & Check Your Server')).toBeInTheDocument();
        const alert = screen.getByRole('alert');
        expect(alert).toHaveTextContent('Your server did not answer at mullum.local');
        expect(alert).toHaveTextContent('Nothing answered.');
        expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
        expect(screen.queryByText(/✓/)).not.toBeInTheDocument();

        // No hard gate: Continue anyway moves on, and step 1 is marked unfinished, not done.
        await click(screen.getByRole('button', { name: /Continue anyway/i }));
        expect(screen.getByText(/Step 2: Owner & Two-Factor Sign-In/i)).toBeInTheDocument();
        expect(screen.getByTestId('wizard-step-1')).toHaveTextContent('⚠');
        expect(screen.getByTestId('wizard-step-1')).not.toHaveTextContent('✓');

        // Back, and Retry once the server answers: now it is really done.
        await click(screen.getByRole('button', { name: /← Back/ }));
        healthy = true;
        await click(screen.getByRole('button', { name: 'Retry' }));
        expect(screen.getByText(/Step 2: Owner & Two-Factor Sign-In/i)).toBeInTheDocument();
        expect(screen.getByTestId('wizard-step-1')).toHaveTextContent('✓');
    });

    it('step 1: a name the node refused to save is reported, not passed over', async () => {
        stubNode({ '/api/local/update-identity': { status: 403, body: { error: 'Only an owner or admin of this node can change its name, place or contact details' } } });
        await renderWizard();

        await click(screen.getByRole('button', { name: /Next: Owner & 2FA/i }));

        expect(screen.getByText('Step 1: Name & Check Your Server')).toBeInTheDocument();
        expect(screen.getByRole('alert')).toHaveTextContent('Your community name was not saved');
        expect(screen.getByRole('alert')).toHaveTextContent('Only an owner or admin');
        await click(screen.getByRole('button', { name: /Continue anyway/i }));
        expect(screen.getByTestId('wizard-step-1')).toHaveTextContent('⚠');
    });

    it('step 2: no made-up recovery material and no pairing QR; the owner link is the app\'s Manage button', async () => {
        await renderWizard();
        await click(screen.getByRole('button', { name: /Next: Owner & 2FA/i }));

        expect(document.body.textContent).not.toMatch(/BP-RECOVERY/);
        expect(document.body.textContent).not.toMatch(/emergency seed/i);
        expect(screen.queryByAltText(/Pair Owner QR/i)).not.toBeInTheDocument();
        expect(document.body.innerHTML).not.toContain('pair-owner');
        expect(screen.getByText(/Owners & admins/)).toBeInTheDocument();
        expect(screen.getByText(/Manage Mullumbimby Commons/)).toBeInTheDocument();
        // With 2FA off there are no backup codes, so there is no kit to download.
        expect(screen.queryByRole('button', { name: /Recovery Kit/i })).not.toBeInTheDocument();
    });

    it('the wizard source carries no BP-RECOVERY seed, emergency seed or pair-owner link', () => {
        const src = fs.readFileSync(path.resolve(__dirname, 'ColdStartWizard.tsx'), 'utf8');
        expect(src).not.toMatch(/BP-RECOVERY/);
        expect(src).not.toMatch(/emergencySeed|Emergency Seed/);
        expect(src).not.toMatch(/pair-owner/);
    });

    it('step 2: 2FA shows "on" only after the node accepts a code, then the kit holds the real backup codes', async () => {
        let verifyCalls = 0;
        stubNode({
            '/api/local/admin/2fa/verify': (init) => {
                verifyCalls++;
                const { code } = JSON.parse(String(init?.body));
                return code === '654321'
                    ? { status: 200, body: { success: true, totpEnabled: true, tfaSessionToken: 'tfa-fresh' } }
                    : { status: 400, body: { success: false, error: 'Invalid 6-digit 2FA code — check authenticator app time sync' } };
            },
        });
        vi.spyOn(nodeClient, 'setTfaSessionToken');
        await renderWizard();
        await click(screen.getByRole('button', { name: /Next: Owner & 2FA/i }));

        expect(screen.getByText('2FA is not on yet.')).toBeInTheDocument();
        await click(screen.getByRole('button', { name: 'Set up 2FA' }));
        expect(screen.getByAltText('Authenticator setup QR')).toBeInTheDocument();
        expect(screen.getByText('JBSW Y3DP EHPK 3PXP')).toBeInTheDocument();
        // A secret on screen is not 2FA on.
        expect(screen.queryByText(/2FA is on/)).not.toBeInTheDocument();
        expect(screen.getByText('2FA is not on yet.')).toBeInTheDocument();
        // Backup codes are pending until verified: not shown yet.
        expect(screen.queryByText('aaaa-1111')).not.toBeInTheDocument();

        // A wrong code: still not on, and the node's reason shows.
        fireEvent.change(screen.getByLabelText('Code from your authenticator'), { target: { value: '000000' } });
        await click(screen.getByRole('button', { name: 'Turn on 2FA' }));
        expect(verifyCalls).toBe(1);
        expect(screen.queryByText(/2FA is on/)).not.toBeInTheDocument();
        expect(screen.getByRole('alert')).toHaveTextContent('Invalid 6-digit 2FA code');

        // The right code: the node confirms, and only now does the wizard say on.
        fireEvent.change(screen.getByLabelText('Code from your authenticator'), { target: { value: '654321' } });
        await click(screen.getByRole('button', { name: 'Turn on 2FA' }));
        expect(screen.getByText(/✓ 2FA is on/)).toBeInTheDocument();
        expect(nodeClient.setTfaSessionToken).toHaveBeenCalledWith('test-node', 'tfa-fresh');
        expect(screen.getByText('aaaa-1111')).toBeInTheDocument();
        expect(screen.getByText('bbbb-2222')).toBeInTheDocument();

        // The kit lists only real things: the address and the node's backup codes.
        let kitText = '';
        const OrigBlob = globalThis.Blob;
        vi.stubGlobal('Blob', class extends OrigBlob {
            constructor(parts: BlobPart[], opts?: BlobPropertyBag) {
                super(parts, opts);
                kitText = parts.map(String).join('');
            }
        });
        await click(screen.getByRole('button', { name: /Download Recovery Kit/i }));
        vi.stubGlobal('Blob', OrigBlob);
        expect(kitText).toContain('https://mullum.local');
        expect(kitText).toContain('aaaa-1111');
        expect(kitText).toContain('bbbb-2222');
        expect(kitText).not.toMatch(/BP-RECOVERY|Emergency Seed|JBSWY3DPEHPK3PXP/);
        expect(screen.getByText(/Recovery kit downloaded/i)).toBeInTheDocument();

        // Later calls carry the fresh 2FA session.
        await click(screen.getByRole('button', { name: /Next: Create First Enterprise/i }));
        await click(screen.getByRole('button', { name: /Next: The Commons/i }));
        expect(nodeClient.createNodeTreasury).toHaveBeenCalledWith(
            mockProfile.url, expect.any(Object), mockProfile.adminPassword, 'tfa-fresh'
        );
        expect(screen.getByTestId('wizard-step-2')).toHaveTextContent('✓');
    });

    it('step 2: when the node refuses 2FA setup, says 2FA is not on and offers Access & Security', async () => {
        stubNode({ '/api/local/admin/2fa/setup': { status: 403, body: { error: 'Only an owner of this node can set up 2FA' } } });
        const onOpenAccessSecurity = vi.fn();
        await renderWizard({ onOpenAccessSecurity });
        await click(screen.getByRole('button', { name: /Next: Owner & 2FA/i }));

        await click(screen.getByRole('button', { name: 'Set up 2FA' }));
        expect(screen.getByRole('alert')).toHaveTextContent('2FA is not on. The node said: Only an owner of this node can set up 2FA');
        expect(screen.queryByText(/2FA is on/)).not.toBeInTheDocument();

        await click(screen.getByRole('button', { name: /Open Access & Security/i }));
        expect(onOpenAccessSecurity).toHaveBeenCalledTimes(1);
    });

    it('step 2: 2FA the node reports as already on shows as on, without starting a new setup', async () => {
        stubNode({ '/api/local/admin/2fa/status': { status: 401, body: { error: '2FA code required', totpRequired: true } } });
        await renderWizard();
        await click(screen.getByRole('button', { name: /Next: Owner & 2FA/i }));

        expect(screen.getByText(/✓ 2FA is on/)).toBeInTheDocument();
        expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining('/2fa/setup'), expect.anything());
    });

    it('step 4 never claims a transfer: it moves no beans, asks for no amount, and calls nothing on the node', async () => {
        await renderWizard();
        await click(screen.getByRole('button', { name: /Next: Owner & 2FA/i }));
        await click(screen.getByRole('button', { name: /Next: Create First Enterprise/i }));
        await click(screen.getByRole('button', { name: /Next: The Commons/i }));
        expect(screen.getByText(/Step 4: How the Commons Fills/i)).toBeInTheDocument();

        expect(screen.getByText(/starts at 0 beans/)).toBeInTheDocument();
        expect(screen.getByText(/this step moves none/)).toBeInTheDocument();
        expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
        expect(screen.queryByText(/Bootstrap Grant/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/seeded|minted/i)).not.toBeInTheDocument();

        const callsBefore = vi.mocked(global.fetch).mock.calls.length;
        await click(screen.getByRole('button', { name: /Next: Founding Invites/i }));
        expect(vi.mocked(global.fetch).mock.calls.length).toBe(callsBefore);
        expect(screen.queryByText(/beans (were )?(moved|added|seeded)/i)).not.toBeInTheDocument();
    });

    it('forwards 2FA session token to identity, treasury, keeper, offer, and invite calls when tfaToken is provided', async () => {
        await renderWizard({ tfaToken: 'tfa-wizard-token' });

        await click(screen.getByRole('button', { name: /Next: Owner & 2FA/i }));
        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('/api/local/update-identity'),
            expect.objectContaining({
                headers: expect.objectContaining({
                    'X-Admin-Password': 'admin-password',
                    'X-Admin-2FA-Session': 'tfa-wizard-token',
                }),
            })
        );

        await click(screen.getByRole('button', { name: /Next: Create First Enterprise/i }));
        await click(screen.getByRole('button', { name: /Next: The Commons/i }));

        expect(nodeClient.createNodeTreasury).toHaveBeenCalledWith(
            mockProfile.url,
            expect.any(Object),
            mockProfile.adminPassword,
            'tfa-wizard-token'
        );
        expect(nodeClient.assignTreasuryKeeper).toHaveBeenCalledWith(
            mockProfile.url,
            'treasury_pk_first',
            expect.any(String),
            mockProfile.adminPassword,
            'tfa-wizard-token'
        );
        expect(nodeClient.seedTreasuryOffer).toHaveBeenCalledWith(
            mockProfile.url,
            'treasury_pk_first',
            expect.any(Object),
            mockProfile.adminPassword,
            'tfa-wizard-token'
        );

        await click(screen.getByRole('button', { name: /Next: Founding Invites/i }));
        await click(screen.getByRole('button', { name: /Generate 3 Founding Invites/i }));

        expect(nodeClient.generateNodeInvite).toHaveBeenCalledWith(
            mockProfile.url,
            mockProfile.adminPassword,
            'trusted',
            'tfa-wizard-token'
        );
    });

    it('re-checks 2FA status and sets up 2FA with the latest effectiveTfaToken', async () => {
        const { rerender } = await renderWizard({ tfaToken: 'tfa-initial' });

        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('/api/local/admin/2fa/status'),
            expect.objectContaining({
                headers: expect.objectContaining({
                    'X-Admin-Password': 'admin-password',
                    'X-Admin-2FA-Session': 'tfa-initial',
                }),
            })
        );

        await act(async () => {
            rerender(
                <ColdStartWizard
                    activeNode={mockProfile}
                    diag={mockDiag}
                    nodeData={{ members: [] }}
                    tfaToken="tfa-updated"
                    onComplete={vi.fn()}
                />
            );
        });

        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('/api/local/admin/2fa/status'),
            expect.objectContaining({
                headers: expect.objectContaining({ 'X-Admin-2FA-Session': 'tfa-updated' }),
            })
        );

        await click(screen.getByRole('button', { name: /Next: Owner & 2FA/i }));
        await click(screen.getByRole('button', { name: 'Set up 2FA' }));
        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('/api/local/admin/2fa/setup'),
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    'X-Admin-Password': 'admin-password',
                    'X-Admin-2FA-Session': 'tfa-updated',
                }),
            })
        );
    });
});

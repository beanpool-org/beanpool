import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ColdStartWizard } from './ColdStartWizard';
import type { NodeProfile } from '../../lib/profiles';
import * as nodeClient from '../../lib/node-client';
import { PICKED_PHOTO, pickOfferPhoto } from '../common/__tests__/offer-photo-helpers';

// jsdom decodes no pictures: a picked photo comes back as PICKED_PHOTO (offer-photo-helpers).
vi.mock('../../lib/photo-resize', () => ({ resizePhotoFile: vi.fn(async () => 'data:image/jpeg;base64,cmVzaXplZA==') }));

// A real automation token's shape (bp_ + 12 hex + _ + 64 hex): only this travels as a Bearer.
const TOKEN = `bp_${'a'.repeat(12)}_${'b'.repeat(64)}`;
const mockProfile: NodeProfile = {
    id: 'test-node',
    name: 'Fresh Sovereign Node',
    url: 'https://mullum.local',
    automationToken: TOKEN,
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

/** A member the node lists as an owner: the only kind the wizard makes the first keeper. */
const ownerNodeData = { members: [{ publicKey: 'owner_pk_1', name: 'Robin', nodeRole: 'owner' as const }] };

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
        await renderWizard({ onComplete: handleComplete, nodeData: ownerNodeData });

        // Step 1: Name & check
        expect(screen.getByText('Step 1: Name & Check Your Server')).toBeInTheDocument();
        await click(screen.getByRole('button', { name: /Next: Owners/i }));

        expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/community/health'));
        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('/api/local/update-identity'),
            expect.objectContaining({
                method: 'POST',
                // The name alone: the callsign stays as stored, never one the owner didn't choose (#1935 finding 1).
                body: JSON.stringify({
                    communityName: 'Mullumbimby Commons',
                }),
            })
        );

        // Step 2: Owners. Nothing to set up here (a node has no 2FA), and moving on is never blocked.
        expect(screen.getByText(/Step 2: Owners/i)).toBeInTheDocument();
        expect(screen.getByTestId('admin-key-owner-card')).toBeInTheDocument();
        expect(screen.queryByText(/2FA/)).not.toBeInTheDocument();
        await click(screen.getByRole('button', { name: /Next: Create First Enterprise/i }));

        // Step 3: Create First Enterprise from Preset & First Offer
        expect(screen.getByText(/Step 3: Establish First Community Enterprise/i)).toBeInTheDocument();
        expect(screen.getByText('Food & Produce')).toBeInTheDocument();
        expect(screen.getByText('Tools & Infrastructure')).toBeInTheDocument();
        expect(screen.getByText('Machinery & Transport')).toBeInTheDocument();
        await click(screen.getByRole('button', { name: /Tools & Infrastructure/i }));
        expect(screen.getByTestId('cold-start-keeper')).toHaveTextContent('Robin');
        await pickOfferPhoto();
        await click(screen.getByRole('button', { name: /Next: The Commons/i }));

        expect(nodeClient.createNodeTreasury).toHaveBeenCalled();
        expect(nodeClient.assignTreasuryKeeper).toHaveBeenCalledWith(
            mockProfile.url, 'treasury_pk_first', 'owner_pk_1', mockProfile.automationToken
        );
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

        // Steps that really happened carry ✓; this session is not an owner's key, so step 2 has nothing done and does not.
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
        await click(screen.getByRole('button', { name: /Next: Owners/i }));
        await click(screen.getByRole('button', { name: /Next: Create First Enterprise/i }));
        await pickOfferPhoto();
        await click(screen.getByRole('button', { name: /Next: The Commons/i }));
        await click(screen.getByRole('button', { name: /Next: Founding Invites/i }));
        expect(screen.getByText(/Step 5: Three Founding Invites/i)).toBeInTheDocument();
        return onComplete;
    }

    it("step 5: when the node refuses, shows its reason and no code, QR or print button — and setup can still finish", async () => {
        vi.mocked(nodeClient.generateNodeInvite).mockRejectedValue(new Error("Wrong or missing token for this node — check it under the node's settings."));
        const onComplete = await goToStep5();

        await click(screen.getByRole('button', { name: /Generate 3 Founding Invites/i }));

        const alert = screen.getByRole('alert');
        expect(alert).toHaveTextContent('No founding invites were made');
        expect(alert).toHaveTextContent("Wrong or missing token for this node — check it under the node's settings.");
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

    it("step 5 says where members' copies go, as the node's info says, and where to change it (vault rethink VR2)", async () => {
        stubNode({ '/api/community/info': { status: 200, body: { recoveryCopies: 'server' } } });
        await goToStep5();
        const line = screen.getByTestId('recovery-copies-line');
        expect(line).toHaveTextContent("Where members' copies go: This server");
        expect(line).toHaveTextContent("Your server keeps members' copies. The people who run it can open them.");
        expect(line).toHaveTextContent('You can change it later under Core settings; once you confirm them, each change asks you to unlock it first.');
        // Asked once, as the wizard opened: never by a step.
        expect(vi.mocked(global.fetch).mock.calls.filter((c: any[]) => String(c[0]).includes('/api/community/info'))).toHaveLength(1);
    });

    it("step 5 draws no copies line for a node that doesn't say its rule (one from before it)", async () => {
        await goToStep5();
        expect(screen.queryByTestId('recovery-copies-line')).not.toBeInTheDocument();
    });

    it('step 1 on a community with no name: the box starts empty, Next waits for a typed name, and the save is that name alone (#1935 finding 1)', async () => {
        // The node's diagnostics give the stored name and callsign, null for none (never "BeanPool Community Node" or
        // "admin": saved untouched, that stand-in was published as the community's name).
        await renderWizard({ diag: { ...mockDiag, communityName: null, callsign: null } });
        const box = screen.getByLabelText('Community Name') as HTMLInputElement;
        expect(box.value).toBe('');
        expect(box.required).toBe(true);
        const next = screen.getByRole('button', { name: /Next: Owners/i }) as HTMLButtonElement;
        expect(next.disabled).toBe(true);
        await click(next);
        const identityCalls = () => (global.fetch as any).mock.calls.filter((c: any[]) => String(c[0]).includes('/api/local/update-identity'));
        expect(identityCalls()).toHaveLength(0);

        await act(async () => { fireEvent.change(box, { target: { value: '  Riverbend Commons ' } }); });
        expect(next.disabled).toBe(false);
        await click(next);
        expect(identityCalls()).toHaveLength(1);
        expect(JSON.parse(identityCalls()[0][1].body)).toEqual({ communityName: 'Riverbend Commons' });
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

        await click(screen.getByRole('button', { name: /Next: Owners/i }));

        // Did not move on.
        expect(screen.getByText('Step 1: Name & Check Your Server')).toBeInTheDocument();
        const alert = screen.getByRole('alert');
        expect(alert).toHaveTextContent('Your server did not answer at mullum.local');
        expect(alert).toHaveTextContent('Nothing answered.');
        expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
        expect(screen.queryByText(/✓/)).not.toBeInTheDocument();

        // No hard gate: Continue anyway moves on, and step 1 is marked unfinished, not done.
        await click(screen.getByRole('button', { name: /Continue anyway/i }));
        expect(screen.getByText(/Step 2: Owners/i)).toBeInTheDocument();
        expect(screen.getByTestId('wizard-step-1')).toHaveTextContent('⚠');
        expect(screen.getByTestId('wizard-step-1')).not.toHaveTextContent('✓');

        // Back, and Retry once the server answers: now it is really done.
        await click(screen.getByRole('button', { name: /← Back/ }));
        healthy = true;
        await click(screen.getByRole('button', { name: 'Retry' }));
        expect(screen.getByText(/Step 2: Owners/i)).toBeInTheDocument();
        expect(screen.getByTestId('wizard-step-1')).toHaveTextContent('✓');
    });

    it('step 1: a name the node refused to save is reported, not passed over', async () => {
        stubNode({ '/api/local/update-identity': { status: 403, body: { error: 'Only an owner or admin of this node can change its name, place or contact details' } } });
        await renderWizard();

        await click(screen.getByRole('button', { name: /Next: Owners/i }));

        expect(screen.getByText('Step 1: Name & Check Your Server')).toBeInTheDocument();
        expect(screen.getByRole('alert')).toHaveTextContent('Your community name was not saved');
        expect(screen.getByRole('alert')).toHaveTextContent('Only an owner or admin');
        await click(screen.getByRole('button', { name: /Continue anyway/i }));
        expect(screen.getByTestId('wizard-step-1')).toHaveTextContent('⚠');
    });

    it('step 2: no made-up recovery material and no pairing QR; an owner adds the owners under Owners & admins', async () => {
        await renderWizard();
        await click(screen.getByRole('button', { name: /Next: Owners/i }));

        expect(document.body.textContent).not.toMatch(/BP-RECOVERY/);
        expect(document.body.textContent).not.toMatch(/emergency seed/i);
        expect(screen.queryByAltText(/Pair Owner QR/i)).not.toBeInTheDocument();
        expect(document.body.innerHTML).not.toContain('pair-owner');
        expect(screen.getByTestId('admin-key-owner-card')).toHaveTextContent('People & Safety → Owners & admins');
        // There is no 2FA set-up, so there are no backup codes and no recovery kit to download.
        expect(screen.queryByRole('button', { name: /Recovery Kit/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Set up 2FA/i })).not.toBeInTheDocument();
    });

    // Since claim stages A/B the installer's phone claims the node and is its owner.
    it('step 2 under an owner key session: "You are the owner.", a second owner soon, no 2FA and no admin card', async () => {
        await renderWizard({ keySession: { memberPubkey: 'owner_pk', role: 'owner' } });
        await click(screen.getByRole('button', { name: /Next: Owners/i }));

        expect(screen.getByText('You are the owner.')).toBeInTheDocument();
        expect(screen.getByText(
            'Add a second owner soon: if this phone is lost, a second owner can still manage the community.'
        )).toBeInTheDocument();
        expect(screen.getByTestId('owner-key-owner-card')).toHaveTextContent('People & Safety → Owners & admins');
        expect(screen.queryByTestId('admin-key-owner-card')).not.toBeInTheDocument();
        expect(screen.queryByTestId('owner-key-no-2fa')).not.toBeInTheDocument();

        // The older how-to is gone.
        expect(screen.queryByText(/Your phone as owner/)).not.toBeInTheDocument();
        expect(screen.queryByText(/admin password/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/Manage Mullumbimby Commons/)).not.toBeInTheDocument();
        expect(screen.queryByText(/2FA/)).not.toBeInTheDocument();

        // Nothing is left to do in step 2, so moving on marks it ✓, not ⚠.
        await click(screen.getByRole('button', { name: /Next: Create First Enterprise/i }));
        expect(screen.getByTestId('wizard-step-2')).toHaveTextContent('✓');
    });

    it('step 2 with no key session (a token) says an owner adds the owners; no phone-as-owner how-to, no admin password, no 2FA', async () => {
        await renderWizard({ keySession: null });
        await click(screen.getByRole('button', { name: /Next: Owners/i }));

        const card = screen.getByTestId('admin-key-owner-card');
        expect(card).toHaveTextContent('An owner of this community adds the owners.');
        expect(card).toHaveTextContent('People & Safety → Owners & admins');
        expect(card).toHaveTextContent('Keep at least two owners');
        expect(screen.queryByText('Your phone as owner')).not.toBeInTheDocument();
        expect(screen.queryByText(/admin password/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/Manage Mullumbimby Commons/)).not.toBeInTheDocument();
        expect(screen.queryByText(/2FA/)).not.toBeInTheDocument();
        expect(screen.queryByText('You are the owner.')).not.toBeInTheDocument();
        expect(screen.queryByTestId('owner-key-owner-card')).not.toBeInTheDocument();

        // Nothing done in step 2 by this session: moving on marks it ⚠, never ✓.
        await click(screen.getByRole('button', { name: /Next: Create First Enterprise/i }));
        expect(screen.getByTestId('wizard-step-2')).toHaveTextContent('⚠');
        expect(screen.getByTestId('wizard-step-2')).not.toHaveTextContent('✓');
    });

    it('step 2 under an admin key session points to the owners, never "You are the owner."', async () => {
        await renderWizard({ keySession: { memberPubkey: 'admin_pk', role: 'admin' } });
        await click(screen.getByRole('button', { name: /Next: Owners/i }));

        expect(screen.getByTestId('admin-key-owner-card')).toHaveTextContent('An owner of this community adds the owners.');
        expect(screen.queryByText('You are the owner.')).not.toBeInTheDocument();
        expect(screen.queryByText(/Add a second owner soon/)).not.toBeInTheDocument();
        expect(screen.queryByTestId('owner-key-owner-card')).not.toBeInTheDocument();
        expect(screen.queryByText(/2FA/)).not.toBeInTheDocument();
    });

    it('the wizard source carries no BP-RECOVERY seed, emergency seed or pair-owner link', () => {
        const src = fs.readFileSync(path.resolve(__dirname, 'ColdStartWizard.tsx'), 'utf8');
        expect(src).not.toMatch(/BP-RECOVERY/);
        expect(src).not.toMatch(/emergencySeed|Emergency Seed/);
        expect(src).not.toMatch(/pair-owner/);
    });

    it('step 2, whoever signed in: the node is never asked about 2FA, nothing is set up, and no admin password or recovery kit is mentioned', async () => {
        for (const keySession of [null, { memberPubkey: 'admin_pk', role: 'admin' as const }, { memberPubkey: 'owner_pk', role: 'owner' as const }]) {
            vi.mocked(global.fetch).mockClear();
            const view = await renderWizard({ keySession });
            await click(screen.getByRole('button', { name: /Next: Owners/i }));
            expect(screen.getByText(/Step 2: Owners/i)).toBeInTheDocument();
            expect(vi.mocked(global.fetch).mock.calls.some((c: any[]) => String(c[0]).includes('/2fa/'))).toBe(false);
            expect(screen.queryByRole('button', { name: /2FA|Recovery Kit|Open Access/i })).not.toBeInTheDocument();
            expect(document.body.textContent).not.toMatch(/2FA|two-factor|authenticator|admin password|recovery kit/i);
            view.unmount();
        }
    });

    it('step 4 never claims a transfer: it moves no beans, asks for no amount, and calls nothing on the node', async () => {
        await renderWizard();
        await click(screen.getByRole('button', { name: /Next: Owners/i }));
        await click(screen.getByRole('button', { name: /Next: Create First Enterprise/i }));
        await pickOfferPhoto();
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

    it('sends the token as a Bearer to the identity save, and passes the credential, with no 2FA argument, to the treasury, keeper, offer and invite calls', async () => {
        await renderWizard({ nodeData: ownerNodeData });

        await click(screen.getByRole('button', { name: /Next: Owners/i }));
        const identity = (global.fetch as any).mock.calls.find((c: any[]) => String(c[0]).includes('/api/local/update-identity'));
        expect(identity[1].headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
        expect(identity[1].headers['X-Admin-Password']).toBeUndefined();
        expect(identity[1].headers['X-Admin-2FA-Session']).toBeUndefined();
        expect('password' in JSON.parse(identity[1].body)).toBe(false);

        await click(screen.getByRole('button', { name: /Next: Create First Enterprise/i }));
        await pickOfferPhoto();
        await click(screen.getByRole('button', { name: /Next: The Commons/i }));

        // The ceiling as the node takes it: whole hundredths (250 Beans is 25000), under `workingCapitalCeiling_c`.
        expect(nodeClient.createNodeTreasury).toHaveBeenCalledWith(
            mockProfile.url,
            expect.objectContaining({ workingCapitalCeiling_c: 25000 }),
            mockProfile.automationToken
        );
        expect(vi.mocked(nodeClient.createNodeTreasury).mock.calls[0][1]).not.toHaveProperty('workingCapitalCeiling');
        expect(nodeClient.assignTreasuryKeeper).toHaveBeenCalledWith(
            mockProfile.url,
            'treasury_pk_first',
            'owner_pk_1',
            mockProfile.automationToken
        );
        // The food preset's 15 Beans, as the node takes a price: `price_c`, whole hundredths, never the old `credits`.
        expect(nodeClient.seedTreasuryOffer).toHaveBeenCalledWith(
            mockProfile.url,
            'treasury_pk_first',
            expect.objectContaining({ photos: [PICKED_PHOTO], price_c: 1500 }),
            mockProfile.automationToken
        );
        expect(vi.mocked(nodeClient.seedTreasuryOffer).mock.calls[0][2]).not.toHaveProperty('credits');

        await click(screen.getByRole('button', { name: /Next: Founding Invites/i }));
        await click(screen.getByRole('button', { name: /Generate 3 Founding Invites/i }));

        expect(nodeClient.generateNodeInvite).toHaveBeenCalledWith(
            mockProfile.url,
            mockProfile.automationToken,
            'trusted'
        );
    });

    it('step 1: Retry after a refused save, with the server reachable, finishes the step with ✓', async () => {
        let saves = 0;
        stubNode({
            '/api/local/update-identity': () => (++saves === 1
                ? { status: 500, body: { error: 'database is locked' } }
                : { status: 200, body: { success: true } }),
        });
        await renderWizard();

        await click(screen.getByRole('button', { name: /Next: Owners/i }));
        expect(screen.getByRole('alert')).toHaveTextContent('database is locked');
        expect(screen.getByText(/Your server answered/)).toBeInTheDocument();

        await click(screen.getByRole('button', { name: 'Retry' }));
        expect(saves).toBe(2);
        expect(screen.getByText(/Step 2: Owners/i)).toBeInTheDocument();
        expect(screen.getByTestId('wizard-step-1')).toHaveTextContent('✓');
        expect(screen.getByTestId('wizard-step-1')).not.toHaveTextContent('⚠');
    });

    it("step 1: a save the node refuses for the token is reported in the node's own words, with Retry; no 2FA prompt is offered", async () => {
        const WRONG = "Wrong or missing token for this node — check it under the node's settings.";
        stubNode({ '/api/local/update-identity': { status: 401, body: { error: WRONG } } });
        await renderWizard();

        await click(screen.getByRole('button', { name: /Next: Owners/i }));
        expect(screen.getByText('Step 1: Name & Check Your Server')).toBeInTheDocument();
        expect(screen.getByRole('alert')).toHaveTextContent('Your community name was not saved');
        expect(screen.getByRole('alert')).toHaveTextContent(WRONG);
        expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /2FA/ })).not.toBeInTheDocument();
        expect(screen.queryByText(/authenticator/i)).not.toBeInTheDocument();
        expect(screen.getByTestId('wizard-step-1')).not.toHaveTextContent('✓');
    });

    async function goToStep3(props: Partial<React.ComponentProps<typeof ColdStartWizard>> = {}) {
        await renderWizard(props);
        await click(screen.getByRole('button', { name: /Next: Owners/i }));
        await click(screen.getByRole('button', { name: /Next: Create First Enterprise/i }));
        expect(screen.getByText(/Step 3: Establish First Community Enterprise/i)).toBeInTheDocument();
    }

    it('step 3: with no owner on the node, says no keeper will be set and appoints nobody', async () => {
        // The genesis "Admin" the server seeds is an owner nobody holds the key for: not a keeper.
        await goToStep3({
            nodeData: { members: [{ publicKey: 'genesis_pk', callsign: 'Admin', invitedBy: 'genesis', nodeRole: 'owner' }] },
        });

        expect(screen.getByTestId('cold-start-keeper')).toHaveTextContent('No keeper will be set');
        expect(document.body.textContent).not.toMatch(/Paired Admin Key|@node-owner/);
        await pickOfferPhoto();
        await click(screen.getByRole('button', { name: /Next: The Commons/i }));

        expect(nodeClient.assignTreasuryKeeper).not.toHaveBeenCalled();
        expect(screen.getByText(/Step 4: How the Commons Fills/i)).toBeInTheDocument();
        expect(screen.getByTestId('wizard-step-3')).toHaveTextContent('✓');
    });

    it('step 3: a refused first offer shows the node\'s reason and Retry, never a ✓, and Retry makes no second enterprise', async () => {
        vi.mocked(nodeClient.seedTreasuryOffer)
            .mockRejectedValueOnce(new Error('title and category are required'))
            .mockResolvedValueOnce({ success: true, post: {} });
        await goToStep3({ nodeData: ownerNodeData });

        await pickOfferPhoto();
        await click(screen.getByRole('button', { name: /Next: The Commons/i }));
        expect(screen.getByText(/Step 3: Establish First Community Enterprise/i)).toBeInTheDocument();
        const alert = screen.getByRole('alert');
        expect(alert).toHaveTextContent('The first offer was not posted. The node said: title and category are required');
        expect(alert).toHaveTextContent('was created');
        expect(screen.getByTestId('cold-start-keeper')).toHaveTextContent('✓ Keeper');

        await click(screen.getByRole('button', { name: 'Retry' }));
        expect(nodeClient.createNodeTreasury).toHaveBeenCalledTimes(1);
        expect(nodeClient.assignTreasuryKeeper).toHaveBeenCalledTimes(1);
        expect(nodeClient.seedTreasuryOffer).toHaveBeenCalledTimes(2);
        expect(screen.getByText(/Step 4: How the Commons Fills/i)).toBeInTheDocument();
        expect(screen.getByTestId('wizard-step-3')).toHaveTextContent('✓');
    });

    it('step 3: with no photo the first offer is not sent; the step says so, Retry with a photo posts only the offer, never a second enterprise', async () => {
        await goToStep3({ nodeData: ownerNodeData });

        await click(screen.getByRole('button', { name: /Next: The Commons/i }));
        expect(screen.getByText(/Step 3: Establish First Community Enterprise/i)).toBeInTheDocument();
        const alert = screen.getByRole('alert');
        expect(alert).toHaveTextContent('The first offer was not posted: every Offer needs a photo. Add one under First Offer, then Retry.');
        expect(alert).toHaveTextContent('was created');
        expect(nodeClient.createNodeTreasury).toHaveBeenCalledTimes(1);
        expect(nodeClient.assignTreasuryKeeper).toHaveBeenCalledTimes(1);
        expect(nodeClient.seedTreasuryOffer).not.toHaveBeenCalled();
        expect(screen.getByTestId('wizard-step-3')).not.toHaveTextContent('✓');

        await pickOfferPhoto();
        await click(screen.getByRole('button', { name: 'Retry' }));
        expect(nodeClient.createNodeTreasury).toHaveBeenCalledTimes(1);
        expect(nodeClient.assignTreasuryKeeper).toHaveBeenCalledTimes(1);
        expect(nodeClient.seedTreasuryOffer).toHaveBeenCalledTimes(1);
        const [nodeUrl, treasuryPk, offer] = vi.mocked(nodeClient.seedTreasuryOffer).mock.calls[0];
        expect([nodeUrl, treasuryPk]).toEqual([mockProfile.url, 'treasury_pk_first']);
        expect(offer).toEqual(expect.objectContaining({ photos: [PICKED_PHOTO] }));
        expect(screen.getByText(/Step 4: How the Commons Fills/i)).toBeInTheDocument();
        expect(screen.getByTestId('wizard-step-3')).toHaveTextContent('✓');
    });

    it('step 3: the first offer\'s price is sent to the cent as price_c; one finer than a cent is said, and not sent', async () => {
        await goToStep3({ nodeData: ownerNodeData });
        await pickOfferPhoto();
        const priceBox = screen.getByLabelText('Price (Beans)');
        fireEvent.change(priceBox, { target: { value: '12.505' } });
        // Past the box's own step (a browser refuses it there), the wizard refuses it in words and sends no offer.
        await act(async () => {
            fireEvent.submit(priceBox.closest('form')!);
        });
        expect(screen.getByRole('alert')).toHaveTextContent('The first offer was not posted: its price is Beans, to the cent. Type at most 2 decimals, like 12.5. Then Retry.');
        expect(nodeClient.seedTreasuryOffer).not.toHaveBeenCalled();
        expect(nodeClient.createNodeTreasury).toHaveBeenCalledTimes(1);

        fireEvent.change(priceBox, { target: { value: '12.50' } });
        await click(screen.getByRole('button', { name: 'Retry' }));
        expect(nodeClient.createNodeTreasury).toHaveBeenCalledTimes(1);
        expect(nodeClient.seedTreasuryOffer).toHaveBeenCalledTimes(1);
        expect(vi.mocked(nodeClient.seedTreasuryOffer).mock.calls[0][2]).toEqual(expect.objectContaining({ price_c: 1250 }));
    });

    it('step 3: with no photo, Continue anyway still moves on, with the step marked unfinished (never a hard gate)', async () => {
        await goToStep3({ nodeData: ownerNodeData });

        await click(screen.getByRole('button', { name: /Next: The Commons/i }));
        await click(screen.getByRole('button', { name: /Continue anyway/i }));
        expect(screen.getByText(/Step 4: How the Commons Fills/i)).toBeInTheDocument();
        expect(screen.getByTestId('wizard-step-3')).toHaveTextContent('⚠');
        expect(nodeClient.seedTreasuryOffer).not.toHaveBeenCalled();
    });

    it('step 3: a refused keeper shows the reason; Continue anyway marks the step unfinished', async () => {
        vi.mocked(nodeClient.assignTreasuryKeeper).mockRejectedValue(new Error('Member not found'));
        await goToStep3({ nodeData: ownerNodeData });

        await pickOfferPhoto();
        await click(screen.getByRole('button', { name: /Next: The Commons/i }));
        expect(screen.getByRole('alert')).toHaveTextContent('Robin was not made its keeper. The node said: Member not found');

        await click(screen.getByRole('button', { name: /Continue anyway/i }));
        expect(screen.getByText(/Step 4: How the Commons Fills/i)).toBeInTheDocument();
        expect(screen.getByTestId('wizard-step-3')).toHaveTextContent('⚠');
        expect(screen.getByTestId('wizard-step-3')).not.toHaveTextContent('✓');
    });

    it('step 3: a refused enterprise posts nothing else and shows the reason', async () => {
        vi.mocked(nodeClient.createNodeTreasury).mockRejectedValue(new Error('name and avatar are required'));
        await goToStep3({ nodeData: ownerNodeData });

        await pickOfferPhoto();
        await click(screen.getByRole('button', { name: /Next: The Commons/i }));
        expect(screen.getByRole('alert')).toHaveTextContent('The enterprise was not created. The node said: name and avatar are required');
        expect(nodeClient.assignTreasuryKeeper).not.toHaveBeenCalled();
        expect(nodeClient.seedTreasuryOffer).not.toHaveBeenCalled();
    });

    it('the wizard source has no made-up keeper fallback', () => {
        const src = fs.readFileSync(path.resolve(__dirname, 'ColdStartWizard.tsx'), 'utf8');
        expect(src).not.toMatch(/operator_key/);
        expect(src).not.toMatch(/Paired Admin Key/);
    });

    it('triggers onCancel when Skip to Dashboard button is clicked', async () => {
        const handleCancel = vi.fn();
        await renderWizard({ onCancel: handleCancel });

        const skipButton = screen.getByRole('button', { name: /Skip to Dashboard/i });
        await click(skipButton);

        expect(handleCancel).toHaveBeenCalledTimes(1);
    });

    it('triggers window.print when Print Founding Cards is clicked in Step 5', async () => {
        const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});
        await goToStep5();

        await click(screen.getByRole('button', { name: /Generate 3 Founding Invites/i }));
        const printButton = screen.getByRole('button', { name: /Print Founding Cards/i });
        await click(printButton);

        expect(printSpy).toHaveBeenCalledTimes(1);
        printSpy.mockRestore();
    });
});

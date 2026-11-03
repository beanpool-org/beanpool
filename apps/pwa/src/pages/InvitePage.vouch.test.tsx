import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { toEd25519Pkcs8 } from '@beanpool/core';

/**
 * Vouch for them on the web's invite screen (Marty, 3 Nov): someone who can vouch sees None, 25, 50, 100, with None on each
 * time the screen opens; a member who can't sees the screen as it was. The node decides; the page sends what the control
 * shows and nothing else, and never makes an offline ticket in place of a vouch, which would quietly carry none.
 */

const { generateInvite, getBalance, communityInfoOnce } = vi.hoisted(() => ({
    generateInvite: vi.fn(),
    getBalance: vi.fn(),
    communityInfoOnce: vi.fn(),
}));

vi.mock('../lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/api')>();
    return { ...actual, generateInvite, getBalance, getMyInvites: vi.fn(async () => ({ invites: [] })), getInviteTree: vi.fn(async () => []) };
});
vi.mock('../lib/visitor-lobby-gate', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/visitor-lobby-gate')>();
    return { ...actual, communityInfoOnce };
});
vi.mock('qrcode.react', () => ({ QRCodeSVG: () => null }));

import { InvitePage } from './InvitePage';

const SEED = Uint8Array.from({ length: 32 }, (_, i) => 7 * i + 3);
const PUB = bytesToHex(ed25519.getPublicKey(SEED));
const IDENTITY = { publicKey: PUB, privateKey: bytesToHex(toEd25519Pkcs8(SEED)), callsign: 'Ana', createdAt: '2026-09-27T00:00:00.000Z' };

const LOCAL = { features: { beans: true, invites: true, inviteVouch: true, door: 'members' } };
const invited = (code: string) => ({ success: true, invite: { code, createdBy: PUB, createdAt: new Date().toISOString(), usedBy: null, usedAt: null } });
const refusal = (status: number, message: string) => Object.assign(new Error(message), { status });

async function open(canVouch: boolean, info: unknown = LOCAL) {
    communityInfoOnce.mockResolvedValue(info);
    getBalance.mockResolvedValue({ canVouch });
    render(<InvitePage identity={IDENTITY} />);
    await waitFor(() => expect(communityInfoOnce).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: /Generate New Invite/ })).toBeTruthy());
}
const pick = (name: string) => fireEvent.click(screen.getByRole('radio', { name }));
const make = () => fireEvent.click(screen.getByRole('button', { name: /Generate New Invite/ }));

beforeEach(() => {
    localStorage.clear();
    generateInvite.mockReset();
    getBalance.mockReset();
    communityInfoOnce.mockReset();
});
afterEach(cleanup);

describe('Vouch for them', () => {
    it('shows someone who can vouch four named choices, with None on', async () => {
        await open(true);
        await waitFor(() => expect(screen.getByRole('group', { name: 'Vouch for them' })).toBeTruthy());
        const radios = screen.getAllByRole('radio') as HTMLInputElement[];
        expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual(['None', '25 Beans', '50 Beans', '100 Beans']);
        expect(radios.map((r) => r.checked)).toEqual([true, false, false, false]);
    });

    it('shows a member who can\'t vouch the screen as it was', async () => {
        await open(false);
        await waitFor(() => expect(getBalance).toHaveBeenCalled());
        expect(screen.queryByTestId('invite-vouch')).toBeNull();
    });

    it('shows nothing where the node doesn\'t say an invite can carry one: Beans off, or a node older than this', async () => {
        await open(true, { features: { beans: false, invites: true, inviteVouch: false, door: 'members' } });
        expect(screen.queryByTestId('invite-vouch')).toBeNull();
        expect(getBalance).not.toHaveBeenCalled();
        cleanup();
        await open(true, { features: { beans: true, invites: true, door: 'members' } });
        expect(screen.queryByTestId('invite-vouch')).toBeNull();
    });

    it('sends no level for None, the body as it always was', async () => {
        generateInvite.mockResolvedValue(invited('INV-AAAA'));
        await open(true);
        await waitFor(() => expect(screen.getByTestId('invite-vouch')).toBeTruthy());
        make();
        await waitFor(() => expect(generateInvite).toHaveBeenCalledTimes(1));
        expect(generateInvite).toHaveBeenCalledWith(PUB, undefined, undefined);
    });

    it('sends the level chosen, then goes back to None so a second invite carries nothing by accident', async () => {
        generateInvite.mockResolvedValue(invited('INV-BBBB'));
        await open(true);
        await waitFor(() => expect(screen.getByTestId('invite-vouch')).toBeTruthy());
        pick('50 Beans');
        expect((screen.getByRole('radio', { name: '50 Beans' }) as HTMLInputElement).checked).toBe(true);
        make();
        await waitFor(() => expect(generateInvite).toHaveBeenCalledWith(PUB, undefined, 2));
        await waitFor(() => expect((screen.getByRole('radio', { name: 'None' }) as HTMLInputElement).checked).toBe(true));
    });

    it('is on None again when the screen opens again', async () => {
        await open(true);
        await waitFor(() => expect(screen.getByTestId('invite-vouch')).toBeTruthy());
        pick('100 Beans');
        cleanup();
        await open(true);
        await waitFor(() => expect(screen.getByTestId('invite-vouch')).toBeTruthy());
        expect((screen.getByRole('radio', { name: 'None' }) as HTMLInputElement).checked).toBe(true);
    });

    it('shows the node\'s words when it refuses the vouch, and makes no ticket', async () => {
        generateInvite.mockRejectedValue(refusal(403, 'Only owners, admins and appointed vouchers can vouch for someone on an invite.'));
        await open(true);
        await waitFor(() => expect(screen.getByTestId('invite-vouch')).toBeTruthy());
        pick('25 Beans');
        make();
        await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('appointed vouchers'));
        expect(localStorage.getItem(`bp_offline_invites_${PUB}`)).toBeNull();
        expect(document.querySelector('p[title^="BP-"]')).toBeNull();
    });

    it('makes no offline ticket in place of a vouch, and says so', async () => {
        generateInvite.mockRejectedValue(new Error('Failed to fetch'));
        await open(true);
        await waitFor(() => expect(screen.getByTestId('invite-vouch')).toBeTruthy());
        pick('100 Beans');
        make();
        await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('offline ticket'));
        expect(localStorage.getItem(`bp_offline_invites_${PUB}`)).toBeNull();
        expect(document.querySelector('p[title^="BP-"]')).toBeNull();
    });

    it('still makes an offline ticket on None', async () => {
        generateInvite.mockRejectedValue(new Error('Failed to fetch'));
        await open(true);
        await waitFor(() => expect(screen.getByTestId('invite-vouch')).toBeTruthy());
        make();
        await waitFor(() => expect(document.querySelector('p[title^="BP-"]')).not.toBeNull());
        expect(generateInvite).toHaveBeenCalledWith(PUB, undefined, undefined);
    });

    it('offers no control to a page that can\'t reach the node, so a ticket is made as before', async () => {
        communityInfoOnce.mockResolvedValue(LOCAL);
        getBalance.mockRejectedValue(new Error('Failed to fetch'));
        generateInvite.mockRejectedValue(new Error('Failed to fetch'));
        render(<InvitePage identity={IDENTITY} />);
        await waitFor(() => expect(getBalance).toHaveBeenCalled());
        expect(screen.queryByTestId('invite-vouch')).toBeNull();
        make();
        await waitFor(() => expect(document.querySelector('p[title^="BP-"]')).not.toBeNull());
    });
});

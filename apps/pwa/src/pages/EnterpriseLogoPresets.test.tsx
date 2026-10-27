/**
 * enterprise-logo-presets — web tests:
 * - Propose's "Logo" (required since Pictures S4: Start says "Choose a logo" until one is) offers presets via a shared picker component.
 * - Selecting a preset sets the logo to bundled://<id> and sends that to createEnterprise.
 * - Enterprise logo edit in EnterpriseManage offers the presets.
 * - Selecting a preset sends bundled://<id> to changeEnterpriseFace.
 * - Member's own avatar in ProfilePage & ProfileSetup offers the same presets and sends bundled://<id> to updateMemberProfile.
 * - Picking a photo file still works across all forms, through the crop step (the part chosen, 512 px square;
 *   components/PictureCropDialog.tsx).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { ProjectsPage } from './ProjectsPage';
import { EnterpriseManage } from '../components/EnterpriseManage';
import { ProfilePage } from './ProfilePage';
import { ProfileSetup } from '../components/ProfileSetup';
import * as api from '../lib/api';
import * as pictureCrop from '../lib/picture-crop';

/** A photo as the crop step reads it (jsdom decodes none): its drawn crop is the stub's fixed JPEG. */
const PHOTO_READ: pictureCrop.LoadedPicture = { src: 'data:image/jpeg;base64,UkFX', width: 1600, height: 1200, image: {} as HTMLImageElement };

/** The crop step, as the member finishes it: Done on the part shown. */
async function chooseTheCrop() {
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Choose the part that shows' })).getByRole('button', { name: 'Done' }));
}

vi.mock('../lib/avatar', () => ({
    resolveAvatarUrl: vi.fn((url: string | null | undefined) => {
        if (!url) return null;
        if (url.startsWith('bundled://')) return `/avatars/avatar_${url.replace('bundled://', '')}.jpg`;
        return url;
    }),
    resolveImageUrl: vi.fn((url: string | null | undefined) => url ?? null),
}));

const mockIdentity = {
    publicKey: 'a'.repeat(64),
    privateKey: 'b'.repeat(64),
    callsign: 'Alice',
    createdAt: '2026-01-01T00:00:00.000Z',
} as any;

const sampleTreasuryDetail = {
    publicKey: 't'.repeat(64),
    name: 'Tool Library',
    purpose: 'Share communal tools',
    about: 'Weekly lending',
    since: '2026-01-01T00:00:00.000Z',
    avatar: null,
    lifecycle: 'ongoing',
    status: 'active',
    paused: false,
    balance: 50,
    creditLine: 100,
    liveOffers: 1,
    isLeadOrSoleKeeperOrAdmin: true,
    keepers: [{ publicKey: mockIdentity.publicKey, callsign: 'Alice', role: 'lead' }],
    shop: { id: 'shop-1', category: 'tools', counts: { things: 1 }, howToDeal: 'Pick up on weekends' },
} as any;

describe('enterprise logo presets (web)', () => {
    beforeEach(() => {
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getGroups').mockResolvedValue([]);
        vi.spyOn(api, 'getDecisions').mockResolvedValue({ decisions: [], myPoolVoting: null });
        vi.spyOn(api, 'createEnterprise').mockResolvedValue({ success: true, project: { id: 'p1' } } as any);
        vi.spyOn(api, 'changeEnterpriseFace').mockResolvedValue({ success: true, name: 'Tool Library', purpose: null, about: null } as any);
        vi.spyOn(api, 'changeEnterpriseShop').mockResolvedValue({ success: true } as any);
        vi.spyOn(api, 'getMemberProfile').mockResolvedValue({
            publicKey: mockIdentity.publicKey,
            callsign: 'Alice',
            avatar: null,
            bio: 'Gardener',
            contact: null,
            role: 'member',
            joinedAt: '2026-01-01T00:00:00.000Z',
        } as any);
        vi.spyOn(api, 'updateMemberProfile').mockResolvedValue({ success: true, profile: {} as any });
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 10, floor: -50, earnedCredit: 50, canVouch: true, tier: { name: 'Green Bean', emoji: '🌱' }, trustStats: { tradeCount: 1 } } as any);
        vi.spyOn(api, 'getMemberPreferences').mockResolvedValue({} as any);
        vi.spyOn(pictureCrop, 'readPictureFile').mockResolvedValue(PHOTO_READ);
        vi.spyOn(pictureCrop, 'drawPictureCrop').mockReturnValue('data:image/jpeg;base64, UkVTSVpFRF9XRUI=');
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('Propose Enterprise modal (ProjectsPage)', () => {
        it('offers preset avatars under Logo; Start says "Choose a logo" until one is picked; picking a preset sends bundled://<id>', async () => {
            render(<ProjectsPage identity={mockIdentity} />);

            fireEvent.click(await screen.findByRole('button', { name: /Start something/i }));
            const sheet = screen.getByRole('dialog', { name: /Start something/i });
            fireEvent.click(within(sheet).getByRole('button', { name: /^Enterprise/i }));

            const dialog = screen.getByRole('dialog', { name: /Start an enterprise/i });
            expect(within(dialog).getByText('LOGO')).toBeInTheDocument();
            expect(within(dialog).queryByText('Logo (optional)')).toBeNull();
            expect(within(dialog).getByRole('button', { name: 'Choose a logo' })).toBeDisabled();

            // Preset avatar buttons should be offered
            const leafPreset = within(dialog).getByRole('button', { name: 'Select Leaf avatar' });
            expect(leafPreset, 'Preset avatar button should exist in Propose modal').toBeInTheDocument();

            // Click leaf preset
            fireEvent.click(leafPreset);

            // Fill title and purpose
            fireEvent.click(within(dialog).getByRole('button', { name: /^🏛️ Enterprise/ }));
            fireEvent.change(within(dialog).getByPlaceholderText(/Community Tool Shed/i), { target: { value: 'Seed Hub' } });
            fireEvent.change(within(dialog).getByPlaceholderText(/State clearly what this enterprise exists to do/i), { target: { value: 'Seed saving and exchange' } });

            // Submit
            fireEvent.click(within(dialog).getByRole('button', { name: /Start the enterprise/i }));

            await waitFor(() => expect(api.createEnterprise).toHaveBeenCalledTimes(1));
            const sent = vi.mocked(api.createEnterprise).mock.calls[0][0];
            expect(sent.avatar).toBe('bundled://leaf');
            expect(sent.photos).toEqual(['bundled://leaf']);
        });

        it('picking a photo file still works and sends the part chosen in the crop step', async () => {
            render(<ProjectsPage identity={mockIdentity} />);

            fireEvent.click(await screen.findByRole('button', { name: /Start something/i }));
            const sheet = screen.getByRole('dialog', { name: /Start something/i });
            fireEvent.click(within(sheet).getByRole('button', { name: /^Enterprise/i }));

            const dialog = screen.getByRole('dialog', { name: /Start an enterprise/i });
            fireEvent.click(within(dialog).getByRole('button', { name: /^🏛️ Enterprise/ }));
            fireEvent.change(within(dialog).getByPlaceholderText(/Community Tool Shed/i), { target: { value: 'Tool Shed' } });
            fireEvent.change(within(dialog).getByPlaceholderText(/State clearly what this enterprise exists to do/i), { target: { value: 'Tool sharing' } });

            const fileInput = dialog.querySelector('input[type="file"]') as HTMLInputElement;
            expect(fileInput).toBeTruthy();
            const file = new File(['dummy'], 'photo.jpg', { type: 'image/jpeg' });
            fireEvent.change(fileInput, { target: { files: [file] } });
            await chooseTheCrop();

            await waitFor(() => expect(within(dialog).getByAltText('Preview')).toBeInTheDocument());

            fireEvent.click(within(dialog).getByRole('button', { name: /Start the enterprise/i }));

            await waitFor(() => expect(api.createEnterprise).toHaveBeenCalledTimes(1));
            const sent = vi.mocked(api.createEnterprise).mock.calls[0][0];
            expect(sent.avatar).toBe('data:image/jpeg;base64, UkVTSVpFRF9XRUI=');
        });
    });

    describe('Propose Enterprise modal: the deciding review of 1e784a87', () => {
        const openPropose = async () => {
            render(<ProjectsPage identity={mockIdentity} />);
            fireEvent.click(await screen.findByRole('button', { name: /Start something/i }));
            const sheet = screen.getByRole('dialog', { name: /Start something/i });
            fireEvent.click(within(sheet).getByRole('button', { name: /^Enterprise/i }));
            return screen.getByRole('dialog', { name: /Start an enterprise/i });
        };

        it("the picker's heading takes the dark modal's readable colour, never the light-card one", async () => {
            const dialog = await openPropose();
            const heading = within(dialog).getByText('Or choose an avatar:');
            expect(heading.className).toContain('text-nature-400');
            expect(heading.className).not.toContain('text-nature-600');
        });

        it('a preset chosen while a photo is still being read stays, opens no crop for the photo, and the form stops waiting', async () => {
            let finish!: (v: pictureCrop.LoadedPicture) => void;
            vi.spyOn(pictureCrop, 'readPictureFile').mockImplementation(() => new Promise((r) => { finish = r; }));
            const dialog = await openPropose();
            fireEvent.click(within(dialog).getByRole('button', { name: /^🏛️ Enterprise/ }));
            fireEvent.change(within(dialog).getByPlaceholderText(/Community Tool Shed/i), { target: { value: 'Seed Hub' } });
            fireEvent.change(within(dialog).getByPlaceholderText(/State clearly what this enterprise exists to do/i), { target: { value: 'Seed saving' } });
            const fileInput = dialog.querySelector('input[type="file"]') as HTMLInputElement;
            fireEvent.change(fileInput, { target: { files: [new File(['x'], 'slow.jpg', { type: 'image/jpeg' })] } });
            fireEvent.click(within(dialog).getByRole('button', { name: 'Select Leaf avatar' }));
            await act(async () => { finish(PHOTO_READ); });
            expect(screen.queryByRole('dialog', { name: 'Choose the part that shows' })).toBeNull();
            const submit = within(dialog).getByRole('button', { name: /Start the enterprise/i });
            expect(submit).not.toBeDisabled();
            fireEvent.click(submit);
            await waitFor(() => expect(api.createEnterprise).toHaveBeenCalledTimes(1));
            expect(vi.mocked(api.createEnterprise).mock.calls[0][0].avatar).toBe('bundled://leaf');
        });
    });

    describe('EnterpriseManage logo edit', () => {
        it('offers preset avatars in Manage logo row; picking a preset sends bundled://<id>', async () => {
            render(<EnterpriseManage treasury="t-key" detail={sampleTreasuryDetail} onSaved={vi.fn()} />);

            const manageForm = screen.getByTestId('manage-face');
            expect(within(manageForm).getByTestId('manage-face-logo-label')).toBeInTheDocument();

            // Preset avatar buttons should be offered
            const sunPreset = within(manageForm).getByRole('button', { name: 'Select Sun avatar' });
            expect(sunPreset, 'Preset avatar button should exist in EnterpriseManage').toBeInTheDocument();

            // Select sun preset
            fireEvent.click(sunPreset);

            // Save
            fireEvent.click(within(manageForm).getByRole('button', { name: 'Save' }));

            await waitFor(() => expect(api.changeEnterpriseFace).toHaveBeenCalledTimes(1));
            expect(vi.mocked(api.changeEnterpriseFace)).toHaveBeenCalledWith('t-key', expect.objectContaining({ avatar: 'bundled://sun' }));
        });

        it('a preset chosen while a logo photo is still being read stays, and opens no crop for the photo (the deciding review of 1e784a87)', async () => {
            let finish!: (v: pictureCrop.LoadedPicture) => void;
            vi.spyOn(pictureCrop, 'readPictureFile').mockImplementation(() => new Promise((r) => { finish = r; }));
            render(<EnterpriseManage treasury="t-key" detail={sampleTreasuryDetail} onSaved={vi.fn()} />);
            const manageForm = screen.getByTestId('manage-face');
            fireEvent.change(within(manageForm).getByTestId('manage-face-logo-input'), { target: { files: [new File(['x'], 'slow.jpg', { type: 'image/jpeg' })] } });
            fireEvent.click(within(manageForm).getByRole('button', { name: 'Select Sun avatar' }));
            await act(async () => { finish(PHOTO_READ); });
            expect(screen.queryByRole('dialog', { name: 'Choose the part that shows' })).toBeNull();
            const save = within(manageForm).getByRole('button', { name: 'Save' });
            expect(save).not.toBeDisabled();
            fireEvent.click(save);
            await waitFor(() => expect(api.changeEnterpriseFace).toHaveBeenCalledTimes(1));
            expect(vi.mocked(api.changeEnterpriseFace)).toHaveBeenCalledWith('t-key', expect.objectContaining({ avatar: 'bundled://sun' }));
        });

        it('picking a photo file still works and sends the part chosen in the crop step', async () => {
            render(<EnterpriseManage treasury="t-key" detail={sampleTreasuryDetail} onSaved={vi.fn()} />);

            const manageForm = screen.getByTestId('manage-face');
            const fileInput = within(manageForm).getByTestId('manage-face-logo-input');
            const file = new File(['dummy'], 'logo.jpg', { type: 'image/jpeg' });
            fireEvent.change(fileInput, { target: { files: [file] } });
            await chooseTheCrop();

            await waitFor(() => expect(within(manageForm).getByTestId('manage-face-logo-image')).toBeInTheDocument());

            fireEvent.click(within(manageForm).getByRole('button', { name: 'Save' }));

            await waitFor(() => expect(api.changeEnterpriseFace).toHaveBeenCalledTimes(1));
            expect(vi.mocked(api.changeEnterpriseFace)).toHaveBeenCalledWith('t-key', expect.objectContaining({ avatar: 'data:image/jpeg;base64, UkVTSVpFRF9XRUI=' }));
        });
    });

    describe('Member profile avatar edit (web)', () => {
        it('ProfilePage offers preset avatars; selecting a preset sends bundled://<id> to updateMemberProfile', async () => {
            render(<ProfilePage identity={mockIdentity} onBack={vi.fn()} />);

            // Wait for profile to load
            await screen.findByText('Your Profile');

            // Preset avatar buttons should be offered
            const sproutPreset = await screen.findByRole('button', { name: 'Select Sprout avatar' });
            expect(sproutPreset, 'Preset avatar button should exist on ProfilePage').toBeInTheDocument();

            fireEvent.click(sproutPreset);

            fireEvent.click(screen.getByRole('button', { name: /Save Profile/i }));

            await waitFor(() => expect(api.updateMemberProfile).toHaveBeenCalledTimes(1));
            expect(vi.mocked(api.updateMemberProfile)).toHaveBeenCalledWith(
                mockIdentity.publicKey,
                expect.objectContaining({ avatar: 'bundled://sprout' })
            );
        });

        it('ProfileSetup offers preset avatars; selecting a preset sends bundled://<id> to updateMemberProfile', async () => {
            render(<ProfileSetup identity={mockIdentity} onDone={vi.fn()} />);

            // When callsign is set and avatar is missing, ProfileSetup opens at avatar step ("Choose your look")
            await screen.findByText(/Choose your look/i);

            // In avatar step, preset avatar buttons should be offered
            const mountainPreset = await screen.findByRole('button', { name: 'Select Mountain avatar' });
            expect(mountainPreset, 'Preset avatar button should exist in ProfileSetup').toBeInTheDocument();

            fireEvent.click(mountainPreset);

            // Next step: guide
            fireEvent.click(screen.getByRole('button', { name: /Next/i }));

            // Finish setup
            const doneBtn = screen.getByRole('button', { name: /Done/i });
            fireEvent.click(doneBtn);

            await waitFor(() => expect(api.updateMemberProfile).toHaveBeenCalledTimes(1));
            expect(vi.mocked(api.updateMemberProfile)).toHaveBeenCalledWith(
                mockIdentity.publicKey,
                expect.objectContaining({ avatar: 'bundled://mountain' })
            );
        });
    });
});

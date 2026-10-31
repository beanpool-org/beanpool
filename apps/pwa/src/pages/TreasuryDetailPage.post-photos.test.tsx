/**
 * Photos while posting an enterprise's Offer or Need on the web (Damo, 26 Oct: "there is no option for that inside
 * enterprises so you have to post the offer first then go back in to add the photo"), as on the phone
 * (apps/native app/treasury-post.tsx). The keepers' post form in Manage has the member composer's photo row
 * (components/PostPhotoPicker.tsx): a photo picked goes through lib/photo-resize.ts and rides the Offer or Need to the node
 * (POST /api/treasury/:t/offer, /need, which check it as a member's own listing's).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TreasuryDetailPage } from './TreasuryDetailPage';
import * as api from '../lib/api';
import * as photoResize from '../lib/photo-resize';

vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../components/EnterpriseDecisions', () => ({ EnterpriseDecisions: () => null }));

const ENT = 'enterprise-eggs';
const BOB = 'keeper-bob';
const BOB_ID = { publicKey: BOB, callsign: 'Bob' } as any;
const RESIZED = ['data:image/jpeg;base64,SEVOUw==', 'data:image/jpeg;base64,RUdHUw=='];

function eggs() {
    return {
        publicKey: ENT, name: 'Community Eggs', purpose: 'Eggs for the street', status: 'active', paused: false, lifecycle: 'ongoing',
        balance: 20, creditLine: 200, liveOffers: 1, earnedSurplus: 0, workingCapitalCeiling: null, deferredClaims: [],
        pendingBids: [], activeDeals: [], keeperRequests: [], keeperChanges: [], leadInactivity: null, succession: null,
        keepers: [{ publicKey: BOB, callsign: 'Bob', role: 'lead', backing: 0 }],
        isLeadOrSoleKeeperOrAdmin: true,
        posts: [{ id: 'p1', type: 'offer', title: 'Dozen eggs', credits: 6, price_type: 'fixed', repeatable: true }],
        flow: [], lat: -28.55, lng: 153.5,
    };
}

beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getTreasury').mockResolvedValue(eggs() as any);
    vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 50, keeperOf: [ENT] } as any);
    vi.spyOn(api, 'getEnterpriseLedger').mockResolvedValue({ enterprise: { publicKey: ENT }, period: {}, summary: {}, entries: [] } as any);
    vi.spyOn(api, 'getEnterpriseThread').mockResolvedValue({ conversation: null, readOnly: false, messages: [] } as any);
    let n = 0;
    vi.spyOn(photoResize, 'resizePhotoFile').mockImplementation(async () => RESIZED[n++ % RESIZED.length]);
});
afterEach(() => { cleanup(); });

async function openForm(which: 'Post Offer' | 'Post Need') {
    await act(async () => { render(<TreasuryDetailPage identity={BOB_ID} pubkey={ENT} onBack={() => {}} />); });
    expect(await screen.findByRole('heading', { level: 1, name: 'Community Eggs' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Manage' }));
    await screen.findByTestId('manage-panel');
    fireEvent.click(screen.getByRole('button', { name: new RegExp(which) }));
    return screen.getByRole('dialog');
}
async function addPhoto(form: HTMLElement, name: string) {
    const input = within(form).getByLabelText('Add photo') as HTMLInputElement;
    expect(input.getAttribute('accept')).toBe('image/*');
    await act(async () => { fireEvent.change(input, { target: { files: [new File(['raw'], name, { type: 'image/jpeg' })] } }); });
}
const shown = (form: HTMLElement) => within(form).queryAllByRole('img').map((i) => i.getAttribute('src'));

describe("an enterprise's Offer or Need, with photos while posting it, on the web", () => {
    it('an Offer: a photo picked is resized, shown, and sent with the Offer', async () => {
        const post = vi.spyOn(api, 'treasuryPostOffer').mockResolvedValue({ success: true, post: { id: 'p2' } });
        const form = await openForm('Post Offer');
        expect(within(form).getByText('Photos (0/5)')).toBeInTheDocument();
        await addPhoto(form, 'hens.jpg');
        await waitFor(() => expect(shown(form)).toEqual([RESIZED[0]]));
        expect(photoResize.resizePhotoFile).toHaveBeenCalledTimes(1);
        expect(within(form).getByText('Photos (1/5)')).toBeInTheDocument();

        fireEvent.change(within(form).getByPlaceholderText('e.g. Dozen fresh eggs'), { target: { value: 'Duck eggs' } });
        fireEvent.change(within(form).getByPlaceholderText('20'), { target: { value: '8' } });
        await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Publish Listing' })); });
        await waitFor(() => expect(post).toHaveBeenCalled());
        expect(post).toHaveBeenCalledWith(ENT, expect.objectContaining({ title: 'Duck eggs', credits: 8, photos: [RESIZED[0]] }));
    });

    it('a Need: two photos, one taken off with ✕, the other sent with the Need', async () => {
        const post = vi.spyOn(api, 'treasuryPostNeed').mockResolvedValue({ success: true, post: { id: 'n1' } });
        const form = await openForm('Post Need');
        await addPhoto(form, 'coop.jpg');
        await addPhoto(form, 'fence.jpg');
        await waitFor(() => expect(shown(form)).toEqual(RESIZED));
        fireEvent.click(within(form).getAllByRole('button', { name: 'Remove photo' })[0]);
        expect(shown(form)).toEqual([RESIZED[1]]);

        fireEvent.change(within(form).getByPlaceholderText('e.g. Tend the chicken coop'), { target: { value: 'Mend the fence' } });
        fireEvent.change(within(form).getByPlaceholderText('20'), { target: { value: '15' } });
        await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Publish Listing' })); });
        await waitFor(() => expect(post).toHaveBeenCalled());
        expect(post).toHaveBeenCalledWith(ENT, expect.objectContaining({ title: 'Mend the fence', credits: 15, photos: [RESIZED[1]] }));
    });

    it("the tag sheet inside the form: Enter in its search posts nothing, and Escape leaves the keeper's form open", async () => {
        const post = vi.spyOn(api, 'treasuryPostOffer').mockResolvedValue({ success: true, post: { id: 'p2' } });
        const form = await openForm('Post Offer');
        await addPhoto(form, 'hens.jpg');
        await waitFor(() => expect(shown(form)).toEqual([RESIZED[0]]));
        fireEvent.change(within(form).getByPlaceholderText('e.g. Dozen fresh eggs'), { target: { value: 'Duck eggs' } });
        fireEvent.change(within(form).getByPlaceholderText('20'), { target: { value: '8' } });
        // Filled in: a submit here would post it.
        expect((within(form).getByRole('button', { name: 'Publish Listing' }) as HTMLButtonElement).disabled).toBe(false);

        fireEvent.click(within(form).getByRole('button', { name: '+ Add tag' }));
        // On document.body, out of the form (components/TagPicker.tsx): the input has no form to submit, and Enter is held anyway.
        const search = screen.getByPlaceholderText('Search tags...') as HTMLInputElement;
        expect(search.form).toBeNull();
        fireEvent.change(search, { target: { value: 'lemon' } });
        // keydown's default action is the browser's implicit submit (jsdom has none): prevented, so it never comes.
        expect(fireEvent.keyDown(search, { key: 'Enter', code: 'Enter' })).toBe(false);
        expect(post).not.toHaveBeenCalled();

        fireEvent.keyDown(search, { key: 'Escape' });
        expect(screen.queryByPlaceholderText('Search tags...')).toBeNull();
        expect(screen.getByRole('dialog')).toBe(form);
        expect((within(form).getByPlaceholderText('e.g. Dozen fresh eggs') as HTMLInputElement).value).toBe('Duck eggs');
    });

    it('none picked: Submit stays disabled with "📷 Add a photo" until one is picked', async () => {
        const post = vi.spyOn(api, 'treasuryPostOffer').mockResolvedValue({ success: true, post: { id: 'p3' } });
        const form = await openForm('Post Offer');
        fireEvent.change(within(form).getByPlaceholderText('e.g. Dozen fresh eggs'), { target: { value: 'Duck eggs' } });
        fireEvent.change(within(form).getByPlaceholderText('20'), { target: { value: '8' } });
        const submitBtn = within(form).getByRole('button', { name: '📷 Add a photo' });
        expect(submitBtn).toBeDisabled();
        expect(post).not.toHaveBeenCalled();
    });
});

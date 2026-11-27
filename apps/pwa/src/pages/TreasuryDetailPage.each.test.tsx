/**
 * An enterprise's own goods priced for each one, from its own form on the web (scratch/fable-design/DESIGN-stall-consignment-
 * fable.md §6 slice 5; Marty, 26 Nov 2026): the keepers' Offer form in Manage offers Each where the node says it takes them up
 * (`perItem`, core priceUnitsOffered), with the member's own boxes (components/PerItemFields: how many, and an optional price
 * for all of them) and core's rules (per-item-form); Recurring goes on Each (the count takes its place); and the Offer carries
 * `priceType: 'each'`, the price for one, `unitsLeft` and `lot` to POST /api/treasury/:t/offer, which passes them through.
 * The phone's enterprise form sends the same for the same boxes (apps/native utils/__tests__/treasury-post-each-render.test.ts,
 * the parity). A Need never offers Each, and nor does a node that doesn't say `perItem`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { perItemRefusalText } from '@beanpool/core';
import { TreasuryDetailPage } from './TreasuryDetailPage';
import * as api from '../lib/api';
import * as photoResize from '../lib/photo-resize';

vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../components/EnterpriseDecisions', () => ({ EnterpriseDecisions: () => null }));
// The node's info, read once (lib/visitor-lobby-gate.ts communityInfoOnce): what it says it does, set per test.
const NODE = vi.hoisted(() => ({ features: {} as Record<string, unknown> }));
vi.mock('../lib/visitor-lobby-gate', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/visitor-lobby-gate')>()),
    communityInfoOnce: vi.fn(async () => ({ memberCount: 3, postCount: 1, transactionCount: 0, commonsBalance_c: 0, features: NODE.features })),
}));

const ENT = 'enterprise-stall';
const KIM = 'keeper-kim';
const KIM_ID = { publicKey: KIM, callsign: 'Kim' } as any;
const RESIZED = 'data:image/jpeg;base64,SkFN';
const PER_ITEM_NODE = { beans: true, escrow: true, enterprises: true, perItem: true };

function stall() {
    return {
        publicKey: ENT, name: 'Riverside stall', purpose: 'Goods from the garden', status: 'active', paused: false, lifecycle: 'ongoing',
        balance_c: 2000, creditLine_c: 20000, liveOffers: 1, earnedSurplus_c: 0, workingCapitalCeiling_c: null, deferredClaims: [],
        pendingBids: [], activeDeals: [], keeperRequests: [], keeperChanges: [], leadInactivity: null, succession: null,
        keepers: [{ publicKey: KIM, callsign: 'Kim', role: 'lead', backing: 0 }],
        isLeadOrSoleKeeperOrAdmin: true,
        posts: [{ id: 'p1', type: 'offer', title: 'Dozen eggs', price_c: 600, price_type: 'fixed', repeatable: true }],
        flow: [], lat: -28.55, lng: 153.5,
    };
}

beforeEach(() => {
    vi.restoreAllMocks();
    NODE.features = PER_ITEM_NODE;
    vi.spyOn(api, 'getTreasury').mockResolvedValue(stall() as any);
    vi.spyOn(api, 'getBalance').mockResolvedValue({ balance_c: 5000, keeperOf: [ENT] } as any);
    vi.spyOn(api, 'getEnterpriseLedger').mockResolvedValue({ enterprise: { publicKey: ENT }, period: {}, summary: {}, entries: [] } as any);
    vi.spyOn(api, 'getEnterpriseThread').mockResolvedValue({ conversation: null, readOnly: false, messages: [] } as any);
    vi.spyOn(photoResize, 'resizePhotoFile').mockImplementation(async () => RESIZED);
});
afterEach(() => { cleanup(); });

async function openForm(which: 'Post Offer' | 'Post Need') {
    await act(async () => { render(<TreasuryDetailPage identity={KIM_ID} pubkey={ENT} onBack={() => {}} />); });
    expect(await screen.findByRole('heading', { level: 1, name: 'Riverside stall' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Manage' }));
    await screen.findByTestId('manage-panel');
    fireEvent.click(screen.getByRole('button', { name: new RegExp(which) }));
    // The node's info lands a moment after the form opens.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    return screen.getByRole('dialog');
}
async function addPhoto(form: HTMLElement) {
    const input = within(form).getByLabelText('Add photo') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { files: [new File(['raw'], 'jam.jpg', { type: 'image/jpeg' })] } }); });
    await waitFor(() => expect(within(form).queryAllByRole('img').map((i) => i.getAttribute('src'))).toEqual([RESIZED]));
}
const unitSelect = (form: HTMLElement) => within(form).getAllByRole('combobox').find((s) => Array.from((s as HTMLSelectElement).options).some((o) => o.value === 'fixed')) as HTMLSelectElement;
const unitsOffered = (form: HTMLElement) => Array.from(unitSelect(form).options).map((o) => o.textContent);
const recurring = (form: HTMLElement) => within(form).queryByText('Recurring listing (stays active after purchase)');
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const publish = async (form: HTMLElement) => { await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Publish Listing' })); }); };

describe("an enterprise's Offer priced for each one, on the web", () => {
    it('Each is offered right after Fixed Total on an Offer, and shows the count and the price for all, with no Recurring', async () => {
        const form = await openForm('Post Offer');
        // Red if the form keeps its own two units, or reads Each without asking core (priceUnitsOffered).
        expect(unitsOffered(form)).toEqual(['Fixed Total', 'Each', 'Hourly (/hr)']);
        expect(within(form).queryByTestId('per-item-fields')).toBeNull();
        expect(recurring(form)).not.toBeNull();

        type(unitSelect(form), 'each');
        expect(unitSelect(form).value).toBe('each');
        expect(within(form).getByLabelText('PRICE FOR ONE')).toBeInTheDocument();
        expect(within(form).getByTestId('per-item-count')).toBeInTheDocument();
        expect(within(form).getByTestId('per-item-lot')).toBeInTheDocument();
        expect(within(form).getByText('Leave this empty to sell them one by one only.')).toBeInTheDocument();
        // Each has no Recurring: the count takes its place.
        expect(recurring(form)).toBeNull();
    });

    it("6.50 each, 12 of them, all 12 for 70: sent as the member's own create form sends it, never Recurring", async () => {
        const post = vi.spyOn(api, 'treasuryPostOffer').mockResolvedValue({ success: true, post: { id: 'p2' } });
        const form = await openForm('Post Offer');
        await addPhoto(form);
        type(within(form).getByPlaceholderText('e.g. Dozen fresh eggs'), 'Plum jam');
        type(unitSelect(form), 'each');
        type(within(form).getByLabelText('PRICE FOR ONE'), '6.50');
        type(within(form).getByTestId('per-item-count'), '12');
        type(within(form).getByTestId('per-item-lot'), '70');
        expect(within(form).getByTestId('per-item-hint').textContent).toBe('All 12 for 70 Beans. One by one they come to 78.');
        await publish(form);
        await waitFor(() => expect(post).toHaveBeenCalled());
        // The same per-item fields the phone's enterprise form sends for the same boxes (treasury-post-each-render.test.ts).
        expect(post).toHaveBeenCalledWith(ENT, {
            title: 'Plum jam', category: 'food', price_c: 650, priceType: 'each', repeatable: false, unitsLeft: 12, lot: { price_c: 7000 }, photos: [RESIZED],
        });
    });

    it('Fixed Total -> Each carries the figure typed as the Total into the price for all, and a count alone sends no price for all', async () => {
        const post = vi.spyOn(api, 'treasuryPostOffer').mockResolvedValue({ success: true, post: { id: 'p3' } });
        const form = await openForm('Post Offer');
        await addPhoto(form);
        type(within(form).getByPlaceholderText('e.g. Dozen fresh eggs'), 'Quince paste');
        type(within(form).getByLabelText('Credits (🫘 Beans)'), '70');
        type(unitSelect(form), 'each');
        expect((within(form).getByLabelText('PRICE FOR ONE') as HTMLInputElement).value).toBe('');
        expect((within(form).getByTestId('per-item-lot') as HTMLInputElement).value).toBe('70');
        type(within(form).getByTestId('per-item-lot'), '');
        type(within(form).getByLabelText('PRICE FOR ONE'), '4');
        type(within(form).getByTestId('per-item-count'), '30');
        await publish(form);
        await waitFor(() => expect(post).toHaveBeenCalled());
        expect(post).toHaveBeenCalledWith(ENT, { title: 'Quince paste', category: 'food', price_c: 400, priceType: 'each', repeatable: false, unitsLeft: 30, photos: [RESIZED] });
    });

    it("a count the node would refuse stops the post, with the node's own sentence under the box", async () => {
        const post = vi.spyOn(api, 'treasuryPostOffer').mockResolvedValue({ success: true, post: { id: 'p4' } });
        const form = await openForm('Post Offer');
        await addPhoto(form);
        type(within(form).getByPlaceholderText('e.g. Dozen fresh eggs'), 'Plum jam');
        type(unitSelect(form), 'each');
        type(within(form).getByLabelText('PRICE FOR ONE'), '6.50');
        for (const bad of ['', '0', '2.5', '10000']) {
            type(within(form).getByTestId('per-item-count'), bad);
            await publish(form);
            expect(within(form).getByTestId('per-item-refusal').textContent, `count "${bad}"`).toBe(perItemRefusalText({ code: 'units_refused' }));
        }
        type(within(form).getByTestId('per-item-count'), '12');
        type(within(form).getByTestId('per-item-lot'), '78.01');
        await publish(form);
        expect(within(form).getByTestId('per-item-refusal').textContent).toBe(perItemRefusalText({ code: 'lot_not_less', count: 12, total_c: 7800 }));
        expect(post).not.toHaveBeenCalled();
    });

    it('a Fixed Total Offer is sent exactly as before, Recurring and all', async () => {
        const post = vi.spyOn(api, 'treasuryPostOffer').mockResolvedValue({ success: true, post: { id: 'p5' } });
        const form = await openForm('Post Offer');
        await addPhoto(form);
        type(within(form).getByPlaceholderText('e.g. Dozen fresh eggs'), 'Dozen eggs');
        type(within(form).getByLabelText('Credits (🫘 Beans)'), '6');
        await publish(form);
        await waitFor(() => expect(post).toHaveBeenCalled());
        expect(post).toHaveBeenCalledWith(ENT, { title: 'Dozen eggs', category: 'food', price_c: 600, priceType: 'fixed', repeatable: true, photos: [RESIZED] });
    });

    it('a Need never offers Each, even after Each was picked on the Offer form', async () => {
        const post = vi.spyOn(api, 'treasuryPostNeed').mockResolvedValue({ success: true, post: { id: 'n1' } });
        const offer = await openForm('Post Offer');
        type(unitSelect(offer), 'each');
        fireEvent.click(within(offer).getByRole('button', { name: 'Cancel' }));
        fireEvent.click(screen.getByRole('button', { name: /Post Need/ }));
        const need = screen.getByRole('dialog');
        expect(unitsOffered(need)).toEqual(['Fixed Total', 'Hourly (/hr)']);
        expect(unitSelect(need).value).toBe('fixed');
        expect(within(need).queryByTestId('per-item-fields')).toBeNull();
        await addPhoto(need);
        type(within(need).getByPlaceholderText('e.g. Tend the chicken coop'), 'Mind the stall');
        type(within(need).getByLabelText('Credits (🫘 Beans)'), '15');
        await publish(need);
        await waitFor(() => expect(post).toHaveBeenCalled());
        expect(post).toHaveBeenCalledWith(ENT, { title: 'Mind the stall', category: 'food', price_c: 1500, priceType: 'fixed', photos: [RESIZED] });
    });

    it.each([[{ beans: true, escrow: true }], [{ beans: true, perItem: false }], [{ beans: true, perItem: 'true' }]])(
        'a node that does not say perItem offers no Each (%j)', async (features) => {
            NODE.features = features;
            const form = await openForm('Post Offer');
            expect(unitsOffered(form)).toEqual(['Fixed Total', 'Hourly (/hr)']);
        });
});

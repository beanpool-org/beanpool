/**
 * An enterprise's price units on the web (#3378 deciding review, BLOCKING 1): TreasuryDetailPage rendered for real, its node
 * calls spied. The keepers' listing composer offers the units the apps' member forms offer an enterprise (core
 * priceUnitsOffered, Each aside, as the phone's app/treasury-post.tsx), per year and per kilo only where the node's features
 * say priceUnitsKgYear; what is picked is what is sent; the form opens again at Total. A keeper releasing a deal priced by
 * quantity is asked for it in the deal's own unit (lib/price-unit-words.ts enterpriseReleaseCopy), the weight in kilos for
 * a per-kilo deal (Marty, 25 Nov 2026), and what they type is sent as the deal's final quantity.
 *
 * LIVE NOW, not gated: the composer used to offer Total and per hour only; it now offers Total, per hour, per day, per week
 * and per month, as the phone's enterprise form has since before #3378 (a week's or a month's price makes a standing deal
 * when taken up, as on the phone).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TreasuryDetailPage } from './TreasuryDetailPage';
import * as api from '../lib/api';
import * as photoResize from '../lib/photo-resize';

vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../components/EnterpriseDecisions', () => ({ EnterpriseDecisions: () => null }));
const node = vi.hoisted(() => ({ features: {} as Record<string, unknown> }));
vi.mock('../lib/features', async (orig) => ({
    ...(await orig<typeof import('../lib/features')>()),
    useCommunityInfo: (enabled = true) => (enabled ? { features: node.features } : null),
}));

const ENT = 'enterprise-eggs';
const BOB = 'keeper-bob';
const BOB_ID = { publicKey: BOB, callsign: 'Bob' } as any;
const RESIZED = 'data:image/jpeg;base64,SEVOUw==';

function eggs(activeDeals: unknown[] = []) {
    return {
        publicKey: ENT, name: 'Community Eggs', purpose: 'Eggs for the street', status: 'active', paused: false, lifecycle: 'ongoing',
        balance_c: 20_000, creditLine_c: 20_000, liveOffers: 1, earnedSurplus_c: 0, workingCapitalCeiling_c: null, deferredClaims: [],
        pendingBids: [], activeDeals, keeperRequests: [], keeperChanges: [], leadInactivity: null, succession: null,
        keepers: [{ publicKey: BOB, callsign: 'Bob', role: 'lead', backing: 0 }],
        isLeadOrSoleKeeperOrAdmin: true,
        posts: [{ id: 'p1', type: 'offer', title: 'Dozen eggs', price_c: 600, price_type: 'fixed', repeatable: true }],
        flow: [], lat: -28.55, lng: 153.5,
    };
}

function stubNode(activeDeals: unknown[] = []) {
    vi.spyOn(api, 'getTreasury').mockResolvedValue(eggs(activeDeals) as any);
    vi.spyOn(api, 'getBalance').mockResolvedValue({ balance_c: 5000, keeperOf: [ENT] } as any);
    vi.spyOn(api, 'getEnterpriseLedger').mockResolvedValue({ enterprise: { publicKey: ENT }, period: {}, summary: {}, entries: [] } as any);
    vi.spyOn(api, 'getEnterpriseThread').mockResolvedValue({ conversation: null, readOnly: false, messages: [] } as any);
}

beforeEach(() => {
    vi.restoreAllMocks();
    node.features = {};
    stubNode();
    vi.spyOn(photoResize, 'resizePhotoFile').mockResolvedValue(RESIZED);
});
afterEach(() => { cleanup(); });

async function openManage() {
    await act(async () => { render(<TreasuryDetailPage identity={BOB_ID} pubkey={ENT} onBack={() => {}} />); });
    expect(await screen.findByRole('heading', { level: 1, name: 'Community Eggs' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Manage' }));
    return screen.findByTestId('manage-panel');
}
async function openForm(which: 'Post Offer' | 'Post Need') {
    fireEvent.click(screen.getByRole('button', { name: new RegExp(which) }));
    return screen.getByRole('dialog');
}
const unitSelect = (form: HTMLElement) => within(form).getAllByRole('combobox').find((s) => Array.from((s as HTMLSelectElement).options).some((o) => o.value === 'hourly')) as HTMLSelectElement;
const unitsIn = (form: HTMLElement) => Array.from(unitSelect(form).options).map((o) => [o.value, o.textContent]);

const WITHOUT_FLAG = [['fixed', 'Fixed Total'], ['hourly', 'Hourly (/hr)'], ['daily', 'Daily (/day)'], ['weekly', 'Weekly (/wk)'], ['monthly', 'Monthly (/mo)']];
const WITH_FLAG = [...WITHOUT_FLAG, ['yearly', 'Yearly (/yr)'], ['per_kg', 'Per kilo (/kg)']];

describe("an enterprise's listing composer on the web: the units offered, the one sent, and Total again after", () => {
    for (const which of ['Post Offer', 'Post Need'] as const) {
        it(`${which}: a node without priceUnitsKgYear offers Total, per hour, day, week and month, never per year or per kilo, nor Each`, async () => {
            await openManage();
            const form = await openForm(which);
            expect(unitsIn(form)).toEqual(WITHOUT_FLAG);
            expect(unitSelect(form).value).toBe('fixed');
        });

        it(`${which}: a node with priceUnitsKgYear adds per year and per kilo, in the forms' order`, async () => {
            node.features = { priceUnitsKgYear: true, perItem: true };
            await openManage();
            const form = await openForm(which);
            expect(unitsIn(form)).toEqual(WITH_FLAG);
        });
    }

    for (const [which, spy] of [['Post Offer', 'treasuryPostOffer'], ['Post Need', 'treasuryPostNeed']] as const) {
        for (const unit of ['daily', 'per_kg'] as const) {
            it(`${which} priced ${unit}: the unit picked is the one sent, and the form opens again at Total`, async () => {
                node.features = { priceUnitsKgYear: true };
                const post = vi.spyOn(api, spy).mockResolvedValue({ success: true, post: { id: 'p9' } } as any);
                await openManage();
                const form = await openForm(which);
                fireEvent.change(unitSelect(form), { target: { value: unit } });
                expect(unitSelect(form).value).toBe(unit);
                const input = within(form).getByLabelText('Add photo') as HTMLInputElement;
                await act(async () => { fireEvent.change(input, { target: { files: [new File(['raw'], 'eggs.jpg', { type: 'image/jpeg' })] } }); });
                await waitFor(() => expect(within(form).getByText('Photos (1/5)')).toBeInTheDocument());
                const title = which === 'Post Offer' ? 'e.g. Dozen fresh eggs' : 'e.g. Tend the chicken coop';
                fireEvent.change(within(form).getByPlaceholderText(title), { target: { value: 'Duck eggs' } });
                fireEvent.change(within(form).getByPlaceholderText('20'), { target: { value: '7.50' } });
                await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Publish Listing' })); });
                await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
                expect(post).toHaveBeenCalledWith(ENT, expect.objectContaining({ title: 'Duck eggs', price_c: 750, priceType: unit }));
                await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
                const again = await openForm(which);
                expect(unitSelect(again).value).toBe('fixed');
            });
        }
    }

    it('a unit picked that the node stops offering reads as Total, never sent as what it no longer takes', async () => {
        node.features = { priceUnitsKgYear: true };
        const post = vi.spyOn(api, 'treasuryPostOffer').mockResolvedValue({ success: true, post: { id: 'p9' } } as any);
        await openManage();
        const form = await openForm('Post Offer');
        fireEvent.change(unitSelect(form), { target: { value: 'per_litre' } });
        expect(unitSelect(form).value).toBe('fixed');
        expect(post).not.toHaveBeenCalled();
    });
});

describe("a keeper releasing an enterprise's deal on the web: asked in the deal's own unit, the answer sent as its quantity", () => {
    const deal = (price_type: string, hours: number | null) => ({
        id: `d-${price_type}`, post_id: 'p1', post_title: 'Duck eggs', amount_c: 1875, price_type, hours, action_required: 'release', peer_callsign: 'Kofi',
    });
    const ROWS: Array<[string, string, string]> = [
        ['hourly', 'Enter hours worked for "Duck eggs":', 'Please enter a valid positive number of hours.'],
        ['daily', 'Enter days worked for "Duck eggs":', 'Please enter a valid positive number of days.'],
        ['weekly', 'Enter weeks worked for "Duck eggs":', 'Please enter a valid positive number of weeks.'],
        ['monthly', 'Enter months worked for "Duck eggs":', 'Please enter a valid positive number of months.'],
        ['yearly', 'Enter years worked for "Duck eggs":', 'Please enter a valid positive number of years.'],
        ['per_kg', 'Enter the weight in kilos for "Duck eggs":', 'Please enter a valid positive number of kilos.'],
    ];
    for (const [unit, question, invalid] of ROWS) {
        it(`${unit}: the prompt names the unit, starts at the booked quantity; 0 is refused, 2.5 is sent`, async () => {
            stubNode([deal(unit, 2)]);
            const complete = vi.spyOn(api, 'treasuryComplete').mockResolvedValue({ success: true } as any);
            const prompts: Array<[string | undefined, string | undefined]> = [];
            const answers = ['0', '2.5'];
            vi.spyOn(window, 'prompt').mockImplementation((q?: string, d?: string) => { prompts.push([q, d]); return answers.shift() ?? null; });
            const alerted: string[] = [];
            vi.spyOn(window, 'alert').mockImplementation((m?: unknown) => { alerted.push(String(m)); });
            await openManage();
            const release = await screen.findByRole('button', { name: /Release Payment/ });
            await act(async () => { fireEvent.click(release); });
            expect(prompts).toEqual([[question, '2']]);
            expect(alerted).toEqual([invalid]);
            expect(complete).not.toHaveBeenCalled();
            await act(async () => { fireEvent.click(release); });
            await waitFor(() => expect(complete).toHaveBeenCalledWith(ENT, `d-${unit}`, 2.5));
        });
    }

    it('fixed: no quantity is asked, the amount held is released as it is', async () => {
        stubNode([deal('fixed', null)]);
        const complete = vi.spyOn(api, 'treasuryComplete').mockResolvedValue({ success: true } as any);
        const prompt = vi.spyOn(window, 'prompt');
        const confirms: string[] = [];
        vi.spyOn(window, 'confirm').mockImplementation((m?: string) => { confirms.push(String(m)); return true; });
        await openManage();
        await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /Release Payment/ })); });
        expect(prompt).not.toHaveBeenCalled();
        expect(confirms).toEqual(['Release payment of 18.75 🫘 for "Duck eggs"? This action cannot be reversed.']);
        await waitFor(() => expect(complete).toHaveBeenCalledWith(ENT, 'd-fixed', undefined));
    });
});

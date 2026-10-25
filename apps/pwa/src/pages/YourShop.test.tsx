/**
 * Your shop on the web: tests first (parity-your-shop, step 1).
 *
 * Covers:
 * 1. open a shop: empty state -> Open my shop -> shop is open with title & category
 * 2. change name/banner (crop)/category: edit text, pick category, crop banner
 * 3. put an Offer in and take it out: Add my live Offers dialog & ShopToggle
 * 4. shop page for a visitor, a member and the owner (Change your shop)
 * 5. global-community visitor sees only category + count, never name, banner or owner
 * 6. close with an open deal -> refused with count and My Deals button
 * 7. close with "End its Offers too"
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ed25519 } from '@noble/curves/ed25519.js';
import * as pictureCrop from '../lib/picture-crop';
import { YourShopPage } from './YourShopPage';
import { ShopDetailPage } from './ShopDetailPage';
import { ShopToggle, type ShopToggleState } from '../components/shop/ShopToggle';
import { ShopHomeBody } from '../components/shop/ShopHomeBody';

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const secret = ed25519.utils.randomSecretKey();
const ME = toHex(ed25519.getPublicKey(secret));
const me = { publicKey: ME, privateKey: toHex(secret), callsign: 'Ana' } as any;

const DAVE = '4'.repeat(64);
const SHOP_ID = 'shop-dave';

function stubCrop(drawn: string) {
    vi.spyOn(pictureCrop, 'drawPictureCrop').mockReturnValue(drawn);
    return vi.spyOn(pictureCrop, 'readPictureFile').mockResolvedValue({
        src: 'data:image/jpeg;base64,RAW',
        width: 1600,
        height: 1200,
        image: {} as HTMLImageElement,
    });
}

describe('Your shop parity test suite (step 1 tests-first)', () => {
    let requests: Array<{ method: string; path: string; body?: any }> = [];

    beforeEach(() => {
        requests = [];
        vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
            const path = url.replace(/^https?:\/\/[^/]+/, '');
            const method = init?.method ?? 'GET';
            const body = init?.body ? JSON.parse(String(init.body)) : undefined;
            requests.push({ method, path, body });

            if (path === '/api/shops/mine' && method === 'GET') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ shop: null }),
                };
            }
            if (path === '/api/shops/mine' && method === 'PUT') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        shop: {
                            id: SHOP_ID,
                            name: body?.name ?? null,
                            ownerName: 'Ana',
                            category: body?.category ?? null,
                            blurb: body?.blurb ?? null,
                            howToDeal: body?.howToDeal ?? null,
                            photoUrl: body?.photo ?? null,
                            counts: { things: 0, available: 0, toBorrow: 0, toBuy: 0, out: 0, newThisWeek: 0 },
                            paused: body?.paused === true,
                            backOn: body?.backOn ?? null,
                        },
                        paused: [],
                        resumed: [],
                    }),
                };
            }
            return {
                ok: false,
                status: 404,
                json: async () => ({ error: 'Not found' }),
            };
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('1. open a shop: shows empty state, clicking Open my shop PUTs to /api/shops/mine', async () => {
        render(<YourShopPage identity={me} onBack={vi.fn()} />);
        expect(await screen.findByTestId('shop-none')).toBeInTheDocument();
        const openBtn = screen.getByTestId('shop-open');
        fireEvent.click(openBtn);
        await waitFor(() => {
            expect(requests.some((r) => r.method === 'PUT' && r.path === '/api/shops/mine')).toBe(true);
        });
        expect(await screen.findByTestId('shop-front')).toBeInTheDocument();
        expect(screen.getByTestId('shop-title')).toHaveTextContent("Ana's shop");
    });

    it('2. change name/banner (crop)/category on Your shop', async () => {
        let shopData: any = {
            id: SHOP_ID,
            name: null,
            ownerName: 'Ana',
            category: null,
            blurb: null,
            howToDeal: null,
            photoUrl: null,
            counts: { things: 1, available: 1, toBorrow: 0, toBuy: 1, out: 0, newThisWeek: 0 },
            paused: false,
            backOn: null,
        };
        vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
            const path = url.replace(/^https?:\/\/[^/]+/, '');
            const method = init?.method ?? 'GET';
            const body = init?.body ? JSON.parse(String(init.body)) : undefined;
            requests.push({ method, path, body });

            if (path === '/api/shops/mine' && method === 'GET') {
                return { ok: true, status: 200, json: async () => ({ shop: shopData }) };
            }
            if (path.startsWith('/api/marketplace/posts?shop=')) {
                return { ok: true, status: 200, json: async () => [] };
            }
            if (path === '/api/shops/mine' && method === 'PUT') {
                shopData = { ...shopData, ...body };
                return { ok: true, status: 200, json: async () => ({ shop: shopData, paused: 0, resumed: 0 }) };
            }
            return { ok: false, status: 404, json: async () => ({}) };
        });

        render(<YourShopPage identity={me} onBack={vi.fn()} />);
        expect(await screen.findByTestId('shop-front')).toBeInTheDocument();

        // Change name
        fireEvent.click(screen.getByTestId('shop-field-name'));
        const nameInput = await screen.findByTestId('shop-text-input');
        fireEvent.change(nameInput, { target: { value: "Ana's Pottery" } });
        fireEvent.click(screen.getByTestId('shop-text-save'));
        await waitFor(() => {
            expect(requests.some((r) => r.method === 'PUT' && r.body?.name === "Ana's Pottery")).toBe(true);
        });

        // Change category
        fireEvent.click(screen.getByTestId('shop-field-category'));
        const catBtn = await screen.findByTestId('shop-category-pick-arts');
        fireEvent.click(catBtn);
        await waitFor(() => {
            expect(requests.some((r) => r.method === 'PUT' && r.body?.category === 'arts')).toBe(true);
        });

        // Change banner with crop
        stubCrop('data:image/jpeg;base64,CROPPED_BANNER');
        const file = new File(['banner'], 'banner.jpg', { type: 'image/jpeg' });
        const bannerInput = document.querySelector('input[type="file"]') as HTMLInputElement;
        if (bannerInput) {
            fireEvent.change(bannerInput, { target: { files: [file] } });
            const doneCrop = await screen.findByRole('button', { name: 'Done' });
            fireEvent.click(doneCrop);
            await waitFor(() => {
                expect(requests.some((r) => r.method === 'PUT' && r.body?.photo === 'data:image/jpeg;base64,CROPPED_BANNER')).toBe(true);
            });
        }
    });

    it('3. put an Offer in and take it out', async () => {
        let inShop = false;
        const toggleState: ShopToggleState = {
            kind: 'open',
            shopId: SHOP_ID,
            title: "Ana's Shop",
            inShop: false,
        };
        const onChange = vi.fn((next: boolean) => { inShop = next; });
        const { rerender } = render(<ShopToggle state={toggleState} on={inShop} onChange={onChange} testId="edit-post-shop" />);
        const checkbox = screen.getByTestId('edit-post-shop');
        expect(checkbox).toHaveAttribute('aria-checked', 'false');
        fireEvent.click(checkbox);
        expect(onChange).toHaveBeenCalledWith(true);

        rerender(<ShopToggle state={{ ...toggleState, inShop: true }} on={true} onChange={onChange} testId="edit-post-shop" />);
        expect(screen.getByTestId('edit-post-shop')).toHaveAttribute('aria-checked', 'true');
        fireEvent.click(screen.getByTestId('edit-post-shop'));
        expect(onChange).toHaveBeenCalledWith(false);
    });

    it('4. shop page for a visitor, a member and the owner (Change your shop)', async () => {
        const shopPayload = {
            id: SHOP_ID,
            name: "Dave's Tools",
            ownerPublicKey: DAVE,
            ownerName: 'Dave',
            enterprise: false,
            category: 'tools',
            counts: { things: 1, available: 1, toBorrow: 1, toBuy: 0, out: 0, newThisWeek: 0 },
            blurb: 'Borrow my garden tools',
            howToDeal: 'Pick up on weekends',
            openedAt: '2026-09-01T00:00:00.000Z',
            paused: false,
            backOn: null,
            photoUrl: null,
        };
        const listingsPayload = [
            {
                id: 'post-1',
                type: 'offer',
                title: 'Lawnmower',
                category: 'tools',
                credits: 5,
                priceType: 'daily',
                status: 'active',
                lendable: true,
                shopId: SHOP_ID,
                featuredAt: null,
                photos: [],
            },
        ];

        vi.stubGlobal('fetch', async (url: string) => {
            const path = url.replace(/^https?:\/\/[^/]+/, '');
            if (path === `/api/shops/${SHOP_ID}`) {
                return { ok: true, status: 200, json: async () => shopPayload };
            }
            if (path.startsWith(`/api/marketplace/posts?shop=${SHOP_ID}`)) {
                return { ok: true, status: 200, json: async () => listingsPayload };
            }
            if (path === `/api/members/${DAVE}`) {
                return { ok: true, status: 200, json: async () => ({ avatar_url: null }) };
            }
            return { ok: false, status: 404, json: async () => ({}) };
        });

        // Visitor / other member view: has Message button, no Change your shop
        const { rerender } = render(
            <ShopDetailPage id={SHOP_ID} identity={me} onBack={vi.fn()} onOpenYourShop={vi.fn()} onMessage={vi.fn()} />
        );
        const daveTitles = await screen.findAllByText("Dave's Tools");
        expect(daveTitles.length).toBeGreaterThan(0);
        expect(screen.getByRole('button', { name: /Message Dave/i })).toBeInTheDocument();
        expect(screen.queryByTestId('shop-page-change')).not.toBeInTheDocument();

        // Owner view: has Change your shop, no Message button
        const daveMe = { publicKey: DAVE, privateKey: '0'.repeat(64), callsign: 'Dave' } as any;
        const onOpenYourShop = vi.fn();
        rerender(
            <ShopDetailPage id={SHOP_ID} identity={daveMe} onBack={vi.fn()} onOpenYourShop={onOpenYourShop} onMessage={vi.fn()} />
        );
        const changeBtn = await screen.findByTestId('shop-page-change');
        expect(changeBtn).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Message Dave/i })).not.toBeInTheDocument();
        fireEvent.click(changeBtn);
        expect(onOpenYourShop).toHaveBeenCalled();
    });

    it('5. global-community visitor sees only category + count, never name, banner or owner', async () => {
        // When accessed by a visitor without membership or on global node, server sends category and count only
        vi.stubGlobal('fetch', async (url: string) => {
            const path = url.replace(/^https?:\/\/[^/]+/, '');
            if (path === `/api/shops/${SHOP_ID}`) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        id: SHOP_ID,
                        category: 'tools',
                        counts: { things: 4, available: 4, toBorrow: 2, toBuy: 2, out: 0, newThisWeek: 0 },
                    }),
                };
            }
            return { ok: false, status: 404, json: async () => ({}) };
        });

        render(<ShopDetailPage id={SHOP_ID} identity={null} onBack={vi.fn()} />);
        expect(await screen.findByText("Members of this community see a shop's name, its owner and what it offers.")).toBeInTheDocument();
        expect(screen.queryByTestId('shopfront-name')).not.toBeInTheDocument();
        expect(screen.queryByTestId('shop-page-owner')).not.toBeInTheDocument();
        expect(screen.queryByTestId('shopfront-banner')).not.toBeInTheDocument();
    });

    it('6. close with an open deal -> refused with count and a My Deals button', async () => {
        const shopData = {
            id: SHOP_ID,
            name: "Ana's Shop",
            ownerName: 'Ana',
            category: 'tools',
            blurb: null,
            howToDeal: null,
            photoUrl: null,
            counts: { things: 2, available: 1, toBorrow: 1, toBuy: 0, out: 1, newThisWeek: 0 },
            paused: false,
            backOn: null,
        };

        vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
            const path = url.replace(/^https?:\/\/[^/]+/, '');
            const method = init?.method ?? 'GET';
            if (path === '/api/shops/mine' && method === 'GET') {
                return { ok: true, status: 200, json: async () => ({ shop: shopData }) };
            }
            if (path.startsWith('/api/marketplace/posts?shop=')) {
                return { ok: true, status: 200, json: async () => [] };
            }
            if (path === '/api/shops/mine/close' && method === 'POST') {
                return {
                    ok: false,
                    status: 409,
                    json: async () => ({
                        code: 'shop_deals_open',
                        message: 'You have 1 open deal on an item in this shop. Complete or cancel it first.',
                    }),
                };
            }
            return { ok: false, status: 404, json: async () => ({}) };
        });

        const onOpenDeals = vi.fn();
        render(<YourShopPage identity={me} onBack={vi.fn()} onOpenDeals={onOpenDeals} />);
        expect(await screen.findByTestId('shop-front')).toBeInTheDocument();

        fireEvent.click(screen.getByTestId('shop-close'));
        expect(await screen.findByTestId('shop-close-sheet')).toBeInTheDocument();
        fireEvent.click(screen.getByTestId('shop-close-go'));

        const error = await screen.findByTestId('shop-close-error');
        expect(error).toHaveTextContent('You have 1 open deal');
        const dealsBtn = screen.getByTestId('shop-close-deals');
        expect(dealsBtn).toBeInTheDocument();
        fireEvent.click(dealsBtn);
        expect(onOpenDeals).toHaveBeenCalled();
    });

    it('7. close with "End its Offers too"', async () => {
        let closed = false;
        const shopData = {
            id: SHOP_ID,
            name: "Ana's Shop",
            ownerName: 'Ana',
            category: 'tools',
            counts: { things: 3, available: 3, toBorrow: 0, toBuy: 3, out: 0, newThisWeek: 0 },
            paused: false,
            backOn: null,
            photoUrl: null,
        };

        vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
            const path = url.replace(/^https?:\/\/[^/]+/, '');
            const method = init?.method ?? 'GET';
            if (path === '/api/shops/mine' && method === 'GET') {
                return { ok: true, status: 200, json: async () => ({ shop: closed ? null : shopData }) };
            }
            if (path.startsWith('/api/marketplace/posts?shop=')) {
                return { ok: true, status: 200, json: async () => [] };
            }
            if (path === '/api/shops/mine/close' && method === 'POST') {
                closed = true;
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        cleared: 0,
                        ended: 3,
                        resumed: 0,
                    }),
                };
            }
            return { ok: false, status: 404, json: async () => ({}) };
        });

        render(<YourShopPage identity={me} onBack={vi.fn()} />);
        expect(await screen.findByTestId('shop-front')).toBeInTheDocument();

        fireEvent.click(screen.getByTestId('shop-close'));
        expect(await screen.findByTestId('shop-close-sheet')).toBeInTheDocument();

        fireEvent.click(screen.getByTestId('shop-close-end'));
        fireEvent.click(screen.getByTestId('shop-close-go'));

        expect(await screen.findByTestId('shop-closed-ended')).toBeInTheDocument();
        expect(screen.getByTestId('shop-closed-ended')).toHaveTextContent('3 Offers have ended');
        expect(screen.getByTestId('shop-open')).toBeInTheDocument();
    });

    it('8. dialogs: focus inside, Escape closes, focus returns (window capture keydown)', async () => {
        const shopData = {
            id: SHOP_ID,
            name: "Ana's Shop",
            ownerName: 'Ana',
            category: 'tools',
            counts: { things: 1, available: 1, toBorrow: 0, toBuy: 1, out: 0, newThisWeek: 0 },
            paused: false,
            backOn: null,
            photoUrl: null,
        };
        vi.stubGlobal('fetch', async (url: string) => {
            const path = url.replace(/^https?:\/\/[^/]+/, '');
            if (path === '/api/shops/mine') return { ok: true, status: 200, json: async () => ({ shop: shopData }) };
            if (path.startsWith('/api/marketplace/posts?shop=')) return { ok: true, status: 200, json: async () => [] };
            return { ok: false, status: 404, json: async () => ({}) };
        });

        render(<YourShopPage identity={me} onBack={vi.fn()} />);
        expect(await screen.findByTestId('shop-front')).toBeInTheDocument();

        const nameButton = screen.getByTestId('shop-field-name');
        nameButton.focus();
        expect(document.activeElement).toBe(nameButton);

        fireEvent.click(nameButton);
        const nameDialog = await screen.findByTestId('shop-text-sheet');
        expect(nameDialog).toBeInTheDocument();
        const input = screen.getByTestId('shop-text-input');
        expect(document.activeElement).toBe(input);

        // Escape closes dialog and returns focus
        fireEvent.keyDown(window, { key: 'Escape' });
        await waitFor(() => {
            expect(screen.queryByTestId('shop-text-sheet')).not.toBeInTheDocument();
        });
        expect(document.activeElement).toBe(nameButton);
    });
});

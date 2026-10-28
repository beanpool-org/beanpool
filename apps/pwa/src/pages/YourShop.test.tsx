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
                shopData = { ...shopData, ...body, photoUrl: body.photo !== undefined ? body.photo : shopData.photoUrl };
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
        expect(screen.getByTestId('shop-page-owner')).toHaveClass('min-h-[48px]');

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

    it('9. ShopDetailPage discards stale async responses when id changes or component unmounts', async () => {
        let resolveShop1: (val: any) => void = () => {};
        const shop1Promise = new Promise((resolve) => {
            resolveShop1 = resolve;
        });

        const shop1Data = {
            id: 'shop-1',
            name: "Alice's Workshop",
            ownerName: 'Alice',
            ownerPublicKey: 'alice-pubkey',
            category: 'tools',
            counts: { things: 1, available: 1, toBorrow: 0, toBuy: 1, out: 0, newThisWeek: 0 },
            paused: false,
            backOn: null,
            photoUrl: null,
        };

        const shop2Data = {
            id: 'shop-2',
            name: "Bob's Bakery",
            ownerName: 'Bob',
            ownerPublicKey: 'bob-pubkey',
            category: 'food',
            counts: { things: 2, available: 2, toBorrow: 0, toBuy: 2, out: 0, newThisWeek: 0 },
            paused: false,
            backOn: null,
            photoUrl: null,
        };

        vi.stubGlobal('fetch', async (url: string) => {
            const path = url.replace(/^https?:\/\/[^/]+/, '');
            if (path === '/api/shops/shop-1') {
                return shop1Promise;
            }
            if (path === '/api/shops/shop-2') {
                return { ok: true, status: 200, json: async () => shop2Data };
            }
            if (path.startsWith('/api/marketplace/posts?shop=shop-2')) {
                return { ok: true, status: 200, json: async () => [] };
            }
            if (path.startsWith('/api/marketplace/posts?shop=shop-1')) {
                return { ok: true, status: 200, json: async () => [] };
            }
            if (path === '/api/members/bob-pubkey' || path === '/api/members/alice-pubkey') {
                return { ok: true, status: 200, json: async () => ({ avatar: null }) };
            }
            return { ok: false, status: 404, json: async () => ({}) };
        });

        const { rerender, unmount } = render(
            <ShopDetailPage id="shop-1" identity={me} onBack={vi.fn()} />
        );

        // While shop-1 is in-flight, navigate to shop-2
        rerender(<ShopDetailPage id="shop-2" identity={me} onBack={vi.fn()} />);

        // Shop-2 resolves and renders
        expect(await screen.findByTestId('shopfront-name')).toHaveTextContent("Bob's Bakery");

        // Now late resolve shop-1
        resolveShop1({ ok: true, status: 200, json: async () => shop1Data });
        await new Promise((r) => setTimeout(r, 50));

        // Shop-2 is still displayed; stale shop-1 response did not overwrite it
        expect(screen.getByTestId('shopfront-name')).toHaveTextContent("Bob's Bakery");
        expect(screen.queryByText("Alice's Workshop")).not.toBeInTheDocument();

        // Unmount should clean up without error
        unmount();
    });

    it('10. ShopDetailPage keeps load stable across parent re-renders and does not re-read or blank', async () => {
        let readCount = 0;
        const shopData = {
            id: 'shop-stable',
            name: 'Stable Shop',
            ownerName: 'Alice',
            ownerPublicKey: 'alice-pubkey',
            category: 'tools',
            counts: { things: 1, available: 1, toBorrow: 0, toBuy: 1, out: 0, newThisWeek: 0 },
            paused: false,
            backOn: null,
            photoUrl: null,
        };

        vi.stubGlobal('fetch', async (url: string) => {
            const path = url.replace(/^https?:\/\/[^/]+/, '');
            if (path === '/api/shops/shop-stable') {
                readCount++;
                return { ok: true, status: 200, json: async () => shopData };
            }
            if (path.startsWith('/api/marketplace/posts?shop=shop-stable')) {
                return { ok: true, status: 200, json: async () => [] };
            }
            if (path === '/api/members/alice-pubkey') {
                return { ok: true, status: 200, json: async () => ({ avatar: null }) };
            }
            return { ok: false, status: 404, json: async () => ({}) };
        });

        function Parent({ renderCount }: { renderCount: number }) {
            return (
                <div>
                    <span>Parent render {renderCount}</span>
                    <ShopDetailPage
                        id="shop-stable"
                        identity={me}
                        onBack={vi.fn()}
                        onOpenEnterprise={() => {}}
                    />
                </div>
            );
        }

        const { rerender } = render(<Parent renderCount={1} />);

        // First load completes and shows the shop name
        expect(await screen.findByTestId('shopfront-name')).toHaveTextContent('Stable Shop');
        expect(readCount).toBe(1);

        // Re-render parent with a new inline onOpenEnterprise reference
        rerender(<Parent renderCount={2} />);

        // Page should NEVER blank (no spinner appears) and readShopPage should NOT be called again
        expect(screen.queryByTestId('shop-page-spinner')).not.toBeInTheDocument();
        expect(screen.getByTestId('shopfront-name')).toHaveTextContent('Stable Shop');
        expect(readCount).toBe(1);
    });

    it('11. YourShopPage Banner field shows the default banner (S3): monogram (10 round copies), echo (one), new words, returns to default on remove', async () => {
        let shopData: any = {
            id: SHOP_ID,
            name: "Ana's Pottery",
            ownerName: 'Ana',
            category: 'arts',
            blurb: null,
            howToDeal: null,
            photoUrl: null,
            counts: { things: 1, available: 1, toBorrow: 0, toBuy: 1, out: 0, newThisWeek: 0 },
            paused: false,
            backOn: null,
        };
        const fetchedUrls: string[] = [];
        vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
            const path = url.replace(/^https?:\/\/[^/]+/, '');
            const method = init?.method ?? 'GET';
            const body = init?.body ? JSON.parse(String(init.body)) : undefined;
            fetchedUrls.push(path);
            if (path === '/api/shops/mine' && method === 'GET') {
                return { ok: true, status: 200, json: async () => ({ shop: shopData }) };
            }
            if (path.startsWith('/api/marketplace/posts?shop=')) {
                return { ok: true, status: 200, json: async () => [] };
            }
            if (path === '/api/shops/mine' && method === 'PUT') {
                shopData = { ...shopData, ...body, photoUrl: body.photo !== undefined ? body.photo : shopData.photoUrl };
                return { ok: true, status: 200, json: async () => ({ shop: shopData, paused: 0, resumed: 0 }) };
            }
            return { ok: false, status: 404, json: async () => ({}) };
        });

        // Case A: bundled avatar on identity -> monogram with 10 round copies, category tint, new words
        const meBundled = { ...me, avatar: 'bundled://leaf' };
        const { unmount } = render(<YourShopPage identity={meBundled} onBack={vi.fn()} />);
        expect(await screen.findByTestId('shop-front')).toBeInTheDocument();

        const bannerField = screen.getByTestId('shop-field-banner-container');
        expect(bannerField).toBeInTheDocument();
        const defaultBanner = screen.getByTestId('default-banner');
        expect(defaultBanner).toBeInTheDocument();
        expect(defaultBanner.style.backgroundColor).toContain('var(--bp-tile-arts-tint)');
        const monogramCopies = screen.getAllByTestId('default-banner-monogram-copy');
        expect(monogramCopies).toHaveLength(10);
        for (const copy of monogramCopies) {
            expect(copy.className).toContain('rounded-full');
            expect(copy.getAttribute('src')).toBe('/avatars/avatar_leaf.webp');
        }
        expect(screen.getByText('Your picture, until you choose a banner.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Choose a banner photo' })).toBeInTheDocument();
        expect(screen.queryByTestId('shop-banner-remove')).toBeNull();

        // No photo was fetched
        expect(fetchedUrls.some((u) => u.includes('/photo'))).toBe(false);
        unmount();

        // Case B: photo avatar on identity -> echo (1 round copy)
        const mePhoto = { ...me, avatar: 'https://mullum.example/ana.jpg' };
        const view2 = render(<YourShopPage identity={mePhoto} onBack={vi.fn()} />);
        expect(await screen.findByTestId('shop-front')).toBeInTheDocument();
        const echoBanner = screen.getByTestId('default-banner');
        expect(echoBanner).toBeInTheDocument();
        const echoCopy = screen.getByTestId('default-banner-echo-copy');
        expect(echoCopy).toBeInTheDocument();
        expect(echoCopy.className).toContain('rounded-full');
        expect(echoCopy.getAttribute('src')).toBe('https://mullum.example/ana.jpg');
        expect(screen.queryByTestId('default-banner-monogram-copy')).toBeNull();

        // Add a banner photo via crop
        stubCrop('data:image/jpeg;base64,CROPPED_BANNER');
        const file = new File(['banner'], 'banner.jpg', { type: 'image/jpeg' });
        const bannerInput = document.querySelector('input[type="file"]') as HTMLInputElement;
        if (bannerInput) {
            fireEvent.change(bannerInput, { target: { files: [file] } });
            const doneCrop = await screen.findByRole('button', { name: 'Done' });
            fireEvent.click(doneCrop);
            await waitFor(() => {
                expect(screen.getByTestId('shop-banner-remove')).toBeInTheDocument();
            });
        }
        expect(screen.getByTestId('shop-banner-image')).toBeInTheDocument();

        // Remove the banner photo returns to the default banner (never a grey block)
        fireEvent.click(screen.getByTestId('shop-banner-remove'));
        await waitFor(() => {
            expect(screen.queryByTestId('shop-banner-image')).toBeNull();
        });
        expect(screen.getByTestId('default-banner')).toBeInTheDocument();
        expect(screen.getByText('Your picture, until you choose a banner.')).toBeInTheDocument();
        view2.unmount();
    });

    it('12. ShopDetailPage shows default banner when banner is empty: monogram (10 copies) for bundled, echo (1) for photo, category tint', async () => {
        const shopData = {
            id: 'shop-flowers',
            name: "Flowers & Co",
            ownerName: 'Chloe',
            ownerPublicKey: 'chloe-pubkey',
            category: 'garden',
            counts: { things: 1, available: 1, toBorrow: 0, toBuy: 1, out: 0, newThisWeek: 0 },
            paused: false,
            backOn: null,
            photoUrl: null,
        };
        const fetchedUrls: string[] = [];
        vi.stubGlobal('fetch', async (url: string) => {
            const path = url.replace(/^https?:\/\/[^/]+/, '');
            fetchedUrls.push(path);
            if (path === '/api/shops/shop-flowers') {
                return { ok: true, status: 200, json: async () => shopData };
            }
            if (path.startsWith('/api/marketplace/posts?shop=shop-flowers')) {
                return { ok: true, status: 200, json: async () => [] };
            }
            if (path === '/api/members/chloe-pubkey' || path === '/api/profile/chloe-pubkey') {
                return { ok: true, status: 200, json: async () => ({ avatar: 'bundled://sunflower' }) };
            }
            return { ok: false, status: 404, json: async () => ({}) };
        });

        // Case A: bundled avatar
        const { unmount } = render(<ShopDetailPage id="shop-flowers" identity={me} onBack={vi.fn()} />);
        expect(await screen.findByTestId('shopfront-name')).toHaveTextContent("Flowers & Co");
        const banner = screen.getByTestId('shopfront-banner');
        const defaultBanner = within(banner).getByTestId('default-banner');
        expect(defaultBanner).toBeInTheDocument();
        expect(defaultBanner.style.backgroundColor).toContain('var(--bp-tile-garden-tint)');
        const copies = within(defaultBanner).getAllByTestId('default-banner-monogram-copy');
        expect(copies).toHaveLength(10);
        for (const copy of copies) {
            expect(copy.className).toContain('rounded-full');
            expect(copy.getAttribute('src')).toBe('/avatars/avatar_sunflower.webp');
        }
        // Nothing fetched beyond avatar
        expect(fetchedUrls.some((u) => u.includes('/photo'))).toBe(false);
        unmount();

        // Case B: photo avatar
        vi.stubGlobal('fetch', async (url: string) => {
            const path = url.replace(/^https?:\/\/[^/]+/, '');
            if (path === '/api/shops/shop-flowers') return { ok: true, status: 200, json: async () => shopData };
            if (path.startsWith('/api/marketplace/posts?shop=shop-flowers')) return { ok: true, status: 200, json: async () => [] };
            if (path === '/api/members/chloe-pubkey' || path === '/api/profile/chloe-pubkey') return { ok: true, status: 200, json: async () => ({ avatar: 'https://mullum.example/chloe.jpg' }) };
            return { ok: false, status: 404, json: async () => ({}) };
        });
        const view2 = render(<ShopDetailPage id="shop-flowers" identity={me} onBack={vi.fn()} />);
        expect(await screen.findByTestId('shopfront-name')).toHaveTextContent("Flowers & Co");
        const banner2 = screen.getByTestId('shopfront-banner');
        const echoBanner = within(banner2).getByTestId('default-banner');
        expect(echoBanner.style.backgroundColor).toContain('var(--bp-tile-garden-tint)');
        const echoCopy = within(echoBanner).getByTestId('default-banner-echo-copy');
        expect(echoCopy).toBeInTheDocument();
        expect(echoCopy.className).toContain('rounded-full');
        expect(echoCopy.getAttribute('src')).toBe('https://mullum.example/chloe.jpg');
        view2.unmount();
    });
});

/**
 * Your shop on the web (parity with apps/native/app/shop/mine.tsx; DESIGN-shops-and-tools-fable.md §8, §9.1):
 * `/shop/mine`, opened from Home's "Your shop and tools" card and Tools.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { BANNER_PICTURE, t, tn, type ShopCategory } from '@beanpool/core';
import type { BeanPoolIdentity } from '../lib/identity';
import { usePictureCrop } from '../components/PictureCropDialog';
import { DefaultBanner } from '../components/DefaultBanner';
import { useOwnAvatar } from '../lib/useOwnAvatar';
import {
    ShopAddOffersDialog, ShopCategoryDialog, ShopCloseDialog, ShopPauseDialog, ShopTextDialog,
    type ShopSheetRefusal, type ShopTextField,
} from '../components/shop/ShopDialogs';
import { ToolButton, ToolEmpty, ToolNote, ToolRow, ToolSection } from '../tools/ui';
import {
    addOffersToMyShop, changeMyShop, closeMyShop, listingState, offersToAdd, readMyLiveOffers,
    readMyShop, readShopListings, shopCategoryLabel, shopStateLine, shopTitle,
    type MyShop, type MyShopChanges, type MyShopRead, type ShopListing,
} from '../lib/shop';

type Where = 'screen' | 'text' | 'category' | 'banner' | 'pause' | 'close' | 'add';

function refusalOf(e: unknown): ShopSheetRefusal {
    const err = e as { message?: unknown; status?: unknown; code?: unknown; unsaid?: unknown } | null;
    const answered = typeof err?.status === 'number' && err.unsaid !== true && typeof err.message === 'string' && err.message.trim().length > 0;
    return {
        message: answered ? String(err!.message) : t("Your community couldn't be reached. Try again."),
        code: typeof err?.code === 'string' ? err.code : undefined,
    };
}

const LIVE = new Set(['active', 'pending', 'paused']);

export interface YourShopPageProps {
    identity: BeanPoolIdentity;
    onBack: () => void;
    onOpenShop?: (id: string) => void;
    onOpenTools?: () => void;
    onOpenPost?: (id: string) => void;
    onOpenDeals?: () => void;
}

export function YourShopPage({
    identity,
    onBack,
    onOpenShop,
    onOpenTools,
    onOpenPost,
    onOpenDeals,
}: YourShopPageProps) {
    const me = identity?.publicKey ?? '';
    const ownAvatar = useOwnAvatar(identity?.publicKey ?? null);
    const [read, setRead] = useState<MyShopRead | null>(null);
    const [listings, setListings] = useState<ShopListing[] | null | undefined>(undefined);
    const [editing, setEditing] = useState<ShopTextField | null>(null);
    const [sheet, setSheet] = useState<'category' | 'pause' | 'close' | 'add' | null>(null);
    const [offers, setOffers] = useState<ShopListing[] | null | undefined>(undefined);
    const [busy, setBusy] = useState(false);
    const [refusal, setRefusal] = useState<({ where: Where } & ShopSheetRefusal) | null>(null);
    const [closed, setClosed] = useState<{ ended: number | null } | null>(null);

    const cropper = usePictureCrop();
    const bannerFileInputRef = useRef<HTMLInputElement | null>(null);

    const loadListings = useCallback(async (shop: MyShop) => {
        if (me) setListings(await readShopListings(shop.id, me));
    }, [me]);

    const load = useCallback(async (afresh = false) => {
        if (afresh) setRead(null);
        const r = await readMyShop();
        setRead(r);
        if (r.state === 'open') await loadListings(r.shop);
    }, [loadListings]);

    useEffect(() => {
        void load();
    }, [load]);

    const shop = read?.state === 'open' ? read.shop : null;
    const refusedAt = (where: Where) => (refusal?.where === where ? refusal : null);

    const openDeals = () => {
        setSheet(null);
        onOpenDeals?.();
    };

    const change = async (changes: MyShopChanges, where: Where): Promise<boolean> => {
        setBusy(true);
        setRefusal(null);
        try {
            const done = await changeMyShop(changes);
            setRead({ state: 'open', shop: done.shop });
            setClosed(null);
            await loadListings(done.shop);
            return true;
        } catch (e) {
            setRefusal({ where, ...refusalOf(e) });
            return false;
        } finally {
            setBusy(false);
        }
    };

    const saveText = async (val: string | null) => {
        if (editing && (await change({ [editing]: val }, 'text'))) setEditing(null);
    };

    const pickBanner = () => {
        if (busy) return;
        setRefusal(null);
        bannerFileInputRef.current?.click();
    };

    const onBannerFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        let photo: string | null;
        try {
            photo = await cropper.crop(file, BANNER_PICTURE);
        } catch {
            setRefusal({ where: 'banner', message: t("That picture couldn't be read. Try another.") });
            return;
        }
        if (photo) await change({ photo }, 'banner');
    };

    const pickCategory = async (category: ShopCategory | null) => {
        if (await change({ category }, 'category')) setSheet(null);
    };

    const pause = async (backOn: string | null) => {
        if (await change(backOn ? { paused: true, backOn } : { paused: true }, 'pause')) setSheet(null);
    };

    const closeShop = async (endOffers: boolean) => {
        setBusy(true);
        setRefusal(null);
        try {
            const done = await closeMyShop(endOffers);
            setSheet(null);
            setRead({ state: 'none' });
            setListings(undefined);
            setClosed({ ended: endOffers ? done.ended : null });
        } catch (e) {
            setRefusal({ where: 'close', ...refusalOf(e) });
        } finally {
            setBusy(false);
        }
    };

    const openAdd = async () => {
        if (!shop) return;
        setRefusal(null);
        setOffers(undefined);
        setSheet('add');
        const mine = await readMyLiveOffers(me);
        setOffers(mine ? offersToAdd(mine, shop.id) : null);
    };

    const add = async (postIds: string[]) => {
        setBusy(true);
        setRefusal(null);
        try {
            await addOffersToMyShop(postIds);
            setSheet(null);
            const r = await readMyShop();
            setRead(r);
            if (r.state === 'open') await loadListings(r.shop);
        } catch (e) {
            setRefusal({ where: 'add', ...refusalOf(e) });
        } finally {
            setBusy(false);
        }
    };

    const closeSheet = () => {
        setSheet(null);
        setRefusal(null);
    };

    const notSet = t('Not written yet');
    const categoryWords = shop?.category ? shopCategoryLabel(shop.category) : null;
    const shown = (listings ?? []).filter((l) => LIVE.has(l.status));

    return (
        <div className="page-overlay z-[110] overflow-y-auto bg-nature-50 dark:bg-nature-950" data-testid="shop-screen">
            <div className="sticky top-0 z-10 bg-nature-100 dark:bg-nature-950 border-b border-nature-200 dark:border-nature-800 px-2 py-1 flex items-center gap-1 min-w-0">
                <button
                    type="button"
                    onClick={onBack}
                    data-testid="shop-back"
                    aria-label={t('Back')}
                    className="shrink-0 min-h-[48px] min-w-[48px] px-2 flex items-center gap-1 text-left bg-transparent border-0 cursor-pointer font-bold text-nature-700 dark:text-nature-200 hover:text-nature-900 dark:hover:text-white rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-brand"
                >
                    <span aria-hidden="true">‹</span>{t('Back')}
                </button>
                <h1 className="m-0 min-w-0 break-words line-clamp-2 text-base font-bold text-nature-900 dark:text-white flex-1">
                    {t('Your shop')}
                </h1>
            </div>

            <div className="max-w-xl mx-auto px-4 py-4 min-w-0 flex flex-col gap-4">
                {read === null ? (
                    <div className="py-8 flex justify-center" data-testid="shop-reading">
                        <div className="w-8 h-8 rounded-full border-2 border-bp-commit-fill border-t-transparent animate-spin" />
                    </div>
                ) : null}

                {read?.state === 'offline' ? (
                    <ToolSection testId="shop-offline">
                        <ToolEmpty
                            icon="📡"
                            title={t("Your shop couldn't be read just now. Try again.")}
                        >
                            <ToolButton onClick={() => { void load(true); }} testId="shop-retry">
                                {t('Try again')}
                            </ToolButton>
                        </ToolEmpty>
                    </ToolSection>
                ) : null}

                {read?.state === 'older' ? (
                    <ToolSection testId="shop-older">
                        <ToolEmpty
                            icon="🏪"
                            title={t("Your community's server doesn't have shops yet. They come with its next update.")}
                        />
                    </ToolSection>
                ) : null}

                {read?.state === 'none' ? (
                    <ToolSection testId="shop-none">
                        {closed ? (
                            closed.ended === null ? (
                                <ToolNote text={t('Your shop is closed. Its Offers stay in the Market on their own.')} testId="shop-closed-kept" />
                            ) : (
                                <ToolNote text={tn(closed.ended, 'Your shop is closed, and its {n} Offer has ended.', 'Your shop is closed, and its {n} Offers have ended.')} testId="shop-closed-ended" />
                            )
                        ) : null}
                        <ToolEmpty
                            icon="🏪"
                            title={t('Your shop is a front window on your own account: the Offers you put in it, under one name. Its Beans are yours.')}
                        >
                            <ToolButton
                                kind="primary"
                                disabled={busy}
                                onClick={() => { void change({}, 'screen'); }}
                                testId="shop-open"
                            >
                                {busy ? t('Opening…') : t('Open my shop')}
                            </ToolButton>
                        </ToolEmpty>
                        {refusedAt('screen') ? (
                            <p data-testid="shop-error" className="m-0 px-3 pb-2 text-sm font-semibold text-bp-ink-danger break-words">
                                {refusal!.message}
                            </p>
                        ) : null}
                    </ToolSection>
                ) : null}

                {shop ? (
                    <>
                        <ToolSection testId="shop-front">
                            <div className="p-3 flex flex-col gap-1 min-w-0">
                                <h2 data-testid="shop-title" className="m-0 text-xl font-extrabold text-nature-900 dark:text-white break-words line-clamp-2">
                                    {shopTitle(shop)}
                                </h2>
                                <p data-testid="shop-category-line" className="m-0 text-sm text-nature-700 dark:text-nature-200 break-words">
                                    {categoryWords ?? t('No category chosen yet')}
                                </p>
                                <p data-testid="shop-state" className="m-0 text-xs text-nature-600 dark:text-nature-300 break-words">
                                    {shopStateLine(shop)}
                                </p>
                                {shop.blurb ? (
                                    <p className="m-0 mt-2 text-sm text-nature-800 dark:text-nature-100 break-words">
                                        {shop.blurb}
                                    </p>
                                ) : null}
                            </div>
                        </ToolSection>

                        {shop.paused ? (
                            <ToolSection testId="shop-paused">
                                <ToolNote text={t('Your shop is closed for now. Its Offers are off the Market and wait for you.')} />
                                <div className="p-3">
                                    <ToolButton
                                        kind="primary"
                                        disabled={busy}
                                        onClick={() => { void change({ paused: false }, 'screen'); }}
                                        testId="shop-reopen"
                                    >
                                        {t('Reopen my shop')}
                                    </ToolButton>
                                </div>
                                {refusedAt('screen') ? (
                                    <p data-testid="shop-error" className="m-0 px-3 pb-2 text-sm font-semibold text-bp-ink-danger break-words">
                                        {refusal!.message}
                                    </p>
                                ) : null}
                            </ToolSection>
                        ) : null}

                        <ToolSection testId="shop-as-members">
                            <ToolRow
                                icon="🪟"
                                title={t('See it as members do')}
                                state={t('Your shopfront, as members here see it')}
                                onClick={() => onOpenShop?.(shop.id)}
                                testId="shop-see-front"
                            />
                        </ToolSection>

                        <ToolSection title={t('About your shop')} testId="shop-fields">
                            <ToolRow
                                title={t('Name')}
                                state={shop.name ?? t('Not named yet')}
                                onClick={() => { setRefusal(null); setEditing('name'); }}
                                testId="shop-field-name"
                            />
                            <ToolRow
                                title={t('Category')}
                                state={categoryWords ?? t('Not chosen yet')}
                                onClick={() => { setRefusal(null); setSheet('category'); }}
                                testId="shop-field-category"
                            />
                            <ToolRow
                                title={t('About')}
                                state={shop.blurb ?? notSet}
                                onClick={() => { setRefusal(null); setEditing('blurb'); }}
                                testId="shop-field-blurb"
                            />
                            <ToolRow
                                title={t('How I deal')}
                                state={shop.howToDeal ?? notSet}
                                onClick={() => { setRefusal(null); setEditing('howToDeal'); }}
                                testId="shop-field-howToDeal"
                            />
                            <div data-testid="shop-field-banner-container" className="p-3 border-t border-nature-200 dark:border-nature-800">
                                <div className="text-sm font-bold text-nature-900 dark:text-white mb-2">
                                    {t('Banner photo')}
                                </div>
                                <div
                                    data-testid="shop-banner-preview"
                                    className="w-full aspect-[3/1] max-w-[720px] rounded-xl overflow-hidden border border-nature-200 dark:border-nature-800 mb-2"
                                >
                                    {shop.photoUrl ? (
                                        <img
                                            src={shop.photoUrl}
                                            alt=""
                                            data-testid="shop-banner-image"
                                            className="w-full h-full object-cover"
                                        />
                                    ) : (
                                        <DefaultBanner
                                            category={shop.category}
                                            logoUrl={ownAvatar}
                                            pubkey={identity?.publicKey}
                                        />
                                    )}
                                </div>
                                {!shop.photoUrl ? (
                                    <p className="m-0 mb-3 text-xs text-nature-500 dark:text-nature-400">
                                        {t('Your picture, until you choose a banner.')}
                                    </p>
                                ) : (
                                    <p className="m-0 mb-3 text-xs text-nature-500 dark:text-nature-400">
                                        {t('Members see it across the top of your shop')}
                                    </p>
                                )}
                                <div className="flex flex-wrap gap-2">
                                    <ToolButton
                                        disabled={busy}
                                        onClick={pickBanner}
                                        testId="shop-field-banner"
                                    >
                                        {shop.photoUrl ? t('Change the banner photo') : t('Choose a banner photo')}
                                    </ToolButton>
                                    {shop.photoUrl ? (
                                        <ToolButton
                                            disabled={busy}
                                            onClick={() => { void change({ photo: null }, 'banner'); }}
                                            testId="shop-banner-remove"
                                        >
                                            {t('Remove the banner photo')}
                                        </ToolButton>
                                    ) : null}
                                </div>
                            </div>
                            {refusedAt('banner') ? (
                                <p data-testid="shop-banner-error" className="m-0 px-3 pb-2 text-sm font-semibold text-bp-ink-danger break-words">
                                    {refusal!.message}
                                </p>
                            ) : null}
                        </ToolSection>

                        <ToolSection title={t('In your shop')} testId="shop-listings">
                            {listings === undefined ? <ToolNote text={t('Reading your Offers…')} /> : null}
                            {listings === null ? <ToolNote text={t("Your shop's Offers couldn't be read just now.")} testId="shop-listings-unread" /> : null}
                            {listings && shown.length === 0 ? (
                                <ToolNote text={t('Nothing in it yet. Put an Offer in from its edit screen, or add your live Offers here.')} testId="shop-listings-empty" />
                            ) : null}
                            {shown.map((l) => (
                                <ToolRow
                                    key={l.id}
                                    title={l.title}
                                    state={listingState(l)}
                                    onClick={() => onOpenPost?.(l.id)}
                                    testId={`shop-listing-${l.id}`}
                                />
                            ))}
                            <div className="p-3">
                                <ToolButton
                                    disabled={shop.paused || busy}
                                    onClick={() => { void openAdd(); }}
                                    testId="shop-add-offers"
                                >
                                    {t('Add my live Offers')}
                                </ToolButton>
                            </div>
                            {shop.paused ? <ToolNote text={t('Nothing goes in while it is closed for now.')} /> : null}
                        </ToolSection>

                        <ToolSection title={t('Tools')}>
                            <ToolRow
                                icon="🧰"
                                title={t('Tools')}
                                state={t('Things you can do on your own')}
                                onClick={() => onOpenTools?.()}
                                testId="shop-tools"
                            />
                        </ToolSection>

                        <ToolSection testId="shop-ends">
                            <div className="p-3 flex flex-wrap gap-2">
                                {!shop.paused ? (
                                    <ToolButton
                                        onClick={() => { setRefusal(null); setSheet('pause'); }}
                                        testId="shop-pause"
                                    >
                                        {t('Close for now')}
                                    </ToolButton>
                                ) : null}
                                <ToolButton
                                    onClick={() => { setRefusal(null); setSheet('close'); }}
                                    testId="shop-close"
                                >
                                    {t('Close my shop')}
                                </ToolButton>
                            </div>
                        </ToolSection>
                    </>
                ) : null}
            </div>

            <ShopTextDialog
                field={editing}
                value={shop && editing ? (editing === 'name' ? shop.name : editing === 'blurb' ? shop.blurb : shop.howToDeal) ?? '' : ''}
                defaultName={shopTitle({ name: null, ownerName: shop?.ownerName ?? identity?.callsign ?? '' })}
                busy={busy}
                refusal={refusedAt('text')}
                onSave={(val) => { void saveText(val); }}
                onClose={() => { setEditing(null); setRefusal(null); }}
            />
            <ShopCategoryDialog
                open={sheet === 'category'}
                category={shop?.category ?? null}
                busy={busy}
                refusal={refusedAt('category')}
                onPick={(c) => { void pickCategory(c); }}
                onClose={closeSheet}
            />
            <ShopPauseDialog
                open={sheet === 'pause'}
                busy={busy}
                refusal={refusedAt('pause')}
                onPause={(day) => { void pause(day); }}
                onClose={closeSheet}
                onDeals={openDeals}
            />
            <ShopCloseDialog
                open={sheet === 'close'}
                busy={busy}
                refusal={refusedAt('close')}
                onCloseShop={(end) => { void closeShop(end); }}
                onClose={closeSheet}
                onDeals={openDeals}
            />
            <ShopAddOffersDialog
                open={sheet === 'add'}
                offers={offers}
                busy={busy}
                refusal={refusedAt('add')}
                onAdd={(ids) => { void add(ids); }}
                onClose={closeSheet}
            />

            <input
                ref={bannerFileInputRef}
                type="file"
                accept="image/*"
                onChange={onBannerFileSelected}
                className="hidden"
            />
            {cropper.dialog}
        </div>
    );
}

/**
 * A shop's page on the web (parity with apps/native/app/shop/[id].tsx; slice S5 of
 * scratch/tools/DESIGN-shops-round3-enterprise-shopfront-fable.md §3): `/shop/<id>`, a member's shop as
 * any member here reads it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@beanpool/core';
import type { BeanPoolIdentity } from '../lib/identity';
import { getMemberProfile } from '../lib/api';
import {
    ShopfrontFeatured, ShopfrontHeader, ShopfrontMessage, ShopfrontSections, ShopfrontText,
    ShopfrontVisitorNote,
} from '../components/Shopfront';
import { PostAuthorTrust } from '../components/PostAuthorTrust';
import { ToolButton, ToolEmpty, ToolSection } from '../tools/ui';
import { shopStateLine, shopTitle } from '../lib/shop';
import {
    categorySinceLine, featuredOf, messageLabel, readShopListingsForReader, readShopPage, shopSectionsOf, sinceLine,
    type ShopfrontListing, type ShopPageRead,
} from '../lib/shopfront';

export interface ShopDetailPageProps {
    id: string;
    identity?: BeanPoolIdentity | null;
    onBack: () => void;
    onOpenYourShop?: () => void;
    onOpenEnterprise?: (pubkey: string) => void;
    onOpenProfile?: (pubkey: string) => void;
    onOpenPost?: (id: string) => void;
    onMessage?: (pubkey: string) => void;
    showsBeans?: boolean;
}

export function ShopDetailPage({
    id,
    identity,
    onBack,
    onOpenYourShop,
    onOpenEnterprise,
    onOpenProfile,
    onOpenPost,
    onMessage,
    showsBeans = true,
}: ShopDetailPageProps) {
    const [read, setRead] = useState<ShopPageRead | null>(null);
    const [listings, setListings] = useState<ShopfrontListing[] | null | undefined>(undefined);
    const [logo, setLogo] = useState<string | null>(null);
    const activeReqRef = useRef(0);
    const onOpenEnterpriseRef = useRef(onOpenEnterprise);
    useEffect(() => {
        onOpenEnterpriseRef.current = onOpenEnterprise;
    }, [onOpenEnterprise]);

    const load = useCallback(async (afresh = false, isCallActive: () => boolean = () => true) => {
        const reqId = ++activeReqRef.current;
        const isActive = () => activeReqRef.current === reqId && isCallActive();

        if (!id) {
            if (isActive()) setRead({ state: 'none' });
            return;
        }
        if (afresh) {
            setRead(null);
            setListings(undefined);
            setLogo(null);
        }
        const r = await readShopPage(id);
        if (!isActive()) return;
        if (r.state === 'enterprise') {
            onOpenEnterpriseRef.current?.(r.ownerPublicKey);
            return;
        }
        setRead(r);
        if (r.state !== 'shop') {
            setListings(null);
            setLogo(null);
            return;
        }
        getMemberProfile(r.shop.ownerPublicKey)
            .then((m) => {
                if (!isActive()) return;
                const url = m?.avatar ?? (m as any)?.avatar_url ?? (m as any)?.avatarUrl;
                setLogo(typeof url === 'string' && url.trim() ? url : null);
            })
            .catch(() => {});
        const items = await readShopListingsForReader(r.shop.id);
        if (isActive()) setListings(items);
    }, [id]);

    useEffect(() => {
        let active = true;
        setRead(null);
        setListings(undefined);
        setLogo(null);
        void load(false, () => active);
        return () => {
            active = false;
            activeReqRef.current = 0;
        };
    }, [load]);

    const shop = read?.state === 'shop' ? read.shop : null;
    const mine = !!shop && !!identity?.publicKey && shop.ownerPublicKey === identity.publicKey;
    const title = shop ? shopTitle(shop) : t('Shop');
    const tier = (listings ?? []).find((l) => l.authorTierCredit !== null && l.authorTierCredit !== undefined)?.authorTierCredit ?? null;

    return (
        <div className="page-overlay z-[110] overflow-y-auto bg-nature-50 dark:bg-nature-950" data-testid="shop-page">
            <div className="sticky top-0 z-10 bg-nature-100 dark:bg-nature-950 border-b border-nature-200 dark:border-nature-800 px-2 py-1 flex items-center gap-1 min-w-0">
                <button
                    type="button"
                    onClick={onBack}
                    data-testid="shop-page-back"
                    aria-label={t('Back')}
                    className="shrink-0 min-h-[48px] min-w-[48px] px-2 flex items-center gap-1 text-left bg-transparent border-0 cursor-pointer font-bold text-nature-700 dark:text-nature-200 hover:text-nature-900 dark:hover:text-white rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-brand"
                >
                    <span aria-hidden="true">‹</span>{t('Back')}
                </button>
                <h1 className="m-0 min-w-0 break-words line-clamp-1 text-base font-bold text-nature-900 dark:text-white flex-1">
                    {title}
                </h1>
            </div>

            <div className="max-w-xl mx-auto px-4 py-4 min-w-0 flex flex-col gap-4">
                {read === null ? (
                    <div className="py-8 flex justify-center" data-testid="shop-page-reading">
                        <div className="w-8 h-8 rounded-full border-2 border-bp-commit-fill border-t-transparent animate-spin" />
                    </div>
                ) : null}

                {read?.state === 'offline' ? (
                    <ToolSection testId="shop-page-offline">
                        <ToolEmpty
                            icon="📡"
                            title={t("This shop couldn't be read just now. Try again.")}
                        >
                            <ToolButton onClick={() => { void load(true); }} testId="shop-page-retry">
                                {t('Try again')}
                            </ToolButton>
                        </ToolEmpty>
                    </ToolSection>
                ) : null}

                {read?.state === 'none' ? (
                    <ToolSection testId="shop-page-none">
                        <ToolEmpty
                            icon="🏪"
                            title={t('This shop is not here any more. Its owner may have closed it.')}
                        />
                    </ToolSection>
                ) : null}

                {read?.state === 'visitor' ? (
                    <div className="py-2">
                        <ShopfrontVisitorNote
                            text={t("Members of this community see a shop's name, its owner and what it offers.")}
                        />
                    </div>
                ) : null}

                {shop ? (
                    <div className="flex flex-col gap-4 min-w-0">
                        <ShopfrontHeader
                            name={title}
                            logoUrl={logo}
                            category={shop.category}
                            bannerUrl={shop.photoUrl}
                            fallbackEmoji="🏪"
                            lines={[
                                categorySinceLine(shop.category, sinceLine(shop.openedAt)),
                                shop.paused ? shopStateLine(shop) : null,
                            ].filter((l): l is string => !!l)}
                        />

                        <div className="-mt-2 mb-1 min-w-0">
                            <button
                                type="button"
                                onClick={() => onOpenProfile?.(shop.ownerPublicKey)}
                                aria-label={t("View {name}'s profile", { name: shop.ownerName })}
                                data-testid="shop-page-owner"
                                className="bg-transparent border-0 p-0 cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-brand rounded-lg"
                            >
                                <PostAuthorTrust
                                    publicKey={shop.ownerPublicKey}
                                    callsign={shop.ownerName}
                                    avatarUrl={logo}
                                    energyCycled={tier ?? 0}
                                    showTier={showsBeans && tier !== null}
                                />
                            </button>
                        </div>

                        {shop.blurb ? (
                            <ShopfrontText title={t('About')} text={shop.blurb} testID="shopfront-about" />
                        ) : null}

                        {listings ? (
                            <ShopfrontFeatured
                                listings={featuredOf(listings)}
                                showsBeans={showsBeans}
                                onOpen={onOpenPost}
                            />
                        ) : null}

                        {listings === undefined ? (
                            <p className="m-0 text-sm text-nature-600 dark:text-nature-300">
                                {t('Reading what is in it…')}
                            </p>
                        ) : null}

                        {listings === null ? (
                            <p data-testid="shop-page-listings-unread" className="m-0 text-sm text-nature-600 dark:text-nature-300">
                                {t("What is in this shop couldn't be read just now.")}
                            </p>
                        ) : null}

                        {listings ? (
                            <ShopfrontSections
                                sections={shopSectionsOf(listings)}
                                showsBeans={showsBeans}
                                empty={
                                    shop.paused
                                        ? t('This shop is closed for now. Its Offers wait until it reopens.')
                                        : t('Nothing in this shop yet.')
                                }
                                onOpen={onOpenPost}
                            />
                        ) : null}

                        {shop.howToDeal ? (
                            <ShopfrontText title={t('How I deal')} text={shop.howToDeal} boxed testID="shopfront-how" />
                        ) : null}

                        {mine ? (
                            <div data-testid="shop-page-mine" className="flex flex-col gap-2 mb-4">
                                <p className="m-0 text-sm text-nature-600 dark:text-nature-300">
                                    {t('This is your shop as members here see it.')}
                                </p>
                                <ToolButton onClick={onOpenYourShop ?? (() => {})} testId="shop-page-change">
                                    {t('Change your shop')}
                                </ToolButton>
                            </div>
                        ) : (
                            <ShopfrontMessage
                                label={messageLabel(shop.ownerName, 'shop')}
                                onClick={() => onMessage?.(shop.ownerPublicKey)}
                            />
                        )}
                    </div>
                ) : null}
            </div>
        </div>
    );
}

/**
 * The two new parts of an enterprise's Manage tab on the web (slice S8 of scratch/tools/DESIGN-shops-round3-enterprise-
 * shopfront-fable.md §3, §4; Marty's answers of 23 Oct 2026; the phone's S7 console): its face and its Featured shelf.
 * The rest of Manage is the keepers' controls the page already had, moved there by pages/TreasuryDetailPage.tsx.
 *
 * - The face, with one Save: any keeper (or a node admin) its About and logo (PUT /api/treasury/:t/profile); only the lead
 *   (its sole keeper, or an admin) its name and what it is for, the others shown them and told why; a keeper its shop's
 *   kind and how it deals (PUT /api/treasury/:t/shop, which opens the shop if need be). Only what changed is sent, each to
 *   its own route, the profile first; a refusal is the node's own sentence and nothing after it is sent. The logo is the
 *   picture the keeper chose, made 800 px here before it goes (lib/photo-resize.ts; memory: photos stay 800px).
 * - Featured: its live Offers in its shop, each on the shelf or off it (PUT /api/marketplace/posts/:id/feature), six at
 *   most, said once; its live Offers for everyone not in its shop yet go in with one tap; no shop yet, one tap opens it.
 *
 * Never a false success: a change shows as made only once the node says so.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import {
    ENTERPRISE_ABOUT_LIMIT, ENTERPRISE_NAME_LIMIT, ENTERPRISE_PURPOSE_LIMIT, SHOP_FEATURED_MAX, SHOP_HOW_TO_DEAL_LIMIT, SHOP_KINDS, t, tn,
    type ShopKind,
} from '@beanpool/core';
import { addEnterpriseShopOffers, changeEnterpriseFace, changeEnterpriseShop, featureOffer } from '../lib/api';
import { resolveAvatarUrl } from '../lib/avatar';
import { resizePhotoFile } from '../lib/photo-resize';
import {
    faceChanges, listingPriceLine, readOwnerListings, shelfLine, shelfOf, shopKindLabel, type Face, type ShopfrontListing,
} from '../lib/shopfront';

const card = 'bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-5 shadow-sm space-y-4';
const heading = 'm-0 text-base font-extrabold text-nature-900 dark:text-white';
const label = 'block text-sm font-bold text-nature-800 dark:text-nature-200 mb-1';
const field = 'w-full bg-nature-50 dark:bg-nature-800 border border-nature-300 dark:border-nature-700 rounded-xl px-3 py-2 text-base text-nature-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500';
const muted = 'm-0 text-sm text-nature-600 dark:text-nature-300';
const errorLine = 'm-0 text-sm font-semibold text-bp-ink-danger';
const secondary = 'min-h-[44px] px-4 py-2 rounded-xl border border-nature-300 dark:border-nature-600 bg-white dark:bg-nature-900 text-nature-900 dark:text-nature-100 font-bold text-sm hover:bg-nature-50 dark:hover:bg-nature-800 transition-colors disabled:opacity-50';
const primary = 'w-full min-h-[48px] px-4 py-2.5 rounded-xl bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on font-extrabold text-base shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

/** The node's own sentence for a refusal; no answer (or a page that isn't the node's) said plainly. */
function refusalWords(e: unknown): string {
    const err = e as { status?: number; unsaid?: boolean; message?: string } | null;
    if (err?.status && !err.unsaid && err.message) return err.message;
    return t("Your community couldn't be reached. Try again.");
}

/** Its face as the detail sends it. */
export function faceOf(detail: any): Face {
    return {
        name: typeof detail?.name === 'string' ? detail.name : '',
        purpose: typeof detail?.purpose === 'string' ? detail.purpose : '',
        about: typeof detail?.about === 'string' ? detail.about : '',
        kind: SHOP_KINDS.includes(detail?.shop?.kind) ? detail.shop.kind as ShopKind : null,
        howToDeal: typeof detail?.shop?.howToDeal === 'string' ? detail.shop.howToDeal : '',
    };
}

export function EnterpriseFace({ treasury, detail, project, lead, shopEditable, onSaved }: {
    treasury: string;
    detail: any;
    project: boolean;
    /** Its lead keeper, sole keeper or a node admin (the detail's isLeadOrSoleKeeperOrAdmin): name and purpose are theirs. */
    lead: boolean;
    /** A keeper, who may change its shop (a node admin who keeps none of it may not). */
    shopEditable: boolean;
    onSaved: () => void;
}) {
    const id = useId();
    const [was, setWas] = useState<Face>(() => faceOf(detail));
    const [form, setForm] = useState<Face>(() => faceOf(detail));
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [picking, setPicking] = useState(false);

    const changes = faceChanges(was, form, { lead, shop: shopEditable });
    const dirty = Object.keys(changes.profile).length > 0 || Object.keys(changes.shop).length > 0;
    const set = (patch: Partial<Face>) => { setForm((f) => ({ ...f, ...patch })); setSaved(false); setError(null); };
    const logo = form.avatar ?? resolveAvatarUrl(detail?.avatar);

    const pickLogo = async (file: File | undefined) => {
        if (!file) return;
        setPicking(true);
        setError(null);
        try {
            set({ avatar: await resizePhotoFile(file) });
        } catch {
            setError(t("That picture couldn't be read. Try another."));
        } finally {
            setPicking(false);
        }
    };

    const save = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!dirty || saving) return;
        setSaving(true);
        setSaved(false);
        setError(null);
        try {
            if (Object.keys(changes.profile).length > 0) {
                await changeEnterpriseFace(treasury, changes.profile);
                // Saved on the node: a retry after a refused shop change does not send these again.
                setWas((w) => ({ ...w, name: lead ? form.name : w.name, purpose: lead ? form.purpose : w.purpose, about: form.about }));
                setForm((f) => ({ ...f, avatar: undefined }));
            }
            if (Object.keys(changes.shop).length > 0) {
                await changeEnterpriseShop(treasury, changes.shop);
                setWas((w) => ({ ...w, kind: form.kind, howToDeal: form.howToDeal }));
            }
            setSaved(true);
            onSaved();
        } catch (err) {
            setError(refusalWords(err));
        } finally {
            setSaving(false);
        }
    };

    return (
        <form onSubmit={save} data-testid="manage-face" aria-labelledby={`${id}-heading`} className={card}>
            <div>
                <h2 id={`${id}-heading`} className={heading}>{project ? t('Its page: what members see') : t('Its shopfront: what members see')}</h2>
                <p className={`${muted} mt-1`}>{t('Any keeper can change the picture, About, the kind of shop and how you deal.')}</p>
            </div>

            <div className="flex items-center gap-3">
                {logo ? (
                    <img data-testid="manage-face-logo-image" src={logo} alt={t('Its picture')} className="w-16 h-16 rounded-full object-cover border border-nature-200 dark:border-nature-700 shrink-0" />
                ) : (
                    <span aria-hidden="true" className="w-16 h-16 rounded-full bg-nature-100 dark:bg-nature-800 flex items-center justify-center text-3xl shrink-0">{project ? '🌱' : '🏛️'}</span>
                )}
                <label data-testid="manage-face-logo" htmlFor={`${id}-logo`} className={`${secondary} inline-flex items-center cursor-pointer focus-within:ring-2 focus-within:ring-emerald-500`}>
                    {picking ? t('Reading the picture…') : t('Change the picture')}
                    <input
                        id={`${id}-logo`}
                        data-testid="manage-face-logo-input"
                        type="file"
                        accept="image/*"
                        className="sr-only"
                        onChange={(e) => { void pickLogo(e.target.files?.[0]); e.target.value = ''; }}
                    />
                </label>
            </div>

            {lead ? (
                <>
                    <div>
                        <label htmlFor={`${id}-name`} className={label}>{t('Name')}</label>
                        <input id={`${id}-name`} data-testid="manage-face-name" type="text" value={form.name} maxLength={ENTERPRISE_NAME_LIMIT.chars}
                            onChange={(e) => set({ name: e.target.value })} className={field} />
                    </div>
                    <div>
                        <label htmlFor={`${id}-purpose`} className={label}>{t('What it is for')}</label>
                        <textarea id={`${id}-purpose`} data-testid="manage-face-purpose" rows={3} value={form.purpose} maxLength={ENTERPRISE_PURPOSE_LIMIT.chars}
                            onChange={(e) => set({ purpose: e.target.value })} className={field} />
                    </div>
                </>
            ) : (
                <div className="space-y-2">
                    <p data-testid="manage-face-name-shown" className="m-0 text-sm text-nature-800 dark:text-nature-200 break-words">
                        <span className="font-bold">{t('Name')}: </span>{was.name}
                    </p>
                    {was.purpose && (
                        <p data-testid="manage-face-purpose-shown" className="m-0 text-sm text-nature-800 dark:text-nature-200 break-words whitespace-pre-line">
                            <span className="font-bold">{t('What it is for')}: </span>{was.purpose}
                        </p>
                    )}
                    <p data-testid="manage-face-lead-only" className={muted}>
                        {project
                            ? t("Only the leader can change the project's name or what it is for.")
                            : t("Only the lead keeper can change the enterprise's name or what it is for.")}
                    </p>
                </div>
            )}

            <div>
                <label htmlFor={`${id}-about`} className={label}>{t('About', undefined, "an enterprise's own words about itself")}</label>
                <textarea id={`${id}-about`} data-testid="manage-face-about" rows={4} value={form.about} maxLength={ENTERPRISE_ABOUT_LIMIT.chars}
                    onChange={(e) => set({ about: e.target.value })} className={field} />
                <p className={`${muted} mt-1`}>{t('Up to {n} characters.', { n: ENTERPRISE_ABOUT_LIMIT.chars })}</p>
            </div>

            {shopEditable && (
                <>
                    <div>
                        <label htmlFor={`${id}-kind`} className={label}>{t('Kind of shop')}</label>
                        <select id={`${id}-kind`} data-testid="manage-face-kind" value={form.kind ?? ''} onChange={(e) => set({ kind: (e.target.value || null) as ShopKind | null })} className={`${field} min-h-[44px]`}>
                            <option value="">{t('None', undefined, 'no kind of shop')}</option>
                            {SHOP_KINDS.map((k) => <option key={k} value={k}>{shopKindLabel(k)}</option>)}
                        </select>
                    </div>
                    <div>
                        <label htmlFor={`${id}-how`} className={label}>{t('How we deal')}</label>
                        <textarea id={`${id}-how`} data-testid="manage-face-how" rows={3} value={form.howToDeal} maxLength={SHOP_HOW_TO_DEAL_LIMIT.chars}
                            placeholder={t('Where and when to pick up, how to book, what to bring.')}
                            onChange={(e) => set({ howToDeal: e.target.value })} className={field} />
                    </div>
                </>
            )}

            {error && <p role="alert" data-testid="manage-face-error" className={errorLine}>{error}</p>}
            {saved && !dirty && <p role="status" data-testid="manage-face-saved" className="m-0 text-sm font-bold text-bp-ink-success">{t('Saved.')}</p>}
            <button type="submit" data-testid="manage-face-save" disabled={!dirty || saving || picking} className={primary}>
                {saving ? t('Saving…') : t('Save')}
            </button>
        </form>
    );
}

/**
 * The live Offers in its shop, each on or off its shelf; those outside it; no shop: open one. `onListingsChanged` hears its
 * listings as they now are, so its page's Featured tiles show the change.
 */
export function EnterpriseFeatured({ treasury, shopId, onShopOpened, onListingsChanged }: {
    treasury: string;
    shopId: string | null;
    onShopOpened: () => void;
    onListingsChanged?: (listings: ShopfrontListing[]) => void;
}) {
    const id = useId();
    const [listings, setListings] = useState<ShopfrontListing[] | null | undefined>(undefined);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const read = useCallback(async () => {
        const rows = await readOwnerListings(treasury);
        setListings(rows);
        return rows;
    }, [treasury]);
    useEffect(() => { void read(); }, [read, shopId]);

    const openShop = async () => {
        setBusy('shop');
        setError(null);
        try {
            await changeEnterpriseShop(treasury, {});
            onShopOpened();
        } catch (e) {
            setError(refusalWords(e));
        } finally {
            setBusy(null);
        }
    };

    const toggle = async (l: ShopfrontListing) => {
        if (busy) return;
        setBusy(l.id);
        setError(null);
        try {
            const res = await featureOffer(l.id, !l.featuredAt);
            const now = (listings ?? []).map((r) => (r.id === l.id ? { ...r, featuredAt: res.featuredAt ?? null } : r));
            setListings(now);
            onListingsChanged?.(now);
        } catch (e) {
            setError(refusalWords(e));
        } finally {
            setBusy(null);
        }
    };

    const putIn = async (ids: string[]) => {
        setBusy('add');
        setError(null);
        try {
            await addEnterpriseShopOffers(treasury, ids);
            const rows = await read();
            if (rows) onListingsChanged?.(rows);
        } catch (e) {
            setError(refusalWords(e));
        } finally {
            setBusy(null);
        }
    };

    const intro = (
        <div>
            <h2 id={`${id}-heading`} className={heading}>{t('Featured', undefined, "a shop's chosen Offers")}</h2>
            <p className={`${muted} mt-1`}>{t('Up to six of its live Offers in its shop show first on its page.')}</p>
        </div>
    );

    if (!shopId) {
        return (
            <section data-testid="manage-featured-noshop" aria-labelledby={`${id}-heading`} className={card}>
                {intro}
                <p data-testid="manage-shop-none" className={muted}>{t('It has no shop yet. Open it, then put its Offers in it to feature them.')}</p>
                {error && <p role="alert" data-testid="manage-featured-error" className={errorLine}>{error}</p>}
                <button type="button" data-testid="manage-shop-open" onClick={openShop} disabled={busy === 'shop'} className={secondary}>
                    {busy === 'shop' ? t('Opening…') : t('Open its shop')}
                </button>
            </section>
        );
    }

    const shelf = listings ? shelfOf(listings, shopId) : null;
    const full = !!shelf && shelf.featured >= SHOP_FEATURED_MAX;
    return (
        <section data-testid="manage-featured" aria-labelledby={`${id}-heading`} className={card}>
            {intro}
            {listings === undefined ? (
                <p className={muted}>{t('Loading…')}</p>
            ) : listings === null ? (
                <div className="space-y-2">
                    <p data-testid="manage-featured-unread" className={muted}>{t("Its Offers couldn't be read just now.")}</p>
                    <button type="button" onClick={() => { setListings(undefined); void read(); }} className={secondary}>{t('Try again')}</button>
                </div>
            ) : (
                <>
                    <p className="m-0 text-sm font-bold text-nature-800 dark:text-nature-200">{shelfLine(shelf!.featured)}</p>
                    {full && <p data-testid="manage-featured-full" className={muted}>{t('Six is the shelf; un-feature one first.')}</p>}
                    {shelf!.inShop.length === 0 ? (
                        <p className={muted}>{t('Nothing of its is in its shop yet.')}</p>
                    ) : (
                        <ul className="m-0 p-0 list-none divide-y divide-nature-100 dark:divide-nature-800">
                            {shelf!.inShop.map((l) => {
                                const on = !!l.featuredAt;
                                const price = listingPriceLine(l, true);
                                return (
                                    <li key={l.id}>
                                        <label className={`min-h-[48px] py-1.5 flex items-center gap-3 ${!on && full ? 'opacity-60' : 'cursor-pointer'}`}>
                                            <input
                                                type="checkbox"
                                                data-testid={`manage-feature-${l.id}`}
                                                checked={on}
                                                disabled={busy !== null || (!on && full)}
                                                onChange={() => void toggle(l)}
                                                aria-label={l.title}
                                                className="w-5 h-5 shrink-0 accent-emerald-600"
                                            />
                                            <span className="flex-1 min-w-0">
                                                <span className="block text-sm font-semibold text-nature-900 dark:text-white break-words">{l.title}</span>
                                                {price && <span className="block text-sm text-nature-600 dark:text-nature-300">{price}</span>}
                                            </span>
                                        </label>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                    {shelf!.outside.length > 0 && (
                        <div className="space-y-2 pt-1">
                            <p data-testid="manage-shop-outside" className={muted}>
                                {tn(shelf!.outside.length,
                                    "{n} of its live Offers isn't in its shop yet, so it can't be featured.",
                                    "{n} of its live Offers aren't in its shop yet, so they can't be featured.")}
                            </p>
                            <button type="button" data-testid="manage-shop-add" disabled={busy !== null} onClick={() => void putIn(shelf!.outside.map((l) => l.id))} className={secondary}>
                                {busy === 'add' ? t('Putting them in…') : t('Put them in its shop')}
                            </button>
                        </div>
                    )}
                </>
            )}
            {error && <p role="alert" data-testid="manage-featured-error" className={errorLine}>{error}</p>}
        </section>
    );
}

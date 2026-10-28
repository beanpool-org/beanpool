/**
 * The keepers' console's own parts (slice S7 of scratch/tools/DESIGN-shops-round3-enterprise-shopfront-fable.md §3; Marty's
 * answers of 23 Oct 2026), drawn by app/treasury-manage.tsx: the enterprise's face as one form with one Save, and its
 * Featured shelf. Their rules are utils/enterprise-manage.ts; the node's routes utils/shop.ts.
 *
 * - The face: any keeper its About, logo, banner photo, category and how we deal; its lead its name and what it is for, which
 *   every other keeper reads with the sentence why (never hidden without saying). A node admin who keeps none of it gets
 *   no banner photo, category or how we deal (its shop's routes take its keepers only), and no Featured (drawn by the console for keepers). One Save sends what changed; the node's refusal
 *   shows in its own words, and no answer says so, keeping what was typed. The console reads the enterprise again after
 *   any action on it, and what was typed and not saved stays through that (faceOnRead).
 * - Featured: each of its live Offers in its shop, on the shelf or off it with one tap (six at most, said once when
 *   full); its live Offers not in its shop yet go in with one tap; no shop yet, one tap opens it.
 *
 * One column, every target at least 48 dp, words through t(), colours from the central tokens (tools/ui.tsx, Home's
 * card parts), at 320 dp and 1.3× text. The logo and the banner photo are the parts of their photos the keeper chose on the
 * crop screen (components/PictureCrop.tsx): the logo 512 px square, the banner 3:1 at 800 px (utils/banner-photo.ts), never more.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { ENTERPRISE_ABOUT_LIMIT, ENTERPRISE_NAME_LIMIT, ENTERPRISE_PURPOSE_LIMIT, SHOP_FEATURED_MAX, SHOP_HOW_TO_DEAL_LIMIT, formatCount, t, tn } from '@beanpool/core';
import { useTheme } from '../../app/ThemeContext';
import { HOME_TARGET_DP, homeStyles } from '../home/HomeParts';
import { MemberAvatar } from '../MemberAvatar';
import { AvatarPickerSheet } from '../AvatarPickerSheet';
import { ToolButton, ToolButtons, ToolField, ToolInput, ToolNote, ToolRow, ToolSection } from '../../tools/ui';
import { ShopCategorySheet } from '../shop/ShopSheets';
import { addOffersToEnterpriseShop, changeEnterpriseFace, changeEnterpriseShop, featureOffer, shopCategoryLabel, type ShopListing } from '../../utils/shop';
import { faceAfterSave, faceFormOf, faceOnRead, faceSaveOf, featuredShelf, leadOnlyLine, refusalWords, savesAnything, type FaceForm, type FaceSave, type FaceState } from '../../utils/enterprise-manage';
import { shopPhotoOf } from '../../utils/shopfront';
import { pickBannerPhoto } from '../../utils/banner-photo';
import { usePictureCrop } from '../PictureCrop';
import { useNodeUri } from '../../utils/node-uri';

/** Its face: one form, one Save. `onSaved` reads the enterprise again once anything was written. */
export function ManageFace({ treasury, detail, lead, keeper, project, logoUrl, onSaved }: {
    treasury: string;
    detail: unknown;
    lead: boolean;
    /** A keeper of it: its category and how we deal are its shop's, which only its keepers change (not a node admin's). */
    keeper: boolean;
    project: boolean;
    /** Its logo now (its avatar's address). */
    logoUrl: string | null | undefined;
    onSaved: () => void;
}) {
    const { colors } = useTheme();
    const read = useMemo(() => faceFormOf(detail), [detail]);
    const [form, setForm] = useState<FaceState>(() => ({ before: read, draft: read }));
    // Every read of the enterprise, not only this form's Save's: what the keeper typed and hasn't saved stays.
    useEffect(() => { setForm((f) => faceOnRead(f, read)); }, [read]);
    const { before, draft } = form;
    // The logo just saved, shown until the enterprise is read with its new one (`over`: its logo when it was sent).
    const [sentLogo, setSentLogo] = useState<{ uri: string; over: string | null | undefined } | null>(null);
    const [busy, setBusy] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [partly, setPartly] = useState(false);
    const [picking, setPicking] = useState(false);
    const [choosingCategory, setChoosingCategory] = useState(false);
    const plan = faceSaveOf(before, draft, lead, keeper);
    const name = typeof (detail as Record<string, unknown> | null)?.name === 'string' ? (detail as Record<string, string>).name : '';
    const logoShown = draft.logo ?? (sentLogo && sentLogo.over === logoUrl ? sentLogo.uri : null) ?? logoUrl ?? null;
    // Its shop's banner: the one just sent until the enterprise is read with it (`over`: its shop's when it was sent), else
    // its shop's as read. Its banner as it will be: the photo just picked, none once taken down, else its shop's.
    const heldBanner = shopPhotoOf((detail as Record<string, unknown> | null)?.shop);
    const [sentBanner, setSentBanner] = useState<{ value: string | null; over: string | null } | null>(null);
    const shopBanner = sentBanner && sentBanner.over === heldBanner ? sentBanner.value : heldBanner;
    const bannerValue = draft.banner !== undefined ? draft.banner : shopBanner;
    const bannerShown = useNodeUri(bannerValue);
    const [pickingBanner, setPickingBanner] = useState(false);
    // The banner's crop step: the strip of the photo that shows, 3:1 as its page draws it (components/PictureCrop.tsx).
    const cropper = usePictureCrop(colors);
    const pickBanner = async () => {
        if (busy || pickingBanner) return;
        setPickingBanner(true);
        setError(null);
        try {
            const photo = await pickBannerPhoto(cropper.crop);
            if (photo) edit({ banner: photo });
        } catch {
            setError(t("That picture couldn't be read. Try another."));
        } finally {
            setPickingBanner(false);
        }
    };
    // Taking down a photo only just picked leaves its shop as it is when it has none; one just sent is its shop's.
    const removeBanner = () => edit({ banner: shopBanner ? null : undefined });

    const edit = (next: Partial<FaceForm>) => {
        setForm((f) => ({ ...f, draft: { ...f.draft, ...next } }));
        setSaved(false);
        setError(null);
        setPartly(false);
    };

    const save = async () => {
        if (busy || !savesAnything(plan)) return;
        const typed = draft;
        setBusy(true);
        setSaved(false);
        setError(null);
        setPartly(false);
        let faceDone = false;
        const went = (sent: FaceSave) => {
            setForm((f) => faceAfterSave(f, typed, sent));
            if (sent.face.avatar) setSentLogo({ uri: sent.face.avatar, over: logoUrl });
            if (sent.shop.photo !== undefined) setSentBanner({ value: sent.shop.photo, over: heldBanner });
        };
        try {
            if (Object.keys(plan.face).length > 0) {
                await changeEnterpriseFace(treasury, plan.face);
                faceDone = true;
            }
            if (Object.keys(plan.shop).length > 0) await changeEnterpriseShop(treasury, plan.shop);
            went(plan);
            setSaved(true);
            onSaved();
        } catch (e) {
            setError(refusalWords(e));
            // Its face went and its shop's part didn't: the face is as typed now, and only the rest is still to save.
            if (faceDone) {
                setPartly(true);
                went({ face: plan.face, shop: {} });
                onSaved();
            }
        } finally {
            setBusy(false);
        }
    };

    return (
        <ToolSection title={t('Its shopfront')} testID="manage-face">
            <ToolNote text={t('What members see on its page. Change any of it, then Save.')} />
            {lead ? (
                <>
                    <ToolInput label={t('Name')} value={draft.name} onChange={(v) => edit({ name: v })} max={ENTERPRISE_NAME_LIMIT.chars} testID="manage-face-name" />
                    <ToolInput label={t('What it is for')} value={draft.purpose} onChange={(v) => edit({ purpose: v })} max={ENTERPRISE_PURPOSE_LIMIT.chars} lines={3} testID="manage-face-purpose" />
                </>
            ) : (
                <>
                    <ToolField label={t('Name')} value={before.name} testID="manage-face-name-shown" />
                    <ToolField label={t('What it is for')} value={before.purpose || t('Not written yet')} testID="manage-face-purpose-shown" />
                    <ToolNote text={leadOnlyLine(project)} testID="manage-face-lead-only" />
                </>
            )}
            <View style={styles.logoRow}>
                <View testID="manage-face-logo-image">
                    <MemberAvatar avatarUrl={logoShown} pubkey={treasury} callsign={draft.name || name} size={56} />
                </View>
                <View style={styles.logoText}>
                    <Text style={[styles.logoLabel, { color: colors.text.body }]}>{t('Logo')}</Text>
                    <ToolButtons>
                        <ToolButton text={t('Change the logo')} onPress={() => setPicking(true)} disabled={busy} testID="manage-face-logo" />
                    </ToolButtons>
                </View>
            </View>
            {/* Its banner: its shop's one photo, across the top of its page (Marty, 24 Oct: the logo and the banner are two
                pictures). Its shop's, so its keepers' only; picked here as the 800 px copy, sent with the one Save. */}
            {keeper ? (
                <View style={styles.bannerRow} testID="manage-face-banner-row">
                    <Text style={[styles.logoLabel, { color: colors.text.body }]}>{t('Banner photo')}</Text>
                    {bannerShown ? (
                        <View style={[styles.bannerPreview, { borderColor: colors.border.default, backgroundColor: colors.surface.subtle }]} testID="manage-face-banner-image">
                            <Image source={{ uri: bannerShown }} style={styles.bannerImage} contentFit="cover" accessibilityLabel={t('Its banner photo')} />
                        </View>
                    ) : null}
                    <ToolButtons>
                        <ToolButton text={pickingBanner ? t('Reading the picture…') : bannerValue ? t('Change the banner photo') : t('Choose a banner photo')}
                            onPress={() => { void pickBanner(); }} disabled={busy || pickingBanner} testID="manage-face-banner" />
                        {bannerValue ? <ToolButton text={t('Remove the banner photo')} onPress={removeBanner} disabled={busy || pickingBanner} testID="manage-face-banner-remove" /> : null}
                    </ToolButtons>
                </View>
            ) : null}
            <ToolInput label={t('About')} value={draft.about} onChange={(v) => edit({ about: v })} max={ENTERPRISE_ABOUT_LIMIT.chars} lines={4} testID="manage-face-about" />
            {/* Its category in a row, the Market's in the sheet Your shop uses: picked here, sent with the one Save. Its shop's,
                so its keepers' only. */}
            {keeper ? (
                <>
                    <ToolRow title={t('Category')} state={draft.category ? shopCategoryLabel(draft.category) : t('Not chosen yet')} onPress={() => setChoosingCategory(true)} testID="manage-face-category" />
                    <ToolInput label={t('How we deal')} value={draft.howToDeal} onChange={(v) => edit({ howToDeal: v })} max={SHOP_HOW_TO_DEAL_LIMIT.chars} lines={3}
                        hint={t('Where to pick up, and when things come back.')} testID="manage-face-how" />
                </>
            ) : null}
            <ToolButtons>
                <ToolButton primary text={busy ? t('Saving…') : t('Save')} onPress={() => { void save(); }} disabled={busy || !savesAnything(plan)} testID="manage-face-save" />
            </ToolButtons>
            {saved ? <ToolNote text={t('Saved.')} testID="manage-face-saved" /> : null}
            {error ? <ToolNote tone="danger" text={error} testID="manage-face-error" /> : null}
            {partly ? <ToolNote text={t('Its other changes were saved.')} testID="manage-face-partly" /> : null}
            <ShopCategorySheet visible={choosingCategory} category={draft.category} busy={false} refusal={null} colors={colors}
                onPick={(c) => { edit({ category: c }); setChoosingCategory(false); }} onClose={() => setChoosingCategory(false)} />
            <AvatarPickerSheet visible={picking} title={t('Its logo')} colors={colors} onClose={() => setPicking(false)} onSelectImage={(uri) => edit({ logo: uri })} />
            {cropper.element}
        </ToolSection>
    );
}

/**
 * Featured, and what is in its shop: `offers` its Offers as its keeper reads them (undefined while read, null when they
 * couldn't be). `onOffers` takes them as the node now has them; `onShopChanged` reads the enterprise again.
 */
export function ManageFeatured({ treasury, shopId, offers, onOffers, onShopChanged }: {
    treasury: string;
    shopId: string | null;
    offers: ShopListing[] | null | undefined;
    onOffers: (next: ShopListing[]) => void;
    onShopChanged: () => void;
}) {
    const { colors } = useTheme();
    const s = homeStyles(colors);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const shelf = featuredShelf(offers ?? [], shopId);

    const toggle = async (o: ShopListing) => {
        if (busy) return;
        setBusy(o.id);
        setError(null);
        try {
            const featuredAt = await featureOffer(o.id, !o.featuredAt);
            onOffers((offers ?? []).map((x) => (x.id === o.id ? { ...x, featuredAt } : x)));
        } catch (e) {
            setError(refusalWords(e));
        } finally {
            setBusy(null);
        }
    };
    const putIn = async () => {
        if (busy) return;
        setBusy('add');
        setError(null);
        try {
            await addOffersToEnterpriseShop(treasury, shelf.outside.map((o) => o.id));
            onShopChanged();
        } catch (e) {
            setError(refusalWords(e));
        } finally {
            setBusy(null);
        }
    };
    const openShop = async () => {
        if (busy) return;
        setBusy('open');
        setError(null);
        try {
            await changeEnterpriseShop(treasury, {});
            onShopChanged();
        } catch (e) {
            setError(refusalWords(e));
        } finally {
            setBusy(null);
        }
    };

    return (
        <ToolSection title={t('Featured')} testID="manage-featured">
            {!shopId ? (
                <>
                    <ToolNote text={t('It has no shop yet. Open it to put its Offers in and feature them.')} testID="manage-shop-none" />
                    <ToolButtons>
                        <ToolButton primary text={busy === 'open' ? t('Opening…') : t('Open its shop')} disabled={!!busy} onPress={() => { void openShop(); }} testID="manage-shop-open" />
                    </ToolButtons>
                </>
            ) : offers === undefined ? (
                <ToolNote text={t('Reading its Offers…')} />
            ) : offers === null ? (
                <ToolNote text={t("Its Offers couldn't be read just now.")} testID="manage-featured-unread" />
            ) : (
                <>
                    <ToolNote text={t('Up to six of its Offers, shown first on its page. {n} of {max} on the shelf.', { n: formatCount(shelf.featured), max: formatCount(SHOP_FEATURED_MAX) })} />
                    {shelf.inShop.length === 0 ? <ToolNote text={t('Nothing in its shop yet.')} testID="manage-featured-empty" /> : null}
                    {shelf.inShop.map((o) => {
                        const on = !!o.featuredAt;
                        const waits = !on && shelf.full;
                        const off = waits || (!!busy && busy !== o.id);
                        return (
                            <Pressable
                                key={o.id}
                                onPress={off ? undefined : () => { void toggle(o); }}
                                disabled={off}
                                style={({ pressed }) => [s.row, pressed && s.pressed, waits && styles.waits]}
                                accessibilityRole="checkbox"
                                accessibilityLabel={o.title}
                                accessibilityHint={on ? t('On the shelf. Tap to take it off.') : t('Tap to put it on the shelf.')}
                                accessibilityState={{ checked: on, disabled: off, busy: busy === o.id }}
                                testID={`manage-feature-${o.id}`}
                            >
                                <MaterialCommunityIcons name={on ? 'star' : 'star-outline'} size={24} color={on ? colors.accent.primary : colors.text.secondary} />
                                <View style={s.rowText}>
                                    <Text style={[s.rowLine, s.rowStrong]} numberOfLines={2}>{o.title}</Text>
                                    <Text style={s.rowSub} numberOfLines={1}>{on ? t('Featured') : t('Not featured')}</Text>
                                </View>
                            </Pressable>
                        );
                    })}
                    {shelf.full ? <ToolNote tone="warning" text={t('Six is the shelf; un-feature one first.')} testID="manage-featured-full" /> : null}
                    {shelf.outside.length > 0 ? (
                        <>
                            <ToolNote
                                text={tn(shelf.outside.length, "{n} of its live Offers isn't in its shop yet, so it can't be featured.", "{n} of its live Offers aren't in its shop yet, so they can't be featured.")}
                                testID="manage-shop-outside"
                            />
                            <ToolButtons>
                                <ToolButton text={busy === 'add' ? t('Putting them in…') : t('Put them in its shop')} disabled={!!busy} onPress={() => { void putIn(); }} testID="manage-shop-add" />
                            </ToolButtons>
                        </>
                    ) : null}
                </>
            )}
            {error ? <ToolNote tone="danger" text={error} testID="manage-featured-error" /> : null}
        </ToolSection>
    );
}

const styles = StyleSheet.create({
    logoRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
    logoText: { flex: 1, minWidth: 0 },
    logoLabel: { fontSize: 13, fontWeight: '700' },
    bannerRow: { paddingVertical: 6, gap: 8 },
    // The banner as its page draws it: the full width, 3:1 (core BANNER_PICTURE), so the strip chosen is the strip seen.
    bannerPreview: { aspectRatio: 3, borderRadius: 12, borderWidth: 1, overflow: 'hidden' },
    bannerImage: { width: '100%', height: '100%' },
    waits: { opacity: 0.6, minHeight: HOME_TARGET_DP },
});

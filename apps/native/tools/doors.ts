/**
 * The doors' writers (scratch/tools/DESIGN-tool-template-fable.md §1.4, slice T0.2): what `offerDoor` (through the List
 * sheet) and `needDoor` do, and how a picked photo is kept. Only the host and its sheets call these; the eslint fence
 * refuses a tool any import of this file, so a tool reaches them only through the functions its permissions grant.
 *
 * A door writes the composer's own draft (app/new-listing.tsx `OFFER_DRAFT_KEY`, read there, never changed here), marked
 * as the tool's, and opens the composer with `?newPost=<type>`; the composer opens it prefilled without asking "Unfinished
 * post?" (utils/compose-options.ts decideDraftOpen, while the draft is a minute old at most), and nothing is posted until
 * the member taps Post there. The composer was the map's (map.tsx, edited once for this by #2291) until MAP-FORM moved it
 * to its own screen; nothing here edits the map files.
 */
import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Crypto from 'expo-crypto';
import { t, type ShopCategory, type ToolNeedDraft, type ToolOfferDraft, type ToolPhoto } from '@beanpool/core';
import { keepToolPhoto, toolPhotoDataUri } from './photos';
import { communityKey } from './community';
import { clearShopChoice, rememberShopChoice } from '../utils/shop-choice';

/** The Offer composer's draft key (app/new-listing.tsx `OFFER_DRAFT_KEY`, read there and never changed here). */
export const OFFER_DRAFT_KEY = 'beanpool_offer_draft';
/** The composer keeps at most this many photos (app/new-listing.tsx pickPhoto). */
const DRAFT_PHOTOS = 5;

/** A photo picked or taken: 800 px wide JPEG (the Offer form's downsize), kept in the tool's folder under a new ref. */
export async function keepPicked(community: string, owner: string, tool: string, result: ImagePicker.ImagePickerResult): Promise<ToolPhoto | null> {
    const asset = !result.canceled ? result.assets?.[0] : undefined;
    if (!asset?.uri) return null;
    const small = await ImageManipulator.manipulateAsync(asset.uri, [{ resize: { width: 800 } }], { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG });
    return keepToolPhoto(community, owner, tool, small, Crypto.randomUUID());
}

/** The fee the List sheet set: free, Beans per day or per week, or a fixed number of Beans. */
export interface ToolListFee {
    kind: 'free' | 'daily' | 'weekly' | 'fixed';
    beans: number;
}

/**
 * The map composer's own draft (map.tsx persistDraft's shape) from a tool's: its title and words as the tool wrote them,
 * the fee as the List sheet set it (0 where Beans are off), the tool's photos as the composer keeps them (data URIs), no
 * pin, and `savedAt` now. With `tool`, it also carries the tool's marker, `source: 'tool'` and `tool: <id>`, so the
 * composer opens it without asking while it is fresh (utils/compose-options.ts decideDraftOpen), and clears the marker
 * once it has. The fields a server slice adds (lendable, availableFrom…) are dropped until that slice lands; `shop` is the
 * List sheet's to say, beside the draft ({@link openOfferComposer}).
 */
export function composerDraft(
    type: 'offer' | 'need', draft: ToolOfferDraft | ToolNeedDraft, anchorUrl: string | null, photos: readonly string[], fee: ToolListFee | null, now: number,
    tool?: string,
): Record<string, unknown> {
    const offer = type === 'offer' ? draft as ToolOfferDraft : null;
    const beans = fee && fee.kind !== 'free' ? Math.max(0, Math.floor(fee.beans)) : 0;
    return {
        anchorUrl,
        postType: type,
        postCategory: draft.category ?? '',
        postTitle: draft.title,
        postDescription: draft.description ?? '',
        postCredits: type === 'offer' ? String(fee ? beans : (offer?.credits ?? 0)) : '',
        postPriceType: fee ? (fee.kind === 'free' ? 'fixed' : fee.kind) : (offer?.priceType ?? 'fixed'),
        postRepeatable: !!offer?.repeatable,
        postCashAlsoNeeded: !!offer?.cashAlsoNeeded,
        postPhotos: photos.slice(0, DRAFT_PHOTOS),
        postLat: null,
        postLng: null,
        postReach: 'local',
        postReachPeers: [],
        savedAt: now,
        ...(tool ? { source: 'tool', tool } : {}),
    };
}

/** Whether the phone holds an unfinished post the member started on the map for this community (map.tsx's own test). */
export async function unfinishedPostHere(): Promise<boolean> {
    try {
        const [raw, anchorUrl] = await Promise.all([AsyncStorage.getItem(OFFER_DRAFT_KEY), AsyncStorage.getItem('beanpool_anchor_url')]);
        const d = raw ? JSON.parse(raw) : null;
        return !!d && d.anchorUrl === anchorUrl && !!(d.postTitle?.trim() || d.postDescription?.trim() || d.postPhotos?.length);
    } catch {
        return false;
    }
}

/** The composer's draft written from the tool's; its community and the photos it holds, as the composer will post them. */
async function writeDraft(type: 'offer' | 'need', owner: string, tool: string, draft: ToolOfferDraft | ToolNeedDraft, fee: ToolListFee | null): Promise<{ anchorUrl: string | null; photos: string[] }> {
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    const community = communityKey(anchorUrl);
    const refs = type === 'offer' ? ((draft as ToolOfferDraft).photos ?? []) : [];
    const photos = (await Promise.all(refs.slice(0, DRAFT_PHOTOS).map((ref) => toolPhotoDataUri(community, owner, tool, ref)))).filter((p): p is string => !!p);
    await AsyncStorage.setItem(OFFER_DRAFT_KEY, JSON.stringify(composerDraft(type, draft, anchorUrl, photos, fee, Date.now(), tool)));
    return { anchorUrl, photos };
}

/**
 * The List sheet's button: the draft written for the map's composer, which opens it. Nothing is posted here. "Put this in
 * your shop" (`inShop`) is kept beside the draft, known by the title, words and photos it hands the composer
 * (utils/shop-choice.ts), since the composer carries only its own fields; off, any earlier choice is forgotten. In the
 * shop, a draft with no category of its own starts in the shop's (`shopCategory`; Marty, 25 Oct 2026), which the member can
 * change in the composer like any.
 */
export async function openOfferComposer(owner: string, tool: string, draft: ToolOfferDraft, fee: ToolListFee, inShop = false, shopCategory: ShopCategory | null = null): Promise<void> {
    const listed = inShop && !draft.category && shopCategory ? { ...draft, category: shopCategory } : draft;
    const { anchorUrl, photos } = await writeDraft('offer', owner, tool, listed, fee);
    await rememberShopChoice(anchorUrl, { title: draft.title, description: draft.description, photos }, inShop);
    router.push('/new-listing?newPost=offer');
}

/** Asked before a door replaces the member's unfinished post on the map (the composer keeps one draft): true to go on. */
function replaceUnfinishedPost(): Promise<boolean> {
    return new Promise((resolve) => {
        Alert.alert(t('Replace your unfinished post?'), t('You have an unfinished post on the map. Going on replaces it.'), [
            { text: t('Cancel'), style: 'cancel', onPress: () => resolve(false) },
            { text: t('Go on'), style: 'destructive', onPress: () => resolve(true) },
        ], { cancelable: true, onDismiss: () => resolve(false) });
    });
}

/**
 * `needDoor`: the Need composer, prefilled. Nothing is posted until the member taps Post. It has no sheet, so an
 * unfinished post on the map that it would replace is asked about first, as the List sheet says it for an Offer. The
 * composer keeps one draft, so a List sheet's "Put this in your shop" goes with the Offer this replaces.
 */
export async function openNeedComposer(owner: string, tool: string, draft: ToolNeedDraft): Promise<void> {
    if (await unfinishedPostHere() && !await replaceUnfinishedPost()) return;
    await writeDraft('need', owner, tool, draft, null);
    await clearShopChoice();
    router.push('/new-listing?newPost=need');
}

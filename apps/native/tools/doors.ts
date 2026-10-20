/**
 * The doors' writers (scratch/tools/DESIGN-tool-template-fable.md §1.4, slice T0.2): what `offerDoor` (through the List
 * sheet) and `needDoor` do, and how a picked photo is kept. Only the host and its sheets call these; the eslint fence
 * refuses a tool any import of this file, so a tool reaches them only through the functions its permissions grant.
 *
 * A door writes the map composer's own draft (map.tsx `OFFER_DRAFT_KEY`, read there, never changed here) and opens the
 * composer with `?newPost=<type>`; the composer offers to continue the draft, and nothing is posted until the member taps
 * Post there. The map files are not edited.
 */
import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Crypto from 'expo-crypto';
import { t, type ToolNeedDraft, type ToolOfferDraft, type ToolPhoto } from '@beanpool/core';
import { keepToolPhoto, toolPhotoDataUri } from './photos';

/** The Offer composer's draft key (app/(tabs)/map.tsx `OFFER_DRAFT_KEY`, read there and never changed here). */
export const OFFER_DRAFT_KEY = 'beanpool_offer_draft';
/** The composer keeps at most this many photos (map.tsx pickPhoto). */
const DRAFT_PHOTOS = 5;

/** A photo picked or taken: 800 px wide JPEG (the Offer form's downsize), kept in the tool's folder under a new ref. */
export async function keepPicked(owner: string, tool: string, result: ImagePicker.ImagePickerResult): Promise<ToolPhoto | null> {
    const asset = !result.canceled ? result.assets?.[0] : undefined;
    if (!asset?.uri) return null;
    const small = await ImageManipulator.manipulateAsync(asset.uri, [{ resize: { width: 800 } }], { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG });
    return keepToolPhoto(owner, tool, small, Crypto.randomUUID());
}

/** The fee the List sheet set: free, Beans per day or per week, or a fixed number of Beans. */
export interface ToolListFee {
    kind: 'free' | 'daily' | 'weekly' | 'fixed';
    beans: number;
}

/**
 * The map composer's own draft (map.tsx persistDraft's shape) from a tool's: its title and words as the tool wrote them,
 * the fee as the List sheet set it (0 where Beans are off), the tool's photos as the composer keeps them (data URIs), no
 * pin. The fields a server slice adds (lendable, shop, availableFrom…) are dropped until that slice lands.
 */
export function composerDraft(
    type: 'offer' | 'need', draft: ToolOfferDraft | ToolNeedDraft, anchorUrl: string | null, photos: readonly string[], fee: ToolListFee | null, now: number,
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

async function writeDraftAndOpen(type: 'offer' | 'need', owner: string, tool: string, draft: ToolOfferDraft | ToolNeedDraft, fee: ToolListFee | null): Promise<void> {
    const refs = type === 'offer' ? ((draft as ToolOfferDraft).photos ?? []) : [];
    const photos = (await Promise.all(refs.slice(0, DRAFT_PHOTOS).map((ref) => toolPhotoDataUri(owner, tool, ref)))).filter((p): p is string => !!p);
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    await AsyncStorage.setItem(OFFER_DRAFT_KEY, JSON.stringify(composerDraft(type, draft, anchorUrl, photos, fee, Date.now())));
    router.push(`/(tabs)/map?newPost=${type}`);
}

/** The List sheet's button: the draft written for the map's composer, which opens it. Nothing is posted here. */
export function openOfferComposer(owner: string, tool: string, draft: ToolOfferDraft, fee: ToolListFee): Promise<void> {
    return writeDraftAndOpen('offer', owner, tool, draft, fee);
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
 * unfinished post on the map that it would replace is asked about first, as the List sheet says it for an Offer.
 */
export async function openNeedComposer(owner: string, tool: string, draft: ToolNeedDraft): Promise<void> {
    if (await unfinishedPostHere() && !await replaceUnfinishedPost()) return;
    return writeDraftAndOpen('need', owner, tool, draft, null);
}

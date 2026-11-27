/**
 * A photo for a listing, as the member's own composer adds one (app/(tabs)/map.tsx pickPhoto): Camera, Gallery (opened on
 * Albums), or Browse files (the system document picker for images, reaching every folder). The photo is picked whole, then
 * sent 800 px wide as a JPEG at 0.7 (memory: photos stay 800px). The redraw also leaves the camera's metadata behind.
 *
 * Asked for only at the tap that needs it (Marty, 26 Oct, from Damo): the camera's permission when Camera is tapped, and
 * nothing for Gallery or Browse files, which use the system picker / Storage Access Framework and need no permission
 * (READ_MEDIA_IMAGES stays in app.json's blockedPermissions, #1284). The picker and the image tools are loaded when a photo
 * is picked, not when a screen that offers one opens (as utils/picture-crop.ts).
 */
import { Alert, Platform, type AlertButton } from 'react-native';
import { fetchedPhotoOf, photosLeftOutLine, photosThatFit, t } from '@beanpool/core';

/** The longest a listing photo's width is sent. */
export const POST_PHOTO_WIDTH = 800;

/** The picked photo as a JPEG data URL, at most 800 px wide; null when the tools gave none back. */
export async function postPhotoOf(uri: string): Promise<string | null> {
    const ImageManipulator = await import('expo-image-manipulator');
    const out = await ImageManipulator.manipulateAsync(uri, [{ resize: { width: POST_PHOTO_WIDTH } }],
        { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true });
    return out.base64 ? `data:image/jpeg;base64,${out.base64}` : null;
}

import type { FetchedPhoto } from '@beanpool/core';

export type { FetchedPhoto };

/** How long a community has to give one photo. */
const FETCH_PHOTO_TIMEOUT_MS = 20_000;
function dataUrlOf(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('unreadable photo'));
        reader.readAsDataURL(blob);
    });
}

/**
 * A listing's photo fetched as any phone fetches it, unsigned, its bytes unchanged: sent 800 px wide when it was posted,
 * and a second JPEG pass would only lose detail. A 200 that isn't an image (a captive portal's page) is no photo: the
 * node would refuse the whole listing for it.
 */
export async function fetchedPostPhoto(url: string): Promise<FetchedPhoto> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_PHOTO_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) return { failed: res.status === 408 || res.status === 429 || res.status >= 500 ? 'later' : 'gone' };
        return fetchedPhotoOf((await dataUrlOf(await res.blob())).replace(/^data:[^,]*,/, ''));
    } catch {
        return { failed: 'later' };
    } finally {
        clearTimeout(timer);
    }
}

/** From the camera: its permission asked now, at the tap. */
export async function postPhotoFromCamera(): Promise<string | null> {
    const ImagePicker = await import('expo-image-picker');
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) { Alert.alert(t('Permission needed'), t('Camera access is needed.')); return null; }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1, base64: false });
    return !result.canceled && result.assets?.[0]?.uri ? postPhotoOf(result.assets[0].uri) : null;
}

/**
 * What one pick from the photo picker or Browse files gave a form: the photos it keeps, each sent 800 px wide (postPhotoOf),
 * in the order picked; how many did not fit the room it had left (photosThatFit: the first ones are kept); and, when one
 * photo's redraw failed, that error (the others are still kept, so a bad photo never costs the good ones).
 */
export interface PickedPostPhotos {
    photos: string[];
    leftOut: number;
    failed: unknown;
}

/** Each kept photo through the same 800 px redraw as one photo always went, in order. */
async function redrawnInOrder(uris: readonly string[], leftOut: number): Promise<PickedPostPhotos> {
    const photos: string[] = [];
    let failed: unknown = null;
    for (const uri of uris) {
        try {
            const photo = await postPhotoOf(uri);
            if (photo) photos.push(photo);
        } catch (e) {
            failed ??= e ?? new Error('unreadable photo');
        }
    }
    return { photos, leftOut, failed };
}

/** The picked photos' addresses, in the order the picker gave them; none when the member left without one. */
function pickedUris(result: { canceled: boolean; assets?: ({ uri?: string | null } | null)[] | null }): string[] {
    if (result.canceled) return [];
    return (result.assets ?? []).map((a) => a?.uri).filter((uri): uri is string => typeof uri === 'string' && uri !== '');
}

/**
 * Up to `room` photos from the system's photo picker, opened on Albums: no permission. With room for more than one, the member
 * picks several in one go (Marty, 26 Nov 2026): the picker itself counts them to the room left (Android's photo picker and
 * iOS's PHPicker both stop at the limit) and gives them back in the order they were picked. With room for one it opens exactly
 * as it always did, a single pick.
 */
export async function postPhotosFromLibrary(room: number): Promise<PickedPostPhotos> {
    const ImagePicker = await import('expo-image-picker');
    const several = room > 1;
    const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'], quality: 1, base64: false, defaultTab: 'albums',
        ...(several ? { allowsMultipleSelection: true, selectionLimit: Math.floor(room), orderedSelection: true } : {}),
    });
    const { kept, leftOut } = photosThatFit(pickedUris(result), room);
    return redrawnInOrder(kept, leftOut);
}

/**
 * Up to `room` photos from the system's document picker (legacy mode for images): reaches every folder without permission.
 * The document picker has no count of its own, and the image picker would quietly cut the list at a selection limit, so it is
 * asked for every photo picked (0: no limit) and the first `room` are kept here, where the member can be told how many were
 * left out.
 */
export async function postPhotosFromFiles(room: number): Promise<PickedPostPhotos> {
    const ImagePicker = await import('expo-image-picker');
    const several = room > 1;
    const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'], quality: 1, base64: false, legacy: true,
        ...(several ? { allowsMultipleSelection: true, selectionLimit: 0 } : {}),
    });
    const { kept, leftOut } = photosThatFit(pickedUris(result), room);
    return redrawnInOrder(kept, leftOut);
}

/** One photo, as a pick for a form with room for one: its redraw's failure is thrown, as it always was. */
async function onePhoto(pick: Promise<PickedPostPhotos>): Promise<string | null> {
    const picked = await pick;
    if (picked.failed && picked.photos.length === 0) throw picked.failed;
    return picked.photos[0] ?? null;
}

/** From the system's photo picker, opened on Albums: no permission. */
export async function postPhotoFromLibrary(): Promise<string | null> {
    return onePhoto(postPhotosFromLibrary(1));
}

/** From the system's document picker (legacy mode for images): reaches every folder without permission. */
export async function postPhotoFromFiles(): Promise<string | null> {
    return onePhoto(postPhotosFromFiles(1));
}

/**
 * The photo-source sheet every Add photo uses. Android's Alert shows at most three buttons and, unless cancelable, can't be
 * closed by Back or a tap outside (review of #2512): there it is Camera, Gallery, Browse files, closed by Back or a tap
 * outside. iOS has no separate files door (the picker's legacy mode is Android-only, so it would open the same library
 * twice): there it is Camera, Gallery, Cancel. `camera` left out: Gallery, Browse files, Cancel on Android. Every way of
 * leaving without a choice calls `onCancel`.
 */
export function askPhotoSource(title: string, sources: { camera?: () => void; gallery: () => void; files: () => void }, onCancel?: () => void): void {
    const cancel: AlertButton = { text: t('Cancel'), style: 'cancel', onPress: onCancel };
    const buttons: AlertButton[] = [
        ...(sources.camera ? [{ text: t('Camera'), onPress: sources.camera }] : []),
        { text: t('Gallery'), onPress: sources.gallery },
        ...(Platform.OS === 'android' ? [{ text: t('Browse files'), onPress: sources.files }] : []),
    ];
    if (buttons.length < 3) buttons.push(cancel);
    Alert.alert(title, t('Choose a source'), buttons, { cancelable: true, onDismiss: onCancel });
}

/** Asks Camera, Gallery, or Browse files, then hands the picked photo to `add`. Nothing is asked of the phone until one is tapped. */
export function askForPostPhoto(add: (photo: string) => void, title?: string): void {
    askForPostPhotos(1, add, title);
}

/**
 * Asks Camera, Gallery, or Browse files for a form with `room` photos left, then hands each picked photo to `add`, one call
 * per photo in the order picked (a form appending to its list keeps them all). Gallery and Browse files let the member pick up
 * to `room` in one go (Marty, 26 Nov 2026: "she had to go back in to gallery 3 times to select 3 photos"); the Camera still
 * takes one. More picked than the room: the first ones are kept and an alert says how many were left out. A photo whose
 * redraw fails says "Photo not added", as one always did, and the others are kept. Nothing is asked of the phone until one is
 * tapped.
 *
 * `picked`, when given, hears once per pick, after `add` has been called for each, with the photos this pick handed over (none:
 * not called): a post form opens Adjust on them by itself (Marty, 28 Nov 2026, use-photo-focus-list.ts `added`).
 */
export function askForPostPhotos(room: number, add: (photo: string) => void, title?: string, picked?: (photos: string[]) => void): void {
    const notAdded = (e: any) => Alert.alert(t('Photo not added'), e?.message || t('Could not open your photos.'));
    const take = (pick: (room: number) => Promise<PickedPostPhotos>) => async () => {
        try {
            const got = await pick(room);
            for (const photo of got.photos) add(photo);
            if (got.photos.length > 0) picked?.(got.photos.slice());
            if (got.failed) notAdded(got.failed);
            // Short title, the words in the message (as the forum's "At most {n} photos." alert).
            else if (got.leftOut > 0) Alert.alert(t('Photos'), photosLeftOutLine(got.leftOut));
        } catch (e: any) {
            notAdded(e);
        }
    };
    const camera = async () => {
        try {
            const photo = await postPhotoFromCamera();
            if (photo) { add(photo); picked?.([photo]); }
        } catch (e: any) {
            Alert.alert(t('Camera Unavailable'), e?.message || t('Could not launch camera.'));
        }
    };
    askPhotoSource(title ?? t('Add Photo'), {
        camera,
        gallery: take(postPhotosFromLibrary),
        files: take(postPhotosFromFiles),
    });
}

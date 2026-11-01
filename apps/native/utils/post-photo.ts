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
import { t } from '@beanpool/core';

/** The longest a listing photo's width is sent. */
export const POST_PHOTO_WIDTH = 800;

/** The picked photo as a JPEG data URL, at most 800 px wide; null when the tools gave none back. */
export async function postPhotoOf(uri: string): Promise<string | null> {
    const ImageManipulator = await import('expo-image-manipulator');
    const out = await ImageManipulator.manipulateAsync(uri, [{ resize: { width: POST_PHOTO_WIDTH } }],
        { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true });
    return out.base64 ? `data:image/jpeg;base64,${out.base64}` : null;
}

/** A photo a community already holds, as a new post sends it, or why it can't be had: `gone` for good, or `later`. */
export type FetchedPhoto = { photo: string } | { failed: 'gone' | 'later' };

/** How long a community has to give one photo. */
const FETCH_PHOTO_TIMEOUT_MS = 20_000;
/** A node stores no picture past 2 MB (core MAX_PICTURE_BYTES): as base64, about this many characters. */
const MOST_PHOTO_CHARS = 2_800_000;

/** The kinds of image a node stores, by the start of their base64 (engine/avatar.ts sniffRasterImageType). */
function imageMimeOf(base64: string): string | null {
    if (base64.startsWith('/9j/')) return 'image/jpeg';
    if (base64.startsWith('iVBORw0KGgo')) return 'image/png';
    if (base64.startsWith('R0lGOD')) return 'image/gif';
    return base64.startsWith('UklGR') ? 'image/webp' : null;
}

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
        const base64 = (await dataUrlOf(await res.blob())).replace(/^data:[^,]*,/, '');
        const mime = imageMimeOf(base64);
        return mime && base64.length <= MOST_PHOTO_CHARS ? { photo: `data:${mime};base64,${base64}` } : { failed: 'gone' };
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
    if (!perm.granted) { Alert.alert(t('Permission needed')); return null; }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1, base64: false });
    return !result.canceled && result.assets?.[0]?.uri ? postPhotoOf(result.assets[0].uri) : null;
}

/** From the system's photo picker, opened on Albums: no permission. */
export async function postPhotoFromLibrary(): Promise<string | null> {
    const ImagePicker = await import('expo-image-picker');
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, base64: false, defaultTab: 'albums' });
    return !result.canceled && result.assets?.[0]?.uri ? postPhotoOf(result.assets[0].uri) : null;
}

/** From the system's document picker (legacy mode for images): reaches every folder without permission. */
export async function postPhotoFromFiles(): Promise<string | null> {
    const ImagePicker = await import('expo-image-picker');
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, base64: false, legacy: true });
    return !result.canceled && result.assets?.[0]?.uri ? postPhotoOf(result.assets[0].uri) : null;
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
    const take = (pick: () => Promise<string | null>, failed?: (e: any) => void) => async () => {
        try {
            const photo = await pick();
            if (photo) add(photo);
        } catch (e: any) {
            if (failed) failed(e);
            else Alert.alert(t('Photo not added'), e?.message || t('Could not open your photos.'));
        }
    };
    askPhotoSource(title ?? t('Add Photo'), {
        camera: take(postPhotoFromCamera, (e) => Alert.alert(t('Camera Unavailable'), e?.message || t('Could not launch camera.'))),
        gallery: take(postPhotoFromLibrary),
        files: take(postPhotoFromFiles),
    });
}

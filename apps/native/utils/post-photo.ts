/**
 * A photo for a listing, as the member's own composer adds one (app/(tabs)/map.tsx pickPhoto): Camera or Gallery, the photo
 * picked whole, then sent 800 px wide as a JPEG at 0.7 (memory: photos stay 800px). The redraw also leaves the camera's
 * metadata behind.
 *
 * Asked for only at the tap that needs it (Marty, 26 Oct, from Damo): the camera's permission when Camera is tapped, and
 * nothing for Gallery, which is the system's photo picker and needs no permission (READ_MEDIA_IMAGES stays in app.json's
 * blockedPermissions, #1284). The picker and the image tools are loaded when a photo is picked, not when a screen that
 * offers one opens (as utils/picture-crop.ts).
 */
import { Alert } from 'react-native';
import { t } from '@beanpool/core';

/** The longest a listing photo's width is sent. */
export const POST_PHOTO_WIDTH = 800;

/** The picked photo as a JPEG data URL, at most 800 px wide; null when the tools gave none back. */
async function postPhotoOf(uri: string): Promise<string | null> {
    const ImageManipulator = await import('expo-image-manipulator');
    const out = await ImageManipulator.manipulateAsync(uri, [{ resize: { width: POST_PHOTO_WIDTH } }],
        { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true });
    return out.base64 ? `data:image/jpeg;base64,${out.base64}` : null;
}

/** From the camera: its permission asked now, at the tap. */
export async function postPhotoFromCamera(): Promise<string | null> {
    const ImagePicker = await import('expo-image-picker');
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) { Alert.alert(t('Permission needed')); return null; }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1, base64: false });
    return !result.canceled && result.assets?.[0]?.uri ? postPhotoOf(result.assets[0].uri) : null;
}

/** From the system's photo picker: no permission. */
export async function postPhotoFromLibrary(): Promise<string | null> {
    const ImagePicker = await import('expo-image-picker');
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, base64: false });
    return !result.canceled && result.assets?.[0]?.uri ? postPhotoOf(result.assets[0].uri) : null;
}

/** Asks Camera or Gallery, then hands the picked photo to `add`. Nothing is asked of the phone until one is tapped. */
export function askForPostPhoto(add: (photo: string) => void): void {
    const take = (pick: () => Promise<string | null>, failed: (e: any) => void) => async () => {
        try {
            const photo = await pick();
            if (photo) add(photo);
        } catch (e: any) {
            failed(e);
        }
    };
    Alert.alert(t('Add Photo'), t('Choose a source'), [
        { text: t('Camera'), onPress: take(postPhotoFromCamera, (e) => Alert.alert(t('Camera Unavailable'), e?.message || t('Could not launch camera.'))) },
        { text: t('Gallery'), onPress: take(postPhotoFromLibrary, (e) => console.error('Failed to read the picked photo:', e)) },
        { text: t('Cancel'), style: 'cancel' },
    ]);
}

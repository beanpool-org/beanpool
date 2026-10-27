/**
 * A picture for a fixed shape on the phone (an avatar, a logo, a shop's banner): picked whole, then cropped by the member
 * on the crop screen (components/PictureCrop.tsx), then cut to exactly the part they chose (Marty, 25 Oct 2026: what the
 * member crops is exactly what is shown). The rule for the part chosen is core's (picture-crop.ts), the web's too.
 *
 * The picker never crops: `allowsEditing` crops a square on iOS whatever aspect is asked (expo-image-picker 55,
 * ImagePickerModule.swift), so a banner could never be chosen there. The photo is first made a working copy, its longest
 * side 1600 px: small enough for an old phone's memory (a 48 MP camera's photo is never held whole), large enough for a
 * banner's 800 px at twice in, and the same pixels the crop screen shows and the cut is made from. The cut is kept at the
 * shape's size (512 px square, or 800 × 267), a JPEG at 0.7 (memory: photos stay 800px).
 *
 * The picker and the image tools are loaded when a photo is picked, not when a screen that offers one opens.
 */
import type { ImagePickerOptions } from 'expo-image-picker';
import { croppedSize, PICTURE_CROP_QUALITY, type CropRect, type PictureShape, type PictureSize } from '@beanpool/core';

/** The working copy's longest side, in pixels. */
export const WORKING_COPY_SIDE = 1600;

/** The working copy: a JPEG on the phone and its size in pixels. */
export interface WorkingPicture extends PictureSize {
    uri: string;
}

/** Opens the crop step on a working copy in `shape`: the part chosen as a JPEG data URL, or null when the member cancelled. */
export type CropPicture = (picture: WorkingPicture, shape: PictureShape) => Promise<string | null>;

/** A photo as picked: its address and, when the picker says, its size. */
interface PickedPhoto {
    uri: string;
    width?: number;
    height?: number;
}

/**
 * A photo from the camera, the library (Albums tab on Android), or files (document picker in legacy mode, reaching every
 * folder), whole, made the working copy; null when none was chosen. The camera's permission is the caller's to ask (it says
 * why in its own words).
 */
export async function pickPicture(from: 'camera' | 'library' | 'files'): Promise<WorkingPicture | null> {
    const ImagePicker = await import('expo-image-picker');
    const options: ImagePickerOptions = {
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 1,
        base64: false,
        ...(from === 'library' ? { defaultTab: 'albums' } : {}),
        ...(from === 'files' ? { legacy: true } : {}),
    };
    const res = from === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
    const photo = !res.canceled ? res.assets?.[0] : undefined;
    return photo?.uri ? workingCopyOf(photo) : null;
}

/** The photo redrawn as the working copy, its longest side at most 1600 px. Throws when the tools can't read it. */
export async function workingCopyOf(photo: PickedPhoto): Promise<WorkingPicture> {
    const ImageManipulator = await import('expo-image-manipulator');
    const save = { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG };
    const w = photo.width ?? 0;
    const h = photo.height ?? 0;
    const shrink = Math.max(w, h) > WORKING_COPY_SIDE ? [w >= h ? { resize: { width: WORKING_COPY_SIDE } } : { resize: { height: WORKING_COPY_SIDE } }] : [];
    let copy = await ImageManipulator.manipulateAsync(photo.uri, shrink, save);
    // A picker that gave no size (or the size before the photo's turn): the copy says its own, and is made small now.
    if (Math.max(copy.width, copy.height) > WORKING_COPY_SIDE) {
        copy = await ImageManipulator.manipulateAsync(copy.uri, [copy.width >= copy.height ? { resize: { width: WORKING_COPY_SIDE } } : { resize: { height: WORKING_COPY_SIDE } }], save);
    }
    if (!copy.width || !copy.height) throw new Error('The picture could not be read.');
    return { uri: copy.uri, width: copy.width, height: copy.height };
}

/** The part chosen, cut from the working copy and made the shape's size, as a JPEG data URL. Throws when it can't be. */
export async function cutPicture(picture: WorkingPicture, rect: CropRect, shape: PictureShape): Promise<string> {
    const ImageManipulator = await import('expo-image-manipulator');
    const cut = await ImageManipulator.manipulateAsync(picture.uri, [{ crop: rect }, { resize: croppedSize(shape) }],
        { compress: PICTURE_CROP_QUALITY, format: ImageManipulator.SaveFormat.JPEG, base64: true });
    if (!cut.base64) throw new Error('The picture could not be made small enough to send.');
    return `data:image/jpeg;base64,${cut.base64}`;
}

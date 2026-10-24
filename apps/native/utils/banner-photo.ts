/**
 * A shop's banner photo, picked on the phone (DESIGN-shops-round3-enterprise-shopfront-fable.md §0 row 4; Marty, 24 Oct
 * 2026): one photo from the member's library, cropped wide, and made the phone's listing-photo copy before it goes: 800 px
 * wide, JPEG at 0.7 (memory: photos stay 800px; the node keeps it as sent, under its photo rule). Drawn across the top of
 * the shopfront, cropped to fill it (components/shopfront/Shopfront.tsx ShopfrontHeader).
 *
 * The picker and the image tools are loaded when a photo is picked, not when a screen that offers one opens (as
 * app/welcome.tsx loads expo-application): the console and Your shop open without either.
 */

/** The width the banner photo is sent at, as a listing's photo is. */
export const BANNER_PHOTO_WIDTH = 800;

/**
 * The picked photo as a JPEG data URL, or null when the member chose none. Throws when the picture can't be read or made
 * small, so the screen says so rather than sending nothing without a word.
 */
export async function pickBannerPhoto(): Promise<string | null> {
    const ImagePicker = await import('expo-image-picker');
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [16, 9], quality: 0.8, base64: false });
    const uri = !res.canceled ? res.assets?.[0]?.uri : undefined;
    if (!uri) return null;
    const ImageManipulator = await import('expo-image-manipulator');
    const small = await ImageManipulator.manipulateAsync(uri, [{ resize: { width: BANNER_PHOTO_WIDTH } }],
        { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true });
    if (!small.base64) throw new Error('The picture could not be made small enough to send.');
    return `data:image/jpeg;base64,${small.base64}`;
}

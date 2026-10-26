/**
 * A shop's banner photo, picked on the phone (DESIGN-shops-round3-enterprise-shopfront-fable.md §0 row 4; Marty, 24 Oct
 * 2026): one photo from the member's library (opening on Albums) or browsed files (reaching every folder), whole, then
 * the strip of it the member chooses on the crop screen (Marty, 25 Oct: "select the part of the image we want"), 3:1,
 * the shape the shopfront draws it in (components/shopfront/Shopfront.tsx ShopfrontHeader), so the strip chosen is the
 * strip seen. Kept 800 × 267, JPEG at 0.7 (core BANNER_PICTURE; memory: photos stay 800px; the node keeps it as sent,
 * under its photo rule).
 *
 * The picker and the image tools are loaded when a photo is picked, not when a screen that offers one opens (as
 * app/welcome.tsx loads expo-application): the console and Your shop open without either.
 */
import { Alert } from 'react-native';
import { BANNER_PICTURE, t } from '@beanpool/core';
import { pickPicture, type CropPicture, type WorkingPicture } from './picture-crop';

/**
 * The strip chosen as a JPEG data URL, or null when the member chose no photo or cancelled the crop. `crop` is the
 * screen's crop step (components/PictureCrop.tsx usePictureCrop). Throws when the picture can't be read or cut, so the
 * screen says so rather than sending nothing without a word. Offers Gallery (on Albums) and Browse files doors.
 */
export async function pickBannerPhoto(crop: CropPicture, from?: 'library' | 'files'): Promise<string | null> {
    const picture = from ? await pickPicture(from) : await new Promise<WorkingPicture | null>((resolve, reject) => {
        Alert.alert(t('Add Photo'), t('Choose a source'), [
            {
                text: t('Gallery'),
                onPress: () => {
                    pickPicture('library').then(resolve, reject);
                },
            },
            {
                text: t('Browse files'),
                onPress: () => {
                    pickPicture('files').then(resolve, reject);
                },
            },
            { text: t('Cancel'), style: 'cancel', onPress: () => resolve(null) },
        ]);
    });
    return picture ? crop(picture, BANNER_PICTURE) : null;
}

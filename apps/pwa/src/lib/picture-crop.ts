/**
 * A picture for a fixed shape on the web (an avatar, a logo, a shop's banner): read whole, then cropped by the member in
 * the crop dialog (components/PictureCropDialog.tsx), then drawn as exactly the part they chose (Marty, 25 Oct 2026: what
 * the member crops is exactly what is shown). The rule for the part chosen is core's (picture-crop.ts), the phone's too.
 *
 * The part chosen is redrawn on a canvas at the shape's size (512 px square, or 800 × 267) as a JPEG at 0.7: never larger
 * than 800 px (memory: photos stay 800px), and, as lib/photo-resize.ts, a canvas holds pixels and nothing else, so the
 * camera's GPS position and serial number stay behind. Free photos (listings, posts, chat) go through photo-resize.ts whole.
 */
import { croppedSize, PICTURE_CROP_QUALITY, type CropRect, type PictureShape, type PictureSize } from '@beanpool/core';

/** A picture read and decoded: its address for an <img>, its size in pixels (turned as the camera meant), and itself. */
export interface LoadedPicture extends PictureSize {
    src: string;
    image: HTMLImageElement;
}

/** The file read and decoded. Rejects when the browser cannot read or decode it. */
export function readPictureFile(file: Blob): Promise<LoadedPicture> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
        reader.onload = () => {
            const src = reader.result as string;
            const image = new Image();
            image.onerror = () => reject(new Error('Could not decode the picture'));
            image.onload = () => {
                const width = image.naturalWidth || image.width;
                const height = image.naturalHeight || image.height;
                if (!width || !height) { reject(new Error('The picture has no size')); return; }
                resolve({ src, image, width, height });
            };
            image.src = src;
        };
        reader.readAsDataURL(file);
    });
}

/** The part chosen, drawn at the shape's size, as a JPEG data URL. Throws when there is no canvas to draw on. */
export function drawPictureCrop(picture: LoadedPicture, rect: CropRect, shape: PictureShape): string {
    const { width, height } = croppedSize(shape);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No canvas to draw the picture on');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(picture.image, rect.originX, rect.originY, rect.width, rect.height, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', PICTURE_CROP_QUALITY);
}

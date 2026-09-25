/**
 * A picked photo as the web app sends it: redrawn on a canvas, no side longer than 800px, as a JPEG.
 *
 * The same resize the marketplace's photo picker does inline (MarketplacePage, the edit form's "+"), so a
 * photo from any picker reaches the node the same size and the same format. The redraw is also what leaves
 * the camera's metadata behind — GPS position, serial number, the time it was taken — because a canvas holds
 * pixels and nothing else. A FileReader data URL of the raw file keeps all of it, and a node serves an
 * enterprise's photo to anyone who asks.
 *
 * 800px is the ceiling for every photo in BeanPool: there are no bigger copies anywhere.
 */

export const MAX_PHOTO_SIDE = 800;
export const PHOTO_JPEG_QUALITY = 0.7;

/** The size a width × height picture is drawn at so neither side exceeds `max`, keeping its shape. Never enlarged. */
export function fitWithin(width: number, height: number, max = MAX_PHOTO_SIDE): { width: number; height: number } {
    if (width <= max && height <= max) return { width, height };
    if (width > height) return { width: max, height: Math.round(height * max / width) };
    return { width: Math.round(width * max / height), height: max };
}

/**
 * The file as a JPEG data URL no larger than 800px on its longest side. Always re-encoded, even when it is
 * already small, because the re-encode is what drops the metadata. Rejects when the browser cannot read or
 * decode the file.
 */
export function resizePhotoFile(file: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error('Could not decode the picture'));
            img.onload = () => {
                const { width, height } = fitWithin(img.width, img.height);
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                if (!ctx) { reject(new Error('No canvas to draw the picture on')); return; }
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', PHOTO_JPEG_QUALITY));
            };
            img.src = reader.result as string;
        };
        reader.readAsDataURL(file);
    });
}

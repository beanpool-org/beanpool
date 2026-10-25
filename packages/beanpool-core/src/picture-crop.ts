/**
 * The part of a picture a member chooses to show (Marty, 25 Oct 2026: "we want both the pwa and phone and both avatar and
 * banner to be able to select the part of the image we want"). What the member crops is exactly what is shown: every
 * picture drawn in a fixed shape goes through one crop step, a frame of that shape over the picture, moved and zoomed,
 * before it is kept. The phone's crop screen (apps/native/components/PictureCrop.tsx) and the web's crop dialog
 * (apps/pwa/src/components/PictureCropDialog.tsx) both work out the part chosen here, so one move and one zoom give the
 * same rectangle on both.
 *
 * The view is held in the picture's own pixels (a zoom and the middle of the part shown), not in screen points: a frame
 * that changes size (a phone turned, a window resized) shows the same part. Free photos (listings, posts, events, chat)
 * keep the whole picture and never come here.
 */

/** A picture's size in pixels. */
export interface PictureSize {
    width: number;
    height: number;
}

/** A fixed shape a picture is drawn in: its width over its height, whether it is shown in a circle, and its width kept. */
export interface PictureShape {
    aspect: number;
    round: boolean;
    /** The width it is kept at, in pixels; its height follows from the aspect. */
    width: number;
}

/** A member's avatar, an enterprise's or project's logo, a group's picture: a square shown in a circle, kept 512 px. */
export const AVATAR_PICTURE: PictureShape = { aspect: 1, round: true, width: 512 };

/** A shop's banner, across the top of its page: 3:1 wherever it is drawn, kept at most 800 px wide (photos stay 800 px). */
export const BANNER_PICTURE: PictureShape = { aspect: 3, round: false, width: 800 };

/** The JPEG quality a cropped picture is kept at, as every photo. */
export const PICTURE_CROP_QUALITY = 0.7;

/** How far in a member may zoom: a quarter of the widest part of the shape. */
export const PICTURE_CROP_MAX_ZOOM = 4;

/** One step of a zoom button, key or screen reader's action. */
export const PICTURE_CROP_ZOOM_STEP = 1.25;

/** One step of an arrow key or screen reader's move: a tenth of the frame. */
export const PICTURE_CROP_MOVE_STEP = 0.1;

/** What is shown: how far in (1 = the widest part of the shape the picture holds) and the middle of it, in picture pixels. */
export interface CropView {
    zoom: number;
    x: number;
    y: number;
}

/** The part kept, in whole picture pixels (the names expo-image-manipulator's crop takes). */
export interface CropRect {
    originX: number;
    originY: number;
    width: number;
    height: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** The widest part of the shape the picture holds. */
function coverOf(pic: PictureSize, aspect: number): PictureSize {
    return pic.width / pic.height > aspect
        ? { width: pic.height * aspect, height: pic.height }
        : { width: pic.width, height: pic.width / aspect };
}

/** The part shown's size in picture pixels, unrounded. */
function partOf(pic: PictureSize, shape: PictureShape, zoom: number): PictureSize {
    const cover = coverOf(pic, shape.aspect);
    return { width: cover.width / zoom, height: cover.height / zoom };
}

/** The picture as the crop step opens on it: the widest part of the shape, from its middle. */
export function startCropView(pic: PictureSize): CropView {
    return { zoom: 1, x: pic.width / 2, y: pic.height / 2 };
}

/** The view kept inside its bounds: zoomed between 1 and the most, and its part wholly inside the picture (never an empty frame). */
export function settleCropView(pic: PictureSize, shape: PictureShape, view: CropView): CropView {
    const zoom = clamp(Number.isFinite(view.zoom) ? view.zoom : 1, 1, PICTURE_CROP_MAX_ZOOM);
    const part = partOf(pic, shape, zoom);
    return {
        zoom,
        x: clamp(view.x, part.width / 2, pic.width - part.width / 2),
        y: clamp(view.y, part.height / 2, pic.height - part.height / 2),
    };
}

/**
 * The picture moved by (dx, dy) frames: a finger dragging it right by half the frame's width is dx 0.5, and the part shown
 * is then further left. Stops at the picture's edge.
 */
export function moveCropView(pic: PictureSize, shape: PictureShape, view: CropView, dx: number, dy: number): CropView {
    const part = partOf(pic, shape, view.zoom);
    return settleCropView(pic, shape, { ...view, x: view.x - dx * part.width, y: view.y - dy * part.height });
}

/** Zoomed by `factor` (above 1 in, below 1 out) about the middle of the frame. */
export function zoomCropView(pic: PictureSize, shape: PictureShape, view: CropView, factor: number): CropView {
    return settleCropView(pic, shape, { ...view, zoom: view.zoom * factor });
}

/** The part shown, in whole pixels inside the picture. */
export function cropRectOf(pic: PictureSize, shape: PictureShape, view: CropView): CropRect {
    const v = settleCropView(pic, shape, view);
    const part = partOf(pic, shape, v.zoom);
    const width = clamp(Math.round(part.width), 1, pic.width);
    const height = clamp(Math.round(part.height), 1, pic.height);
    return {
        originX: clamp(Math.round(v.x - part.width / 2), 0, pic.width - width),
        originY: clamp(Math.round(v.y - part.height / 2), 0, pic.height - height),
        width,
        height,
    };
}

/** The size a picture of this shape is kept at. */
export function croppedSize(shape: PictureShape): PictureSize {
    return { width: shape.width, height: Math.round(shape.width / shape.aspect) };
}

/**
 * Where the picture is drawn under a frame `frameWidth` wide so the part inside the frame is exactly `rect`: its offset
 * from the frame's top-left corner and its drawn size, in the frame's units.
 */
export function cropPlacement(pic: PictureSize, rect: CropRect, frameWidth: number): { left: number; top: number; width: number; height: number } {
    const scale = frameWidth / rect.width;
    return { left: -rect.originX * scale, top: -rect.originY * scale, width: pic.width * scale, height: pic.height * scale };
}

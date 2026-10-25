import { describe, it, expect } from 'vitest';
import {
    AVATAR_PICTURE, BANNER_PICTURE, PICTURE_CROP_MAX_ZOOM, PICTURE_CROP_MOVE_STEP, PICTURE_CROP_QUALITY, PICTURE_CROP_ZOOM_STEP,
    croppedSize, cropRectOf, moveCropView, startCropView, zoomCropView,
    type CropRect, type PictureShape, type PictureSize,
} from '../index.js';

/**
 * The part of a picture a member chooses (Marty, 25 Oct 2026: "what the member crops is exactly what is shown"): one rule
 * for the phone and the web, so a move and a zoom give the same rectangle on both.
 */
const PHOTO: PictureSize = { width: 1600, height: 1200 };
const PORTRAIT: PictureSize = { width: 1200, height: 1600 };

/** The rectangle is inside the picture and of the shape's aspect, to the pixel. */
function expectInside(rect: CropRect, pic: PictureSize, shape: PictureShape) {
    expect(rect.originX).toBeGreaterThanOrEqual(0);
    expect(rect.originY).toBeGreaterThanOrEqual(0);
    expect(rect.originX + rect.width).toBeLessThanOrEqual(pic.width);
    expect(rect.originY + rect.height).toBeLessThanOrEqual(pic.height);
    expect(Math.abs(rect.width / rect.height - shape.aspect)).toBeLessThan(0.01);
    for (const v of Object.values(rect)) expect(Number.isInteger(v)).toBe(true);
}

describe('picture shapes', () => {
    it('an avatar, a logo or a group picture is a square shown in a circle, kept 512 px', () => {
        expect(AVATAR_PICTURE).toEqual({ aspect: 1, round: true, width: 512 });
        expect(croppedSize(AVATAR_PICTURE)).toEqual({ width: 512, height: 512 });
    });

    it('a banner is 3:1, kept at most 800 px wide (memory: photos stay 800px)', () => {
        expect(BANNER_PICTURE).toEqual({ aspect: 3, round: false, width: 800 });
        expect(croppedSize(BANNER_PICTURE)).toEqual({ width: 800, height: 267 });
    });

    it('a crop is a JPEG at 0.7, as every photo', () => {
        expect(PICTURE_CROP_QUALITY).toBe(0.7);
    });
});

describe('the part of the picture chosen', () => {
    it('starts as the largest middle part of the shape', () => {
        expect(cropRectOf(PHOTO, AVATAR_PICTURE, startCropView(PHOTO))).toEqual({ originX: 200, originY: 0, width: 1200, height: 1200 });
        expect(cropRectOf(PHOTO, BANNER_PICTURE, startCropView(PHOTO))).toEqual({ originX: 0, originY: 333, width: 1600, height: 533 });
        expect(cropRectOf(PORTRAIT, AVATAR_PICTURE, startCropView(PORTRAIT))).toEqual({ originX: 0, originY: 200, width: 1200, height: 1200 });
    });

    it('a zoom in takes a smaller part about the middle; a move takes the part the picture moved to', () => {
        let view = zoomCropView(PHOTO, AVATAR_PICTURE, startCropView(PHOTO), PICTURE_CROP_ZOOM_STEP);
        expect(cropRectOf(PHOTO, AVATAR_PICTURE, view)).toEqual({ originX: 320, originY: 120, width: 960, height: 960 });
        // The picture moved left by two steps of a tenth of the frame: the part shown is 192 px further right.
        view = moveCropView(PHOTO, AVATAR_PICTURE, view, -PICTURE_CROP_MOVE_STEP, 0);
        view = moveCropView(PHOTO, AVATAR_PICTURE, view, -PICTURE_CROP_MOVE_STEP, 0);
        expect(cropRectOf(PHOTO, AVATAR_PICTURE, view)).toEqual({ originX: 512, originY: 120, width: 960, height: 960 });
    });

    it('a banner moved up shows a lower strip', () => {
        let view = startCropView(PHOTO);
        view = moveCropView(PHOTO, BANNER_PICTURE, view, 0, -PICTURE_CROP_MOVE_STEP);
        view = moveCropView(PHOTO, BANNER_PICTURE, view, 0, -PICTURE_CROP_MOVE_STEP);
        expect(cropRectOf(PHOTO, BANNER_PICTURE, view)).toEqual({ originX: 0, originY: 440, width: 1600, height: 533 });
    });

    it('never leaves the frame empty: a move past the edge stops at it', () => {
        const view = moveCropView(PHOTO, AVATAR_PICTURE, startCropView(PHOTO), 5, 5);
        const rect = cropRectOf(PHOTO, AVATAR_PICTURE, view);
        expect(rect).toEqual({ originX: 0, originY: 0, width: 1200, height: 1200 });
        // And moving back starts from the edge, not from where the finger went.
        const back = moveCropView(PHOTO, AVATAR_PICTURE, view, -0.1, 0);
        expect(cropRectOf(PHOTO, AVATAR_PICTURE, back).originX).toBe(120);
    });

    it('never zooms out past the whole of the shape, nor in past four times', () => {
        const out = zoomCropView(PHOTO, BANNER_PICTURE, startCropView(PHOTO), 0.1);
        expect(out.zoom).toBe(1);
        let inn = startCropView(PHOTO);
        for (let i = 0; i < 20; i++) inn = zoomCropView(PHOTO, AVATAR_PICTURE, inn, PICTURE_CROP_ZOOM_STEP);
        expect(inn.zoom).toBe(PICTURE_CROP_MAX_ZOOM);
        expect(cropRectOf(PHOTO, AVATAR_PICTURE, inn)).toEqual({ originX: 650, originY: 450, width: 300, height: 300 });
    });

    it('a zoom out near an edge pulls the part back inside the picture', () => {
        let view = zoomCropView(PHOTO, AVATAR_PICTURE, startCropView(PHOTO), 2);
        view = moveCropView(PHOTO, AVATAR_PICTURE, view, -5, -5);
        view = zoomCropView(PHOTO, AVATAR_PICTURE, view, 0.5);
        expectInside(cropRectOf(PHOTO, AVATAR_PICTURE, view), PHOTO, AVATAR_PICTURE);
        expect(cropRectOf(PHOTO, AVATAR_PICTURE, view)).toEqual({ originX: 400, originY: 0, width: 1200, height: 1200 });
    });

    it('stays inside any picture, of either shape, whatever the moves', () => {
        const pictures: PictureSize[] = [PHOTO, PORTRAIT, { width: 801, height: 267 }, { width: 3000, height: 100 }, { width: 100, height: 3000 }, { width: 1, height: 1 }];
        for (const pic of pictures) {
            for (const shape of [AVATAR_PICTURE, BANNER_PICTURE]) {
                let view = startCropView(pic);
                for (const [dx, dy, z] of [[0.3, -0.7, 1.7], [-2, 0.1, 0.6], [0.05, 3, 4], [1, 1, 0.2]]) {
                    view = zoomCropView(pic, shape, moveCropView(pic, shape, view, dx, dy), z);
                    const rect = cropRectOf(pic, shape, view);
                    expect(rect.width).toBeGreaterThanOrEqual(1);
                    expect(rect.height).toBeGreaterThanOrEqual(1);
                    expect(rect.originX + rect.width).toBeLessThanOrEqual(pic.width);
                    expect(rect.originY + rect.height).toBeLessThanOrEqual(pic.height);
                    expect(rect.originX).toBeGreaterThanOrEqual(0);
                    expect(rect.originY).toBeGreaterThanOrEqual(0);
                }
            }
        }
    });
});

import { afterEach, describe, expect, it } from 'vitest';
import { fitWithin, MAX_PHOTO_SIDE, PHOTO_JPEG_QUALITY, resizePhotoFile } from './photo-resize';

/**
 * jsdom decodes no pictures and draws on no canvas, so these stand in for both — the same stubs
 * MessagesPage.test uses — and record what our code asked of them.
 */
let restore: Array<() => void> = [];
afterEach(() => {
    restore.forEach((r) => r());
    restore = [];
});

function stubPipeline(natural: { width: number; height: number }, opts: { decodeFails?: boolean } = {}) {
    const originalImage = window.Image;
    const loaded: string[] = [];
    class FakeImage {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        width = natural.width;
        height = natural.height;
        set src(value: string) {
            loaded.push(value);
            setTimeout(() => (opts.decodeFails ? this.onerror?.() : this.onload?.()), 0);
        }
    }
    (window as any).Image = FakeImage;
    restore.push(() => { (window as any).Image = originalImage; });

    const drawn: Array<{ canvasWidth: number; canvasHeight: number; args: unknown[] }> = [];
    const encoded: Array<{ type: unknown; quality: unknown }> = [];
    const originalGetContext = window.HTMLCanvasElement.prototype.getContext;
    const originalToDataUrl = window.HTMLCanvasElement.prototype.toDataURL;
    (window.HTMLCanvasElement.prototype as any).getContext = function (this: HTMLCanvasElement) {
        const canvas = this;
        return { drawImage: (...args: unknown[]) => drawn.push({ canvasWidth: canvas.width, canvasHeight: canvas.height, args }) };
    };
    (window.HTMLCanvasElement.prototype as any).toDataURL = (type: unknown, quality: unknown) => {
        encoded.push({ type, quality });
        return 'data:image/jpeg;base64,cmVzaXplZA==';
    };
    restore.push(() => {
        (window.HTMLCanvasElement.prototype as any).getContext = originalGetContext;
        (window.HTMLCanvasElement.prototype as any).toDataURL = originalToDataUrl;
    });
    return { loaded, drawn, encoded };
}

/** A camera-sized "file": its bytes are only read into a data URL, never decoded, so any bytes will do. */
const cameraFile = () => new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66])], 'IMG_0001.jpg', { type: 'image/jpeg' });

describe('fitWithin', () => {
    it('brings the longest side down to 800px and keeps the shape', () => {
        expect(fitWithin(4032, 3024)).toEqual({ width: 800, height: 600 });
        expect(fitWithin(3024, 4032)).toEqual({ width: 600, height: 800 });
        expect(fitWithin(5000, 5000)).toEqual({ width: 800, height: 800 });
    });

    it('never enlarges a picture that already fits', () => {
        expect(fitWithin(640, 480)).toEqual({ width: 640, height: 480 });
        expect(fitWithin(800, 800)).toEqual({ width: 800, height: 800 });
    });
});

describe('resizePhotoFile', () => {
    it('draws a large camera photo at no more than 800px and re-encodes it as a JPEG', async () => {
        const { loaded, drawn, encoded } = stubPipeline({ width: 4032, height: 3024 });

        const result = await resizePhotoFile(cameraFile());

        expect(result).toBe('data:image/jpeg;base64,cmVzaXplZA==');
        expect(loaded).toHaveLength(1);
        expect(loaded[0]).toMatch(/^data:image\/jpeg;base64,/); // the raw file went into the <img>, not out to the node
        expect(result).not.toBe(loaded[0]);
        expect(drawn).toHaveLength(1);
        expect(drawn[0].canvasWidth).toBe(MAX_PHOTO_SIDE);
        expect(drawn[0].canvasHeight).toBe(600);
        expect(drawn[0].args.slice(1)).toEqual([0, 0, 800, 600]);
        expect(Math.max(drawn[0].canvasWidth, drawn[0].canvasHeight)).toBeLessThanOrEqual(800);
        expect(encoded).toEqual([{ type: 'image/jpeg', quality: PHOTO_JPEG_QUALITY }]);
    });

    it('re-encodes a small photo too, because the re-encode is what leaves the metadata behind', async () => {
        const { drawn, encoded } = stubPipeline({ width: 320, height: 240 });

        const result = await resizePhotoFile(cameraFile());

        expect(result).toBe('data:image/jpeg;base64,cmVzaXplZA==');
        expect(drawn[0].canvasWidth).toBe(320);
        expect(drawn[0].canvasHeight).toBe(240);
        expect(encoded).toHaveLength(1);
    });

    it('rejects a picture the browser cannot decode, rather than sending the raw file', async () => {
        const { encoded } = stubPipeline({ width: 1, height: 1 }, { decodeFails: true });

        await expect(resizePhotoFile(cameraFile())).rejects.toThrow();
        expect(encoded).toHaveLength(0);
    });
});

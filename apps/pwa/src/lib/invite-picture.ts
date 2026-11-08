/**
 * The QR picture a member shares with an invite on the web (Damo, 9 Nov: "it should share this picture, but it just copies
 * the text"). The phone's People → Invites does the same (apps/native/utils/invite-picture-share.ts).
 *
 * The picture is a PNG of the page's own QR (the same value the card draws) on a white ground with the code printed under it,
 * 640 px wide, named `beanpool-invite-<CODE>.png` (core invitePictureName). It is made BEFORE the tap, when the code appears
 * (components/InvitePictures.tsx): Safari refuses a share that awaits anything first, so the click handler only looks the file
 * up here and calls `navigator.share` in the same breath.
 *
 * What Share does with it, in order (`shareInvite`): the picture and the message together where the browser can take a file;
 * the message alone where it cannot; and where there is no share at all, the caller copies the message and says so, with a
 * Save QR picture button (`saveInvitePicture`).
 */
import { invitePictureCode, invitePictureName } from '@beanpool/core';

/** The QR is drawn this many pixels square, centred in a white picture with `PAD` of ground around it. */
export const QR_PX = 512;
const PAD = 64;
const CODE_PX = 40;
/** A picture is not a themed surface: it is read in someone else's chat, so it is always dark on white, whatever the page is. */
const GROUND = '#ffffff';
const INK = '#0f1a14';

/** The browser pieces the picture needs, so a test can stand in for them (jsdom has no canvas). */
export interface PictureEnv {
    /** Decode an SVG document into something a canvas can draw. */
    loadImage(svgMarkup: string): Promise<CanvasImageSource>;
    canvas(width: number, height: number): PictureCanvas;
}
export interface PictureCanvas {
    getContext(kind: '2d'): PictureContext | null;
    toBlob(done: (blob: Blob | null) => void, type: string): void;
}
export interface PictureContext {
    fillStyle: string | CanvasGradient | CanvasPattern;
    font: string;
    textAlign: CanvasTextAlign;
    textBaseline: CanvasTextBaseline;
    fillRect(x: number, y: number, w: number, h: number): void;
    drawImage(image: CanvasImageSource, x: number, y: number, w: number, h: number): void;
    fillText(text: string, x: number, y: number, maxWidth?: number): void;
}

export const browserPictureEnv: PictureEnv = {
    loadImage: (svgMarkup) => new Promise((resolve, reject) => {
        // An image that never answers (a browser that does not decode SVG) must not stall the pictures behind it.
        const gaveUp = setTimeout(() => reject(new Error('The QR took too long to draw')), 5000);
        const img = new Image();
        img.onload = () => { clearTimeout(gaveUp); resolve(img); };
        img.onerror = () => { clearTimeout(gaveUp); reject(new Error('The QR could not be drawn')); };
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgMarkup)}`;
    }),
    canvas: (width, height) => {
        const el = document.createElement('canvas');
        el.width = width;
        el.height = height;
        return el as unknown as PictureCanvas;
    },
};

/** The picture's size: the QR with its ground, then the printed code under it. */
export const PICTURE_WIDTH = QR_PX + PAD * 2;
export const PICTURE_HEIGHT = PAD + QR_PX + 24 + CODE_PX + PAD;

/**
 * Draws the QR (an SVG document, as qrcode.react renders it at `QR_PX`) and the code under it, and returns the PNG as a File
 * named for the code, or null where the browser cannot make one. Never throws.
 */
export async function composeInvitePicture(svgMarkup: string, code: string, env: PictureEnv = browserPictureEnv): Promise<File | null> {
    try {
        const image = await env.loadImage(svgMarkup);
        const canvas = env.canvas(PICTURE_WIDTH, PICTURE_HEIGHT);
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.fillStyle = GROUND;
        ctx.fillRect(0, 0, PICTURE_WIDTH, PICTURE_HEIGHT);
        ctx.drawImage(image, PAD, PAD, QR_PX, QR_PX);
        ctx.fillStyle = INK;
        ctx.font = `bold ${CODE_PX}px ui-monospace, Menlo, Consolas, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(invitePictureCode(code), PICTURE_WIDTH / 2, PAD + QR_PX + 24 + CODE_PX, PICTURE_WIDTH - PAD);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
        return blob ? new File([blob], invitePictureName(code), { type: 'image/png' }) : null;
    } catch {
        return null;
    }
}

// ── The pictures made so far, by code ────────────────────────────────────────────────────────────────────────────────

const made = new Map<string, File>();
const failed = new Set<string>();

/** The picture made for this code, or null before it is ready (or where the browser could not make one). */
export function invitePictureFor(code: string): File | null {
    return made.get(code) ?? null;
}
/** Settled: a picture, or a failure that is not tried again. */
export function invitePictureSettled(code: string): boolean {
    return made.has(code) || failed.has(code);
}
export function rememberInvitePicture(code: string, file: File | null): void {
    if (file) made.set(code, file);
    else failed.add(code);
}
/** For tests. */
export function forgetInvitePictures(): void {
    made.clear();
    failed.clear();
}

/** The QR's value: the link a scan opens. */
export function inviteQrValue(code: string): string {
    return `${window.location.origin}/?invite=${code}`;
}

// ── Share ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The part of `navigator` Share uses. */
export interface ShareNavigator {
    share?: (data: ShareData) => Promise<void>;
    canShare?: (data: ShareData) => boolean;
}
export type InviteShareResult = 'shared' | 'cancelled' | 'copy';

const cancelled = (e: unknown) => (e as { name?: string } | null)?.name === 'AbortError';

/**
 * Shares the message with the picture. Calls `navigator.share` before anything is awaited, so it still counts as the tap's own
 * (Safari refuses it otherwise). 'copy' is for the caller to answer: the browser has no share, or refused this one, so the
 * message is copied and the person told (never a share that failed without a word, as before).
 */
export function shareInvite(nav: ShareNavigator, data: { title: string; text: string }, file: File | null): Promise<InviteShareResult> {
    if (typeof nav.share !== 'function') return Promise.resolve('copy');
    const withFile = file !== null && typeof nav.canShare === 'function' && nav.canShare({ files: [file] });
    return attempt(nav, withFile ? { ...data, files: [file as File] } : data, withFile, data);
}

async function attempt(nav: ShareNavigator, shown: ShareData, withFile: boolean, textOnly: { title: string; text: string }): Promise<InviteShareResult> {
    try {
        await nav.share!(shown);
        return 'shared';
    } catch (e) {
        if (cancelled(e)) return 'cancelled';
        // The browser took the share but not the picture: the message alone, as before.
        if (withFile) {
            try {
                await nav.share!(textOnly);
                return 'shared';
            } catch (again) {
                return cancelled(again) ? 'cancelled' : 'copy';
            }
        }
        return 'copy';
    }
}

/** Downloads the picture (the Save QR picture button). */
export function saveInvitePicture(file: File, doc: Document = document): void {
    const url = URL.createObjectURL(file);
    const link = doc.createElement('a');
    link.href = url;
    link.download = file.name;
    link.rel = 'noopener';
    doc.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

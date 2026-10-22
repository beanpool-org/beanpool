/**
 * A tool's photos on the web (scratch/tools/DESIGN-tool-template-fable.md §1.6, slice T1.3: the Tool shed is the first
 * tool to ask for `photos` and `camera`): chosen, or taken where the browser offers its camera, through the browser's own
 * file picker, drawn at 800 px as a JPEG (lib/photo-resize.ts, which also leaves the camera's metadata behind), and kept
 * in this browser's tool store beside the tool's document (tools/store.ts). Never inside the document, and never on the
 * node until a listing is posted with it.
 *
 * The host's `photos.uri(ref)` is synchronous and a kept photo is read from IndexedDB, so a uri is a token naming the
 * photo; the template's primitives (tools/ui.tsx ToolPhoto, ToolRow's image) draw a token through {@link useToolPhotoSrc}.
 * Only the host and the primitives import this file: a tool's folder is fenced off from it (eslint.config.mjs).
 */
import { useEffect, useState } from 'react';
import type { ToolPhoto } from '@beanpool/core';
import { resizePhotoFileWithSize } from '../lib/photo-resize';
import { keepToolPhoto, readToolPhoto } from './store';

const TOKEN = 'beanpool-tool-photo:';

/** A kept photo's uri, as the host gives it to a tool. */
export const toolPhotoToken = (owner: string, tool: string, ref: string) =>
    `${TOKEN}${[owner, tool, ref].map(encodeURIComponent).join('/')}`;

/** The owner, tool and ref a token names, or null for any other uri. */
export function parseToolPhotoToken(uri: string): { owner: string; tool: string; ref: string } | null {
    if (!uri.startsWith(TOKEN)) return null;
    const parts = uri.slice(TOKEN.length).split('/');
    if (parts.length !== 3) return null;
    try {
        const [owner, tool, ref] = parts.map(decodeURIComponent);
        return { owner, tool, ref };
    } catch {
        return null;
    }
}

/**
 * The browser's file picker for one picture, with its camera first where it has one (`capture`): the file chosen, or
 * null when the member closes it. Nothing leaves the browser.
 */
export function chooseImageFile(capture: boolean, doc: Document = document): Promise<File | null> {
    return new Promise((resolve) => {
        const input = doc.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        if (capture) input.setAttribute('capture', 'environment');
        input.style.display = 'none';
        let done = false;
        const finish = (file: File | null) => {
            if (done) return;
            done = true;
            input.remove();
            resolve(file);
        };
        input.addEventListener('change', () => finish(input.files?.[0] ?? null));
        input.addEventListener('cancel', () => finish(null));
        doc.body.appendChild(input);
        input.click();
    });
}

/**
 * A chosen file kept for `tool` under a new ref: drawn at 800 px, then put in the store. Null when the browser can't
 * read or draw it, or the store couldn't keep it (the screen shows nothing new).
 */
export async function keepChosen(
    owner: string, tool: string, file: File | null, ref: string,
    resize: (file: Blob) => Promise<{ dataUrl: string; width: number; height: number }> = resizePhotoFileWithSize,
): Promise<ToolPhoto | null> {
    if (!file) return null;
    const drawn = await resize(file).catch(() => null);
    if (!drawn) return null;
    return await keepToolPhoto(owner, tool, ref, drawn.dataUrl) ? { ref, width: drawn.width, height: drawn.height } : null;
}

/**
 * What an <img> draws for a uri the host gave: a token read from the store (undefined until it is read, null when this
 * browser has no such photo: one taken on another device, whose ref came with the server's copy of the document), any
 * other uri as it is, and null for none.
 */
export function useToolPhotoSrc(uri: string | null | undefined): string | null | undefined {
    const token = uri ? parseToolPhotoToken(uri) : null;
    const [src, setSrc] = useState<string | null | undefined>(() => (!uri ? null : token ? undefined : uri));
    useEffect(() => {
        if (!uri) { setSrc(null); return; }
        const named = parseToolPhotoToken(uri);
        if (!named) { setSrc(uri); return; }
        let gone = false;
        setSrc(undefined);
        void readToolPhoto(named.owner, named.tool, named.ref).then((s) => { if (!gone) setSrc(s); });
        return () => { gone = true; };
    }, [uri]);
    return src;
}

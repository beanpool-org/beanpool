/**
 * Getting a picture out of a paste or a drop.
 *
 * Chrome, Safari and Firefox do not agree on where a pasted screenshot lands.
 * Firefox and Chrome fill `files`; Safari often fills only `items`, and during a
 * drag no browser exposes either — only `types`. So we read whatever the event
 * itself carries and take the first image we find.
 *
 * We never call `navigator.clipboard.read()`. That asks the browser for the
 * clipboard's whole contents outside of anything the person did, which is both a
 * permission prompt and more than they meant to hand over. A paste or a drop is
 * the person's own act, and its event data is all we need.
 */

/**
 * The biggest source file a paste or a drop will take on.
 *
 * Everything is re-encoded to a 1000px-wide JPEG before it is sent, so this is
 * not about what the node will accept — it is the point past which decoding the
 * original in a canvas stops being something a modest phone or an old laptop can
 * do. A pasted screenshot is never near it; a dropped camera RAW can be.
 */
export const MAX_CHAT_IMAGE_BYTES = 20 * 1024 * 1024;

/** How that limit is written where a person reads it. */
export const MAX_CHAT_IMAGE_LABEL = '20 MB';

/** What we need of a `DataTransfer`, so a test can hand us a plain object. */
export interface ImageTransferLike {
    files?: ArrayLike<File> | null;
    items?: ArrayLike<DataTransferItem> | null;
    types?: ArrayLike<string> | null;
}

function isImage(file: File | null | undefined): file is File {
    return !!file && typeof file.type === 'string' && file.type.startsWith('image/');
}

/**
 * The first image file a paste or drop carries, or null when it carries none.
 * Null means "not ours" — the browser should handle the event as it always has.
 */
export function imageFromTransfer(transfer: ImageTransferLike | null | undefined): File | null {
    if (!transfer) return null;

    const files = transfer.files;
    if (files) {
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            if (isImage(file)) return file;
        }
    }

    const items = transfer.items;
    if (items) {
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (!item || item.kind !== 'file') continue;
            if (typeof item.type !== 'string' || !item.type.startsWith('image/')) continue;
            const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
            if (isImage(file)) return file;
        }
    }

    return null;
}

/**
 * Whether a drag in progress is carrying a file at all.
 *
 * `dragover` deliberately hides the file itself until the drop, so this is the
 * most we can know while deciding whether to light the chat up.
 */
export function dragCarriesFile(transfer: ImageTransferLike | null | undefined): boolean {
    if (!transfer) return false;

    const types = transfer.types;
    if (types) {
        for (let i = 0; i < types.length; i++) {
            if (types[i] === 'Files') return true;
        }
    }

    const items = transfer.items;
    if (items) {
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item && item.kind === 'file') return true;
        }
    }

    return false;
}

/** Why a picked image cannot be sent, or null when it can. */
export function chatImageRefusal(file: File): string | null {
    if (!file.type.startsWith('image/')) return 'That file is not a picture.';
    if (file.size > MAX_CHAT_IMAGE_BYTES) {
        return `That picture is bigger than ${MAX_CHAT_IMAGE_LABEL}. Try a smaller one.`;
    }
    return null;
}

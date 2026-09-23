import { describe, it, expect } from 'vitest';
import {
    imageFromTransfer, dragCarriesFile, chatImageRefusal,
    MAX_CHAT_IMAGE_BYTES, MAX_CHAT_IMAGE_LABEL,
} from './chat-image-transfer';

function imageFile(name = 'screenshot.png', type = 'image/png', size = 1024): File {
    const file = new File([new Uint8Array(1)], name, { type });
    Object.defineProperty(file, 'size', { value: size });
    return file;
}

/** What Chrome hands a drop of a file from the desktop. */
function fileItem(file: File | null, type: string): DataTransferItem {
    return { kind: 'file', type, getAsFile: () => file } as unknown as DataTransferItem;
}

/** What every browser hands a plain text paste in the `items` list. */
function stringItem(type = 'text/plain'): DataTransferItem {
    return { kind: 'string', type, getAsFile: () => null } as unknown as DataTransferItem;
}

describe('imageFromTransfer — where a pasted or dropped picture actually is', () => {
    it('finds the image in `files`, which is where Chrome and Firefox put it', () => {
        const file = imageFile();
        expect(imageFromTransfer({ files: [file], items: [], types: ['Files'] })).toBe(file);
    });

    it('finds the image in `items` when `files` is empty, which is what Safari does', () => {
        const file = imageFile('pasted.png');
        const transfer = { files: [], items: [fileItem(file, 'image/png')], types: ['Files'] };
        expect(imageFromTransfer(transfer)).toBe(file);
    });

    it('returns null for a text-only paste, so the browser pastes the text as it always has', () => {
        expect(imageFromTransfer({ files: [], items: [stringItem()], types: ['text/plain'] })).toBeNull();
    });

    it('returns null for a non-image file — only image/* comes through', () => {
        const pdf = new File(['x'], 'invoice.pdf', { type: 'application/pdf' });
        const transfer = { files: [pdf], items: [fileItem(pdf, 'application/pdf')], types: ['Files'] };
        expect(imageFromTransfer(transfer)).toBeNull();
    });

    it('skips a text item that claims an image type without being a file', () => {
        // Some clipboards carry an <img> tag as HTML; kind is 'string', not 'file'.
        const transfer = { files: [], items: [stringItem('text/html')], types: ['text/html'] };
        expect(imageFromTransfer(transfer)).toBeNull();
    });

    it('skips a file item whose getAsFile() comes back empty, as it does mid-drag', () => {
        const transfer = { files: [], items: [fileItem(null, 'image/png')], types: ['Files'] };
        expect(imageFromTransfer(transfer)).toBeNull();
    });

    it('takes the first image when several are carried at once', () => {
        const first = imageFile('one.png');
        const second = imageFile('two.png');
        expect(imageFromTransfer({ files: [first, second], types: ['Files'] })).toBe(first);
    });

    it('survives a missing or empty transfer', () => {
        expect(imageFromTransfer(null)).toBeNull();
        expect(imageFromTransfer(undefined)).toBeNull();
        expect(imageFromTransfer({})).toBeNull();
    });
});

describe('dragCarriesFile — the most a dragover is allowed to know', () => {
    it("is true on the 'Files' type, which is all a dragover exposes", () => {
        expect(dragCarriesFile({ files: [], items: [], types: ['Files'] })).toBe(true);
    });

    it('is false for a drag of selected text', () => {
        expect(dragCarriesFile({ files: [], items: [stringItem()], types: ['text/plain'] })).toBe(false);
    });

    it('falls back to a file item when types is missing', () => {
        expect(dragCarriesFile({ items: [fileItem(null, 'image/png')] })).toBe(true);
    });

    it('survives a missing transfer', () => {
        expect(dragCarriesFile(null)).toBe(false);
    });
});

describe('chatImageRefusal — what we will not take on', () => {
    it('accepts an ordinary screenshot', () => {
        expect(chatImageRefusal(imageFile())).toBeNull();
    });

    it('accepts a picture right on the limit', () => {
        expect(chatImageRefusal(imageFile('big.jpg', 'image/jpeg', MAX_CHAT_IMAGE_BYTES))).toBeNull();
    });

    it('refuses one over the limit, and says the limit in plain words', () => {
        const refusal = chatImageRefusal(imageFile('raw.tiff', 'image/tiff', MAX_CHAT_IMAGE_BYTES + 1));
        expect(refusal).toContain(MAX_CHAT_IMAGE_LABEL);
        expect(refusal).not.toMatch(/error|failed|invalid/i);
    });

    it('refuses anything that is not an image', () => {
        const pdf = new File(['x'], 'invoice.pdf', { type: 'application/pdf' });
        expect(chatImageRefusal(pdf)).toBe('That file is not a picture.');
    });
});

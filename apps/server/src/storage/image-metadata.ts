/**
 * Metadata off every photo a node stores (G9a-3).
 *
 * A camera photo carries more than its picture: EXIF GPS coordinates, the camera's serial number, the time it
 * was taken, an XMP packet, a thumbnail of the picture as it was before it was cropped. None of it is needed to
 * show the photo, and every photo a node stores is served to whoever can see the post, the member or the
 * enterprise — on the global node, to visitors who have not joined. The phone and the web app re-encode their
 * photos before sending them, but the node cannot rely on that: a self-hoster's fork, a script or a client path
 * nobody has noticed yet (the web app's enterprise photo sent the raw file until G9a-3) can send the original.
 * So the node takes the metadata off itself, where the bytes are stored.
 *
 * ## What this is allowed to do to an image
 *
 * Only remove whole, well-delimited metadata blocks: JPEG segments, PNG chunks, WebP chunks, GIF extension
 * blocks. The compressed picture is never decoded, re-encoded or touched: every byte of it comes out exactly as
 * it went in. Anything that decides how the picture is drawn stays — colour profiles, transparency, animation,
 * and a JPEG's orientation, which is rebuilt as a 26-byte EXIF block holding that one number and nothing else.
 *
 * ## What it must never do
 *
 * Throw, grow the bytes, or lose the picture. A file whose structure does not parse from its first byte to its
 * end marker — truncated, corrupt, a format this does not know — is returned exactly as given, which is how the
 * node stored every image before this existed. It is only ever stripping a file it has walked completely and found
 * a picture in (a JPEG scan, a PNG IDAT chunk before IEND, a WebP image chunk inside the RIFF, a GIF image block).
 *
 * ## Formats
 *
 * JPEG, PNG, WebP and GIF are stripped: between them they are every format a node accepts where it checks the
 * bytes (avatars, enterprise and crowdfund photos, group pictures: `isAcceptableAvatarValue`, a JPEG, PNG, WebP or
 * GIF whose bytes really are one; where a photo is also handed out as stored, `isAcceptablePhotoValue` holds a bare
 * base64 value to the same rule) and every format a post may declare (JPEG, PNG, WebP). Anything else passes
 * through untouched. It can only arrive where a node does not look at the bytes: a post photo whose declared type
 * does not match what it holds (the post check reads the data URL's type, not the bytes, and the existing suites
 * post placeholder bytes that must keep working), and an operator's pricing-guide thumbnail. Neither is anything
 * an app sends.
 *
 * ## Orientation
 *
 * The phone and the web app draw every photo upright before they send it, so their photos have no orientation
 * to keep. A camera original sent raw (a script, an old or forked client) may be stored on its side and rely on
 * EXIF orientation to be drawn upright; a JPEG keeps that one number, so it is drawn as it was before. A PNG's or
 * WebP's EXIF goes whole, orientation included: cameras write JPEGs, so a raw PNG or WebP that relies on its
 * orientation is rare, and it would be drawn as stored (on its side). Accepted: the alternative is keeping EXIF.
 *
 * No dependency: `sharp` would be a native module for what is a walk over block headers (G9a design §10).
 */

// ── The entry points ───────────────────────────────────────────────────────────────────────────

/**
 * The image with its metadata removed, or the very same Buffer (`===`) when there was nothing to remove or the
 * bytes are not an image this can walk safely. Never throws; the result is never longer than the input.
 */
export function stripImageMetadata(bytes: Buffer): Buffer {
    try {
        const stripped = stripByFormat(bytes);
        if (!stripped || stripped.length > bytes.length) return bytes;
        return stripped;
    } catch {
        return bytes;
    }
}

/**
 * The same, for an image the way a node stores it: a base64 data URL, or (a legacy avatar value the avatar route
 * still serves) bare base64. A bare value is read exactly as the avatar route reads one: `Buffer.from(…, 'base64')`,
 * which takes standard and URL-safe base64 and skips any character outside the alphabet.
 *
 * Returns the value exactly as given when nothing was removed, so a photo that carries no metadata — every photo
 * the phone and the web app send — is stored character for character as it always was. When something was
 * removed, the result is re-encoded canonically under the MIME type it declared. Anything else (null, a
 * `bundled://` name, a URL, text that does not decode to an image) comes back untouched.
 *
 * The data-URL match is the avatar route's (`engine/avatar.ts`): case-insensitive, base64 that may be wrapped
 * across lines. It and the bare-value read are the most lenient readers of a stored image anywhere in the server,
 * so whatever any route would decode and serve, this decodes and strips.
 */
export function stripImageValue<T>(value: T): T {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    const m = trimmed.match(DATA_URL);
    if (m) {
        const bytes = Buffer.from(m[2], 'base64');
        const stripped = stripImageMetadata(bytes);
        if (stripped === bytes) return value;
        return `data:${m[1]};base64,${stripped.toString('base64')}` as T;
    }
    if (/^data:/i.test(trimmed)) return value;
    const bytes = Buffer.from(trimmed, 'base64'); // a URL or a name decodes to bytes that are no image: returned as given
    const stripped = stripImageMetadata(bytes);
    if (stripped === bytes) return value;
    return stripped.toString('base64') as T;
}

const DATA_URL = /^data:([^;,]+);base64,([\s\S]*)$/i;

function stripByFormat(buf: Buffer): Buffer | null {
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return stripJpeg(buf);
    if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return stripPng(buf);
    if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return stripWebp(buf);
    const head = buf.toString('latin1', 0, 6);
    if (head === 'GIF87a' || head === 'GIF89a') return stripGif(buf);
    return null;
}

// ── JPEG ───────────────────────────────────────────────────────────────────────────────────────
//
// SOI, then segments (0xFF, a marker byte, a 2-byte big-endian length that counts itself, the payload) until SOS;
// after each SOS the entropy-coded scan runs to the next marker that is not a stuffed 0xFF00 or a restart
// marker (either may follow fill bytes, a run of 0xFF); a progressive file has several scans with tables between
// them; EOI ends the image.
//
// Kept: every segment that is not APPn or COM (frame, tables, scans), APP0 JFIF (without the optional thumbnail),
// APP2 ICC_PROFILE (colour, possibly split over several segments), and APP14 Adobe — twelve bytes that say how
// the colour channels are encoded, without which a CMYK or RGB JPEG decodes in the wrong colours.
// Dropped: every other APPn (APP1 Exif and XMP, APP2 MPF, APP13 Photoshop/IPTC, …), COM, and everything after EOI
// (MPF's secondary images, vendor trailers), each of which can carry its own GPS.
// Orientation: the first Exif block's orientation, when it is not the default, comes back as a minimal Exif block
// in the same place, so a camera original that relies on it is drawn the way up it was drawn before.

const JFIF = Buffer.from('JFIF\0', 'latin1');
const ICC_PROFILE = Buffer.from('ICC_PROFILE\0', 'latin1');
const ADOBE = Buffer.from('Adobe', 'latin1');
const EXIF = Buffer.from('Exif\0\0', 'latin1');

function startsWith(payload: Buffer, prefix: Buffer): boolean {
    return payload.length >= prefix.length && payload.subarray(0, prefix.length).equals(prefix);
}

function stripJpeg(buf: Buffer): Buffer | null {
    const parts: Buffer[] = [buf.subarray(0, 2)];
    let changed = false;
    let orientationKept = false;
    let hasPicture = false;
    let pos = 2;
    for (;;) {
        // A marker must start here; running out of bytes before EOI means a truncated file.
        if (pos >= buf.length || buf[pos] !== 0xff) return null;
        const start = pos;
        while (pos + 1 < buf.length && buf[pos + 1] === 0xff) pos++; // fill bytes before a marker
        if (pos + 1 >= buf.length) return null;
        const marker = buf[pos + 1];
        if (marker === 0xd9) { // EOI
            parts.push(buf.subarray(start, pos + 2));
            pos += 2;
            break;
        }
        if (marker === 0x00 || marker === 0xd8) return null; // a stuffed byte outside a scan, or a second SOI
        if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { // RSTn, TEM: no length
            parts.push(buf.subarray(start, pos + 2));
            pos += 2;
            continue;
        }
        if (pos + 4 > buf.length) return null;
        const length = buf.readUInt16BE(pos + 2);
        const end = pos + 2 + length;
        if (length < 2 || end > buf.length) return null;
        const payload = buf.subarray(pos + 4, end);

        if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) {
            if (marker === 0xe0 && startsWith(payload, JFIF)) {
                if (payload.length <= 14) {
                    parts.push(buf.subarray(start, end));
                } else {
                    // JFIF header (version, units, density) with the thumbnail dimensions zeroed and its pixels gone.
                    const header = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...payload.subarray(0, 12), 0x00, 0x00]);
                    parts.push(header);
                    changed = true;
                }
            } else if ((marker === 0xe2 && startsWith(payload, ICC_PROFILE)) || (marker === 0xee && startsWith(payload, ADOBE))) {
                parts.push(buf.subarray(start, end));
            } else {
                const orientation = marker === 0xe1 && !orientationKept && startsWith(payload, EXIF)
                    ? readTiffOrientation(payload.subarray(EXIF.length)) : null;
                if (orientation !== null && orientation !== 1) {
                    const minimal = orientationOnlyExifSegment(orientation);
                    orientationKept = true;
                    // Already nothing but the orientation (a photo this stripped before): kept as it is, so a
                    // second strip changes nothing and hands back the very same Buffer.
                    if (buf.subarray(pos, end).equals(minimal)) parts.push(buf.subarray(start, end));
                    else { parts.push(minimal); changed = true; }
                } else {
                    changed = true;
                }
            }
        } else {
            parts.push(buf.subarray(start, end));
        }
        pos = end;

        if (marker === 0xda) { // SOS: the entropy-coded scan follows its header
            hasPicture = true;
            let i = pos;
            for (;;) {
                i = buf.indexOf(0xff, i);
                if (i < 0) return null; // the scan runs off the end: truncated
                // Any number of fill bytes (0xFF) may come before a marker, a restart marker inside the scan
                // included (T.81 B.1.1.2); the byte after them decides what this is.
                let m = i + 1;
                while (m < buf.length && buf[m] === 0xff) m++;
                if (m >= buf.length) return null;
                const next = buf[m];
                if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { i = m + 1; continue; }
                break; // i is still at the first 0xFF: the walk above reads the fill bytes and the marker
            }
            parts.push(buf.subarray(pos, i));
            pos = i;
        }
    }
    if (pos < buf.length) changed = true; // bytes after EOI
    return changed && hasPicture ? Buffer.concat(parts) : null;
}

/**
 * Orientation (tag 0x0112) from a TIFF structure's first IFD, or null when it is absent or not the single SHORT
 * 1–8 the EXIF specification allows. Every read is bounds-checked; a TIFF block that does not parse gives null,
 * which only means the orientation is dropped with the rest.
 */
export function readTiffOrientation(tiff: Buffer): number | null {
    if (tiff.length < 8) return null;
    const order = tiff.toString('latin1', 0, 2);
    const le = order === 'II';
    if (!le && order !== 'MM') return null;
    const u16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
    const u32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
    if (u16(2) !== 42) return null;
    const ifd = u32(4);
    if (ifd < 8 || ifd + 2 > tiff.length) return null;
    const count = u16(ifd);
    for (let k = 0; k < count; k++) {
        const entry = ifd + 2 + k * 12;
        if (entry + 12 > tiff.length) return null;
        if (u16(entry) !== 0x0112) continue;
        if (u16(entry + 2) !== 3 || u32(entry + 4) !== 1) return null; // type SHORT, count 1
        const value = u16(entry + 8);
        return value >= 1 && value <= 8 ? value : null;
    }
    return null;
}

/** An APP1 Exif segment holding one tag, the orientation: big-endian TIFF header, one IFD of one entry, no next IFD. */
function orientationOnlyExifSegment(orientation: number): Buffer {
    const tiff = Buffer.from([
        0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // "MM", 42, IFD0 at offset 8
        0x00, 0x01, // one entry
        0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // Orientation, SHORT, 1, value
        0x00, 0x00, 0x00, 0x00, // no next IFD
    ]);
    const length = 2 + EXIF.length + tiff.length;
    return Buffer.concat([Buffer.from([0xff, 0xe1, length >> 8, length & 0xff]), EXIF, tiff]);
}

// ── PNG ────────────────────────────────────────────────────────────────────────────────────────
//
// The signature, then chunks (4-byte big-endian length, 4-letter type, data, CRC) until IEND. A chunk whose type
// starts with a capital letter is critical: a decoder must understand it, so it is always kept. Ancillary chunks
// are kept only when they change how the picture is drawn (colour, transparency, animation, pixel size); every
// other ancillary chunk goes — tEXt, zTXt, iTXt, eXIf and tIME by name, and any private chunk (C2PA manifests,
// vendor data) because nothing about drawing the picture can depend on one. Kept chunks are copied with their
// own CRC, so no CRC is ever recomputed. Bytes after IEND go too.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DRAWING_CHUNKS = new Set([
    'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'cICP', 'mDCV', 'cLLI', 'bKGD', 'hIST', 'pHYs', 'sPLT',
    'acTL', 'fcTL', 'fdAT',
]);

function stripPng(buf: Buffer): Buffer | null {
    const parts: Buffer[] = [buf.subarray(0, 8)];
    let changed = false;
    let hasPicture = false;
    let pos = 8;
    for (;;) {
        if (pos + 12 > buf.length) return null; // no IEND before the end: truncated
        const length = buf.readUInt32BE(pos);
        const type = buf.toString('latin1', pos + 4, pos + 8);
        if (!/^[A-Za-z]{4}$/.test(type) || length > 0x7fffffff) return null;
        const end = pos + 12 + length;
        if (end > buf.length) return null;
        if (type === 'IDAT') hasPicture = true;
        const critical = type.charCodeAt(0) < 0x61;
        if (critical || PNG_DRAWING_CHUNKS.has(type)) parts.push(buf.subarray(pos, end));
        else changed = true;
        pos = end;
        if (type === 'IEND') break;
    }
    if (pos < buf.length) changed = true;
    return changed && hasPicture ? Buffer.concat(parts) : null;
}

// ── WebP ───────────────────────────────────────────────────────────────────────────────────────
//
// "RIFF", a 4-byte little-endian size of everything after it, "WEBP", then chunks (FourCC, 4-byte little-endian
// size, data, a pad byte when the size is odd). Only the extended format (a VP8X chunk first) can carry EXIF or
// XMP; its flags byte says whether it does, so dropping those chunks clears the two flags, and the RIFF size is
// rewritten for the shorter file. Kept: the image chunks, alpha, animation and the ICC profile. Every other chunk
// — EXIF, "XMP ", anything unknown, which a decoder is required to ignore — goes, as does anything after the RIFF.

const WEBP_DRAWING_CHUNKS = new Set(['VP8X', 'VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);
const WEBP_PICTURE_CHUNKS = new Set(['VP8 ', 'VP8L', 'ANMF']);
const VP8X_EXIF_FLAG = 0x08;
const VP8X_XMP_FLAG = 0x04;

function stripWebp(buf: Buffer): Buffer | null {
    const riffEnd = 8 + buf.readUInt32LE(4);
    if (riffEnd < 12 || riffEnd > buf.length) return null;
    const parts: Buffer[] = [];
    let changed = false;
    let vp8xIndex = -1;
    let hasPicture = false;
    let pos = 12;
    while (pos < riffEnd) {
        if (pos + 8 > riffEnd) return null;
        const fourcc = buf.toString('latin1', pos, pos + 4);
        const size = buf.readUInt32LE(pos + 4);
        const end = pos + 8 + size + (size & 1);
        if (end > riffEnd) return null;
        if (WEBP_PICTURE_CHUNKS.has(fourcc)) hasPicture = true;
        if (WEBP_DRAWING_CHUNKS.has(fourcc)) {
            if (fourcc === 'VP8X') {
                if (size < 10 || vp8xIndex !== -1) return null;
                vp8xIndex = parts.length;
            }
            parts.push(buf.subarray(pos, end));
        } else {
            changed = true;
        }
        pos = end;
    }
    if (riffEnd < buf.length) changed = true;
    // No picture inside the RIFF (a size field that stops short of it, say): nothing here to keep safely.
    if (!changed || !hasPicture) return null;
    if (vp8xIndex !== -1) {
        const vp8x = Buffer.from(parts[vp8xIndex]);
        vp8x[8] &= ~(VP8X_EXIF_FLAG | VP8X_XMP_FLAG) & 0xff;
        parts[vp8xIndex] = vp8x;
    }
    const body = Buffer.concat(parts);
    const header = Buffer.alloc(12);
    header.write('RIFF', 0, 'latin1');
    header.writeUInt32LE(4 + body.length, 4);
    header.write('WEBP', 8, 'latin1');
    return Buffer.concat([header, body]);
}

// ── GIF ────────────────────────────────────────────────────────────────────────────────────────
//
// A GIF has no EXIF, but it can carry an XMP packet (an application extension "XMP DataXMP", which Photoshop
// fills from the source photo, GPS included), IPTC and Photoshop blocks, and free-text comments. Header, screen
// descriptor and colour table, then blocks until the trailer: an image (descriptor, optional colour table, LZW
// data in sub-blocks) or an extension (label, sub-blocks). Kept: every image, graphic control (frame timing and
// transparency), plain text (it is drawn), and the looping and ICC application extensions. Dropped: comments and
// every other application or unknown extension, and anything after the trailer.

const GIF_KEPT_APPLICATIONS = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0', 'ICCRGBG1012']);

/** The offset just past a run of GIF sub-blocks (each a length byte and that many bytes, ended by a zero), or -1. */
function skipGifSubBlocks(buf: Buffer, pos: number): number {
    while (pos < buf.length) {
        const n = buf[pos];
        pos += 1;
        if (n === 0) return pos;
        pos += n;
    }
    return -1;
}

function colourTableBytes(packed: number): number {
    return packed & 0x80 ? 3 * (1 << ((packed & 0x07) + 1)) : 0;
}

function stripGif(buf: Buffer): Buffer | null {
    if (buf.length < 13) return null;
    let pos = 13 + colourTableBytes(buf[10]);
    if (pos > buf.length) return null;
    const parts: Buffer[] = [buf.subarray(0, pos)];
    let changed = false;
    let hasPicture = false;
    for (;;) {
        if (pos >= buf.length) return null; // no trailer before the end: truncated
        const introducer = buf[pos];
        if (introducer === 0x3b) { // trailer
            parts.push(buf.subarray(pos, pos + 1));
            pos += 1;
            break;
        }
        if (introducer === 0x2c) { // image descriptor
            if (pos + 10 > buf.length) return null;
            const data = pos + 10 + colourTableBytes(buf[pos + 9]) + 1; // + the LZW minimum code size byte
            const end = data > buf.length ? -1 : skipGifSubBlocks(buf, data);
            if (end < 0) return null;
            parts.push(buf.subarray(pos, end));
            hasPicture = true;
            pos = end;
            continue;
        }
        if (introducer === 0x21) { // extension
            if (pos + 2 > buf.length) return null;
            const label = buf[pos + 1];
            const end = skipGifSubBlocks(buf, pos + 2);
            if (end < 0) return null;
            const application = label === 0xff && buf[pos + 2] === 11 && pos + 14 <= end
                ? buf.toString('latin1', pos + 3, pos + 14) : null;
            const keep = label === 0xf9 || label === 0x01 || (application !== null && GIF_KEPT_APPLICATIONS.has(application));
            if (keep) parts.push(buf.subarray(pos, end));
            else changed = true;
            pos = end;
            continue;
        }
        return null;
    }
    if (pos < buf.length) changed = true;
    return changed && hasPicture ? Buffer.concat(parts) : null;
}

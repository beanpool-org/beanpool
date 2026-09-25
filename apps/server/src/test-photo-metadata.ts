/**
 * Test Suite: no location or camera metadata leaves a node (G9a-3).
 *
 * A camera photo carries its GPS position, the camera's serial number, an XMP packet, comments and, after the
 * picture itself, more pictures with their own GPS. The node strips all of it where a photo is stored
 * (storage/image-metadata.ts), for every upload path, and serves nothing else back.
 *
 * Part 1 — the strip itself, on real images built here byte by byte: a clean image with every kind of metadata
 * spliced in, which must come back as exactly the clean image (plus a 26-byte orientation block for the JPEG).
 * Truncated at every length, and fuzzed with bit flips: never a throw, never a byte more. A JPEG is read the way
 * libjpeg reads it — extraneous bytes between segments skipped, the end of the data after a scan read as EOI — so the
 * two defects decoders accept in a camera file are stripped like any other; anything else that does not parse to
 * its end comes back exactly as given, and a node refuses to store it (isStorableImageValue).
 *
 * Part 2 — over a real HTTPS round trip, signed as a member: each upload route, read back through the route
 * that serves it (post photos, events, avatars, enterprises, crowdfund projects, groups, and the operator's
 * pricing-guide thumbnail). No canary from the metadata survives and the picture's bytes are exactly the clean
 * image's. A member's photo is also read back the way other members see it: every route that hands out the
 * stored value (group, group members, profile) and every one that turns it into an avatar address (the group and
 * event chats). A photo in a format the strip does not know (a HEIC, GPS inside) is refused on every one of those
 * routes rather than stored with its GPS: with a data: prefix, as bare base64, or labelled image/jpeg. So is a JPEG
 * the walk cannot read. A camera JPEG with extraneous bytes or no EOI goes through a profile, a post and an
 * enterprise stripped, and a pricing-guide item read back with the aggregator's photo link saves with it.
 *
 * "Still decodes" is checked structurally: every result is compared byte for byte with the clean image, which
 * libvips drew, and a PNG's CRCs and inflated pixels are checked on their own.
 *
 * Local only — it talks to the server it starts on localhost and nothing else.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-photo-metadata.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
process.env.ADMIN_PASSWORD = 'PhotoMetaAdmin123!';

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword } from './config/local-config.js';
import { db } from './db/db.js';
import { runPricingAggregationCycle } from './pricing-aggregator.js';

const PORT = 8757;
const BASE = `https://localhost:${PORT}`;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ FAIL: ${msg}`); }
}

// ── Clean images: what the phone and the web app send ─────────────────────────────────────────────

/** 16×16 baseline JPEG from libvips, with a real sRGB ICC profile in APP2 — colour the strip must keep. */
const CLEAN_JPEG = Buffer.from(
    '/9j/4gHwSUNDX1BST0ZJTEUAAQEAAAHgbGNtcwQgAABtbnRyUkdCIFhZWiAH4gADABQACQAOAB1hY3NwTVNGVAAAAABzYXdzY3RybAAAAAAAAAAA' +
    'AAAAAAAA9tYAAQAAAADTLWhhbmR56b9WWj4BtoMjhVVG90+qAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApkZXNjAAAA/AAAACRjcHJ0' +
    'AAABIAAAACJ3dHB0AAABRAAAABRjaGFkAAABWAAAACxyWFlaAAABhAAAABRnWFlaAAABmAAAABRiWFlaAAABrAAAABRyVFJDAAABwAAAACBnVFJD' +
    'AAABwAAAACBiVFJDAAABwAAAACBtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAYAAAAc' +
    'AEMAQwAwAABYWVogAAAAAAAA9tYAAQAAAADTLXNmMzIAAAAAAAEMPwAABd3///MmAAAHkAAA/ZL///uh///9ogAAA9wAAMBxWFlaIAAAAAAAAG+g' +
    'AAA48gAAA49YWVogAAAAAAAAYpYAALeJAAAY2lhZWiAAAAAAAAAkoAAAD4UAALbEcGFyYQAAAAAAAwAAAAJmaQAA8qcAAA1ZAAAT0AAAClv/2wBD' +
    'AAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYa' +
    'KCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAQABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAA' +
    'AAAAAAAABgf/xAAaEAAABwAAAAAAAAAAAAAAAAAABQYREiKh/8QAFQEBAQAAAAAAAAAAAAAAAAAAAwb/xAAaEQACAgMAAAAAAAAAAAAAAAAABgMS' +
    'BBQh/9oADAMBAAIRAxEAPwCME6beNMDgnTDxpgYkabeNMFBI0w8aYJuHI2hllmrXp//Z',
    'base64');

/** 16×16 progressive JPEG from libvips: several scans with tables between them, and no metadata. */
const CLEAN_PROGRESSIVE_JPEG = Buffer.from(
    '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMK' +
    'ChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wgARCAAQABADASIAAhEBAxEB/8QAFQABAQAA' +
    'AAAAAAAAAAAAAAAABQb/xAAVAQEBAAAAAAAAAAAAAAAAAAACBf/aAAwDAQACEAMQAAABi3GaCa//xAAWEAADAAAAAAAAAAAAAAAAAAAAAwT/2gAI' +
    'AQEAAQUCTMJmETCJj//EABYRAQEBAAAAAAAAAAAAAAAAAAURAP/aAAgBAwEBPwExOTf/xAAXEQADAQAAAAAAAAAAAAAAAAAAAgMT/9oACAECAQE/' +
    'AUpqf//EABQQAQAAAAAAAAAAAAAAAAAAACD/2gAIAQEABj8CH//EABYQAAMAAAAAAAAAAAAAAAAAAAAhMf/aAAgBAQABPyGCIogiKP/aAAwDAQAC' +
    'AAMAAAAQ0//EABURAQEAAAAAAAAAAAAAAAAAAABB/9oACAEDAQE/EKD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EA//xAAWEAADAAAA' +
    'AAAAAAAAAAAAAAAAEdH/2gAIAQEAAT8QZEbEZEbE/9k=',
    'base64');

/** 16×16 lossless WebP from libvips: the simple format, one VP8L chunk. */
const CLEAN_WEBP = Buffer.from('UklGRjAAAABXRUJQVlA4TCMAAAAvD8ADAJkyRPQ/NvWvf/Q/QKRtUwn3b3jwdCAmICYArpP1HwA=', 'base64');

/** 1×1 GIF89a: header, screen descriptor, 2-colour table, graphic control, one image, trailer. */
const CLEAN_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const GIF_HEAD = 6 + 7 + 6; // header, logical screen descriptor, global colour table

/** 8×8 RGB PNG built here: IHDR, sRGB, gAMA, pHYs (all kept), one IDAT, IEND. */
const PNG_W = 8, PNG_H = 8;
const PNG_SCANLINES = Buffer.concat(Array.from({ length: PNG_H }, (_, y) =>
    Buffer.from([0, ...Array.from({ length: PNG_W }, (_, x) => [x * 32, y * 32, (x ^ y) * 16]).flat()])));

// ── Metadata, with a canary in every block ────────────────────────────────────────────────────────

const CANARY = 'CANARY';
const u16 = (v: number, le: boolean) => { const b = Buffer.alloc(2); if (le) b.writeUInt16LE(v); else b.writeUInt16BE(v); return b; };
const u32 = (v: number, le: boolean) => { const b = Buffer.alloc(4); if (le) b.writeUInt32LE(v); else b.writeUInt32BE(v); return b; };
const ascii = (s: string) => Buffer.from(`${s}\0`, 'latin1');
const rationals = (pairs: number[][], le: boolean) => Buffer.concat(pairs.flatMap(([n, d]) => [u32(n, le), u32(d, le)]));

/** Castlemaine's latitude as EXIF writes it — the bytes that must never be found in anything served. */
const LAT = [[37, 1], [3, 1], [4512, 100]];
const LNG = [[144, 1], [12, 1], [3456, 100]];
const GPS_SIGNATURES = [rationals(LAT, true), rationals(LAT, false), rationals(LNG, true), rationals(LNG, false)];

interface TiffEntry { tag: number; type: number; count: number; data: Buffer }
function ifdSize(entries: TiffEntry[]): number {
    return 2 + entries.length * 12 + 4 + entries.reduce((n, e) => n + (e.data.length > 4 ? e.data.length + (e.data.length & 1) : 0), 0);
}
function writeIfd(out: Buffer, at: number, entries: TiffEntry[], le: boolean): void {
    u16(entries.length, le).copy(out, at);
    let data = at + 2 + entries.length * 12 + 4;
    entries.forEach((e, i) => {
        const p = at + 2 + i * 12;
        u16(e.tag, le).copy(out, p);
        u16(e.type, le).copy(out, p + 2);
        u32(e.count, le).copy(out, p + 4);
        if (e.data.length <= 4) e.data.copy(out, p + 8);
        else { u32(data, le).copy(out, p + 8); e.data.copy(out, data); data += e.data.length + (e.data.length & 1); }
    });
}

/** A camera's EXIF: make, model, orientation, a serial number in the Exif IFD, and a GPS IFD with a position. */
function cameraTiff(le: boolean, orientation: number | null): Buffer {
    const gps: TiffEntry[] = [
        { tag: 0x0001, type: 2, count: 2, data: ascii('S') },
        { tag: 0x0002, type: 5, count: 3, data: rationals(LAT, le) },
        { tag: 0x0003, type: 2, count: 2, data: ascii('E') },
        { tag: 0x0004, type: 5, count: 3, data: rationals(LNG, le) },
    ];
    const serial = ascii(`${CANARY}-SERIAL-0042`);
    const exif: TiffEntry[] = [{ tag: 0xa431, type: 2, count: serial.length, data: serial }];
    const make = ascii(`${CANARY}-MAKE`), model = ascii(`${CANARY}-MODEL`);
    const ifd0: TiffEntry[] = [
        { tag: 0x010f, type: 2, count: make.length, data: make },
        { tag: 0x0110, type: 2, count: model.length, data: model },
        ...(orientation === null ? [] : [{ tag: 0x0112, type: 3, count: 1, data: u16(orientation, le) }]),
        { tag: 0x8769, type: 4, count: 1, data: Buffer.alloc(4) },
        { tag: 0x8825, type: 4, count: 1, data: Buffer.alloc(4) },
    ];
    const exifAt = 8 + ifdSize(ifd0);
    const gpsAt = exifAt + ifdSize(exif);
    ifd0.find(e => e.tag === 0x8769)!.data = u32(exifAt, le);
    ifd0.find(e => e.tag === 0x8825)!.data = u32(gpsAt, le);
    const out = Buffer.alloc(gpsAt + ifdSize(gps));
    out.write(le ? 'II' : 'MM', 0, 'latin1');
    u16(42, le).copy(out, 2);
    u32(8, le).copy(out, 4);
    writeIfd(out, 8, ifd0, le);
    writeIfd(out, exifAt, exif, le);
    writeIfd(out, gpsAt, gps, le);
    return out;
}

const XMP = Buffer.from(
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="37,3.75S" exif:GPSLongitude="144,12.576E"' +
    ` xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreatorTool="${CANARY}-XMP"/></rdf:RDF></x:xmpmeta>`, 'latin1');

// JPEG pieces.
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
function segment(marker: number, payload: Buffer): Buffer {
    const len = payload.length + 2;
    return Buffer.concat([Buffer.from([0xff, marker, len >> 8, len & 0xff]), payload]);
}
const JFIF_FIELDS = Buffer.from([0x01, 0x02, 0x01, 0x00, 0x48, 0x00, 0x48]); // version 1.2, dpi, 72×72
const JFIF_WITH_THUMBNAIL = segment(0xe0, Buffer.concat([Buffer.from('JFIF\0', 'latin1'), JFIF_FIELDS, Buffer.from([1, 1, 0xca, 0x4e, 0xa7])]));
const JFIF_PLAIN = segment(0xe0, Buffer.concat([Buffer.from('JFIF\0', 'latin1'), JFIF_FIELDS, Buffer.from([0, 0])]));
const exifApp1 = (le: boolean, orientation: number | null) =>
    segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), cameraTiff(le, orientation)]));
const XMP_APP1 = segment(0xe1, Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'), XMP]));
const IPTC_APP13 = segment(0xed, Buffer.from(`Photoshop 3.0\u00008BIM\u0004\u0004\u0000\u0000\u0000\u0000\u0000\u0014\u001c\u0002Z\u0000\u000f${CANARY}-CITY`, 'latin1'));
const COMMENT = segment(0xfe, Buffer.from(`${CANARY}-COMMENT taken at 12 Example St`, 'latin1'));
const MPF_APP2 = segment(0xe2, Buffer.from(`MPF\0${CANARY}-MPF-INDEX`, 'latin1'));
/** A second picture after EOI with its own GPS — how MPF stores a preview or a depth map. */
const MPF_SECOND_IMAGE = Buffer.concat([SOI, exifApp1(true, 1), EOI]);

/** Orientation 6 and nothing else, exactly as the strip writes it: big-endian TIFF, one entry, no next IFD. */
const ORIENTATION_6_ONLY = segment(0xe1, Buffer.from([
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01,
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]));

/** A phone photo as the camera wrote it (little-endian EXIF, turned on its side): every block, then a trailer. */
const CAMERA_JPEG = Buffer.concat([
    SOI, JFIF_WITH_THUMBNAIL, exifApp1(true, 6), XMP_APP1, IPTC_APP13, COMMENT, MPF_APP2,
    CLEAN_JPEG.subarray(2), MPF_SECOND_IMAGE,
]);
const CAMERA_JPEG_STRIPPED = Buffer.concat([SOI, JFIF_PLAIN, ORIENTATION_6_ONLY, CLEAN_JPEG.subarray(2)]);

/** Progressive, big-endian EXIF with the default orientation, and a comment between the last scan and EOI. */
const CAMERA_PROGRESSIVE_JPEG = Buffer.concat([
    SOI, exifApp1(false, 1), CLEAN_PROGRESSIVE_JPEG.subarray(2, -2), COMMENT, EOI,
]);

/**
 * The two defects in a camera JPEG that decoders accept (#1148 review): bytes between two segments (libjpeg: "2
 * extraneous bytes before marker 0xe1"), and no EOI after the scan (a file cut short). Pillow and macOS ImageIO read
 * both, and until the walk read them the way libjpeg does, both were stored and served with their EXIF GPS.
 */
const PADDED_CAMERA_JPEG = Buffer.concat([
    SOI, JFIF_WITH_THUMBNAIL, exifApp1(true, 6), Buffer.from([0x00, 0x00]), XMP_APP1, IPTC_APP13, COMMENT, MPF_APP2,
    CLEAN_JPEG.subarray(2), MPF_SECOND_IMAGE,
]);
const CAMERA_JPEG_NO_EOI = Buffer.concat([
    SOI, JFIF_WITH_THUMBNAIL, exifApp1(true, 6), XMP_APP1, IPTC_APP13, COMMENT, MPF_APP2, CLEAN_JPEG.subarray(2, -2),
]);
/** Stripped, a file with no EOI still has none: its scan is kept to the last byte and nothing is added. */
const CAMERA_JPEG_NO_EOI_STRIPPED = CAMERA_JPEG_STRIPPED.subarray(0, -2);
/** A camera JPEG whose structure no decoder reads (a second SOI after its EXIF): the node cannot strip it, so refuses it. */
const UNWALKABLE_CAMERA_JPEG = Buffer.concat([SOI, exifApp1(true, 6), SOI, CLEAN_JPEG.subarray(2)]);

// PNG pieces.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    return Buffer.concat([u32(data.length, false), typed, u32(crc32(typed), false)]);
}
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IHDR = chunk('IHDR', Buffer.concat([u32(PNG_W, false), u32(PNG_H, false), Buffer.from([8, 2, 0, 0, 0])]));
const SRGB = chunk('sRGB', Buffer.from([0]));
const GAMA = chunk('gAMA', u32(45455, false));
const PHYS = chunk('pHYs', Buffer.concat([u32(2835, false), u32(2835, false), Buffer.from([1])]));
const IDAT = chunk('IDAT', zlib.deflateSync(PNG_SCANLINES));
const IEND = chunk('IEND', Buffer.alloc(0));
const CLEAN_PNG = Buffer.concat([PNG_SIGNATURE, IHDR, SRGB, GAMA, PHYS, IDAT, IEND]);
const CAMERA_PNG = Buffer.concat([
    PNG_SIGNATURE, IHDR, SRGB, GAMA,
    chunk('tEXt', Buffer.from(`Comment\0${CANARY}-TEXT`, 'latin1')),
    chunk('zTXt', Buffer.concat([Buffer.from('Location\0\0', 'latin1'), zlib.deflateSync(Buffer.from(`${CANARY}-ZTXT 37.0625S 144.2096E`))])),
    chunk('iTXt', Buffer.concat([Buffer.from('XML:com.adobe.xmp\0\0\0\0\0', 'latin1'), XMP])),
    chunk('eXIf', cameraTiff(false, 6)),
    PHYS,
    chunk('tIME', Buffer.from([0x07, 0xea, 9, 25, 10, 30, 0])),
    chunk('caBX', Buffer.from(`${CANARY}-C2PA-MANIFEST`, 'latin1')),
    IDAT, IEND,
    Buffer.from(`${CANARY}-AFTER-IEND`, 'latin1'),
]);

// WebP pieces.
function riffChunk(fourcc: string, data: Buffer): Buffer {
    return Buffer.concat([Buffer.from(fourcc, 'latin1'), u32(data.length, true), data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
function riff(chunks: Buffer[]): Buffer {
    const body = Buffer.concat(chunks);
    return Buffer.concat([Buffer.from('RIFF', 'latin1'), u32(4 + body.length, true), Buffer.from('WEBP', 'latin1'), body]);
}
const VP8L_CHUNK = CLEAN_WEBP.subarray(12);
const vp8x = (flags: number) => riffChunk('VP8X', Buffer.from([flags, 0, 0, 0, 15, 0, 0, 15, 0, 0])); // 16×16 canvas
const CAMERA_WEBP = riff([
    vp8x(0x08 | 0x04), VP8L_CHUNK,
    riffChunk('EXIF', cameraTiff(true, 1)),
    riffChunk('XMP ', XMP),
    riffChunk('CNRY', Buffer.from(`${CANARY}-UNKNOWN-CHUNK`, 'latin1')),
]);
const CAMERA_WEBP_STRIPPED = riff([vp8x(0), VP8L_CHUNK]);

// GIF pieces.
const NETSCAPE_LOOP = Buffer.concat([Buffer.from([0x21, 0xff, 0x0b]), Buffer.from('NETSCAPE2.0', 'latin1'), Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00])]);
const GIF_COMMENT = Buffer.concat([Buffer.from([0x21, 0xfe, 18]), Buffer.from(`${CANARY}-GIF-COMMENTX`.slice(0, 18), 'latin1'), Buffer.from([0x00])]);
/** XMP in a GIF: raw packet bytes after the application id, then the 258-byte "magic trailer" that ends any sub-block walk. */
const GIF_XMP = Buffer.concat([
    Buffer.from([0x21, 0xff, 0x0b]), Buffer.from('XMP DataXMP', 'latin1'), XMP,
    Buffer.from([0x01, ...Array.from({ length: 256 }, (_, i) => 0xff - i), 0x00]),
]);
const CAMERA_GIF = Buffer.concat([CLEAN_GIF.subarray(0, GIF_HEAD), NETSCAPE_LOOP, GIF_COMMENT, GIF_XMP, CLEAN_GIF.subarray(GIF_HEAD)]);
const CAMERA_GIF_STRIPPED = Buffer.concat([CLEAN_GIF.subarray(0, GIF_HEAD), NETSCAPE_LOOP, CLEAN_GIF.subarray(GIF_HEAD)]);

/** The start of an iPhone's HEIC (an ISO-BMFF ftyp box, then an Exif item with GPS): a format the strip does not know. */
const CAMERA_HEIC = Buffer.concat([
    u32(24, false), Buffer.from('ftypheic', 'latin1'), u32(0, false), Buffer.from('mif1heic', 'latin1'),
    u32(8 + 6 + cameraTiff(false, 6).length, false), Buffer.from('Exif', 'latin1'), Buffer.from('Exif\0\0', 'latin1'), cameraTiff(false, 6),
]);

// ── Oracles: independent of the code under test ───────────────────────────────────────────────────

/** Why these bytes still carry something they must not: a canary, a GPS coordinate, or null when clean. */
function leak(bytes: Buffer): string | null {
    if (bytes.includes(CANARY)) return `a ${bytes.toString('latin1').match(/CANARY[-A-Z0-9]*/)?.[0]} block`;
    if (GPS_SIGNATURES.some(sig => bytes.includes(sig))) return 'a GPS coordinate';
    if (bytes.includes('GPSLatitude')) return 'an XMP GPS field';
    return null;
}

/** Where a well-formed JPEG's first scan data begins: just past its first SOS segment, found by segment lengths. */
function firstScanData(jpeg: Buffer): number {
    let pos = 2;
    while (jpeg[pos + 1] !== 0xda) pos += 2 + jpeg.readUInt16BE(pos + 2);
    return pos + 2 + jpeg.readUInt16BE(pos + 2);
}

/** A PNG decoded without help: every chunk's CRC checks and the IDAT data inflates to the pixels we drew. */
function pngDecodes(bytes: Buffer): boolean {
    if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
    const idat: Buffer[] = [];
    let pos = 8;
    while (pos + 12 <= bytes.length) {
        const len = bytes.readUInt32BE(pos);
        const typed = bytes.subarray(pos + 4, pos + 8 + len);
        if (crc32(typed) !== bytes.readUInt32BE(pos + 8 + len)) return false;
        const type = typed.subarray(0, 4).toString('latin1');
        if (type === 'IDAT') idat.push(typed.subarray(4));
        pos += 12 + len;
        if (type === 'IEND') return pos === bytes.length && zlib.inflateSync(Buffer.concat(idat)).equals(PNG_SCANLINES);
    }
    return false;
}

// ── Part 1: the strip ─────────────────────────────────────────────────────────────────────────────

type StripModule = typeof import('./storage/image-metadata.js');

function mulberry32(seed: number): () => number {
    return () => {
        seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

async function partOne(m: StripModule): Promise<void> {
    const { stripImageMetadata: strip, stripImageValue, readTiffOrientation } = m;

    console.log('\n── 1a. Each format comes back as exactly the clean image ──');
    const jpeg = strip(CAMERA_JPEG);
    assert(jpeg.equals(CAMERA_JPEG_STRIPPED),
        'JPEG: Exif, XMP, IPTC, comment, MPF and the second image after EOI are gone; JFIF (without its thumbnail), the ICC profile, and every byte of the picture stay');
    assert(leak(jpeg) === null, `JPEG: no canary and no GPS coordinate survives (${leak(jpeg) ?? 'clean'})`);
    assert(jpeg.includes(CLEAN_JPEG.subarray(2)), 'JPEG: the clean image from its ICC profile to EOI is there byte for byte');
    assert(readTiffOrientation(jpeg.subarray(jpeg.indexOf('Exif\0\0') + 6)) === 6, 'JPEG: the orientation (6, on its side) survives, alone');
    const progressive = strip(CAMERA_PROGRESSIVE_JPEG);
    assert(progressive.equals(CLEAN_PROGRESSIVE_JPEG),
        'progressive JPEG: big-endian Exif with the default orientation, and a comment after the last scan, are gone; the scans are untouched');
    // Fill bytes (runs of 0xFF) may come before any marker, restart markers inside a scan included (T.81 B.1.1.2).
    const SOS_ONE_COMPONENT = segment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]));
    const FILLED_SCAN = Buffer.from([0x12, 0x34, 0xff, 0xff, 0xd0, 0x56, 0xff, 0x00, 0x78, 0xff, 0xff, 0xff, 0xd1, 0x9a, 0xff, 0xff, 0x00, 0xbc, 0xff]);
    const filled = strip(Buffer.concat([SOI, exifApp1(true, 1), COMMENT, SOS_ONE_COMPONENT, FILLED_SCAN, EOI]));
    assert(filled.equals(Buffer.concat([SOI, SOS_ONE_COMPONENT, FILLED_SCAN, EOI])),
        'JPEG: a scan with fill bytes before its restart markers is walked to EOI, its metadata gone and every scan byte kept');
    const png = strip(CAMERA_PNG);
    assert(png.equals(CLEAN_PNG), 'PNG: tEXt, zTXt, iTXt, eXIf, tIME, a private chunk and bytes after IEND are gone; IHDR, sRGB, gAMA, pHYs, IDAT, IEND stay');
    assert(pngDecodes(png), 'PNG: every CRC checks and the IDAT inflates to the pixels drawn');
    const webp = strip(CAMERA_WEBP);
    assert(webp.equals(CAMERA_WEBP_STRIPPED), 'WebP: EXIF, XMP and an unknown chunk are gone, the VP8X flags say so, the RIFF size is the new length');
    assert(webp.readUInt32LE(4) === webp.length - 8 && (webp[20] & 0x0c) === 0, 'WebP: RIFF size and VP8X flags checked directly');
    const gif = strip(CAMERA_GIF);
    assert(gif.equals(CAMERA_GIF_STRIPPED), 'GIF: the comment and the XMP application block are gone; the loop block, graphic control and image stay');
    for (const [name, out] of [['JPEG', jpeg], ['progressive JPEG', progressive], ['PNG', png], ['WebP', webp], ['GIF', gif]] as const) {
        assert(leak(out) === null, `${name}: nothing identifying is left (${leak(out) ?? 'clean'})`);
    }
    console.log('\n── 1b. A photo with nothing to strip is left alone — the same Buffer ──');
    const legacyTestJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
    for (const [name, clean] of [
        ['baseline JPEG with an ICC profile', CLEAN_JPEG], ['progressive JPEG', CLEAN_PROGRESSIVE_JPEG],
        ['the JFIF-only JPEG the image-store suites use', legacyTestJpeg], ['PNG', CLEAN_PNG], ['simple WebP', CLEAN_WEBP], ['GIF', CLEAN_GIF],
    ] as const) {
        assert(strip(clean) === clean, `${name}: returned as the very same Buffer`);
    }
    for (const [name, out] of [['JPEG', jpeg], ['PNG', png], ['WebP', webp], ['GIF', gif]] as const) {
        assert(strip(out) === out, `${name}: stripping twice changes nothing (idempotent)`);
    }

    console.log('\n── 1c. Truncated at every length: no throw, no growth; a JPEG cut short once its scan has begun is stripped ──');
    const ends: Array<[string, Buffer, number]> = [
        ['JPEG', CAMERA_JPEG, CAMERA_JPEG.length - MPF_SECOND_IMAGE.length],
        ['progressive JPEG', CAMERA_PROGRESSIVE_JPEG, CAMERA_PROGRESSIVE_JPEG.length],
        ['PNG', CAMERA_PNG, CAMERA_PNG.length - `${CANARY}-AFTER-IEND`.length],
        ['WebP', CAMERA_WEBP, CAMERA_WEBP.length],
        ['GIF', CAMERA_GIF, CAMERA_GIF.length],
    ];
    // libjpeg reads the end of the data as EOI, so a JPEG cut short after its first scan has begun is a picture, and it
    // comes back as the stripped file's first n − (metadata before the picture) bytes: every picture byte it had,
    // nothing added. Less any trailing 0xFF, which begins a marker whose code was cut off (or is a stuffed 0xFF whose
    // 0x00 was): a decoder reads it as fill before the end. Cut before the scan, it holds no picture: unchanged.
    const cutJpeg: Record<string, { scan: number; stripped: Buffer; removed: number; pictureEnd: number }> = {
        'JPEG': {
            scan: firstScanData(CAMERA_JPEG), stripped: CAMERA_JPEG_STRIPPED,
            removed: CAMERA_JPEG.length - MPF_SECOND_IMAGE.length - CAMERA_JPEG_STRIPPED.length, pictureEnd: CAMERA_JPEG_STRIPPED.length,
        },
        'progressive JPEG': {
            // Its comment comes after the last scan, so what a cut there keeps is the picture up to (not including) EOI.
            scan: firstScanData(CAMERA_PROGRESSIVE_JPEG), stripped: CLEAN_PROGRESSIVE_JPEG,
            removed: exifApp1(false, 1).length, pictureEnd: CLEAN_PROGRESSIVE_JPEG.length - 2,
        },
    };
    for (const [name, file, endMarkerEnd] of ends) {
        const jpeg = cutJpeg[name];
        let bad = '';
        for (let n = 0; n < file.length && !bad; n++) {
            const prefix = Buffer.from(file.subarray(0, n));
            let out: Buffer;
            try { out = strip(prefix); } catch (e) { bad = `threw at ${n}: ${e}`; break; }
            if (out.length > prefix.length) bad = `grew at ${n}`;
            else if (jpeg && n >= jpeg.scan) {
                let want = jpeg.stripped.subarray(0, Math.min(n - jpeg.removed, jpeg.pictureEnd));
                while (want.length > 0 && want[want.length - 1] === 0xff) want = want.subarray(0, -1);
                if (!out.equals(want)) bad = `a cut after the scan began, at ${n}, is not the stripped picture so far (${out.length} bytes, ${want.length} expected)`;
                else if (leak(out) !== null) bad = `a cut at ${n} kept ${leak(out)}`;
            } else if (n < endMarkerEnd && out !== prefix) bad = `changed a file cut before its ${jpeg ? 'scan' : 'end marker'}, at ${n}`;
        }
        assert(bad === '', `${name}: all ${file.length} truncations${bad ? ` — ${bad}` : ''}`);
    }

    console.log('\n── 1d. Fuzzed: bit flips and garbage behind every magic number ──');
    const random = mulberry32(0x6a3);
    for (const [name, file] of ends.map(([n, f]) => [n, f] as const)) {
        let bad = '';
        for (let i = 0; i < 3000 && !bad; i++) {
            const mutated = Buffer.from(file);
            const flips = 1 + Math.floor(random() * 4);
            for (let f = 0; f < flips; f++) mutated[Math.floor(random() * mutated.length)] ^= 1 << Math.floor(random() * 8);
            try {
                if (strip(mutated).length > mutated.length) bad = `grew on mutation ${i}`;
            } catch (e) { bad = `threw on mutation ${i}: ${e}`; }
        }
        assert(bad === '', `${name}: 3000 random bit flips${bad ? ` — ${bad}` : ''}`);
    }
    {
        let bad = '';
        const magics = [Buffer.from([0xff, 0xd8, 0xff]), PNG_SIGNATURE, Buffer.from('RIFF\0\0\0\0WEBP', 'latin1'), Buffer.from('GIF89a', 'latin1')];
        for (let i = 0; i < 4000 && !bad; i++) {
            const garbage = Buffer.concat([magics[i % 4], crypto.randomBytes(Math.floor(random() * 300))]);
            if (i % 8 === 2) garbage.writeUInt32LE(garbage.length - 8, 4); // a plausible RIFF size
            try {
                if (strip(garbage).length > garbage.length) bad = `grew on ${garbage.toString('hex')}`;
            } catch (e) { bad = `threw on ${garbage.toString('hex')}: ${e}`; }
        }
        assert(bad === '', `4000 random bodies behind a JPEG, PNG, WebP or GIF magic number${bad ? ` — ${bad}` : ''}`);
    }

    console.log('\n── 1e. Malformed on purpose: returned exactly as given ──');
    const exact = (name: string, input: Buffer) => {
        let out: Buffer | null = null;
        try { out = strip(input); } catch { /* reported below */ }
        assert(out === input, `${name}: returned as given`);
    };
    exact('an empty buffer', Buffer.alloc(0));
    exact('one byte', Buffer.from([0xff]));
    exact('not an image', Buffer.from('%PDF-1.7 not an image at all', 'latin1'));
    exact('JPEG: a segment length of 1', Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0x00, 0x01]), COMMENT, CLEAN_JPEG.subarray(2)]));
    exact('JPEG: a segment that claims more bytes than the file has', Buffer.concat([SOI, COMMENT, Buffer.from([0xff, 0xe1, 0xff, 0xff, 0x00])]));
    exact('JPEG: a second SOI where a segment should be', Buffer.concat([SOI, COMMENT, SOI, CLEAN_JPEG.subarray(2)]));
    exact('JPEG: a marker code T.81 reserves (0xF7, JPEG-LS), which libjpeg refuses', Buffer.concat([SOI, COMMENT, Buffer.from([0xff, 0xf7, 0x00, 0x04, 0x00, 0x00]), CLEAN_JPEG.subarray(2)]));
    exact('PNG: a chunk type that is not four letters', Buffer.concat([PNG_SIGNATURE, IHDR, chunk('tE1t', Buffer.from(CANARY)), IDAT, IEND]));
    exact('PNG: a chunk length of 2^32-1', Buffer.concat([PNG_SIGNATURE, IHDR, Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from('tEXt', 'latin1'), IDAT, IEND]));
    exact('PNG: no IEND', Buffer.concat([PNG_SIGNATURE, IHDR, chunk('tEXt', Buffer.from(CANARY)), IDAT]));
    const tooBig = Buffer.from(CAMERA_WEBP); tooBig.writeUInt32LE(CAMERA_WEBP.length, 4);
    exact('WebP: a RIFF size larger than the file', tooBig);
    exact('WebP: a VP8X chunk shorter than 10 bytes', riff([riffChunk('VP8X', Buffer.from([0x08, 0, 0, 0])), VP8L_CHUNK, riffChunk('EXIF', cameraTiff(true, 1))]));
    exact('WebP: two VP8X chunks', riff([vp8x(0x08), vp8x(0x08), VP8L_CHUNK, riffChunk('EXIF', cameraTiff(true, 1))]));
    exact('WebP: a chunk that runs past the RIFF', riff([vp8x(0x08), VP8L_CHUNK, Buffer.from('EXIF\xff\x00\x00\x00', 'latin1')]));
    exact('GIF: a sub-block that runs off the end', Buffer.concat([CLEAN_GIF.subarray(0, GIF_HEAD), GIF_COMMENT.subarray(0, 8)]));
    exact('GIF: an unknown block introducer', Buffer.concat([CLEAN_GIF.subarray(0, GIF_HEAD), GIF_COMMENT, Buffer.from([0x99]), CLEAN_GIF.subarray(GIF_HEAD)]));
    exact('GIF: no trailer', Buffer.concat([CLEAN_GIF.subarray(0, GIF_HEAD), GIF_COMMENT, CLEAN_GIF.subarray(GIF_HEAD, -1)]));
    exact('WebP: a RIFF size that stops before the picture (only metadata inside it)',
        Buffer.concat([riff([vp8x(0x08), riffChunk('EXIF', cameraTiff(true, 1))]), VP8L_CHUNK]));
    exact('JPEG: no scan at all, nothing but metadata', Buffer.concat([SOI, exifApp1(true, 6), COMMENT, EOI]));
    exact('GIF: no image block, nothing but a comment', Buffer.concat([CLEAN_GIF.subarray(0, GIF_HEAD), GIF_COMMENT, Buffer.from([0x3b])]));
    exact('PNG: no IDAT before IEND, nothing but metadata', Buffer.concat([PNG_SIGNATURE, IHDR, chunk('tEXt', Buffer.from(`Comment\0${CANARY}-TEXT`, 'latin1')), IEND]));
    exact('PNG: the only IDAT comes after IEND', Buffer.concat([PNG_SIGNATURE, IHDR, chunk('tEXt', Buffer.from(`Comment\0${CANARY}-TEXT`, 'latin1')), IEND, IDAT]));

    console.log('\n── 1f. The orientation reader ──');
    assert(readTiffOrientation(cameraTiff(true, 8)) === 8 && readTiffOrientation(cameraTiff(false, 3)) === 3, 'reads both byte orders');
    assert(readTiffOrientation(cameraTiff(true, null)) === null, 'no orientation tag → null');
    assert(readTiffOrientation(cameraTiff(true, 9)) === null, 'a value outside 1–8 → null');
    assert(readTiffOrientation(cameraTiff(true, 6).subarray(0, 20)) === null, 'a TIFF cut short → null, no throw');
    assert(readTiffOrientation(Buffer.from('XX\0*\0\0\0\x08', 'latin1')) === null, 'an unknown byte order → null');

    console.log('\n── 1g. Stored values: data URLs, bare base64, and everything that is not an image ──');
    const cameraUrl = `data:image/jpeg;base64,${CAMERA_JPEG.toString('base64')}`;
    assert(stripImageValue(cameraUrl) === `data:image/jpeg;base64,${CAMERA_JPEG_STRIPPED.toString('base64')}`, 'a data URL comes back stripped, canonical, under the same MIME type');
    const cleanUrl = `data:image/jpeg;base64,${CLEAN_JPEG.toString('base64')}`;
    assert(stripImageValue(cleanUrl) === cleanUrl, 'a data URL with nothing to strip comes back as the same string');
    const wrapped = `data:image/png;base64,${CAMERA_PNG.toString('base64').replace(/(.{76})/g, '$1\n')}`;
    assert(stripImageValue(wrapped) === `data:image/png;base64,${CLEAN_PNG.toString('base64')}`, 'base64 wrapped across lines (the avatar route decodes it) is stripped too');
    assert(stripImageValue(`  DATA:image/jpg;base64,${CAMERA_JPEG.toString('base64')}  `) === `data:image/jpg;base64,${CAMERA_JPEG_STRIPPED.toString('base64')}`,
        'the avatar route\'s case-insensitive, whitespace-tolerant form is stripped');
    assert(stripImageValue(CAMERA_JPEG.toString('base64')) === CAMERA_JPEG_STRIPPED.toString('base64'), 'a legacy bare-base64 avatar (still served) is stripped and stays bare');
    assert(stripImageValue(CAMERA_JPEG.toString('base64url')) === CAMERA_JPEG_STRIPPED.toString('base64'),
        'bare URL-safe base64 (the avatar route decodes it) is stripped');
    assert(stripImageValue(CAMERA_JPEG.toString('base64').replace(/(.{60})/g, '$1.')) === CAMERA_JPEG_STRIPPED.toString('base64'),
        'bare base64 with characters outside the alphabet (the avatar route skips them) is stripped');
    const lying = `data:image/png;base64,${CAMERA_JPEG.toString('base64')}`;
    assert(stripImageValue(lying) === `data:image/png;base64,${CAMERA_JPEG_STRIPPED.toString('base64')}`, 'the bytes decide the format, not the declared MIME type');
    for (const v of [null, undefined, '', 'bundled://avatar-3', '/api/avatar/abcdef', 'https://example.org/me.jpg', 'data:image/svg+xml,%3Csvg%3E', 'data:image/jpeg;base64,', 'bm90IGFuIGltYWdl']) {
        assert(stripImageValue(v) === v, `left exactly as given: ${JSON.stringify(v)}`);
    }
    assert((stripImageValue as (v: unknown) => unknown)({ not: 'a string' }) !== undefined, 'a non-string value passes through');

    console.log('\n── 1h. The two defects decoders accept: read the way libjpeg reads them, and stripped ──');
    const padded = strip(PADDED_CAMERA_JPEG);
    assert(padded.equals(CAMERA_JPEG_STRIPPED),
        'JPEG with two extraneous bytes after its Exif segment: every metadata block goes, the extraneous bytes too, and every picture byte stays');
    assert(leak(padded) === null, `padded JPEG: no canary and no GPS coordinate survives (${leak(padded) ?? 'clean'})`);
    const noEoi = strip(CAMERA_JPEG_NO_EOI);
    assert(noEoi.equals(CAMERA_JPEG_NO_EOI_STRIPPED),
        'JPEG with no EOI after its scan: every metadata block goes, the scan is kept to its last byte and nothing is added');
    assert(leak(noEoi) === null, `JPEG with no EOI: no canary and no GPS coordinate survives (${leak(noEoi) ?? 'clean'})`);
    assert(stripImageValue(dataUrl('image/jpeg', PADDED_CAMERA_JPEG)) === dataUrl('image/jpeg', CAMERA_JPEG_STRIPPED)
        && stripImageValue(CAMERA_JPEG_NO_EOI.toString('base64')) === CAMERA_JPEG_NO_EOI_STRIPPED.toString('base64'),
        'the same, as a data URL and as bare base64');
    // These two were "returned as given" (1e) before the walk read JPEGs the way libjpeg does.
    assert(strip(Buffer.concat([SOI, COMMENT, Buffer.from([0x00]), CLEAN_JPEG.subarray(2)])).equals(CLEAN_JPEG),
        'JPEG: a data byte where a marker should be is skipped, as libjpeg skips it, and the comment before it goes');
    assert(strip(Buffer.concat([SOI, exifApp1(true, 6), CLEAN_JPEG.subarray(2, -2)])).equals(Buffer.concat([SOI, ORIENTATION_6_ONLY, CLEAN_JPEG.subarray(2, -2)])),
        'JPEG: no EOI (the scan runs off the end): the Exif goes, its orientation stays, the scan is kept to its last byte');
    // libjpeg's next_marker also skips a stuffed 0xFF00 outside a scan, and any fill bytes before the marker it finds.
    assert(strip(Buffer.concat([SOI, exifApp1(true, 6), Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xff]), CLEAN_JPEG.subarray(2)]))
        .equals(Buffer.concat([SOI, ORIENTATION_6_ONLY, Buffer.from([0xff, 0xff]), CLEAN_JPEG.subarray(2)])),
        'JPEG: extraneous bytes with a stuffed 0xFF00 among them are skipped; fill bytes before the next marker stay with it');
    {
        // Between two scans of a progressive file, after a table: where libjpeg's warning usually points.
        const tables = CLEAN_PROGRESSIVE_JPEG.indexOf(Buffer.from([0xff, 0xc4]), firstScanData(CLEAN_PROGRESSIVE_JPEG));
        const dht = CLEAN_PROGRESSIVE_JPEG.subarray(tables, tables + 2 + CLEAN_PROGRESSIVE_JPEG.readUInt16BE(tables + 2));
        const at = tables + dht.length;
        const junky = Buffer.concat([SOI, exifApp1(false, 1), CLEAN_PROGRESSIVE_JPEG.subarray(2, at), Buffer.from([0, 0, 0]), CLEAN_PROGRESSIVE_JPEG.subarray(at)]);
        assert(strip(junky).equals(CLEAN_PROGRESSIVE_JPEG), 'progressive JPEG: extraneous bytes after a table between two scans are skipped, every scan byte kept');
    }

    console.log('\n── 1i. What a node refuses rather than store with its metadata ──');
    // Absent before this check existed, when every value was stored: read as "storable" so the suite still runs there.
    const storable = (v: unknown): boolean => typeof m.isStorableImageValue !== 'function' || m.isStorableImageValue(v);
    const cutInsideIcc = CAMERA_JPEG.subarray(0, CAMERA_JPEG.indexOf(CLEAN_JPEG.subarray(2)) + 100);
    for (const [name, bytes] of [
        ['JPEG: a second SOI after its Exif', UNWALKABLE_CAMERA_JPEG],
        ['JPEG: a segment length of 1 after its Exif', Buffer.concat([SOI, exifApp1(true, 6), Buffer.from([0xff, 0xe1, 0x00, 0x01]), CLEAN_JPEG.subarray(2)])],
        ['JPEG: a reserved marker code after its Exif', Buffer.concat([SOI, exifApp1(true, 6), Buffer.from([0xff, 0xf7, 0x00, 0x04, 0x00, 0x00]), CLEAN_JPEG.subarray(2)])],
        ['JPEG: no scan at all, nothing but metadata', Buffer.concat([SOI, exifApp1(true, 6), COMMENT, EOI])],
        ['JPEG: cut short before its scan, Exif and all', cutInsideIcc],
        ['PNG: no IEND, a tEXt inside', Buffer.concat([PNG_SIGNATURE, IHDR, chunk('tEXt', Buffer.from(CANARY)), IDAT])],
        ['PNG: no IDAT before IEND, nothing but metadata', Buffer.concat([PNG_SIGNATURE, IHDR, chunk('tEXt', Buffer.from(`Comment\0${CANARY}-TEXT`, 'latin1')), IEND])],
        ['PNG: cut short inside a chunk', CLEAN_PNG.subarray(0, CLEAN_PNG.length - 20)],
        ['PNG: a chunk type that is not four letters', Buffer.concat([PNG_SIGNATURE, IHDR, chunk('tE1t', Buffer.from(CANARY)), IDAT, IEND])],
        ['WebP: a RIFF size larger than the file, Exif inside', tooBig],
        ['WebP: a RIFF size that stops before the picture', Buffer.concat([riff([vp8x(0x08), riffChunk('EXIF', cameraTiff(true, 1))]), VP8L_CHUNK])],
        ['GIF: no trailer, a comment inside', Buffer.concat([CLEAN_GIF.subarray(0, GIF_HEAD), GIF_COMMENT, CLEAN_GIF.subarray(GIF_HEAD, -1)])],
        ['GIF: an unknown block introducer', Buffer.concat([CLEAN_GIF.subarray(0, GIF_HEAD), GIF_COMMENT, Buffer.from([0x99]), CLEAN_GIF.subarray(GIF_HEAD)])],
    ] as const) {
        assert(strip(bytes) === bytes, `${name}: the strip returns it as given`);
        assert(!storable(dataUrl('image/jpeg', bytes)) && !storable(bytes.toString('base64')) && !storable(bytes.toString('base64url'))
            && !storable(`?${bytes.toString('base64')}`),
            `${name}: refused as a data URL, as bare base64, URL-safe, and with a character the avatar route skips`);
    }
    for (const [name, value] of [
        ...([['camera JPEG', CAMERA_JPEG], ['padded camera JPEG', PADDED_CAMERA_JPEG], ['camera JPEG with no EOI', CAMERA_JPEG_NO_EOI],
            ['progressive camera JPEG', CAMERA_PROGRESSIVE_JPEG], ['camera PNG', CAMERA_PNG], ['camera WebP', CAMERA_WEBP], ['camera GIF', CAMERA_GIF],
            ['clean JPEG', CLEAN_JPEG], ['clean PNG', CLEAN_PNG], ['clean WebP', CLEAN_WEBP], ['clean GIF', CLEAN_GIF],
            ['the JFIF-only JPEG the image-store suites use', legacyTestJpeg],
            ['a clean PNG cut at a chunk boundary, nothing in it but the picture', CLEAN_PNG.subarray(0, CLEAN_PNG.length - IEND.length)],
        ] as const).map(([n, b]) => [n, dataUrl('image/jpeg', b)] as const),
        // What other suites post as placeholders: a PNG signature alone, and a JFIF header cut short.
        ['a PNG signature alone', 'data:image/png;base64,iVBORw0KGgo='], ['a JFIF header cut short', 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='],
        ['an empty data URL', 'data:image/jpeg;base64,'], ['null', null], ['nothing', ''], ['a bundled:// name', 'bundled://sprout'],
        ['an emoji', '🌾'], ['a link', 'https://example.org/me.jpg'], ['this node\'s avatar address', '/api/avatar/abcdef'],
        ['this node\'s post-photo address', `/api/marketplace/posts/${crypto.randomUUID()}/photos/0`],
    ] as const) {
        assert(storable(value), `stored: ${name}`);
    }
}

// ── Part 2: over HTTPS, signed as a member ────────────────────────────────────────────────────────

interface Identity { pub: string; priv: crypto.KeyObject }
function keypair(): Identity {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey };
}

async function signed(method: string, path: string, body: unknown, signer: Identity): Promise<{ status: number; json: any }> {
    const bodyString = method === 'GET' ? '' : JSON.stringify(body);
    const ts = String(Date.now());
    const nonce = crypto.randomUUID();
    const canonical = `${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`;
    const headers: Record<string, string> = {
        'X-Public-Key': signer.pub,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), signer.priv).toString('base64'),
        'X-Timestamp': ts,
        'X-Nonce': nonce,
    };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : bodyString });
    let json: any;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, json };
}

/** What an anonymous <img> gets. */
async function fetchBytes(path: string): Promise<{ status: number; bytes: Buffer; type: string }> {
    const res = await fetch(`${BASE}${path}`);
    return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') ?? '' };
}

const dataUrl = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString('base64')}`;
function decodeDataUrl(value: unknown): Buffer | null {
    const m = typeof value === 'string' ? value.match(/^data:[^;,]+;base64,([\s\S]*)$/) : null;
    return m ? Buffer.from(m[1], 'base64') : null;
}

/**
 * The image an avatar field stands for, however a route hands it out: a data URL or bare base64 (the stored value
 * as it is), or this node's avatar address (fetched, as an <img> would).
 */
async function avatarBytes(value: unknown): Promise<Buffer | null> {
    if (typeof value !== 'string' || !value) return null;
    if (/^\/api\/avatar\//.test(value)) return (await fetchBytes(value)).bytes;
    return decodeDataUrl(value) ?? Buffer.from(value, 'base64');
}

/** One served image checked against the clean image it must equal. */
async function served(name: string, bytes: Buffer | null, expected: Buffer): Promise<void> {
    if (!bytes) { assert(false, `${name}: nothing was served`); return; }
    assert(leak(bytes) === null, `${name}: no metadata served (${leak(bytes) ?? 'clean'})`);
    assert(bytes.equals(expected), `${name}: the bytes are exactly the clean image's (${bytes.length} served, ${expected.length} expected)`);
}

async function partTwo(): Promise<void> {
    await initTls();
    initStateEngine();
    initAdminPassword();
    const member = keypair();
    // Joined long ago with a photo and a name, so no new-account limit or profile gate is what answers.
    db.prepare(`INSERT INTO members (public_key, callsign, avatar_url, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, ?, 'active', '2025-01-01T00:00:00.000Z', 'genesis', 'genesis')`)
        .run(member.pub, `photo-${member.pub.slice(0, 6)}`, dataUrl('image/jpeg', CLEAN_JPEG));
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(member.pub);
    await startHttpsServer(PORT);

    console.log('\n── 2a. A post with a photo in each format: POST /api/marketplace/posts → GET …/photos/:n ──');
    const create = await signed('POST', '/api/marketplace/posts', {
        type: 'offer', category: 'other', title: 'Lemons from the tree', description: 'A bag of lemons', credits: 0, priceType: 'fixed',
        authorPublicKey: member.pub, lat: -37.06, lng: 144.21,
        photos: [dataUrl('image/jpeg', CAMERA_JPEG), dataUrl('image/png', CAMERA_PNG), dataUrl('image/webp', CAMERA_WEBP)],
    }, member);
    const postId = create.json?.post?.id as string | undefined;
    assert(create.status === 200 && !!postId, `the post is created (${create.status} ${create.json?.error ?? ''})`);
    if (postId) {
        const photos = [[CAMERA_JPEG_STRIPPED, 'image/jpeg'], [CLEAN_PNG, 'image/png'], [CAMERA_WEBP_STRIPPED, 'image/webp']] as const;
        for (const [n, [expected, mime]] of photos.entries()) {
            const got = await fetchBytes(`/api/marketplace/posts/${postId}/photos/${n}`);
            assert(got.status === 200 && got.type.startsWith(mime), `photo ${n} is served as ${mime} (${got.status} ${got.type})`);
            await served(`post photo ${n} (${mime})`, got.bytes, expected);
        }

        console.log('\n── 2b. Editing the post with a new photo: POST /api/marketplace/posts/update ──');
        const kept = create.json.post.photos[0] as string;
        const edit = await signed('POST', '/api/marketplace/posts/update', {
            id: postId, authorPublicKey: member.pub, photos: [kept, dataUrl('image/jpeg', CAMERA_PROGRESSIVE_JPEG)],
        }, member);
        assert(edit.status === 200, `the edit is saved (${edit.status} ${edit.json?.error ?? ''})`);
        await served('the photo the edit kept', (await fetchBytes(`/api/marketplace/posts/${postId}/photos/0`)).bytes, CAMERA_JPEG_STRIPPED);
        await served('the photo the edit added', (await fetchBytes(`/api/marketplace/posts/${postId}/photos/1`)).bytes, CLEAN_PROGRESSIVE_JPEG);
    }

    console.log('\n── 2c. An event\'s photo: POST /api/marketplace/posts (type event) ──');
    const event = await signed('POST', '/api/marketplace/posts', {
        type: 'event', category: 'community', title: 'Street party', credits: 0, priceType: 'fixed',
        authorPublicKey: member.pub, lat: -37.06, lng: 144.21, eventStartAt: new Date(Date.now() + 30 * 3600_000).toISOString(),
        photos: [dataUrl('image/jpeg', CAMERA_JPEG)],
    }, member);
    const eventId = event.json?.post?.id as string | undefined;
    assert(event.status === 200 && !!eventId, `the event is created (${event.status} ${event.json?.error ?? ''})`);
    if (eventId) await served('event photo', (await fetchBytes(`/api/marketplace/posts/${eventId}/photos/0`)).bytes, CAMERA_JPEG_STRIPPED);

    // The photo route serves the stored bytes under the declared type without looking at them, so bytes that are not
    // a picture the strip knows are refused, whatever the data URL says they are.
    const mislabelled = dataUrl('image/jpeg', CAMERA_HEIC);
    const heicPost = await signed('POST', '/api/marketplace/posts', {
        type: 'offer', category: 'other', title: 'Limes from the tree', description: 'A bag of limes', credits: 0, priceType: 'fixed',
        authorPublicKey: member.pub, lat: -37.06, lng: 144.21, photos: [dataUrl('image/jpeg', CLEAN_JPEG), mislabelled],
    }, member);
    assert(heicPost.status === 400, `a post photo whose bytes are a HEIC (GPS inside), labelled image/jpeg, is refused (${heicPost.status} ${heicPost.json?.error ?? ''})`);
    const textPost = await signed('POST', '/api/marketplace/posts', {
        type: 'offer', category: 'other', title: 'Figs from the tree', description: 'A bag of figs', credits: 0, priceType: 'fixed',
        authorPublicKey: member.pub, lat: -37.06, lng: 144.21, photos: [dataUrl('image/png', Buffer.from('plain text, not a picture'))],
    }, member);
    assert(textPost.status === 400, `and one whose bytes are no picture at all (${textPost.status} ${textPost.json?.error ?? ''})`);
    const heicEvent = await signed('POST', '/api/marketplace/posts', {
        type: 'event', category: 'community', title: 'Working bee', credits: 0, priceType: 'fixed',
        authorPublicKey: member.pub, lat: -37.06, lng: 144.21, eventStartAt: new Date(Date.now() + 30 * 3600_000).toISOString(),
        photos: [mislabelled],
    }, member);
    assert(heicEvent.status === 400, `and the same HEIC as an event's photo (${heicEvent.status} ${heicEvent.json?.error ?? ''})`);
    if (postId) {
        const heicEdit = await signed('POST', '/api/marketplace/posts/update', {
            id: postId, authorPublicKey: member.pub, photos: [`/api/marketplace/posts/${postId}/photos/0`, mislabelled],
        }, member);
        assert(heicEdit.status === 400, `and on an edit (${heicEdit.status} ${heicEdit.json?.error ?? ''})`);
        await served('the post photo after the refused edit', (await fetchBytes(`/api/marketplace/posts/${postId}/photos/0`)).bytes, CAMERA_JPEG_STRIPPED);
        const second = await fetchBytes(`/api/marketplace/posts/${postId}/photos/1`);
        assert(leak(second.bytes) === null && second.bytes.equals(CLEAN_PROGRESSIVE_JPEG), `the refused edit left the second photo as it was (${second.status})`);
    }

    console.log('\n── 2d. The member\'s own photo: POST /api/profile/update → GET /api/avatar/:pk ──');
    for (const [mime, camera, expected] of [
        ['image/jpeg', CAMERA_JPEG, CAMERA_JPEG_STRIPPED], ['image/png', CAMERA_PNG, CLEAN_PNG],
        ['image/webp', CAMERA_WEBP, CAMERA_WEBP_STRIPPED], ['image/gif', CAMERA_GIF, CAMERA_GIF_STRIPPED],
    ] as const) {
        const upd = await signed('POST', '/api/profile/update', { avatar: dataUrl(mime, camera) }, member);
        assert(upd.status === 200, `a ${mime} avatar is saved (${upd.status} ${upd.json?.error ?? ''})`);
        const got = await fetchBytes(`/api/avatar/${member.pub}`);
        assert(got.status === 200, `GET /api/avatar answers 200 for the ${mime} avatar (${got.status})`);
        await served(`member avatar (${mime})`, got.bytes, expected);
    }
    {
        const upd = await signed('POST', '/api/profile/update', { avatar: CAMERA_JPEG.toString('base64') }, member);
        assert(upd.status === 200, `a legacy bare-base64 avatar is saved (${upd.status} ${upd.json?.error ?? ''})`);
        await served('member avatar (legacy bare base64)', (await fetchBytes(`/api/avatar/${member.pub}`)).bytes, CAMERA_JPEG_STRIPPED);
    }

    console.log('\n── 2e. An enterprise, as the web app proposes one: POST /api/treasury → GET /api/avatar/<enterprise> ──');
    const ent = await signed('POST', '/api/treasury', {
        name: 'Shade House Co-op', purpose: 'We build a shade house', lifecycle: 'bounded', goalAmount: 500,
        photos: [dataUrl('image/jpeg', CAMERA_JPEG)], avatar: dataUrl('image/jpeg', CAMERA_JPEG),
    }, member);
    const entKey = ent.json?.publicKey as string | undefined;
    assert(ent.status === 200 && !!entKey, `the enterprise is created (${ent.status} ${ent.json?.error ?? ''})`);
    if (entKey) {
        await served('enterprise avatar', (await fetchBytes(`/api/avatar/${entKey}`)).bytes, CAMERA_JPEG_STRIPPED);
        const row = db.prepare('SELECT photos FROM projects WHERE id = ?').get(entKey) as { photos: string } | undefined;
        const stored = row ? (JSON.parse(row.photos) as unknown[]) : [];
        await served('the bounded enterprise\'s projects row', decodeDataUrl(stored[0]), CAMERA_JPEG_STRIPPED);
        const page = await signed('GET', `/api/enterprise/${entKey}`, undefined, member);
        assert(page.status === 200 && leak(Buffer.from(JSON.stringify(page.json ?? {}), 'latin1')) === null,
            `GET /api/enterprise/:id carries no metadata (${page.status})`);
        await served('GET /api/enterprise/:id avatarUrl (the stored value)', await avatarBytes(page.json?.avatarUrl), CAMERA_JPEG_STRIPPED);
    }
    const bareHeicEnt = await signed('POST', '/api/treasury', {
        name: 'Seed Bank Co-op', purpose: 'We keep seeds', lifecycle: 'bounded', goalAmount: 500,
        photos: [CAMERA_HEIC.toString('base64')],
    }, member);
    assert(bareHeicEnt.status === 400, `an enterprise photo sent as bare base64 of a HEIC (GPS inside) is refused, not stored (${bareHeicEnt.status})`);

    // The operator's form, POST /api/local/admin/treasury, writes the same members.avatar_url, and the enterprise
    // routes hand it out as stored (avatarUrl): the same photo rule, bare base64 included.
    const adminTreasury = async (name: string, avatar: string): Promise<{ status: number; json: any }> => {
        const res = await fetch(`${BASE}/api/local/admin/treasury`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Admin-Password': process.env.ADMIN_PASSWORD! },
            body: JSON.stringify({ name, avatar }),
        });
        return { status: res.status, json: await res.json().catch(() => null) };
    };
    const adminHeic = await adminTreasury('Tool Shed Co-op', CAMERA_HEIC.toString('base64'));
    assert(adminHeic.status === 400, `the operator's enterprise form refuses a HEIC sent as bare base64 (${adminHeic.status} ${adminHeic.json?.error ?? ''})`);
    const adminText = await adminTreasury('Bee Keepers Co-op', Buffer.from('plain text, not a picture').toString('base64'));
    assert(adminText.status === 400, `and bare base64 that is no picture at all (${adminText.status} ${adminText.json?.error ?? ''})`);
    const adminBare = await adminTreasury('Orchard Co-op', CAMERA_JPEG.toString('base64'));
    const adminKey = adminBare.json?.publicKey as string | undefined;
    assert(adminBare.status === 200 && !!adminKey, `the operator's enterprise with a bare-base64 camera JPEG is created (${adminBare.status} ${adminBare.json?.error ?? ''})`);
    if (adminKey) {
        await served('the operator\'s enterprise, GET /api/avatar', (await fetchBytes(`/api/avatar/${adminKey}`)).bytes, CAMERA_JPEG_STRIPPED);
        const detail = await signed('GET', `/api/enterprise/${adminKey}`, undefined, member);
        await served('the operator\'s enterprise, GET /api/enterprise/:id avatarUrl', await avatarBytes(detail.json?.avatarUrl), CAMERA_JPEG_STRIPPED);
        const list = await signed('GET', '/api/enterprises', undefined, member);
        const row = (list.json?.treasuries as any[] | undefined)?.find(t => t.publicKey === adminKey);
        await served('the operator\'s enterprise, GET /api/enterprises avatarUrl', await avatarBytes(row?.avatarUrl), CAMERA_JPEG_STRIPPED);
    }
    const adminBundled = await adminTreasury('Sprout Co-op', 'bundled://sprout');
    assert(adminBundled.status === 200, `a bundled:// avatar still passes the operator's form (${adminBundled.status} ${adminBundled.json?.error ?? ''})`);

    console.log('\n── 2f. A crowdfund project: POST /api/crowdfund/projects (+ /update) → GET /api/crowdfund/projects/:id and /api/avatar ──');
    const projectId = crypto.randomUUID();
    const proj = await signed('POST', '/api/crowdfund/projects', {
        id: projectId, title: 'Community oven', description: 'A wood-fired oven', goalAmount: 300,
        photos: [dataUrl('image/jpeg', CAMERA_JPEG), dataUrl('image/png', CAMERA_PNG)],
    }, member);
    assert(proj.status === 200, `the project is created (${proj.status} ${proj.json?.error ?? ''})`);
    const projectPhotos = async (): Promise<unknown[]> => {
        const res = await fetch(`${BASE}/api/crowdfund/projects/${projectId}`);
        const body = await res.json().catch(() => null) as any;
        const photos = body?.photos ?? body?.project?.photos;
        return typeof photos === 'string' ? JSON.parse(photos) : (Array.isArray(photos) ? photos : []);
    };
    let listed = await projectPhotos();
    await served('crowdfund photo 0, as the public project route serves it', decodeDataUrl(listed[0]), CAMERA_JPEG_STRIPPED);
    await served('crowdfund photo 1, as the public project route serves it', decodeDataUrl(listed[1]), CLEAN_PNG);
    await served('crowdfund project avatar', (await fetchBytes(`/api/avatar/${projectId}`)).bytes, CAMERA_JPEG_STRIPPED);
    const projUpd = await signed('POST', '/api/crowdfund/projects/update', {
        id: projectId, title: 'Community oven', description: 'A wood-fired oven', goalAmount: 300,
        photos: [dataUrl('image/webp', CAMERA_WEBP)],
    }, member);
    assert(projUpd.status === 200, `the project edit is saved (${projUpd.status} ${projUpd.json?.error ?? ''})`);
    listed = await projectPhotos();
    await served('crowdfund photo after the edit', decodeDataUrl(listed[0]), CAMERA_WEBP_STRIPPED);
    await served('crowdfund project avatar after the edit', (await fetchBytes(`/api/avatar/${projectId}`)).bytes, CAMERA_WEBP_STRIPPED);
    const heicProject = await signed('POST', '/api/crowdfund/projects', {
        id: crypto.randomUUID(), title: 'Tool library', description: 'Shared tools', goalAmount: 200,
        photos: [dataUrl('image/jpeg', CLEAN_JPEG), dataUrl('image/heic', CAMERA_HEIC)],
    }, member);
    assert(heicProject.status === 400, `a second photo the node cannot strip (a HEIC, GPS inside) is refused, not stored (${heicProject.status})`);
    const heicEdit = await signed('POST', '/api/crowdfund/projects/update', {
        id: projectId, title: 'Community oven', description: 'A wood-fired oven', goalAmount: 300,
        photos: [dataUrl('image/webp', CAMERA_WEBP), dataUrl('image/heic', CAMERA_HEIC)],
    }, member);
    assert(heicEdit.status === 400, `the same HEIC is refused on an edit (${heicEdit.status})`);
    listed = await projectPhotos();
    assert(listed.length === 1 && leak(Buffer.from(JSON.stringify(listed), 'latin1')) === null, 'the refused edit left the project as it was');
    const bareHeicProject = await signed('POST', '/api/crowdfund/projects', {
        id: crypto.randomUUID(), title: 'Seed library', description: 'Shared seeds', goalAmount: 200,
        photos: [dataUrl('image/jpeg', CLEAN_JPEG), CAMERA_HEIC.toString('base64')],
    }, member);
    assert(bareHeicProject.status === 400, `a HEIC sent as bare base64, no data: prefix, is refused too (${bareHeicProject.status})`);
    const bareHeicEdit = await signed('POST', '/api/crowdfund/projects/update', {
        id: projectId, title: 'Community oven', description: 'A wood-fired oven', goalAmount: 300,
        photos: [dataUrl('image/webp', CAMERA_WEBP), CAMERA_HEIC.toString('base64url')],
    }, member);
    assert(bareHeicEdit.status === 400, `and on an edit, in URL-safe base64 (${bareHeicEdit.status})`);
    listed = await projectPhotos();
    assert(listed.length === 1 && leak(Buffer.from(JSON.stringify(listed), 'latin1')) === null, 'the refused bare edit left the project as it was');
    // What an editor that loaded the project sends back: this node's own avatar address as photos[0], which means
    // "unchanged". Not image bytes, so still accepted, beside a bare photo that is stripped.
    const selfUrlEdit = await signed('POST', '/api/crowdfund/projects/update', {
        id: projectId, title: 'Community oven', description: 'A wood-fired oven', goalAmount: 300,
        photos: [`/api/avatar/${projectId}`, CAMERA_JPEG.toString('base64url')],
    }, member);
    assert(selfUrlEdit.status === 200, `an edit sending back the node's own avatar address and a bare photo is saved (${selfUrlEdit.status} ${selfUrlEdit.json?.error ?? ''})`);
    listed = await projectPhotos();
    assert(listed[0] === `/api/avatar/${projectId}`, 'the avatar address is kept as sent');
    await served('crowdfund photo sent as bare URL-safe base64', typeof listed[1] === 'string' ? Buffer.from(listed[1], 'base64') : null, CAMERA_JPEG_STRIPPED);
    await served('crowdfund project avatar after the address edit (unchanged)', (await fetchBytes(`/api/avatar/${projectId}`)).bytes, CAMERA_WEBP_STRIPPED);

    console.log('\n── 2g. A group\'s picture: POST /api/groups, PATCH /api/groups/:id → GET /api/groups/:id ──');
    const group = await signed('POST', '/api/groups', {
        name: 'Seed Savers', description: 'We swap seeds', joinPolicy: 'open', avatarUrl: dataUrl('image/jpeg', CAMERA_JPEG),
    }, member);
    const groupId = group.json?.id as string | undefined;
    assert(group.status === 201 && !!groupId, `the group is created (${group.status} ${group.json?.error ?? ''})`);
    if (groupId) {
        let read = await signed('GET', `/api/groups/${groupId}`, undefined, member);
        await served('group picture', decodeDataUrl(read.json?.avatarUrl), CAMERA_JPEG_STRIPPED);
        const patch = await signed('PATCH', `/api/groups/${groupId}`, { avatarUrl: dataUrl('image/png', CAMERA_PNG) }, member);
        assert(patch.status === 200, `the group picture is changed (${patch.status} ${patch.json?.error ?? ''})`);
        read = await signed('GET', `/api/groups/${groupId}`, undefined, member);
        await served('group picture after the edit', decodeDataUrl(read.json?.avatarUrl), CLEAN_PNG);
        const heicPatch = await signed('PATCH', `/api/groups/${groupId}`, { avatarUrl: dataUrl('image/heic', CAMERA_HEIC) }, member);
        assert(heicPatch.status === 400, `a group picture the node cannot strip (a HEIC, GPS inside) is refused (${heicPatch.status})`);
        read = await signed('GET', `/api/groups/${groupId}`, undefined, member);
        await served('group picture after the refused edit', decodeDataUrl(read.json?.avatarUrl), CLEAN_PNG);
        const bareHeicPatch = await signed('PATCH', `/api/groups/${groupId}`, { avatarUrl: CAMERA_HEIC.toString('base64') }, member);
        assert(bareHeicPatch.status === 400, `a group picture sent as bare base64 of a HEIC is refused (${bareHeicPatch.status})`);
        read = await signed('GET', `/api/groups/${groupId}`, undefined, member);
        await served('group picture after the refused bare edit', decodeDataUrl(read.json?.avatarUrl), CLEAN_PNG);
    }
    const heicGroup = await signed('POST', '/api/groups', {
        name: 'Bike Kitchen', description: 'We fix bikes', joinPolicy: 'open', avatarUrl: dataUrl('image/heic', CAMERA_HEIC),
    }, member);
    assert(heicGroup.status === 400, `a new group with a HEIC picture is refused (${heicGroup.status})`);
    const bareHeicGroup = await signed('POST', '/api/groups', {
        name: 'Repair Cafe', description: 'We mend things', joinPolicy: 'open', avatarUrl: CAMERA_HEIC.toString('base64'),
    }, member);
    assert(bareHeicGroup.status === 400, `and one whose HEIC picture is bare base64 (${bareHeicGroup.status})`);

    console.log('\n── 2h. The operator\'s pricing-guide thumbnail: POST /api/pricing-guide/admin/item → GET /api/pricing-guide ──');
    const saved = await fetch(`${BASE}/api/pricing-guide/admin/item`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Password': process.env.ADMIN_PASSWORD! },
        body: JSON.stringify({
            id: 'custom-photo-meta', category: 'food', emoji: '🍋', name: 'Lemons (bag)', priceBeans: 5,
            thumbnailUrl: dataUrl('image/jpeg', CAMERA_JPEG),
        }),
    });
    assert(saved.status === 200, `the operator saves an item with a camera photo as its thumbnail (${saved.status})`);
    const guide = await signed('GET', '/api/pricing-guide', undefined, member);
    const item = (guide.json?.items as any[] | undefined)?.find(i => i.id === 'custom-photo-meta');
    await served('pricing-guide thumbnail', decodeDataUrl(item?.thumbnailUrl), CAMERA_JPEG_STRIPPED);
    const saveThumbnail = (thumbnailUrl: string) => fetch(`${BASE}/api/pricing-guide/admin/item`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Password': process.env.ADMIN_PASSWORD! },
        body: JSON.stringify({ id: 'custom-photo-meta', category: 'food', emoji: '🍋', name: 'Lemons (bag)', priceBeans: 5, thumbnailUrl }),
    });
    for (const [label, value] of [
        ['a HEIC (GPS inside) as a data URL', dataUrl('image/heic', CAMERA_HEIC)], ['a HEIC as bare base64', CAMERA_HEIC.toString('base64')],
    ] as const) {
        const res = await saveThumbnail(value);
        assert(res.status === 400, `${label} is refused as a pricing-guide thumbnail (${res.status})`);
    }
    const kept = ((await signed('GET', '/api/pricing-guide', undefined, member)).json?.items as any[] | undefined)?.find(i => i.id === 'custom-photo-meta');
    await served('the pricing-guide thumbnail after the refusals', decodeDataUrl(kept?.thumbnailUrl), CAMERA_JPEG_STRIPPED);
    const link = await saveThumbnail('https://example.org/lemons.jpg');
    assert(link.status === 200, `a link as the thumbnail still passes (${link.status})`);

    console.log('\n── 2i. A member\'s photo as other members read it: POST /api/profile/update → groups, profile, chats ──');
    // members.avatar_url is not only served by /api/avatar/:pk, which sniffs. The group, group-members and profile
    // routes hand it out exactly as stored; the chats turn it into an avatar address. A second member reads each.
    const reader = keypair();
    db.prepare(`INSERT INTO members (public_key, callsign, avatar_url, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, ?, 'active', '2025-01-01T00:00:00.000Z', 'genesis', 'genesis')`)
        .run(reader.pub, `reader-${reader.pub.slice(0, 6)}`, dataUrl('image/jpeg', CLEAN_JPEG));
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(reader.pub);
    const storedAvatar = () => (db.prepare('SELECT avatar_url FROM members WHERE public_key = ?').get(member.pub) as { avatar_url: string | null }).avatar_url;

    const bare = await signed('POST', '/api/profile/update', { avatar: CAMERA_JPEG.toString('base64') }, member);
    assert(bare.status === 200, `a camera JPEG sent as bare base64 is saved (${bare.status} ${bare.json?.error ?? ''})`);
    await served('the stored member avatar', await avatarBytes(storedAvatar()), CAMERA_JPEG_STRIPPED);

    const open = await signed('POST', '/api/groups', { name: 'Lemon Growers', description: 'We grow lemons', joinPolicy: 'open' }, member);
    const openId = open.json?.id as string | undefined;
    assert(open.status === 201 && !!openId, `an open group is created (${open.status} ${open.json?.error ?? ''})`);
    const invited = await signed('POST', '/api/groups', { name: 'Orchard Keepers', description: 'We keep an orchard', joinPolicy: 'invite_only' }, member);
    const invitedId = invited.json?.id as string | undefined;
    assert(invited.status === 201 && !!invitedId, `an invite-only group is created (${invited.status} ${invited.json?.error ?? ''})`);
    if (openId) {
        const join = await signed('POST', `/api/groups/${openId}/join`, {}, reader);
        assert(join.status === 200, `the reader joins the open group (${join.status} ${join.json?.error ?? ''})`);
        const line = await signed('POST', `/api/groups/${openId}/chat/message`, { text: 'The lemons are ripe' }, member);
        assert(line.status === 200 || line.status === 201, `the member writes in the group chat (${line.status} ${line.json?.error ?? ''})`);
    }
    if (invitedId) {
        const invite = await signed('POST', `/api/groups/${invitedId}/members`, { targetPubkey: reader.pub }, member);
        assert(invite.status === 200, `the member invites the reader (${invite.status} ${invite.json?.error ?? ''})`);
    }
    if (eventId) {
        const going = await signed('POST', `/api/marketplace/posts/${eventId}/rsvp`, { status: 'going' }, reader);
        assert(going.status === 200, `the reader is going to the event (${going.status} ${going.json?.error ?? ''})`);
        const line = await signed('POST', `/api/marketplace/posts/${eventId}/chat/message`, { text: 'Bring a plate' }, member);
        assert(line.status === 200 || line.status === 201, `the host writes in the event chat (${line.status} ${line.json?.error ?? ''})`);
    }

    /** Every route that shows the member's photo to the reader, with the value it shows. */
    const readsOfTheMember = async (): Promise<Array<[string, unknown]>> => {
        const fromAuthor = (json: any) => (json?.messages as any[] | undefined)?.find(m => m.authorPubkey === member.pub)?.authorAvatar;
        return [
            ['GET /api/groups/:id convenorAvatarUrl', openId && (await signed('GET', `/api/groups/${openId}`, undefined, reader)).json?.convenorAvatarUrl],
            ['GET /api/groups/:id viewerInvitedBy.avatarUrl', invitedId && (await signed('GET', `/api/groups/${invitedId}`, undefined, reader)).json?.viewerInvitedBy?.avatarUrl],
            ['GET /api/groups/:id/members avatarUrl', openId && ((await signed('GET', `/api/groups/${openId}/members`, undefined, reader)).json as any[] | undefined)
                ?.find(m => m.memberPubkey === member.pub)?.avatarUrl],
            ['GET /api/profile/:publicKey avatar', (await signed('GET', `/api/profile/${member.pub}`, undefined, reader)).json?.avatar],
            ['GET /api/groups/:id/chat authorAvatar', openId && fromAuthor((await signed('GET', `/api/groups/${openId}/chat`, undefined, reader)).json)],
            ['GET /api/marketplace/posts/:id/chat authorAvatar', eventId && fromAuthor((await signed('GET', `/api/marketplace/posts/${eventId}/chat`, undefined, reader)).json)],
            ['GET /api/avatar/:pk', `/api/avatar/${member.pub}`],
        ];
    };
    for (const [route, value] of await readsOfTheMember()) await served(`the member's photo, as ${route} shows it`, await avatarBytes(value), CAMERA_JPEG_STRIPPED);

    // Not a JPEG, PNG, WebP or GIF: refused with a plain 400, and the photo already stored stays. The HEIC comes last,
    // so on a node that stored it the reads below show its GPS.
    for (const [label, value] of [
        ['bare base64 that is no picture at all', Buffer.from('plain text, not a picture').toString('base64')],
        ['a HEIC (GPS inside) as bare URL-safe base64', CAMERA_HEIC.toString('base64url')],
        ['a HEIC (GPS inside) as a data URL', dataUrl('image/heic', CAMERA_HEIC)],
        ['a HEIC (GPS inside) as bare base64', CAMERA_HEIC.toString('base64')],
    ] as const) {
        const before = storedAvatar();
        const upd = await signed('POST', '/api/profile/update', { avatar: value, bio: 'Lemons and limes' }, member);
        assert(upd.status === 400 && upd.json?.error === 'avatar_invalid', `${label} is refused as a member's photo (${upd.status} ${upd.json?.error ?? ''})`);
        assert(storedAvatar() === before, `${label}: the stored photo is unchanged`);
    }
    for (const [route, value] of await readsOfTheMember()) await served(`after the refusals, ${route}`, await avatarBytes(value), CAMERA_JPEG_STRIPPED);

    // What the apps send besides a new photo passes as it always has: this node's own avatar address (an editor that
    // loaded the profile sends it back, and it means "unchanged") and a bundled:// name.
    for (const address of [`/api/avatar/${member.pub}?size=thumb&v=1`, `${BASE}/api/avatar/${member.pub}`]) {
        const upd = await signed('POST', '/api/profile/update', { avatar: address }, member);
        assert(upd.status === 200, `this node's avatar address ${address.startsWith('/') ? '(relative)' : '(absolute)'} is accepted (${upd.status} ${upd.json?.error ?? ''})`);
        await served(`after sending back the ${address.startsWith('/') ? 'relative' : 'absolute'} address, the stored photo`, await avatarBytes(storedAvatar()), CAMERA_JPEG_STRIPPED);
    }
    const bundled = await signed('POST', '/api/profile/update', { avatar: 'bundled://sprout' }, member);
    assert(bundled.status === 200 && storedAvatar() === 'bundled://sprout', `a bundled:// avatar is accepted and stored as sent (${bundled.status} ${bundled.json?.error ?? ''})`);

    console.log('\n── 2j. The two camera defects decoders accept, through a profile, a post and an enterprise; and a JPEG no walk can read ──');
    for (const [label, camera, expected, tag] of [
        ['two extraneous bytes after its Exif', PADDED_CAMERA_JPEG, CAMERA_JPEG_STRIPPED, 'Padded'],
        ['no EOI after its scan', CAMERA_JPEG_NO_EOI, CAMERA_JPEG_NO_EOI_STRIPPED, 'Cut'],
    ] as const) {
        const upd = await signed('POST', '/api/profile/update', { avatar: dataUrl('image/jpeg', camera) }, member);
        assert(upd.status === 200, `a member's photo with ${label} is saved (${upd.status} ${upd.json?.error ?? ''})`);
        await served(`the member's photo with ${label}, GET /api/avatar/:pk`, (await fetchBytes(`/api/avatar/${member.pub}`)).bytes, expected);
        await served(`the member's photo with ${label}, as stored and handed out`, await avatarBytes(storedAvatar()), expected);

        const post = await signed('POST', '/api/marketplace/posts', {
            type: 'offer', category: 'other', title: `${tag} pears from the tree`, description: 'A bag of pears', credits: 0, priceType: 'fixed',
            authorPublicKey: member.pub, lat: -37.06, lng: 144.21, photos: [dataUrl('image/jpeg', camera)],
        }, member);
        const id = post.json?.post?.id as string | undefined;
        assert(post.status === 200 && !!id, `a post photo with ${label} is saved (${post.status} ${post.json?.error ?? ''})`);
        if (id) await served(`the post photo with ${label}, GET …/photos/0`, (await fetchBytes(`/api/marketplace/posts/${id}/photos/0`)).bytes, expected);

        const ent = await signed('POST', '/api/treasury', {
            name: `${tag} Orchard Co-op`, purpose: 'We grow pears', lifecycle: 'bounded', goalAmount: 500, avatar: dataUrl('image/jpeg', camera),
        }, member);
        const key = ent.json?.publicKey as string | undefined;
        assert(ent.status === 200 && !!key, `an enterprise photo with ${label} is saved (${ent.status} ${ent.json?.error ?? ''})`);
        if (key) {
            await served(`the enterprise photo with ${label}, GET /api/avatar/<enterprise>`, (await fetchBytes(`/api/avatar/${key}`)).bytes, expected);
            const row = db.prepare('SELECT photos FROM projects WHERE id = ?').get(key) as { photos: string } | undefined;
            await served(`the enterprise photo with ${label}, its projects row`, decodeDataUrl(row ? JSON.parse(row.photos)[0] : null), expected);
        }
    }

    // Not walkable, so the strip cannot take its Exif off: refused with a plain 400, and nothing is stored.
    const avatarBefore = storedAvatar();
    for (const [label, value] of [
        ['a JPEG with a second SOI after its Exif, as a data URL', dataUrl('image/jpeg', UNWALKABLE_CAMERA_JPEG)],
        ['the same as bare base64', UNWALKABLE_CAMERA_JPEG.toString('base64')],
        ['a JPEG cut short before its scan, Exif and all', dataUrl('image/jpeg', CAMERA_JPEG.subarray(0, firstScanData(CAMERA_JPEG) - 20))],
    ] as const) {
        const upd = await signed('POST', '/api/profile/update', { avatar: value }, member);
        assert(upd.status === 400 && upd.json?.error === 'avatar_invalid', `${label} is refused as a member's photo (${upd.status} ${upd.json?.error ?? ''})`);
        assert(storedAvatar() === avatarBefore, `${label}: the stored photo is unchanged`);
    }
    const refusedPost = await signed('POST', '/api/marketplace/posts', {
        type: 'offer', category: 'other', title: 'Quinces from the tree', description: 'A bag of quinces', credits: 0, priceType: 'fixed',
        authorPublicKey: member.pub, lat: -37.06, lng: 144.21, photos: [dataUrl('image/jpeg', CLEAN_JPEG), dataUrl('image/jpeg', UNWALKABLE_CAMERA_JPEG)],
    }, member);
    assert(refusedPost.status === 400, `the same JPEG as a post's second photo is refused (${refusedPost.status} ${refusedPost.json?.error ?? ''})`);
    assert((db.prepare('SELECT COUNT(*) AS n FROM posts WHERE title = ?').get('Quinces from the tree') as { n: number }).n === 0, 'and no post is stored');
    const refusedEnt = await signed('POST', '/api/treasury', {
        name: 'Quince Co-op', purpose: 'We grow quinces', lifecycle: 'bounded', goalAmount: 500, avatar: dataUrl('image/jpeg', UNWALKABLE_CAMERA_JPEG),
    }, member);
    assert(refusedEnt.status === 400, `and as an enterprise's photo (${refusedEnt.status} ${refusedEnt.json?.error ?? ''})`);
    assert((db.prepare('SELECT COUNT(*) AS n FROM members WHERE callsign = ?').get('Quince Co-op') as { n: number }).n === 0, 'and no enterprise is stored');

    console.log('\n── 2k. A pricing-guide item saved back with its own photo link: GET /api/pricing-guide → POST …/admin/item ──');
    // The aggregator gives an item its matching listing's first photo, as this node's address for it: a string made
    // only of base64 characters, which the bare-base64 photo rule read as a picture and refused.
    const listing = await signed('POST', '/api/marketplace/posts', {
        type: 'offer', category: 'other', title: 'Lemons (bag) from the tree', description: 'Picked this morning', credits: 5, priceType: 'fixed',
        authorPublicKey: member.pub, lat: -37.06, lng: 144.21, photos: [dataUrl('image/jpeg', CLEAN_JPEG)],
    }, member);
    const listingId = listing.json?.post?.id as string | undefined;
    assert(listing.status === 200 && !!listingId, `a listing that matches the item is created (${listing.status} ${listing.json?.error ?? ''})`);
    runPricingAggregationCycle();
    const guideItem = async () => ((await signed('GET', '/api/pricing-guide', undefined, member)).json?.items as any[] | undefined)?.find(i => i.id === 'custom-photo-meta');
    const readBack = await guideItem();
    const photoLink = `/api/marketplace/posts/${listingId}/photos/0`;
    assert(readBack?.thumbnailUrl === photoLink, `the aggregator gave the item the listing's photo link (${readBack?.thumbnailUrl})`);
    if (readBack) {
        const { id, category, emoji, name, description, priceBeans, unit, isPinned, seasonalityHint, thumbnailUrl } = readBack;
        const resaved = await fetch(`${BASE}/api/pricing-guide/admin/item`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Admin-Password': process.env.ADMIN_PASSWORD! },
            body: JSON.stringify({ id, category, emoji, name, description, priceBeans: priceBeans + 1, unit, isPinned: true, seasonalityHint, thumbnailUrl }),
        });
        assert(resaved.status === 200, `the item, read back and saved with a new price and its own photo link, is saved (${resaved.status})`);
        const after = await guideItem();
        assert(after?.priceBeans === priceBeans + 1 && after?.isPinned === true, `the new price and pin are saved (${after?.priceBeans}, ${after?.isPinned})`);
        assert(after?.thumbnailUrl === photoLink, `the photo link is kept (${after?.thumbnailUrl})`);
    }
    for (const link of [`${photoLink}?v=1`, `${BASE}${photoLink}`]) {
        const res = await saveThumbnail(link);
        assert(res.status === 200, `this node's photo link ${link.startsWith('/') ? 'with its ?v=' : 'as an absolute address'} is saved as a thumbnail (${res.status})`);
    }
    const refusedThumb = await saveThumbnail(dataUrl('image/jpeg', UNWALKABLE_CAMERA_JPEG));
    assert(refusedThumb.status === 400, `a JPEG no walk can read is refused as a thumbnail (${refusedThumb.status})`);
}

async function main(): Promise<void> {
    console.log('\n=== No location or camera metadata leaves a node (G9a-3) ===');
    // Imported here rather than at the top so Part 2 still runs — and shows the leak itself — on a build
    // that does not have the strip yet.
    let strip: StripModule | null = null;
    try {
        strip = await import('./storage/image-metadata.js');
    } catch (e) {
        assert(false, `storage/image-metadata.ts loads (${(e as Error).message})`);
    }
    if (strip) await partOne(strip);
    await partTwo();

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

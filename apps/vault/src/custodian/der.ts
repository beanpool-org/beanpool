/**
 * A small DER reader for the two AMD documents the chip check reads beyond what Node's X509Certificate shows: a VCEK's
 * own extensions (which chip and which firmware levels it was made for) and AMD's revocation list (vault comeback
 * design §2.3 rows 8 and 9). Node's crypto does every signature; this only finds bytes.
 *
 * Strict on purpose: definite lengths in their shortest form, low tag numbers, every length inside its parent. The
 * input can come from the vault's host (its certificate table) or the network, so anything else throws, and the chip
 * check turns a throw into a refusal.
 */

export class DerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DerError';
    }
}

export interface DerNode {
    /** The identifier byte as written (class, constructed bit and tag number). */
    tag: number;
    /** The whole element: identifier, length and content. */
    raw: Buffer;
    content: Buffer;
}

export const TAG = {
    BOOLEAN: 0x01,
    INTEGER: 0x02,
    BIT_STRING: 0x03,
    OCTET_STRING: 0x04,
    OID: 0x06,
    IA5_STRING: 0x16,
    UTC_TIME: 0x17,
    GENERALIZED_TIME: 0x18,
    SEQUENCE: 0x30,
} as const;

/** The element that starts at `offset`, which must end inside `buf`. */
export function readDer(buf: Buffer, offset = 0): DerNode {
    if (offset + 2 > buf.length) throw new DerError('a DER element is cut short');
    const tag = buf[offset];
    if ((tag & 0x1f) === 0x1f) throw new DerError('a DER tag number this reader does not take');
    const first = buf[offset + 1];
    let len: number;
    let header: number;
    if (first < 0x80) {
        len = first;
        header = 2;
    } else {
        const n = first & 0x7f;
        if (n === 0 || n > 4) throw new DerError('a DER length this reader does not take');
        if (offset + 2 + n > buf.length) throw new DerError('a DER length is cut short');
        len = 0;
        for (let i = 0; i < n; i++) len = len * 256 + buf[offset + 2 + i];
        if (buf[offset + 2] === 0 || len < 0x80) throw new DerError('a DER length not in its shortest form');
        header = 2 + n;
    }
    const end = offset + header + len;
    if (end > buf.length) throw new DerError('a DER element runs past its parent');
    return { tag, raw: buf.subarray(offset, end), content: buf.subarray(offset + header, end) };
}

/** One element filling all of `buf`, nothing after it. */
export function readDerExact(buf: Buffer): DerNode {
    const node = readDer(buf, 0);
    if (node.raw.length !== buf.length) throw new DerError('bytes after the DER element');
    return node;
}

/** The elements inside a constructed one. */
export function children(node: DerNode): DerNode[] {
    if (!(node.tag & 0x20)) throw new DerError('a DER element without parts where parts are expected');
    const out: DerNode[] = [];
    let at = 0;
    while (at < node.content.length) {
        const child = readDer(node.content, at);
        out.push(child);
        at += child.raw.length;
    }
    return out;
}

export function expectTag(node: DerNode | undefined, tag: number, what: string): DerNode {
    if (!node || node.tag !== tag) throw new DerError(`${what} is not where it should be`);
    return node;
}

/** A non-negative INTEGER up to 2^48, as a number. */
export function derSmallUint(node: DerNode): number {
    expectTag(node, TAG.INTEGER, 'an INTEGER');
    const c = node.content;
    if (!c.length || c[0] & 0x80) throw new DerError('a negative or empty INTEGER');
    if (c.length > 1 && c[0] === 0 && !(c[1] & 0x80)) throw new DerError('an INTEGER not in its shortest form');
    const digits = c[0] === 0 && c.length > 1 ? c.subarray(1) : c;
    if (digits.length > 6) throw new DerError('an INTEGER too large for this reader');
    return digits.reduce((n, b) => n * 256 + b, 0);
}

/** An INTEGER's magnitude as lower-case hex, without the leading zero a positive value may carry. */
export function derUintHex(node: DerNode): string {
    expectTag(node, TAG.INTEGER, 'an INTEGER');
    const c = node.content;
    if (!c.length || c[0] & 0x80) throw new DerError('a negative or empty INTEGER');
    return (c[0] === 0 && c.length > 1 ? c.subarray(1) : c).toString('hex');
}

/** UTCTime (YYMMDDHHMMSSZ) or GeneralizedTime (YYYYMMDDHHMMSSZ), in ms since the epoch. */
export function derTime(node: DerNode): number {
    const s = node.content.toString('latin1');
    let m: RegExpMatchArray | null;
    let year: number;
    if (node.tag === TAG.UTC_TIME && (m = s.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/))) {
        const yy = Number(m[1]);
        year = yy >= 50 ? 1900 + yy : 2000 + yy;
    } else if (node.tag === TAG.GENERALIZED_TIME && (m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/))) {
        year = Number(m[1]);
    } else {
        throw new DerError('a time this reader does not take');
    }
    const [mo, d, h, mi, se] = m.slice(2).map(Number);
    const t = Date.UTC(year, mo - 1, d, h, mi, se);
    const back = new Date(t);
    if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || h > 23 || mi > 59 || se > 59) throw new DerError('a time that is no date');
    return t;
}

/** The DER content of an OBJECT IDENTIFIER, from its dotted form (for comparing). */
export function oidBytes(dotted: string): Buffer {
    const parts = dotted.split('.').map(Number);
    const out = [parts[0] * 40 + parts[1]];
    for (const p of parts.slice(2)) {
        const groups = [p & 0x7f];
        for (let v = Math.floor(p / 128); v > 0; v = Math.floor(v / 128)) groups.unshift((v & 0x7f) | 0x80);
        out.push(...groups);
    }
    return Buffer.from(out);
}

// ─── Certificates and revocation lists ───────────────────────────────────────────────────────

/** A certificate's extensions by OID (dotted), each its extnValue's content. A repeated OID throws. */
export function certExtensions(certDer: Buffer): Map<string, Buffer> {
    const cert = expectTag(readDerExact(certDer), TAG.SEQUENCE, 'the certificate');
    const tbs = expectTag(children(cert)[0], TAG.SEQUENCE, 'the certificate body');
    const wrapped = children(tbs).find(c => c.tag === 0xa3);
    const out = new Map<string, Buffer>();
    if (!wrapped) return out;
    const list = expectTag(children(wrapped)[0], TAG.SEQUENCE, 'the extension list');
    for (const ext of children(list)) {
        const parts = children(expectTag(ext, TAG.SEQUENCE, 'an extension'));
        const oid = expectTag(parts[0], TAG.OID, 'an extension\'s name');
        const value = expectTag(parts[parts.length - 1], TAG.OCTET_STRING, 'an extension\'s value');
        if (parts.length === 3) expectTag(parts[1], TAG.BOOLEAN, 'an extension\'s critical flag');
        else if (parts.length !== 2) throw new DerError('an extension with the wrong number of parts');
        const key = oid.content.toString('hex');
        if (out.has(key)) throw new DerError('a certificate with the same extension twice');
        out.set(key, value.content);
    }
    return out;
}

/** A certificate body's parts from the serial number on: serial, signature, issuer, validity, subject, key, ... */
function certBody(certDer: Buffer): DerNode[] {
    const cert = expectTag(readDerExact(certDer), TAG.SEQUENCE, 'the certificate');
    const parts = children(expectTag(children(cert)[0], TAG.SEQUENCE, 'the certificate body'));
    return parts[0]?.tag === 0xa0 ? parts.slice(1) : parts;
}

/** The DER of a certificate's subject Name (to compare a revocation list's issuer with it). */
export function certSubject(certDer: Buffer): Buffer {
    return expectTag(certBody(certDer)[4], TAG.SEQUENCE, 'the certificate\'s subject').raw;
}

/** A certificate's validity, in ms since the epoch. */
export function certValidity(certDer: Buffer): { notBefore: number; notAfter: number } {
    const [notBefore, notAfter, ...rest] = children(expectTag(certBody(certDer)[3], TAG.SEQUENCE, 'the certificate\'s validity'));
    if (!notBefore || !notAfter || rest.length) throw new DerError('a validity with the wrong number of parts');
    return { notBefore: derTime(notBefore), notAfter: derTime(notAfter) };
}

export interface Crl {
    /** The signed part, exactly as written. */
    tbs: Buffer;
    /** The signature algorithm's DER (outer), and the inner one in the signed part: they must be the same. */
    signatureAlgorithm: Buffer;
    innerAlgorithm: Buffer;
    signature: Buffer;
    issuer: Buffer;
    thisUpdate: number;
    nextUpdate: number | null;
    /** Revoked serial numbers, lower-case hex without leading zeros. */
    revoked: string[];
}

/** RFC 5280 §5.1 CertificateList. */
export function parseCrl(der: Buffer): Crl {
    const top = children(expectTag(readDerExact(der), TAG.SEQUENCE, 'the revocation list'));
    if (top.length !== 3) throw new DerError('a revocation list with the wrong number of parts');
    const [tbsNode, algNode, sigNode] = top;
    const tbs = children(expectTag(tbsNode, TAG.SEQUENCE, 'the revocation list body'));
    let i = 0;
    if (tbs[i]?.tag === TAG.INTEGER) {
        if (derSmallUint(tbs[i]) !== 1) throw new DerError('a revocation list version this reader does not take');
        i++;
    }
    const innerAlgorithm = expectTag(tbs[i++], TAG.SEQUENCE, 'the revocation list\'s algorithm').raw;
    const issuer = expectTag(tbs[i++], TAG.SEQUENCE, 'the revocation list\'s issuer').raw;
    const thisNode = tbs[i++];
    if (!thisNode) throw new DerError('a revocation list without a date');
    const thisUpdate = derTime(thisNode);
    let nextUpdate: number | null = null;
    if (tbs[i] && (tbs[i].tag === TAG.UTC_TIME || tbs[i].tag === TAG.GENERALIZED_TIME)) nextUpdate = derTime(tbs[i++]);
    const revoked: string[] = [];
    if (tbs[i]?.tag === TAG.SEQUENCE) {
        for (const entry of children(tbs[i++])) {
            const e = children(expectTag(entry, TAG.SEQUENCE, 'a revoked entry'));
            revoked.push(derUintHex(expectTag(e[0], TAG.INTEGER, 'a revoked serial')));
        }
    }
    if (tbs[i]?.tag === 0xa0) i++;
    if (i !== tbs.length) throw new DerError('a revocation list body with parts this reader does not know');
    const sig = expectTag(sigNode, TAG.BIT_STRING, 'the revocation list\'s signature');
    if (!sig.content.length || sig.content[0] !== 0) throw new DerError('a signature that is not whole bytes');
    return {
        tbs: Buffer.from(tbsNode.raw), signatureAlgorithm: Buffer.from(expectTag(algNode, TAG.SEQUENCE, 'the signature algorithm').raw),
        innerAlgorithm: Buffer.from(innerAlgorithm), signature: Buffer.from(sig.content.subarray(1)), issuer: Buffer.from(issuer),
        thisUpdate, nextUpdate, revoked,
    };
}

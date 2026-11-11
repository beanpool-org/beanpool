/**
 * A QR code as data: the rows of dark and light modules the printed pages draw (lights-out-poster.ts, beans-sign.ts).
 *
 * Its own file, and a subpath of the package (`@beanpool/core/qr-matrix`), not part of the barrel: it holds the one outside
 * library the printed pages need (`qrcode`, the encoder the manager and react-native-qrcode-svg already use), so only a screen
 * that is about to print loads it, and the node and the phone's start-up never do. It is the encoder alone
 * (`qrcode/lib/core/qrcode`, plain JavaScript): the package's main entry reaches for Node's file system.
 *
 * It encodes text on this device and asks nothing of the internet.
 */
import encoder from 'qrcode/lib/core/qrcode.js';
import type { QrMatrix } from './lights-out-poster.js';

/**
 * `text` as a square grid, `true` for a dark module, without the quiet zone (the page adds that). Error correction M: a
 * code on a window or a stall is scanned at an angle, through glass, and is rubbed, so it takes a code that survives a few
 * lost modules. Throws on text that is empty or too long for a code (the caller shows its own "couldn't be made").
 */
export function qrMatrix(text: string, errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H' = 'M'): QrMatrix {
    if (typeof text !== 'string' || text.length === 0) throw new Error('A code needs some text.');
    const { modules } = encoder.create(text, { errorCorrectionLevel });
    const side = modules.size;
    const rows: boolean[][] = [];
    for (let y = 0; y < side; y++) {
        const row: boolean[] = [];
        for (let x = 0; x < side; x++) row.push(modules.get(y, x) === 1);
        rows.push(row);
    }
    return rows;
}

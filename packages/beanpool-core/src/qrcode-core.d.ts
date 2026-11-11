/**
 * The part of `qrcode`'s encoder that qr-matrix.ts calls. `@types/qrcode` covers the package's main entry, which reaches for
 * Node's file system and so cannot be bundled for the phone; the encoder alone (`lib/core/qrcode`, the file
 * react-native-qrcode-svg also imports) is plain JavaScript and has no types of its own.
 */
declare module 'qrcode/lib/core/qrcode.js' {
    interface QrBitMatrix {
        readonly size: number;
        readonly data: ArrayLike<number>;
        get(row: number, col: number): number;
    }
    const encoder: {
        create(text: string, options?: { errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' }): { modules: QrBitMatrix };
    };
    export default encoder;
}

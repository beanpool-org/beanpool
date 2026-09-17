import { describe, expect, it, vi } from 'vitest';
import QRCode from 'qrcode';
import { generateOfflineQrUrl } from './qr';

describe('generateOfflineQrUrl', () => {
    it('generates a valid SVG data URL for a text string', () => {
        const text = 'beanpool:test-addr';
        const url = generateOfflineQrUrl(text);

        expect(url).toMatch(/^data:image\/svg\+xml;utf8,/);

        const svgContent = decodeURIComponent(url.replace('data:image/svg+xml;utf8,', ''));
        expect(svgContent).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
        expect(svgContent).toContain('shape-rendering="crispEdges"');
        expect(svgContent).toContain('<path fill="#ffffff"');
        expect(svgContent).toContain('<path fill="#000000"');
    });

    it('returns empty string on empty input string', () => {
        const url = generateOfflineQrUrl('');
        expect(url).toBe('');
    });

    it('returns empty string when QRCode creation throws an error', () => {
        vi.spyOn(QRCode, 'create').mockImplementationOnce(() => {
            throw new Error('QR creation failed');
        });

        const url = generateOfflineQrUrl('error-test');
        expect(url).toBe('');
    });
});

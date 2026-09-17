import QRCode from 'qrcode';

/**
 * Generate a self-contained SVG data URL for a QR code completely offline.
 * Works without network access, third-party APIs, or external image dependencies.
 */
export function generateOfflineQrUrl(text: string): string {
    try {
        const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
        const size = qr.modules.size;
        const data = qr.modules.data;
        let path = '';
        for (let r = 0; r < size; r++) {
            for (let c = 0; c < size; c++) {
                if (data[r * size + c]) {
                    path += `M${c + 1},${r + 1}h1v1h-1z `;
                }
            }
        }
        const totalSize = size + 2; // 1-module margin
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalSize} ${totalSize}" shape-rendering="crispEdges"><path fill="#ffffff" d="M0,0h${totalSize}v${totalSize}h-${totalSize}z"/><path fill="#000000" d="${path}"/></svg>`;
        return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    } catch {
        return '';
    }
}

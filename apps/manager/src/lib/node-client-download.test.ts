import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { downloadAdminFile, HARVESTER_UNAVAILABLE } from './node-client';

describe('downloadAdminFile edge cases', () => {
    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;
    const origConfirm = window.confirm;

    beforeEach(() => {
        vi.restoreAllMocks();
        URL.createObjectURL = vi.fn().mockReturnValue('blob:test-url');
        URL.revokeObjectURL = vi.fn();
        window.confirm = vi.fn();
    });

    afterEach(() => {
        URL.createObjectURL = origCreateObjectURL;
        URL.revokeObjectURL = origRevokeObjectURL;
        window.confirm = origConfirm;
    });

    it('returns empty notice without downloading if huge file confirmation is declined', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers({
                'content-length': String(600 * 1024 * 1024), // 600 MB > 500 MB HUGE_DOWNLOAD_BYTES
            }),
        } as unknown as Response);

        vi.spyOn(window, 'confirm').mockReturnValueOnce(false);

        const notice = await downloadAdminFile(
            '/api/local/admin/snapshots/download',
            { name: 'huge.db' },
            'admin123',
            'huge.db',
        );

        expect(fetchSpy).toHaveBeenCalledOnce();
        expect(window.confirm).toHaveBeenCalledOnce();
        expect(notice).toEqual({ text: '', short: false });
    });

    it('uses Content-Disposition filename when safe, and falls back to default when unsafe or missing', async () => {
        const createElSpy = vi.spyOn(document, 'createElement');

        // Safe filename in Content-Disposition
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers({
                'content-disposition': 'attachment; filename="custom-backup.tar.gz"',
                'X-Backup-Images': '10/10',
            }),
            blob: async () => new Blob(['data']),
        } as unknown as Response);

        let notice = await downloadAdminFile('/api/local/admin/backup', {}, 'pass', 'fallback.db');
        expect(notice).toEqual({ text: '', short: false });

        const createdLinks = createElSpy.mock.results.map((r) => r.value as HTMLElement);
        const firstLink = createdLinks.find((el) => el.tagName === 'A') as HTMLAnchorElement;
        expect(firstLink?.download).toBe('custom-backup.tar.gz');

        createElSpy.mockClear();

        // Unsafe filename with path traversal in Content-Disposition
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers({
                'content-disposition': 'attachment; filename="../evil.db"',
                'X-Backup-Images': '10/10',
            }),
            blob: async () => new Blob(['data']),
        } as unknown as Response);

        notice = await downloadAdminFile('/api/local/admin/backup', {}, 'pass', 'fallback.db');
        const secondCreatedLinks = createElSpy.mock.results.map((r) => r.value as HTMLElement);
        const secondLink = secondCreatedLinks.find((el) => el.tagName === 'A') as HTMLAnchorElement;
        expect(secondLink?.download).toBe('fallback.db');
    });

    it('formats error with body.error for failed responses, adding HARVESTER_UNAVAILABLE prefix for manager API', async () => {
        // Non-OK response for node API with JSON error body
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
            ok: false,
            status: 404,
            json: async () => ({ error: 'No snapshot with that name' }),
        } as unknown as Response);

        await expect(
            downloadAdminFile('/api/local/admin/snapshots/download', { name: 'missing' }, 'pass', 'test.db')
        ).rejects.toThrow('No snapshot with that name');

        // Non-OK response for manager API (/api/manager/...)
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
            ok: false,
            status: 500,
            json: async () => ({ error: 'Storage offline' }),
        } as unknown as Response);

        await expect(
            downloadAdminFile('/api/manager/backups/download', { id: 'node-1' }, 'pass', 'test.tar.gz')
        ).rejects.toThrow(`${HARVESTER_UNAVAILABLE} (Storage offline)`);
    });
});

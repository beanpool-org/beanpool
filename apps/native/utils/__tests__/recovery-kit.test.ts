/**
 * The recovery kit (utils/recovery-kit.ts): the page made from the member's 12 words, and the Print and Save as PDF
 * actions that hand it to the phone. Nothing here touches a device: the print and share modules are stand-ins.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
    KIT_FAILED_LINE, KIT_SAVE_WARNING, askBeforeSavingKit, printRecoveryKit, recoveryKitHtml, saveRecoveryKitPdf,
    sweepPrintedPdfs, type KitFileSystem, type KitModules,
} from '../recovery-kit';

const WORDS = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'];
const KIT = { words: WORDS, communityName: 'Mullum', communityAddress: 'https://mullum.example.org', date: new Date('2026-10-03T09:00:00Z') };

function fakeModules(over: { share?: () => Promise<void>; toFile?: () => Promise<{ uri: string }> } = {}) {
    const calls: string[] = [];
    const modules: KitModules = {
        Print: {
            printAsync: vi.fn(async () => { calls.push('print'); }),
            printToFileAsync: vi.fn(over.toFile ?? (async () => { calls.push('toFile'); return { uri: 'file:///cache/kit.pdf' }; })),
        },
        Sharing: { shareAsync: vi.fn(over.share ?? (async () => { calls.push('share'); })) },
        FileSystem: { deleteAsync: vi.fn(async () => { calls.push('delete'); }) },
    };
    return { modules, calls };
}

describe('recoveryKitHtml', () => {
    it('has the title, and all 12 words numbered 1 to 12 in order', () => {
        const html = recoveryKitHtml(KIT);
        expect(html).toContain('Your BeanPool recovery kit');
        let at = -1;
        WORDS.forEach((word, i) => {
            const cell = html.indexOf(`>${i + 1}.<`, at + 1);
            expect(cell, `number ${i + 1}`).toBeGreaterThan(at);
            const found = html.indexOf(`>${word}<`, cell);
            expect(found, word).toBeGreaterThan(cell);
            at = found;
        });
    });

    it('names the community, its address and the date it was made', () => {
        const html = recoveryKitHtml(KIT);
        expect(html).toContain('Mullum');
        expect(html).toContain('https://mullum.example.org');
        expect(html).toContain('3 October 2026');
    });

    it('names any community address, not only a beanpool.org one', () => {
        const html = recoveryKitHtml({ ...KIT, communityAddress: 'http://192.168.1.20:8080' });
        expect(html).toContain('http://192.168.1.20:8080');
    });

    it('carries the warning and the steps back in', () => {
        const html = recoveryKitHtml(KIT);
        expect(html).toContain('Anyone who has these 12 words can sign in as you. Keep this page somewhere safe. Never photograph it or send it in a chat.');
        expect(html).toContain('Already a Member? Restore Account');
        expect(html).toContain('Recover with 12 Words');
        expect(html).toContain('Recover Identity');
    });

    it('never says whose account it is, even when the caller hands over a callsign, name or key', () => {
        const extra = { ...KIT, callsign: 'zz_callsign_zz', displayName: 'Zed Person', publicKey: 'PUBKEY0123456789abcdef' } as Parameters<typeof recoveryKitHtml>[0];
        const html = recoveryKitHtml(extra);
        expect(html).not.toContain('zz_callsign_zz');
        expect(html).not.toContain('Zed Person');
        expect(html).not.toContain('PUBKEY0123456789abcdef');
    });

    it('escapes the community name and address for HTML', () => {
        const html = recoveryKitHtml({ ...KIT, communityName: `<script>alert("x")</script> Tom's`, communityAddress: `https://a.example/?q="<b>"&r='1'` });
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; Tom&#39;s');
        expect(html).toContain('https://a.example/?q=&quot;&lt;b&gt;&quot;&amp;r=&#39;1&#39;');
    });

    it('escapes the words too', () => {
        const html = recoveryKitHtml({ ...KIT, words: [...WORDS.slice(0, 11), '<i>x</i>'] });
        expect(html).not.toContain('<i>x</i>');
        expect(html).toContain('&lt;i&gt;x&lt;/i&gt;');
    });

    it('refuses anything but exactly 12 words', () => {
        expect(() => recoveryKitHtml({ ...KIT, words: WORDS.slice(0, 11) })).toThrow();
        expect(() => recoveryKitHtml({ ...KIT, words: [...WORDS, 'extra'] })).toThrow();
        expect(() => recoveryKitHtml({ ...KIT, words: [...WORDS.slice(0, 11), ''] })).toThrow();
    });
});

describe('printRecoveryKit', () => {
    it('hands the kit page to the system print dialog and writes no file', async () => {
        const { modules } = fakeModules();
        const result = await printRecoveryKit(KIT, modules);
        expect(result).toBe('done');
        expect(modules.Print.printAsync).toHaveBeenCalledWith({ html: recoveryKitHtml(KIT) });
        expect(modules.Print.printToFileAsync).not.toHaveBeenCalled();
        expect(modules.FileSystem.deleteAsync).not.toHaveBeenCalled();
    });

    it('says it failed, never a false success, when printing throws', async () => {
        const { modules } = fakeModules();
        (modules.Print.printAsync as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('no print service'));
        expect(await printRecoveryKit(KIT, modules)).toBe('failed');
    });

    it('says it failed when the print module is missing on this phone', async () => {
        expect(await printRecoveryKit(KIT, () => { throw new Error('Cannot find native module'); })).toBe('failed');
    });
});

describe('saveRecoveryKitPdf', () => {
    it('makes the PDF, shares it, then deletes the temporary file', async () => {
        const { modules, calls } = fakeModules();
        const result = await saveRecoveryKitPdf(KIT, async () => true, modules);
        expect(result).toBe('done');
        expect(modules.Print.printToFileAsync).toHaveBeenCalledWith({ html: recoveryKitHtml(KIT) });
        expect(modules.Sharing.shareAsync).toHaveBeenCalledWith('file:///cache/kit.pdf', expect.objectContaining({ mimeType: 'application/pdf' }));
        expect(modules.FileSystem.deleteAsync).toHaveBeenCalledWith('file:///cache/kit.pdf', { idempotent: true });
        expect(calls).toEqual(['toFile', 'share', 'delete']);
    });

    it('still deletes the temporary file when sharing throws, and says it failed', async () => {
        const { modules } = fakeModules({ share: async () => { throw new Error('share sheet gone'); } });
        const result = await saveRecoveryKitPdf(KIT, async () => true, modules);
        expect(result).toBe('failed');
        expect(modules.FileSystem.deleteAsync).toHaveBeenCalledWith('file:///cache/kit.pdf', { idempotent: true });
    });

    it('asks first, and Cancel makes and saves nothing', async () => {
        const { modules } = fakeModules();
        const ask = vi.fn(async () => false);
        const result = await saveRecoveryKitPdf(KIT, ask, modules);
        expect(ask).toHaveBeenCalledTimes(1);
        expect(result).toBe('cancelled');
        expect(modules.Print.printToFileAsync).not.toHaveBeenCalled();
        expect(modules.Sharing.shareAsync).not.toHaveBeenCalled();
    });

    it('asks before making the file', async () => {
        const order: string[] = [];
        const { modules } = fakeModules({ toFile: async () => { order.push('toFile'); return { uri: 'file:///cache/kit.pdf' }; } });
        await saveRecoveryKitPdf(KIT, async () => { order.push('ask'); return true; }, modules);
        expect(order).toEqual(['ask', 'toFile']);
    });
});

describe('askBeforeSavingKit', () => {
    it('shows the warning with Cancel and Save, and answers with the button pressed', async () => {
        type Button = { text: string; style?: string; onPress?: () => void };
        let shown: { title: string; message?: string; buttons: Button[] } | null = null;
        const alert = (title: string, message?: string, buttons?: Button[]) => { shown = { title, message, buttons: buttons ?? [] }; };
        const saving = askBeforeSavingKit(alert);
        expect(shown).not.toBeNull();
        const text = `${shown!.title} ${shown!.message ?? ''}`;
        expect(text).toContain(KIT_SAVE_WARNING);
        expect(shown!.buttons.map((b) => b.text)).toEqual(['Cancel', 'Save']);
        shown!.buttons[1].onPress?.();
        expect(await saving).toBe(true);

        const cancelling = askBeforeSavingKit(alert);
        shown!.buttons[0].onPress?.();
        expect(await cancelling).toBe(false);
    });

    it('the failure line tells the member to write the words down', () => {
        expect(KIT_FAILED_LINE).toBe('The recovery kit couldn’t be made on this phone. Write the 12 words down instead.');
        expect(KIT_SAVE_WARNING).toBe('Keep this file off cloud backups and chats. Anyone who has it can sign in as you.');
    });
});

describe('sweepPrintedPdfs (review 4170916838)', () => {
    /** A fake expo-file-system/legacy: a cache folder with expo-print's Print/ folder in it, and what was deleted. */
    function fakeFs(files: Record<string, string[]>, cacheDirectory: string | null = 'file:///data/cache/') {
        const deleted: string[] = [];
        const read: string[] = [];
        const fsFake: KitFileSystem = {
            cacheDirectory,
            readDirectoryAsync: vi.fn(async (uri: string) => {
                read.push(uri);
                if (!(uri in files)) throw new Error('not a directory');
                return files[uri];
            }),
            deleteAsync: vi.fn(async (uri: string) => { deleted.push(uri); }),
        };
        return { fsFake, deleted, read };
    }

    it('deletes only the *.pdf files in expo-print’s cache Print/ folder', async () => {
        const { fsFake, deleted, read } = fakeFs({
            'file:///data/cache/Print/': ['0b1e-kit.pdf', 'A7C2-NAMES.PDF', 'notes.txt', 'sub', 'x.pdf.tmp'],
        });
        expect(await sweepPrintedPdfs(fsFake)).toBe(2);
        expect(read).toEqual(['file:///data/cache/Print/']);
        expect(deleted).toEqual(['file:///data/cache/Print/0b1e-kit.pdf', 'file:///data/cache/Print/A7C2-NAMES.PDF']);
    });

    it('sweeps nothing, and never throws, with no folder yet, no cache directory, or an older module', async () => {
        const none = fakeFs({});
        expect(await sweepPrintedPdfs(none.fsFake)).toBe(0);
        expect(none.deleted).toEqual([]);
        const noCache = fakeFs({ 'file:///data/cache/Print/': ['a.pdf'] }, null);
        expect(await sweepPrintedPdfs(noCache.fsFake)).toBe(0);
        expect(await sweepPrintedPdfs({ deleteAsync: vi.fn(async () => {}) })).toBe(0);
        const failing = fakeFs({ 'file:///data/cache/Print/': ['a.pdf', 'b.pdf'] });
        (failing.fsFake.deleteAsync as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('busy'));
        expect(await sweepPrintedPdfs(failing.fsFake)).toBe(1);
    });

    it('Save as PDF sweeps a PDF an earlier Save left behind before it makes the new one', async () => {
        const { modules, calls } = fakeModules();
        const left = fakeFs({ 'file:///cache/Print/': ['old-kit.pdf'] }, 'file:///cache');
        modules.FileSystem = {
            ...left.fsFake,
            readDirectoryAsync: vi.fn(async (uri: string) => { calls.push('sweep'); return left.fsFake.readDirectoryAsync!(uri); }),
            deleteAsync: vi.fn(async (uri: string) => { calls.push(`delete ${uri}`); }),
        };
        expect(await saveRecoveryKitPdf(KIT, async () => true, modules)).toBe('done');
        expect(calls).toEqual(['sweep', 'delete file:///cache/Print/old-kit.pdf', 'toFile', 'share', 'delete file:///cache/kit.pdf']);
    });

    it('runs once at app start, from the root layout', () => {
        const layout = readFileSync(resolve(__dirname, '../../app/_layout.tsx'), 'utf-8');
        expect(layout).toContain("import { sweepPrintedPdfs } from '../utils/recovery-kit';");
        expect(layout).toMatch(/useEffect\(\(\) => \{ void sweepPrintedPdfs\(\); \}, \[\]\);/);
    });
});

/**
 * The "Beans accepted here" sign on the phone (utils/beans-sign.ts): the PDF made on the phone from core's page, handed to the share
 * sheet, and the phone's copy deleted whatever the share sheet did. Nothing here touches a device: the print, share and file modules
 * are stand-ins, and the community's card is a stand-in fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BEANS_SIGN_SIZES, type QrMatrix } from '@beanpool/core';
import { qrMatrix } from '@beanpool/core/qr-matrix';
import { communityLogoDataUri, communityPublishedName, shareBeansSign, type SignFileSystem, type SignModules } from '../beans-sign';

const COMMUNITY = { communityName: 'Mullum', communityAddress: 'https://mullum.example.org' };
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function fakeModules(over: {
    share?: () => Promise<void>;
    toFile?: () => Promise<{ uri: string }>;
    download?: SignFileSystem['downloadAsync'];
    qr?: (text: string) => QrMatrix;
} = {}) {
    const calls: string[] = [];
    const printed: Array<{ html: string; width: number; height: number }> = [];
    const asked: string[] = [];
    const FileSystem: SignFileSystem = {
        cacheDirectory: 'file:///cache/',
        readDirectoryAsync: vi.fn(async () => []),
        deleteAsync: vi.fn(async (uri: string) => { calls.push(`delete ${uri}`); }),
        downloadAsync: vi.fn(over.download ?? (async (_url: string, file: string) => ({ status: 200, uri: file }))),
        readAsStringAsync: vi.fn(async () => PNG_B64),
    };
    const modules: SignModules = {
        Print: {
            printToFileAsync: vi.fn(async (o: { html: string; width: number; height: number }) => {
                printed.push(o);
                calls.push('toFile');
                return over.toFile ? over.toFile() : { uri: 'file:///cache/Print/sign.pdf' };
            }),
        },
        Sharing: { shareAsync: vi.fn(over.share ?? (async () => { calls.push('share'); })) },
        FileSystem,
        qrMatrix: over.qr ?? ((text: string) => { asked.push(text); return qrMatrix(text); }),
    };
    return { modules, calls, printed, asked, FileSystem };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

/** A community that publishes no card: the sign uses the name the phone holds. */
function noCard() {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
}

describe('shareBeansSign', () => {
    it.each([['a4'], ['a6']] as const)('%s: makes a PDF of that paper, shares it, then deletes the phone\'s copy', async (size) => {
        noCard();
        const { modules, calls, printed } = fakeModules();
        expect(await shareBeansSign(size, COMMUNITY, modules)).toBe('done');
        expect(printed).toHaveLength(1);
        expect(printed[0].width).toBe(BEANS_SIGN_SIZES[size].widthPt);
        expect(printed[0].height).toBe(BEANS_SIGN_SIZES[size].heightPt);
        expect(printed[0].html).toContain('<h1>Beans accepted here</h1>');
        expect(printed[0].html).toContain('Mullum');
        expect(modules.Sharing.shareAsync).toHaveBeenCalledWith('file:///cache/Print/sign.pdf', expect.objectContaining({ mimeType: 'application/pdf' }));
        expect(calls.indexOf('share')).toBeGreaterThan(calls.indexOf('toFile'));
        expect(calls[calls.length - 1]).toBe('delete file:///cache/Print/sign.pdf');
    });

    it('the code is the community\'s own address, at its root, never beanpool.org; the page prints the same address', async () => {
        noCard();
        const { modules, asked, printed } = fakeModules();
        await shareBeansSign('a4', { communityName: 'Shop', communityAddress: 'https://shop.example.org' }, modules);
        expect(asked).toEqual(['https://shop.example.org/']);
        expect(printed[0].html).toContain('shop.example.org');
        expect(printed[0].html).not.toMatch(/beanpool\.org/i);
    });

    it('uses the name the community publishes, and the phone\'s own name when it publishes none', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ joining: 'open', name: 'Mullumbimby Community', host: 'mullum.example.org' }) })));
        const first = fakeModules();
        await shareBeansSign('a4', COMMUNITY, first.modules);
        expect(first.printed[0].html).toContain('Mullumbimby Community');
        noCard();
        const second = fakeModules();
        await shareBeansSign('a4', COMMUNITY, second.modules);
        expect(second.printed[0].html).toContain('<bdi>Mullum</bdi>');
    });

    it('puts the community\'s own logo in the page, read once and deleted from the phone', async () => {
        noCard();
        const { modules, printed, FileSystem, calls } = fakeModules();
        await shareBeansSign('a4', COMMUNITY, modules);
        expect(FileSystem.downloadAsync).toHaveBeenCalledWith('https://mullum.example.org/logo.png', 'file:///cache/beans-sign-logo.png');
        expect(printed[0].html).toContain(`data:image/png;base64,${PNG_B64}`);
        expect(calls).toContain('delete file:///cache/beans-sign-logo.png');
    });

    it('with no logo to be had, still makes a whole sign with the word BeanPool', async () => {
        noCard();
        const { modules, printed } = fakeModules({ download: async () => { throw new Error('offline'); } });
        expect(await shareBeansSign('a6', COMMUNITY, modules)).toBe('done');
        expect(printed[0].html).not.toContain('<img');
        expect(printed[0].html).toContain('<span class="brand">BeanPool</span>');
    });

    it('with no community on the phone, makes nothing and says it failed', async () => {
        const loader = vi.fn(() => fakeModules().modules);
        expect(await shareBeansSign('a4', null, loader)).toBe('failed');
        expect(loader).not.toHaveBeenCalled();
    });

    it('an address that is not a web address makes nothing and says it failed', async () => {
        noCard();
        const { modules, printed } = fakeModules();
        expect(await shareBeansSign('a4', { communityName: 'x', communityAddress: 'not an address' }, modules)).toBe('failed');
        expect(printed).toHaveLength(0);
    });

    it('a PDF that could not be made shares nothing and says it failed', async () => {
        noCard();
        const { modules } = fakeModules({ toFile: async () => { throw new Error('no printer service'); } });
        expect(await shareBeansSign('a4', COMMUNITY, modules)).toBe('failed');
        expect(modules.Sharing.shareAsync).not.toHaveBeenCalled();
    });

    it('a share sheet that fails still has the phone\'s copy deleted, and the result is failed', async () => {
        noCard();
        const { modules, calls } = fakeModules({ share: async () => { throw new Error('closed'); } });
        expect(await shareBeansSign('a4', COMMUNITY, modules)).toBe('failed');
        expect(calls).toContain('delete file:///cache/Print/sign.pdf');
    });

    it('a code that could not be made says it failed and prints no blank frame', async () => {
        noCard();
        const { modules, printed } = fakeModules({ qr: () => { throw new Error('too long'); } });
        expect(await shareBeansSign('a4', COMMUNITY, modules)).toBe('failed');
        expect(printed).toHaveLength(0);
    });

    it('a phone built before the print module loads fails the sign alone', async () => {
        expect(await shareBeansSign('a4', COMMUNITY, () => { throw new Error('Cannot find native module ExpoPrint'); })).toBe('failed');
    });
});

describe('communityPublishedName', () => {
    const card = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body }));

    it('is the name on the community\'s card', async () => {
        expect(await communityPublishedName('https://a.example.org', card({ joining: 'open', name: 'The Co-op', host: 'a.example.org' }))).toBe('The Co-op');
        expect(await communityPublishedName('https://a.example.org', card({ joining: 'open', name: 'The Co-op' }))).toBe('The Co-op');
    });

    it('is nothing from a card about another host, a card with no name, an answer that is not a card, a refusal, or no answer', async () => {
        expect(await communityPublishedName('https://a.example.org', card({ joining: 'open', name: 'Not Us', host: 'b.example.org' }))).toBeNull();
        expect(await communityPublishedName('https://a.example.org', card({ joining: 'open' }))).toBeNull();
        expect(await communityPublishedName('https://a.example.org', card({ nonsense: true }))).toBeNull();
        expect(await communityPublishedName('https://a.example.org', card({}, false))).toBeNull();
        expect(await communityPublishedName('https://a.example.org', vi.fn(async () => { throw new Error('offline'); }))).toBeNull();
    });
});

describe('communityLogoDataUri', () => {
    it('is nothing on a phone whose file module cannot download, or from an answer that is not a 200', async () => {
        expect(await communityLogoDataUri('https://a.example.org', { deleteAsync: vi.fn(async () => {}) })).toBeUndefined();
        const { FileSystem } = fakeModules({ download: async (_u, f) => ({ status: 404, uri: f }) });
        expect(await communityLogoDataUri('https://a.example.org', FileSystem)).toBeUndefined();
    });
});

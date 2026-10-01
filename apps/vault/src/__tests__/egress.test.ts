import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readSettingsFile, renderEgress } from '../egress/egress.js';
import { parseSettings, settingsHash, type SettingsFile } from '../shared/settings.js';

/**
 * Root's egress step (src/egress): the names of the custodians' store, webhook and mail server into the resolver's
 * extra config, and nothing else. The file is the API's user's, so root reads it as it reads anything of theirs.
 */

const dir = mkdtempSync(path.join(os.tmpdir(), 'bv-egress-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function file(raw: unknown): SettingsFile {
    const settings = parseSettings(raw);
    return { v: 1, settings, hash: settingsHash(settings), approvedBy: ['a', 'b'], approvedAt: 1 };
}

const store = { kind: 's3', endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'vault-backups', accessKeyId: 'AK-SECRET', secretAccessKey: 'SK-SECRET' };

describe('the resolver\'s lines', () => {
    it('the store and webhook into the HTTPS sets, the mail server into the mail sets, through Quad9; no secret, no path', () => {
        const f = file({ v: 1, offsite: store, alerts: {
            webhook: { url: 'https://ntfy.example.org/topic-secret' },
            email: { host: 'smtp.example.org', port: 465, username: 'u', password: 'PW-SECRET', from: 'v@example.org', to: ['c@example.org'] },
        } });
        const out = renderEgress(f);
        const lines = out.text.split('\n').filter(l => l && !l.startsWith('#'));
        expect(lines).toEqual([
            'server=/acct.r2.cloudflarestorage.com/ntfy.example.org/smtp.example.org/9.9.9.9',
            'server=/acct.r2.cloudflarestorage.com/ntfy.example.org/smtp.example.org/149.112.112.112',
            'nftset=/acct.r2.cloudflarestorage.com/ntfy.example.org/4#inet#vault#egress4,6#inet#vault#egress6',
            'nftset=/smtp.example.org/4#inet#vault#smtp4,6#inet#vault#smtp6',
        ]);
        for (const secret of ['SECRET', 'topic-secret', 'c@example.org', 'vault-backups/']) expect(out.text).not.toContain(secret);
    });

    it('one name for both HTTPS and mail gets every set on one line; an address, an odd port or this machine is left out, and said', () => {
        const both = renderEgress(file({ v: 1, alerts: {
            webhook: { url: 'https://mail.example.org/hook' },
            email: { host: 'mail.example.org', port: 587, from: 'v@example.org', to: ['c@example.org'] },
        } }));
        expect(both.text).toContain('nftset=/mail.example.org/4#inet#vault#egress4,6#inet#vault#egress6,4#inet#vault#smtp4,6#inet#vault#smtp6\n');
        expect(both.text.match(/^nftset=/gm)).toHaveLength(1);
        const odd = renderEgress(file({ v: 1, offsite: { ...store, endpoint: 'https://198.51.100.7' }, alerts: { webhook: { url: 'http://127.0.0.1:9/x' } } }));
        expect(odd.text.split('\n').filter(l => l && !l.startsWith('#'))).toEqual([]);
        expect(odd.text).toMatch(/# Left out: offsite: 198\.51\.100\.7 is not a DNS name\./);
        expect(odd.text).toMatch(/# Left out: webhook: only https on port 443 goes out\./);
    });

    it('no settings: an empty config, with why', () => {
        expect(renderEgress(null, 'no settings').text.split('\n').filter(l => l && !l.startsWith('#'))).toEqual([]);
    });
});

describe('root reading the API user\'s file', () => {
    it('a link is never followed, a directory or a file past the cap is not read, and a file whose hash doesn\'t match what it holds is not used', () => {
        const good = file({ v: 1, offsite: store });
        const p = (name: string) => path.join(dir, name);
        writeFileSync(p('settings.json'), JSON.stringify(good));
        expect(readSettingsFile(p('settings.json')).settings?.hash).toBe(good.hash);
        symlinkSync(p('settings.json'), p('link.json'));
        expect(readSettingsFile(p('link.json'))).toMatchObject({ settings: null, why: expect.stringMatching(/can't be read \((ELOOP|EMLINK)\)/) });
        mkdirSync(p('a-dir.json'));
        expect(readSettingsFile(p('a-dir.json')).why).toBe('the settings file is not a regular file');
        writeFileSync(p('big.json'), Buffer.alloc(64 * 1024 + 1, 0x20));
        expect(readSettingsFile(p('big.json')).why).toBe('the settings file is too large');
        writeFileSync(p('edited.json'), JSON.stringify({ ...good, settings: { ...good.settings, offsite: { ...good.settings.offsite, endpoint: 'https://evil.example.org' } } }));
        expect(readSettingsFile(p('edited.json')).why).toBe('the settings file is not one the API wrote');
        writeFileSync(p('lines.json'), JSON.stringify({ ...good, settings: { v: 1, offsite: null, alerts: { webhook: { url: 'https://x.example.org/\nserver=/#/1.2.3.4' } } } }));
        expect(readSettingsFile(p('lines.json')).settings).toBeNull();
        expect(readSettingsFile(p('missing.json')).why).toBe('no settings');
    });
});

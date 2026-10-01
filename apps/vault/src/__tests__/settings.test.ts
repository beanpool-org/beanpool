import { describe, expect, it } from 'vitest';
import { egressNames, parseSettings, parseSettingsFile, settingsHash, settingsSummary, SettingsError } from '../shared/settings.js';

/**
 * The operator settings (shared/settings.ts): nothing built in, nothing in the clear but to this machine, nothing that
 * could break a mail header or the resolver's config, and one hash for one meaning whatever order a file is written in.
 */

const store = { kind: 's3', endpoint: 'https://abc123.r2.cloudflarestorage.com', region: 'auto', bucket: 'vault-backups', prefix: 'v/', accessKeyId: 'AK', secretAccessKey: 'SK' };
const email = { host: 'smtp.example.org', port: 587, username: 'u', password: 'p', from: 'vault@example.org', to: ['a@example.org'] };

describe('operator settings', () => {
    it('nothing is required, and an empty set is no settings', () => {
        expect(parseSettings({ v: 1 })).toEqual({ v: 1, offsite: null, alerts: null });
        expect(parseSettings({ v: 1, offsite: null, alerts: { email: null, webhook: null } })).toEqual({ v: 1, offsite: null, alerts: null });
    });

    it('fills the defaults: path-style, region auto, STARTTLS on 587 and TLS on 465, JSON webhooks', () => {
        const s = parseSettings({ v: 1, offsite: { ...store, region: undefined, prefix: undefined }, alerts: { email, webhook: { url: 'https://ntfy.sh/topic' } } });
        expect(s.offsite).toMatchObject({ region: 'auto', prefix: '', pathStyle: true, endpoint: 'https://abc123.r2.cloudflarestorage.com' });
        expect(s.alerts?.email?.security).toBe('starttls');
        expect(parseSettings({ v: 1, alerts: { email: { ...email, port: 465 } } }).alerts?.email?.security).toBe('tls');
        expect(s.alerts?.webhook).toEqual({ url: 'https://ntfy.sh/topic', format: 'json' });
    });

    it('refuses what would go in the clear (but to this machine), a header break, a setting it doesn\'t know', () => {
        const bad: unknown[] = [
            { v: 1, offsite: { ...store, endpoint: 'http://store.example.org' } },
            { v: 1, offsite: { ...store, endpoint: 'https://store.example.org/path' } },
            { v: 1, offsite: { ...store, endpoint: 'https://user:pw@store.example.org' } },
            { v: 1, offsite: { ...store, bucket: 'Bad_Bucket' } },
            { v: 1, offsite: { ...store, prefix: '../x/' } },
            { v: 1, offsite: { ...store, kind: 'gcs' } },
            { v: 1, alerts: { webhook: { url: 'http://hooks.example.org/x' } } },
            { v: 1, alerts: { email: { ...email, security: 'none' } } },
            { v: 1, alerts: { email: { ...email, host: 'smtp.example.org/../x' } } },
            { v: 1, alerts: { email: { ...email, from: 'vault@example.org\r\nBcc: x@evil.test' } } },
            { v: 1, alerts: { email: { ...email, to: ['a@example.org>\r\nRCPT TO:<x@evil.test'] } } },
            { v: 1, alerts: { email: { ...email, password: undefined } } },
            { v: 1, alerts: { email, sms: {} } },
            { v: 1, extra: true },
            { v: 2 },
        ];
        for (const b of bad) expect(() => parseSettings(b), JSON.stringify(b)).toThrow(SettingsError);
        expect(parseSettings({ v: 1, offsite: { ...store, endpoint: 'http://127.0.0.1:9000' } }).offsite?.endpoint).toBe('http://127.0.0.1:9000');
        expect(parseSettings({ v: 1, alerts: { email: { ...email, host: 'localhost' } } }).alerts?.email?.host).toBe('localhost');
    });

    it('one hash whatever order the file is written in; any change, another hash', () => {
        const a = parseSettings({ v: 1, offsite: store, alerts: { email } });
        const b = parseSettings({ alerts: { email: Object.fromEntries(Object.entries(email).reverse()) }, offsite: Object.fromEntries(Object.entries(store).reverse()), v: 1 });
        expect(settingsHash(a)).toBe(settingsHash(b));
        expect(settingsHash(parseSettings({ v: 1, offsite: { ...store, secretAccessKey: 'SK2' }, alerts: { email } }))).not.toBe(settingsHash(a));
    });

    it('a settings file is used only as written: the hash must match what it holds', () => {
        const settings = parseSettings({ v: 1, offsite: store });
        const file = { v: 1, settings, hash: settingsHash(settings), approvedBy: ['a', 'b'], approvedAt: 1 };
        expect(parseSettingsFile(JSON.stringify(file))?.hash).toBe(file.hash);
        expect(parseSettingsFile(JSON.stringify({ ...file, settings: { ...settings, offsite: { ...store, bucket: 'other-bucket' } } }))).toBeNull();
        expect(parseSettingsFile('not json')).toBeNull();
        expect(parseSettingsFile(`{"pad": "${'x'.repeat(70_000)}"}`)).toBeNull();
    });

    it('the names root\'s egress step lets out: DNS names on 443 and the mail ports only', () => {
        expect(egressNames(parseSettings({ v: 1, offsite: store, alerts: { email, webhook: { url: 'https://ntfy.sh/topic' } } }))).toEqual({
            https: ['abc123.r2.cloudflarestorage.com', 'ntfy.sh'], smtp: ['smtp.example.org'], skipped: [],
        });
        expect(egressNames(parseSettings({ v: 1, offsite: { ...store, pathStyle: false } })).https).toEqual(['vault-backups.abc123.r2.cloudflarestorage.com']);
        const odd = egressNames(parseSettings({
            v: 1, offsite: { ...store, endpoint: 'https://203.0.113.9' },
            alerts: { email: { ...email, port: 2525 }, webhook: { url: 'https://hooks.example.org:8443/x' } },
        }));
        expect(odd.https).toEqual([]);
        expect(odd.smtp).toEqual([]);
        expect(odd.skipped).toHaveLength(3);
    });

    it('the report\'s summary names no host, address or secret', () => {
        const settings = parseSettings({ v: 1, offsite: store, alerts: { email, webhook: { url: 'https://ntfy.sh/topic' } } });
        const summary = settingsSummary({ v: 1, settings, hash: settingsHash(settings), approvedBy: ['k1', 'k2'], approvedAt: 5 });
        expect(summary).toEqual({ hash: settingsHash(settings).slice(0, 16), approvedAt: 5, offsite: true, alerts: ['email', 'webhook'] });
        expect(settingsSummary(null)).toEqual({ hash: null, approvedAt: null, offsite: false, alerts: [] });
    });
});

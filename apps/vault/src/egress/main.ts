#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { EGRESS_CONF, readSettingsFile, renderEgress } from './egress.js';

/**
 * `vault-egress [--reload]`, as root (egress.ts): the names of the custodians' off-box store, webhook and mail server,
 * from the settings file named in the image's api.json, into the resolver's extra config (EGRESS_CONF). With
 * `--reload`, when that changed, the resolver restarts to read it (without waiting: the resolver's unit is ordered
 * after this one at boot, so waiting for it here would wait forever). It always writes the file, empty for no
 * settings, so the resolver always starts; and it always exits 0: the journal says what it did.
 */

const API_CONFIG = '/etc/beanpool-vault/api.json';
const DNS_UNIT = 'beanpool-vault-dns.service';

function main(): void {
    let settingsFile: string | undefined;
    try {
        settingsFile = (JSON.parse(readFileSync(API_CONFIG, 'utf8')) as { settingsFile?: string }).settingsFile;
    } catch {
        settingsFile = undefined;
    }
    const read = settingsFile ? readSettingsFile(settingsFile) : { settings: null, why: 'no settingsFile in api.json' };
    const out = renderEgress(read.settings, read.why);
    let before = '';
    try {
        before = readFileSync(EGRESS_CONF, 'utf8');
    } catch {
        // Not there yet.
    }
    if (before !== out.text) {
        writeFileSync(`${EGRESS_CONF}.part`, out.text, { mode: 0o644 });
        renameSync(`${EGRESS_CONF}.part`, EGRESS_CONF);
    }
    const what = read.settings
        ? `https ${out.https.join(' ') || 'none'}; mail ${out.smtp.join(' ') || 'none'}${out.skipped.length ? `; left out: ${out.skipped.join('; ')}` : ''}`
        : `none (${read.why})`;
    console.log(`vault-egress: ${before === out.text ? 'unchanged' : 'written'}: ${what}`);
    if (process.argv.includes('--reload') && before !== out.text) {
        const r = spawnSync('systemctl', ['--no-block', 'try-restart', DNS_UNIT], { encoding: 'utf8' });
        if (r.status !== 0) console.log(`vault-egress: the resolver was not restarted: ${(r.stderr ?? '').trim().slice(0, 200)}`);
    }
}

try {
    main();
} catch (e) {
    console.log(`vault-egress: ${(e as Error).message}`);
}

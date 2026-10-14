import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { egressNames, parseSettingsFile, SETTINGS_MAX_BYTES, type SettingsFile } from '../shared/settings.js';

/**
 * Root's egress step (the image: beanpool-vault-egress.service, started at boot before the resolver and again by
 * beanpool-vault-egress.path whenever the settings file changes). The vault's firewall lets HTTPS out only to addresses
 * its own resolver has just returned for an allowed name (etc/nftables.conf, etc/beanpool-vault/dnsmasq.conf); the
 * names in the image are the providers', Expo's, GitHub's and Let's Encrypt's. The custodians' off-box store, webhook
 * and mail server are theirs to choose (shared/settings.ts), so this adds their names, from the settings file the API
 * keeps, to a file the resolver reads (`conf-file=`): HTTPS names into the `egress` sets (port 443, for the API and
 * Caddy), the mail server's into the `smtp` sets (ports 465 and 587, for the API alone).
 *
 * The settings file is the API's user's, so it is read as root reads anything of that user's: never through a link,
 * only a regular file, no more than SETTINGS_MAX_BYTES, and checked again (parseSettingsFile: every field, and the hash
 * of what it holds). What goes into the resolver's config is only DNS names that settings.ts's own pattern took
 * (letters, digits, hyphens and dots), so nothing in the file can add any other line. A file that isn't one gives an
 * empty config: the vault reaches nothing of the custodians' until two of them set it again.
 *
 * Who decides these names: two custodians (server.ts `/v1/unlock/settings`), and whoever can write the API user's
 * files, the API included. That lets a compromised API reach a name of its choosing; it can already send what it
 * likes to any phone through Expo's push service. The egress lock bounds mistakes and casual reach, not a hostile API.
 */

export const EGRESS_CONF = '/run/beanpool-vault-egress.conf';
const QUAD9 = ['9.9.9.9', '149.112.112.112'];
const HTTPS_SETS = '4#inet#vault#egress4,6#inet#vault#egress6';
const SMTP_SETS = '4#inet#vault#smtp4,6#inet#vault#smtp6';

/** The settings file as root reads it: no link followed, a regular file, capped, checked again. */
export function readSettingsFile(file: string): { settings: SettingsFile | null; why: string | null } {
    let fd: number;
    try {
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        return { settings: null, why: code === 'ENOENT' ? 'no settings' : `the settings file can't be read (${code})` };
    }
    try {
        const st = fstatSync(fd);
        if (!st.isFile()) return { settings: null, why: 'the settings file is not a regular file' };
        if (st.size > SETTINGS_MAX_BYTES) return { settings: null, why: 'the settings file is too large' };
        const buf = Buffer.alloc(st.size);
        let at = 0;
        while (at < buf.length) {
            const n = readSync(fd, buf, at, buf.length - at, at);
            if (!n) break;
            at += n;
        }
        const settings = parseSettingsFile(buf.subarray(0, at).toString('utf8'));
        return settings ? { settings, why: null } : { settings: null, why: 'the settings file is not one the API wrote' };
    } finally {
        closeSync(fd);
    }
}

/** The resolver's lines for these settings (an empty config, with why, for none). */
export function renderEgress(settings: SettingsFile | null, why: string | null = null): { text: string; https: string[]; smtp: string[]; skipped: string[] } {
    const head = '# Written by vault-egress (root) from the custodians\' settings: the names the vault may reach for them.\n';
    if (!settings) return { text: `${head}# None: ${why ?? 'no settings'}.\n`, https: [], smtp: [], skipped: [] };
    const { https, smtp, skipped } = egressNames(settings.settings);
    const lines = [head.trimEnd(), `# Settings ${settings.hash.slice(0, 16)}.`];
    for (const s of skipped) lines.push(`# Left out: ${s.replace(/[^\x20-\x7e]/g, '?')}.`);
    const all = [...new Set([...https, ...smtp])].sort();
    if (all.length) for (const q of QUAD9) lines.push(`server=/${all.join('/')}/${q}`);
    // A name in both lists gets every set, on one line: the resolver takes one nftset line per name.
    const both = https.filter(n => smtp.includes(n));
    const httpsOnly = https.filter(n => !both.includes(n));
    const smtpOnly = smtp.filter(n => !both.includes(n));
    if (httpsOnly.length) lines.push(`nftset=/${httpsOnly.join('/')}/${HTTPS_SETS}`);
    if (smtpOnly.length) lines.push(`nftset=/${smtpOnly.join('/')}/${SMTP_SETS}`);
    if (both.length) lines.push(`nftset=/${both.join('/')}/${HTTPS_SETS},${SMTP_SETS}`);
    return { text: `${lines.join('\n')}\n`, https, smtp, skipped };
}

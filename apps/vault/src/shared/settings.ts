import crypto from 'node:crypto';
import { isIP } from 'node:net';

/**
 * The vault's operator settings (key vault design §3, §4): where backups go off the box, and where alerts go. Nothing
 * here is built in: no destination, no channel, no host of BeanPool's. Without settings the vault runs as before, with
 * its backups on its own disk and no alert sent (and `/v1/report` says so).
 *
 *   {"v": 1,
 *    "offsite": {"kind": "s3", "endpoint": "https://<host>", "region": "auto", "bucket": "...", "prefix": "vault/",
 *                "accessKeyId": "...", "secretAccessKey": "...", "pathStyle": true} | null,
 *    "alerts": {"email": {"host": "...", "port": 465, "security": "tls" | "starttls", "username": "...",
 *                         "password": "...", "from": "...", "to": ["..."]} | null,
 *               "webhook": {"url": "https://...", "format": "json" | "text"} | null}}
 *
 * - `offsite` is any S3-compatible store: Cloudflare R2, Backblaze B2, Wasabi, Scaleway, OVH, Hetzner, AWS, or one you
 *   run yourself (MinIO, Garage). It is trusted with nothing but keeping bytes: every backup is sealed and signed before
 *   it leaves (backup-format.ts).
 * - `alerts.email` sends through an SMTP server over TLS (implicit on 465, or STARTTLS on 587); never in the clear.
 * - `alerts.webhook` POSTs each alert to a URL: JSON `{text, content, ...}` (Slack and Discord read `text` and
 *   `content`), or plain text (ntfy, which gives a push to a phone).
 *
 * Two custodians set them (server.ts `/v1/unlock/settings`): each sends the same settings, and they take effect at the
 * second. The vault keeps them on its state partition, where its host can read them (as it can read the vault's
 * memory): give the store key access to its one bucket only, and the mail account nothing else to do.
 *
 * Plain `http://` and a mail server without TLS are refused, except on the machine itself (a rehearsal or a test).
 */

export const SETTINGS_VERSION = 1;
/** A settings file larger than this is not read (root's egress step and the API both). */
export const SETTINGS_MAX_BYTES = 64 * 1024;
export const SETTINGS_FILE_NAME = 'settings.json';

export interface OffsiteS3 {
    kind: 's3';
    endpoint: string;
    region: string;
    bucket: string;
    prefix: string;
    accessKeyId: string;
    secretAccessKey: string;
    pathStyle: boolean;
}

export interface EmailChannel {
    host: string;
    port: number;
    security: 'tls' | 'starttls';
    username: string | null;
    password: string | null;
    from: string;
    to: string[];
}

export interface WebhookChannel {
    url: string;
    format: 'json' | 'text';
}

export interface AlertChannels {
    email: EmailChannel | null;
    webhook: WebhookChannel | null;
}

export interface OperatorSettings {
    v: 1;
    offsite: OffsiteS3 | null;
    alerts: AlertChannels | null;
}

export const NO_SETTINGS: OperatorSettings = { v: 1, offsite: null, alerts: null };

export class SettingsError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SettingsError';
    }
}

function fail(message: string): never {
    throw new SettingsError(message);
}

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** The machine itself: the only place plain HTTP or SMTP is allowed (a rehearsal, a test). */
export function isLoopbackHost(host: string): boolean {
    return LOOPBACK_NAMES.has(host.toLowerCase());
}

// A DNS name of letters, digits and hyphens, at least two labels, a letter-led top label: what root's egress step
// writes into the resolver's config. Nothing else can reach it (no '/', '#', spaces or line breaks).
const DNS_NAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

export function isDnsName(host: string): boolean {
    return DNS_NAME_RE.test(host);
}

function str(o: Record<string, unknown>, key: string, where: string, opts: { max?: number; optional?: boolean } = {}): string {
    const v = o[key];
    if (v === undefined || v === null) {
        if (opts.optional) return '';
        fail(`${where}.${key} is missing.`);
    }
    if (typeof v !== 'string' || !v.length) fail(`${where}.${key} must be a non-empty string.`);
    if (v.length > (opts.max ?? 512)) fail(`${where}.${key} is too long.`);
    if (/[\r\n\0]/.test(v)) fail(`${where}.${key} may not hold a line break.`);
    return v;
}

function obj(v: unknown, where: string): Record<string, unknown> {
    if (!v || typeof v !== 'object' || Array.isArray(v)) fail(`${where} must be an object.`);
    return v as Record<string, unknown>;
}

function onlyKeys(o: Record<string, unknown>, keys: string[], where: string): void {
    for (const k of Object.keys(o)) if (!keys.includes(k)) fail(`${where}.${k} is not a setting.`);
}

/** An https URL (http only to the machine itself), no credentials in it, no fragment. */
function webUrl(value: string, where: string): URL {
    let u: URL;
    try {
        u = new URL(value);
    } catch {
        return fail(`${where} is not a URL.`);
    }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(u.hostname))) fail(`${where} must be https:// (http:// only to this machine).`);
    if (u.username || u.password) fail(`${where} may not carry a user name or password.`);
    if (u.hash) fail(`${where} may not have a #fragment.`);
    return u;
}

/** An address for the SMTP envelope and headers: plain `local@domain`, nothing that could break a header. */
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

function parseOffsite(v: unknown): OffsiteS3 | null {
    if (v === null || v === undefined) return null;
    const o = obj(v, 'offsite');
    onlyKeys(o, ['kind', 'endpoint', 'region', 'bucket', 'prefix', 'accessKeyId', 'secretAccessKey', 'pathStyle'], 'offsite');
    if (o.kind !== 's3') fail('offsite.kind must be "s3" (any S3-compatible store).');
    const u = webUrl(str(o, 'endpoint', 'offsite'), 'offsite.endpoint');
    if (u.pathname !== '/' || u.search) fail('offsite.endpoint is the store\'s address only (https://host[:port]), with no path.');
    const bucket = str(o, 'bucket', 'offsite', { max: 63 });
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) fail('offsite.bucket must be an S3 bucket name (3-63 lower-case letters, digits, dots, hyphens).');
    const prefix = o.prefix === undefined || o.prefix === null ? '' : str(o, 'prefix', 'offsite', { max: 200 });
    // No '.' or '..' segment: a URL would fold `/bucket/../x/` into another bucket's path.
    if (prefix && (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/$/.test(prefix) || prefix.split('/').some(seg => seg === '.' || seg === '..'))) {
        fail('offsite.prefix must be like "vault/" or "a/b/" (letters, digits, . _ -, ending in /; no "." or ".." part).');
    }
    const region = o.region === undefined ? 'auto' : str(o, 'region', 'offsite', { max: 64 });
    if (!/^[a-z0-9-]+$/.test(region)) fail('offsite.region must be like "auto" or "eu-central-1".');
    if (o.pathStyle !== undefined && typeof o.pathStyle !== 'boolean') fail('offsite.pathStyle must be true or false.');
    return {
        kind: 's3', endpoint: u.origin, region, bucket, prefix,
        accessKeyId: str(o, 'accessKeyId', 'offsite', { max: 256 }), secretAccessKey: str(o, 'secretAccessKey', 'offsite', { max: 256 }),
        pathStyle: o.pathStyle !== false,
    };
}

function parseEmail(v: unknown): EmailChannel | null {
    if (v === null || v === undefined) return null;
    const o = obj(v, 'alerts.email');
    onlyKeys(o, ['host', 'port', 'security', 'username', 'password', 'from', 'to'], 'alerts.email');
    const host = str(o, 'host', 'alerts.email', { max: 253 }).toLowerCase();
    if (!isDnsName(host) && !isLoopbackHost(host)) fail('alerts.email.host must be the mail server\'s DNS name.');
    const port = o.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) fail('alerts.email.port must be a port number.');
    const security = o.security === undefined ? (port === 465 ? 'tls' : 'starttls') : o.security;
    if (security !== 'tls' && security !== 'starttls') fail('alerts.email.security must be "tls" (port 465) or "starttls" (port 587): never in the clear.');
    const username = o.username === undefined || o.username === null ? null : str(o, 'username', 'alerts.email', { max: 256 });
    const password = o.password === undefined || o.password === null ? null : str(o, 'password', 'alerts.email', { max: 256 });
    if ((username === null) !== (password === null)) fail('alerts.email needs both username and password, or neither.');
    const from = str(o, 'from', 'alerts.email', { max: 254 });
    if (!EMAIL_RE.test(from)) fail('alerts.email.from must be a plain address (name@domain).');
    const to = o.to;
    if (!Array.isArray(to) || !to.length || to.length > 10) fail('alerts.email.to must list 1 to 10 addresses.');
    for (const t of to) if (typeof t !== 'string' || !EMAIL_RE.test(t)) fail('alerts.email.to must list plain addresses (name@domain).');
    return { host, port, security, username, password, from, to: [...new Set(to as string[])] };
}

function parseWebhook(v: unknown): WebhookChannel | null {
    if (v === null || v === undefined) return null;
    const o = obj(v, 'alerts.webhook');
    onlyKeys(o, ['url', 'format'], 'alerts.webhook');
    const u = webUrl(str(o, 'url', 'alerts.webhook', { max: 2048 }), 'alerts.webhook.url');
    const format = o.format === undefined ? 'json' : o.format;
    if (format !== 'json' && format !== 'text') fail('alerts.webhook.format must be "json" or "text".');
    return { url: u.href, format };
}

/** Settings as written by a person (defaults filled, names checked), or a SettingsError saying what is wrong. */
export function parseSettings(value: unknown): OperatorSettings {
    const o = obj(value, 'settings');
    onlyKeys(o, ['v', 'offsite', 'alerts'], 'settings');
    if (o.v !== SETTINGS_VERSION) fail('settings.v must be 1.');
    let alerts: AlertChannels | null = null;
    if (o.alerts !== null && o.alerts !== undefined) {
        const a = obj(o.alerts, 'alerts');
        onlyKeys(a, ['email', 'webhook'], 'alerts');
        alerts = { email: parseEmail(a.email), webhook: parseWebhook(a.webhook) };
        if (!alerts.email && !alerts.webhook) alerts = null;
    }
    return { v: 1, offsite: parseOffsite(o.offsite), alerts };
}

/** One spelling of a settings value: keys sorted at every level. Two custodians' copies of one file give the same. */
export function canonicalSettings(s: OperatorSettings): string {
    const sort = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(sort);
        if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sort((v as Record<string, unknown>)[k])]));
        return v;
    };
    return JSON.stringify(sort(s));
}

/** SHA-256 (hex) of the canonical settings: what two custodians agree on, and what the report names (its first 16). */
export function settingsHash(s: OperatorSettings): string {
    return crypto.createHash('sha256').update(`beanpool-vault-settings/1\n${canonicalSettings(s)}`).digest('hex');
}

/** What the vault keeps on its state partition: the settings, and who agreed to them. */
export interface SettingsFile {
    v: 1;
    settings: OperatorSettings;
    hash: string;
    approvedBy: string[];
    approvedAt: number;
}

/** A settings file as the API wrote it, checked again; null when it isn't one. */
export function parseSettingsFile(text: string): SettingsFile | null {
    if (Buffer.byteLength(text) > SETTINGS_MAX_BYTES) return null;
    try {
        const f = JSON.parse(text) as Partial<SettingsFile>;
        if (!f || f.v !== 1 || !Array.isArray(f.approvedBy) || !Number.isSafeInteger(f.approvedAt)) return null;
        const settings = parseSettings(f.settings);
        const hash = settingsHash(settings);
        if (f.hash !== hash) return null;
        return { v: 1, settings, hash, approvedBy: f.approvedBy.filter(k => typeof k === 'string'), approvedAt: f.approvedAt as number };
    } catch {
        return null;
    }
}

/**
 * The names the vault must reach for these settings, for root's egress step (src/egress): HTTPS (443) to the store and
 * the webhook, SMTP (465 or 587) to the mail server. Only DNS names: an address written as a number, or the machine
 * itself, is left out (the vault's firewall lets HTTPS out only to names its own resolver looked up), and so is a port
 * the firewall doesn't open; `skipped` says which and why.
 */
export function egressNames(s: OperatorSettings): { https: string[]; smtp: string[]; skipped: string[] } {
    const https = new Set<string>();
    const smtp = new Set<string>();
    const skipped: string[] = [];
    const web = (what: string, href: string) => {
        const u = new URL(href);
        const host = u.hostname.toLowerCase();
        if (u.protocol !== 'https:' || (u.port && u.port !== '443')) skipped.push(`${what}: only https on port 443 goes out`);
        else if (isIP(host.replace(/^\[|\]$/g, '')) || !isDnsName(host)) skipped.push(`${what}: ${host} is not a DNS name`);
        else https.add(host);
    };
    if (s.offsite) web('offsite', s.offsite.pathStyle ? s.offsite.endpoint : virtualHostUrl(s.offsite));
    if (s.alerts?.webhook) web('webhook', s.alerts.webhook.url);
    const email = s.alerts?.email;
    if (email) {
        if (email.port !== 465 && email.port !== 587) skipped.push(`email: only ports 465 and 587 go out`);
        else if (!isDnsName(email.host)) skipped.push(`email: ${email.host} is not a DNS name`);
        else smtp.add(email.host);
    }
    return { https: [...https].sort(), smtp: [...smtp].sort(), skipped };
}

/** The store's address with the bucket in the host name (virtual-hosted style). */
export function virtualHostUrl(o: OffsiteS3): string {
    const u = new URL(o.endpoint);
    u.hostname = `${o.bucket}.${u.hostname}`;
    return u.origin;
}

/**
 * What the public report says of the settings: whether each part is set, and the hash's first 16 characters, so a
 * custodian can check which settings are in force against their own file. Never an address, a host or a secret.
 */
export function settingsSummary(f: SettingsFile | null): { hash: string | null; approvedAt: number | null; offsite: boolean; alerts: string[] } {
    if (!f) return { hash: null, approvedAt: null, offsite: false, alerts: [] };
    const alerts: string[] = [];
    if (f.settings.alerts?.email) alerts.push('email');
    if (f.settings.alerts?.webhook) alerts.push('webhook');
    return { hash: f.hash.slice(0, 16), approvedAt: f.approvedAt, offsite: !!f.settings.offsite, alerts };
}

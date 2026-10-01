import type tls from 'node:tls';
import { ed25519 } from '@noble/curves/ed25519.js';
import type { FetchLike } from '@beanpool/signin';
import { AlertBook, AlertChannelSender, type AlertKey, type Condition } from '../api/alerts.js';
import type { AlertChannels } from '../shared/settings.js';

/**
 * The watcher outside the vault (key vault design §3: "an outside uptime service checks it too"): what the vault can't
 * say about itself. Run by a custodian (or anyone) on another machine, `vault-custodian watch`, it looks at the vault
 * every minute and tells its own channels (the same kinds as the vault's: email, webhook) when:
 *
 *   - the vault doesn't answer for five minutes (the machine is gone, the host is down, the network is cut);
 *   - it answers locked for five minutes;
 *   - it answers open but gives no report signed by the ticket key the apps pin, or one that isn't fresh (a replay):
 *     the daily signed report has stopped;
 *   - its own signed report says backups, the off-box copy or the daily report are failing (what the vault raised,
 *     relayed, since its own alerts may be what is broken), or the newest backup it names is over two hours old.
 *
 * It holds no key and sends nothing to the vault but two GETs; nothing in what it reads or sends is per member.
 */

export const WATCH_DOWN_MS = 5 * 60 * 1000;
const STALE_MS = 2 * 60 * 60 * 1000 + 10 * 60 * 1000;
/** A report signed more than this far from the watcher's clock is old (a replay) or the vault's clock is wrong. */
const REPORT_SKEW_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;
const REPORT_TAG = 'beanpool-vault-report/1\n';

export interface WatchOptions {
    /** The vault, e.g. https://vault.beanpool.org */
    url: string;
    /** The vault's ticket key (64 hex), as the apps pin it: the only key a report is believed under. */
    ticketKey: string;
    channels: AlertChannels | null;
    fetch?: FetchLike;
    clock?: () => number;
    smtpTls?: tls.ConnectionOptions;
}

export interface WatchLook {
    at: number;
    reachable: boolean;
    state: string | null;
    reportOk: boolean;
    problems: { key: AlertKey; detail: string }[];
}

interface SignedReport {
    v?: number;
    at?: number;
    uptimeSeconds?: number;
    /** When the vault opened, as its API saw it: no backup is taken while it is locked, so staleness counts from here. */
    openSince?: number;
    backups?: { lastOkAt?: number | null; failuresInARow?: number };
    offsite?: { lastOkAt?: number | null; failuresInARow?: number; error?: string | null } | null;
    alerts?: { active?: string[] };
}

export class VaultWatcher {
    private readonly fetch: FetchLike;
    private readonly clock: () => number;
    private readonly base: string;
    private readonly book: AlertBook;
    private downSince: number | null = null;
    private lockedSince: number | null = null;
    private reportBadSince: number | null = null;

    constructor(private readonly opts: WatchOptions) {
        this.fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
        this.clock = opts.clock ?? (() => Date.now());
        this.base = opts.url.replace(/\/$/, '');
        if (!/^[0-9a-f]{64}$/.test(opts.ticketKey)) throw new Error('The ticket key is 64 lower-case hex characters (the key the apps pin).');
        const name = new URL(this.base).host;
        this.book = new AlertBook({
            vaultName: name, clock: this.clock, channels: () => opts.channels,
            sender: new AlertChannelSender({ fetch: opts.fetch, heloName: 'vault-watcher', smtpTls: opts.smtpTls, clock: this.clock }),
        });
    }

    private async getJson(p: string): Promise<{ status: number; body: Record<string, unknown> } | { error: string }> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const res = await this.fetch(`${this.base}${p}`, { signal: controller.signal, redirect: 'error' });
            const text = await res.text();
            try {
                return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
            } catch {
                return { status: res.status, body: {} };
            }
        } catch {
            return { error: controller.signal.aborted ? 'timed out' : 'unreachable' };
        } finally {
            clearTimeout(timer);
        }
    }

    /** Is this the vault's report, signed by the pinned ticket key, and fresh? Its contents, or why not. */
    private checkReport(body: Record<string, unknown>, now: number): { report: SignedReport } | { why: string } {
        const r = body.report as { text?: unknown; signature?: unknown } | undefined;
        if (!r || typeof r.text !== 'string' || typeof r.signature !== 'string') return { why: 'it gives no signed report' };
        let ok = false;
        try {
            ok = ed25519.verify(Buffer.from(r.signature, 'base64url'), Buffer.from(`${REPORT_TAG}${r.text}`, 'utf8'), Buffer.from(this.opts.ticketKey, 'hex'));
        } catch {
            ok = false;
        }
        if (!ok) return { why: 'its report is not signed by the vault\'s ticket key' };
        let report: SignedReport;
        try {
            report = JSON.parse(r.text) as SignedReport;
        } catch {
            return { why: 'its signed report is not readable' };
        }
        if (typeof report.at !== 'number' || Math.abs(now - report.at) > REPORT_SKEW_MS) {
            return { why: `its signed report is from ${typeof report.at === 'number' ? new Date(report.at).toISOString().slice(0, 16) : 'no time'}Z, not now (a replay, or its clock is wrong)` };
        }
        return { report };
    }

    /** One look at the vault; the conditions go to the alert book (which tells the channels). */
    async check(): Promise<WatchLook> {
        const now = this.clock();
        const problems: WatchLook['problems'] = [];
        const health = await this.getJson('/v1/health');
        const reachable = !('error' in health) && health.status === 200;
        const state = reachable ? String((health as { body: Record<string, unknown> }).body.state ?? '') : null;
        if (!reachable) this.downSince ??= now;
        else this.downSince = null;
        if (reachable && state !== 'open') this.lockedSince ??= now;
        else this.lockedSince = null;

        let reportOk = false;
        let report: SignedReport | null = null;
        let reportWhy = '';
        if (reachable && state === 'open') {
            const got = await this.getJson('/v1/report');
            if ('error' in got) reportWhy = `its report did not come (${got.error})`;
            else if (got.status !== 200) reportWhy = `its report answers HTTP ${got.status}`;
            else {
                const checked = this.checkReport(got.body, now);
                if ('why' in checked) reportWhy = checked.why;
                else report = checked.report;
            }
            reportOk = !!report;
            if (reportOk) this.reportBadSince = null;
            else this.reportBadSince ??= now;
        } else {
            this.reportBadSince = null;
        }

        const why = 'error' in health ? health.error : `HTTP ${(health as { status: number }).status}`;
        const conditions: Condition[] = [
            {
                key: 'unreachable', active: this.downSince !== null && now - this.downSince >= WATCH_DOWN_MS, since: this.downSince ?? undefined,
                detail: this.downSince === null ? 'it answers again.' : `it does not answer from outside (${why}): the machine, its host or its network is down.`,
            },
            {
                key: 'locked', active: this.lockedSince !== null && now - this.lockedSince >= WATCH_DOWN_MS, since: this.lockedSince ?? undefined,
                detail: this.lockedSince === null ? 'it answers open again.' : 'it answers locked: two custodians must unlock it.',
            },
        ];
        // The report's conditions only when the vault answers open: locked or gone, nothing is known of them, and what was
        // raised stays raised (never "resolved" for want of a look).
        if (reachable && state === 'open') {
            const relayed = new Set(report?.alerts?.active ?? []);
            conditions.push({
                key: 'report', active: (this.reportBadSince !== null && now - this.reportBadSince >= WATCH_DOWN_MS) || relayed.has('report'),
                since: this.reportBadSince ?? undefined,
                detail: reportWhy ? `${reportWhy}.` : relayed.has('report') ? 'its own signed report says a day\'s report was not made.' : 'its signed report is back.',
            });
            if (report) {
                // As the vault's own check does: from the later of when it opened and the newest backup (none is taken while it is locked).
                const openedAt = typeof report.openSince === 'number' ? report.openSince : now - (report.uptimeSeconds ?? 0) * 1000;
                const lastBackup = report.backups?.lastOkAt ?? null;
                const backupOld = now - Math.max(openedAt, lastBackup ?? 0) > STALE_MS;
                const off = report.offsite ?? null;
                const offsiteOld = !!off && now - Math.max(openedAt, off.lastOkAt ?? 0) > STALE_MS;
                const backupBad = relayed.has('backup') || backupOld;
                const offsiteBad = relayed.has('offsite') || offsiteOld;
                conditions.push(
                    {
                        key: 'backup', active: backupBad, since: lastBackup ?? undefined,
                        detail: backupBad
                            ? `its signed report says backups are failing (${report.backups?.failuresInARow ?? 0} in a row; the newest ${lastBackup ? `at ${new Date(lastBackup).toISOString().slice(0, 16)}Z` : 'unknown'}).`
                            : 'its signed report says backups work again.',
                    },
                    {
                        key: 'offsite', active: offsiteBad, since: off?.lastOkAt ?? undefined,
                        detail: offsiteBad
                            ? `its signed report says the off-box copy is failing (${off?.failuresInARow ?? 0} in a row${off?.error ? `, ${off.error}` : ''}).`
                            : 'its signed report says backups go off the box again.',
                    },
                );
            }
        }
        for (const c of conditions) if (c.active) problems.push({ key: c.key, detail: c.detail });
        await this.book.update(conditions);
        return { at: now, reachable, state, reportOk, problems };
    }

    status() {
        return this.book.status();
    }
}

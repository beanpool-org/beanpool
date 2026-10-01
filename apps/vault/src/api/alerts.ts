import type tls from 'node:tls';
import type { FetchLike } from '@beanpool/signin';
import type { AlertChannels } from '../shared/settings.js';
import { sendMail, SmtpError } from './smtp.js';

/**
 * Alerts to the custodians (key vault design §3, §4): when the vault is locked (or its keyholder unreachable) for five
 * minutes, when backups fail twice in a row or the newest is more than two hours old, the same for the off-box copy,
 * and when a day's signed report was not made. Each goes to the configured channels (shared/settings.ts: an email
 * through an SMTP server, a webhook), once when it starts, again every 24 hours while it lasts, and once when it ends.
 *
 * What an alert says is the vault's own words: which condition, since when, a count, and an error in a few words. It
 * names no member, key, sign-in, address or token: the vault keeps none it could name. The same alert book serves the
 * watcher outside the vault (custodian/watch.ts), which sees what the vault can't say about itself: that it is gone.
 *
 * A channel that fails is tried again every five minutes; what waits for it is kept (up to 50 events) and goes in one
 * message. With no channel set, nothing is sent and the report says so.
 */

export const ALERT_REMIND_MS = 24 * 60 * 60 * 1000;
export const ALERT_RETRY_MS = 5 * 60 * 1000;
const MAX_WAITING = 50;
const WEBHOOK_TIMEOUT_MS = 15_000;

export type AlertKey = 'locked' | 'unreachable' | 'backup' | 'offsite' | 'report';

export interface Condition {
    key: AlertKey;
    active: boolean;
    /** What it is, in the vault's own words, for the message (nothing per member). */
    detail: string;
    /** When it began, if known. */
    since?: number;
}

export interface AlertEvent {
    key: AlertKey;
    kind: 'raised' | 'still' | 'cleared';
    at: number;
    since: number;
    detail: string;
}

export interface AlertMessage {
    subject: string;
    text: string;
    events: AlertEvent[];
}

const TITLES: Record<AlertKey, string> = {
    locked: 'locked',
    unreachable: 'unreachable',
    backup: 'backups failing',
    offsite: 'off-box backups failing',
    report: 'daily report missing',
};

function when(ms: number): string {
    return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The words of one message for `events`, about the vault called `vaultName`. */
export function composeAlert(vaultName: string, events: AlertEvent[]): AlertMessage {
    const first = events[0];
    const head = first.kind === 'cleared' ? `${TITLES[first.key]}: resolved` : TITLES[first.key];
    const subject = `BeanPool key vault ${vaultName}: ${head}${events.length > 1 ? ` (+${events.length - 1} more)` : ''}`;
    const lines = events.map(e => {
        if (e.kind === 'cleared') return `- RESOLVED (${TITLES[e.key]}, since ${when(e.since)}): ${e.detail}`;
        return `- ${e.kind === 'still' ? 'STILL ' : ''}${TITLES[e.key].toUpperCase()} since ${when(e.since)}: ${e.detail}`;
    });
    const text = [
        `The BeanPool key vault at ${vaultName}:`,
        '',
        ...lines,
        '',
        `Its signed report, while it is open: https://${vaultName}/v1/report`,
        'This message names no member: the vault keeps nothing it could name one by.',
    ].join('\n');
    return { subject, text, events };
}

export interface ChannelStatus {
    lastOkAt: number | null;
    failedInARow: number;
    error: string | null;
}

/** Sends one message to every configured channel. */
export class AlertChannelSender {
    readonly status: Record<'email' | 'webhook', ChannelStatus> = {
        email: { lastOkAt: null, failedInARow: 0, error: null },
        webhook: { lastOkAt: null, failedInARow: 0, error: null },
    };

    constructor(private readonly opts: { fetch?: FetchLike; heloName: string; smtpTls?: tls.ConnectionOptions; clock?: () => number }) {}

    /** True when at least one channel took it. Each channel's result goes into `status`. */
    async send(channels: AlertChannels, m: AlertMessage): Promise<boolean> {
        const now = this.opts.clock?.() ?? Date.now();
        const results = await Promise.all([
            channels.email ? this.mail(channels, m, now).then(() => this.ok('email', now), e => this.failed('email', e)) : null,
            channels.webhook ? this.hook(channels, m).then(() => this.ok('webhook', now), e => this.failed('webhook', e)) : null,
        ]);
        return results.some(r => r === true);
    }

    private ok(which: 'email' | 'webhook', now: number): true {
        this.status[which] = { lastOkAt: now, failedInARow: 0, error: null };
        return true;
    }

    private failed(which: 'email' | 'webhook', e: unknown): false {
        const s = this.status[which];
        s.failedInARow++;
        s.error = e instanceof SmtpError || e instanceof WebhookError ? e.short : 'failed';
        return false;
    }

    private mail(channels: AlertChannels, m: AlertMessage, now: number): Promise<void> {
        return sendMail(channels.email!, { subject: m.subject, text: m.text, date: now }, { heloName: this.opts.heloName, tlsOptions: this.opts.smtpTls });
    }

    private async hook(channels: AlertChannels, m: AlertMessage): Promise<void> {
        const w = channels.webhook!;
        const fetchFn: FetchLike = this.opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
        try {
            const body = w.format === 'text' ? `${m.subject}\n\n${m.text}` : JSON.stringify({
                text: `${m.subject}\n\n${m.text}`, content: `${m.subject}\n\n${m.text}`.slice(0, 2000), subject: m.subject,
                events: m.events.map(e => ({ condition: e.key, state: e.kind, since: new Date(e.since).toISOString(), detail: e.detail })),
            });
            const res = await fetchFn(w.url, {
                method: 'POST', body, signal: controller.signal, redirect: 'error',
                headers: { 'Content-Type': w.format === 'text' ? 'text/plain; charset=utf-8' : 'application/json', ...(w.format === 'text' ? { Title: m.subject } : {}) },
            });
            await res.arrayBuffer().catch(() => undefined);
            if (res.status < 200 || res.status >= 300) throw new WebhookError(`HTTP ${res.status}`);
        } catch (e) {
            if (e instanceof WebhookError) throw e;
            throw new WebhookError(controller.signal.aborted ? 'timed out' : 'unreachable');
        } finally {
            clearTimeout(timer);
        }
    }
}

export class WebhookError extends Error {
    constructor(readonly short: string) {
        super(short);
        this.name = 'WebhookError';
    }
}

interface Raised {
    since: number;
    detail: string;
    toldAt: number;
}

export interface AlertBookStatus {
    channels: string[];
    active: AlertKey[];
    lastSentAt: number | null;
    waiting: number;
    dropped: number;
    email: ChannelStatus | null;
    webhook: ChannelStatus | null;
}

/**
 * Which conditions are raised, and the events still to be told. `update` is called with every condition each tick
 * (a minute in the API); it raises what became active, reminds of what stayed active a day, clears what ended, and sends
 * what waits when a channel is set and a try is due.
 */
export class AlertBook {
    private readonly raised = new Map<AlertKey, Raised>();
    private waiting: AlertEvent[] = [];
    private nextTryAt = 0;
    private lastSentAt: number | null = null;
    private dropped = 0;
    private sending: Promise<void> | null = null;

    constructor(private readonly opts: {
        vaultName: string;
        sender: AlertChannelSender;
        channels: () => AlertChannels | null;
        clock: () => number;
        remindMs?: number;
        retryMs?: number;
    }) {}

    async update(conditions: readonly Condition[]): Promise<void> {
        const now = this.opts.clock();
        const remind = this.opts.remindMs ?? ALERT_REMIND_MS;
        const push = (e: AlertEvent) => {
            this.waiting.push(e);
            if (this.waiting.length > MAX_WAITING) {
                this.waiting.shift();
                this.dropped++;
            }
        };
        for (const c of conditions) {
            const r = this.raised.get(c.key);
            if (c.active && !r) {
                const since = c.since ?? now;
                this.raised.set(c.key, { since, detail: c.detail, toldAt: now });
                push({ key: c.key, kind: 'raised', at: now, since, detail: c.detail });
            } else if (c.active && r) {
                r.detail = c.detail;
                if (now - r.toldAt >= remind) {
                    r.toldAt = now;
                    push({ key: c.key, kind: 'still', at: now, since: r.since, detail: c.detail });
                }
            } else if (!c.active && r) {
                this.raised.delete(c.key);
                push({ key: c.key, kind: 'cleared', at: now, since: r.since, detail: c.detail });
            }
        }
        await this.flush();
    }

    /** Sends what waits, if a channel is set and a try is due. One send at a time. */
    async flush(): Promise<void> {
        if (this.sending) return this.sending;
        const now = this.opts.clock();
        const channels = this.opts.channels();
        if (!this.waiting.length || !channels || now < this.nextTryAt) return;
        const events = this.waiting;
        this.sending = (async () => {
            const delivered = await this.opts.sender.send(channels, composeAlert(this.opts.vaultName, events));
            if (delivered) {
                this.waiting = this.waiting.filter(e => !events.includes(e));
                this.lastSentAt = this.opts.clock();
                this.nextTryAt = 0;
            } else {
                this.nextTryAt = this.opts.clock() + (this.opts.retryMs ?? ALERT_RETRY_MS);
            }
        })().finally(() => {
            this.sending = null;
        });
        return this.sending;
    }

    active(): AlertKey[] {
        return [...this.raised.keys()];
    }

    status(): AlertBookStatus {
        const channels = this.opts.channels();
        const s = this.opts.sender.status;
        return {
            channels: [channels?.email ? 'email' : null, channels?.webhook ? 'webhook' : null].filter((x): x is string => !!x),
            active: this.active(), lastSentAt: this.lastSentAt, waiting: this.waiting.length, dropped: this.dropped,
            email: channels?.email ? { ...s.email } : null, webhook: channels?.webhook ? { ...s.webhook } : null,
        };
    }
}

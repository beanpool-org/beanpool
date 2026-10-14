import type { FetchLike } from '@beanpool/signin';

/**
 * Notices to a member's devices (key vault design §1.5), through Expo's push service, straight from the vault.
 *
 * - A push never blocks anything: it is sent after the answer is decided, a failure is counted and dropped, and the
 *   hold is what protects (a missed push means the member sees it at the next app open, from `/v1/copies/status`).
 * - Nothing of the copy goes in one: a title, a line of text, and `data.type` so the app knows to read its status.
 *   No key, no sub, no hold id, no envelope.
 * - Tokens come out of the member's envelopes, which the API can only read while the vault is open.
 *
 * Expo may require an access token for BeanPool's project (design §10, unverified). If it does, it is passed in here.
 */

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const PUSH_TIMEOUT_MS = 10_000;

export type PushKind = 'vault-hold' | 'vault-released' | 'vault-replaced';

export interface PushMessage {
    to: string;
    title: string;
    body: string;
    sound: 'default';
    priority: 'high';
    data: { type: PushKind };
}

/** The words of each notice, for the provider as a member reads it ("Google"). */
export function noticeFor(kind: PushKind, providerLabel: string): { title: string; body: string } {
    switch (kind) {
        case 'vault-hold':
            return {
                title: 'Someone is getting back into your BeanPool account',
                body: `Someone used ${providerLabel} to get back into your BeanPool account on another device. If it was you, open `
                    + 'BeanPool here and tap "Yes, it\'s me" to let it through now; otherwise it goes through in 24 hours. '
                    + 'Not you? Open BeanPool and tap Stop.',
            };
        case 'vault-released':
            return {
                title: 'Your BeanPool account was restored',
                body: `Your BeanPool account was just restored with ${providerLabel} on another device. If that wasn't you, open BeanPool now.`,
            };
        case 'vault-replaced':
            return {
                title: 'Sign-in recovery moved to another account',
                body: `Your ${providerLabel} account now protects a different BeanPool account. This one has only its 12 words.`,
            };
    }
}

export class PushSender {
    private readonly inFlight = new Set<Promise<void>>();
    sent = 0;
    failed = 0;

    constructor(private readonly opts: { fetch?: FetchLike; url?: string; accessToken?: string }) {}

    /** Sends `kind` to every token, in the background. */
    notify(tokens: readonly string[], kind: PushKind, providerLabel: string): void {
        const unique = [...new Set(tokens)];
        if (!unique.length) return;
        const { title, body } = noticeFor(kind, providerLabel);
        const messages: PushMessage[] = unique.map(to => ({ to, title, body, sound: 'default', priority: 'high', data: { type: kind } }));
        const job = this.send(messages).finally(() => this.inFlight.delete(job));
        this.inFlight.add(job);
    }

    private async send(messages: PushMessage[]): Promise<void> {
        const fetchFn: FetchLike = this.opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
        try {
            const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' };
            if (this.opts.accessToken) headers.Authorization = `Bearer ${this.opts.accessToken}`;
            const res = await fetchFn(this.opts.url ?? EXPO_PUSH_URL, {
                method: 'POST', headers, body: JSON.stringify(messages), signal: controller.signal,
            });
            if (res.ok) this.sent += messages.length;
            else this.failed += messages.length;
        } catch {
            this.failed += messages.length;
        } finally {
            clearTimeout(timer);
        }
    }

    /** Resolves once every push sent so far has finished (tests, and shutdown). */
    async idle(): Promise<void> {
        while (this.inFlight.size) await Promise.allSettled([...this.inFlight]);
    }
}

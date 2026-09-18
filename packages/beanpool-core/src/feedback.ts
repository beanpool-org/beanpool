/**
 * "Suggest a change to BeanPool" — the client half, shared by the member app, the PWA and the node
 * Settings app.
 *
 * Every install reports to the PROJECT, not to its own node: a self-hosted community on another
 * continent still reaches us. So the endpoint is one fixed constant here, not node config.
 * The server half is apps/feedback (a Cloudflare Worker); its limits in src/validate.js mirror these.
 */

export const FEEDBACK_ENDPOINT = 'https://beanpool.org/api/feedback';

export const FEEDBACK_TEXT_MIN = 10;
export const FEEDBACK_TEXT_MAX = 2000;
export const FEEDBACK_COMMUNITY_MAX = 80;

export type FeedbackKind = 'idea' | 'problem' | 'other';
export type FeedbackSource = 'member-app' | 'web' | 'settings-app';

export const FEEDBACK_KINDS: ReadonlyArray<{ id: FeedbackKind; label: string }> = [
    { id: 'idea', label: 'Idea' },
    { id: 'problem', label: 'Problem' },
    { id: 'other', label: 'Other' },
];

/** The sentence every form shows above the text box. */
export const FEEDBACK_NOTICE =
    "This goes to the BeanPool project team, not to your community. Don't include personal details.";

export const FEEDBACK_THANKS = 'Thank you — your suggestion has reached the BeanPool project team.';

/** Characters as a person counts them, so a suggestion in any script gets the same room. */
export function feedbackCharCount(text: string): number {
    return [...text.trim()].length;
}

/** A message for the member, or null when the text can be sent. */
export function feedbackTextProblem(text: string): string | null {
    const n = feedbackCharCount(text);
    if (n < FEEDBACK_TEXT_MIN) return `Please write at least ${FEEDBACK_TEXT_MIN} characters.`;
    if (n > FEEDBACK_TEXT_MAX) return `Please keep it under ${FEEDBACK_TEXT_MAX} characters (${n} now).`;
    return null;
}

export interface FeedbackInput {
    text: string;
    kind: FeedbackKind;
    source: FeedbackSource;
    appVersion?: string | null;
    platform?: string | null;
    lang?: string | null;
    /** Only what the member typed. Forms start this EMPTY — never prefill it from the node. */
    community?: string | null;
}

export type FeedbackResult = { ok: true } | { ok: false; error: string };

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) =>
    Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const NETWORK_ERROR = "Couldn't reach the BeanPool project just now. Your text is still here — please try again later.";

/** The exact JSON the Worker receives. Exported so the tests can pin it. */
export function buildFeedbackBody(input: FeedbackInput): Record<string, string> {
    const body: Record<string, string> = {
        text: input.text.trim(),
        kind: input.kind,
        source: input.source,
        website: '', // honeypot: always empty from a real form
    };
    if (input.appVersion) body.appVersion = input.appVersion;
    if (input.platform) body.platform = input.platform;
    if (input.lang) body.lang = input.lang;
    const community = input.community?.trim();
    if (community) body.community = community;
    return body;
}

/**
 * Sends one suggestion. Never throws: a failure comes back as a message for the member, and the
 * caller keeps the text on screen.
 */
export async function submitFeedback(
    input: FeedbackInput,
    opts: { fetch?: FetchLike; endpoint?: string; timeoutMs?: number } = {},
): Promise<FeedbackResult> {
    const problem = feedbackTextProblem(input.text);
    if (problem) return { ok: false, error: problem };
    const community = input.community?.trim() ?? '';
    if ([...community].length > FEEDBACK_COMMUNITY_MAX) {
        return { ok: false, error: `Please keep the community name under ${FEEDBACK_COMMUNITY_MAX} characters.` };
    }

    const doFetch: FetchLike = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000) : undefined;
    try {
        const res = await doFetch(opts.endpoint ?? FEEDBACK_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(buildFeedbackBody(input)),
            signal: controller?.signal,
        });
        if (res.ok) return { ok: true };
        let message: string | undefined;
        try {
            const data = (await res.json()) as { error?: unknown };
            if (typeof data?.error === 'string' && data.error) message = data.error;
        } catch { /* not JSON — fall through to a generic message */ }
        if (message) return { ok: false, error: message };
        if (res.status === 429) return { ok: false, error: 'Too many suggestions from your connection recently. Please try again later — your text is still here.' };
        return { ok: false, error: NETWORK_ERROR };
    } catch {
        return { ok: false, error: NETWORK_ERROR };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * "Suggest a change to BeanPool" — the client half, shared by the member app, the PWA and the node
 * Settings app.
 *
 * Every install reports to the PROJECT, not to its own node: a self-hosted community on another
 * continent still reaches us. So the endpoint is one fixed constant here, not node config.
 * The server half is apps/feedback (a Cloudflare Worker); its limits in src/validate.js mirror these.
 */

import { t, tn, word, type WordKey } from './words.js';

export const FEEDBACK_ENDPOINT = 'https://beanpool.org/api/feedback';

/**
 * Whether the Worker behind FEEDBACK_ENDPOINT is deployed. Every "Suggest a change" entry point hides while this is
 * false, so no build sends suggestions into the website's HTML fallback. Flip it to true in the same change that
 * deploys apps/feedback (release checklist).
 */
export const FEEDBACK_LIVE = false;

export const FEEDBACK_TEXT_MIN = 10;
export const FEEDBACK_TEXT_MAX = 2000;
export const FEEDBACK_COMMUNITY_MAX = 80;

export type FeedbackKind = 'idea' | 'problem' | 'other';
export type FeedbackSource = 'member-app' | 'web' | 'settings-app';

/**
 * Each kind's label is a word() key: the phone shows it through t(), in the member's language. No context: the web app and
 * the manager draw the label as it is, so it stays the plain English.
 */
export const FEEDBACK_KINDS: ReadonlyArray<{ id: FeedbackKind; label: WordKey }> = [
    { id: 'idea', label: word('Idea') },
    { id: 'problem', label: word('Problem') },
    { id: 'other', label: word('Other') },
];

/** The form's two fixed sentences, as word() keys: a form shows them through t(). */
export const FEEDBACK_LINES = {
    /** The sentence every form shows above the text box. */
    notice: word("This goes to the BeanPool project team, not to your community. Don't include personal details."),
    thanks: word('Thank you — your suggestion has reached the BeanPool project team.'),
} as const;

/** The sentence every form shows above the text box. */
export const FEEDBACK_NOTICE: string = FEEDBACK_LINES.notice;

export const FEEDBACK_THANKS: string = FEEDBACK_LINES.thanks;

/** Characters as a person counts them, so a suggestion in any script gets the same room. */
export function feedbackCharCount(text: string): number {
    return [...text.trim()].length;
}

/** A message for the member, in their language, or null when the text can be sent. */
export function feedbackTextProblem(text: string): string | null {
    const n = feedbackCharCount(text);
    if (n < FEEDBACK_TEXT_MIN) return tn(FEEDBACK_TEXT_MIN, 'Please write at least {n} characters.', 'Please write at least {n} characters.');
    if (n > FEEDBACK_TEXT_MAX) return tn(FEEDBACK_TEXT_MAX, 'Please keep it under {n} characters ({count} now).', 'Please keep it under {n} characters ({count} now).', { count: n });
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

const LINES = { networkError: word("Couldn't reach the BeanPool project just now. Your text is still here — please try again later.") } as const;

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
        return { ok: false, error: tn(FEEDBACK_COMMUNITY_MAX, 'Please keep the community name under {n} characters.', 'Please keep the community name under {n} characters.') };
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
        let data: { ok?: unknown; error?: unknown } | undefined;
        try { data = (await res.json()) as { ok?: unknown; error?: unknown }; } catch { /* not JSON */ }
        // Only our Worker's own {ok:true} counts as sent. Anything else that answers 2xx (a static page, a
        // captive portal) must not tell the member "thank you" while their text is lost (#919 review).
        if (res.ok && data?.ok === true) return { ok: true };
        let message: string | undefined;
        try {
            if (typeof data?.error === 'string' && data.error) message = data.error;
        } catch { /* fall through to a generic message */ }
        if (message) return { ok: false, error: message };
        if (res.status === 429) return { ok: false, error: t('Too many suggestions from your connection recently. Please try again later — your text is still here.') };
        return { ok: false, error: t(LINES.networkError) };
    } catch {
        return { ok: false, error: t(LINES.networkError) };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

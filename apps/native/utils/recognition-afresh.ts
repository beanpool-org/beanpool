/**
 * The root layout's "does the community in use know this key?" (app/NodeStatusContext.tsx `recognition`), asked afresh for
 * the community a switch has just moved the phone to, by the switch itself (use-communities.ts `switchCommunity`).
 *
 * Why: every switch bounces through Welcome, where the root guard (app/_layout.tsx) lands the account on the tabs. The guard
 * reads the recognition, and nothing asked it again on a tap of a community's row: it still held the answer of the community
 * left. A guest of one community (a "stranger" there) who switched back to their own was held on Welcome as a stranger, and
 * saw the newcomers' front door until the app was stopped and opened again (director, 27 Nov, release 1.4.8 on Android 16).
 * Asked afresh, the answer held is dropped at once, as at a cold start ('unknown', on which the guard lands an account on the
 * tabs), and the community now in use is asked; its answer then acts as at any start (a guest stays, a stranger it doesn't
 * know goes to the not-recognised screen).
 *
 * Only the switches that bounce through Welcome ask: the one switch, and Settings' saved-community switch (app/(tabs)/settings.tsx
 * handleSwitchNode). A join that moves the phone before its redeem lands (Welcome's invite, the deep link's Switch & Join) asks
 * the recognition itself once the redeem is in, so a "not a member yet" asked mid-join never diverts it, and a guest using an
 * invite on Welcome is never moved off it.
 *
 * No imports, so anything can ask. With no provider drawn (a test, a screen outside the root layout), it asks nothing.
 */
type AskAfresh = (url: string) => Promise<unknown>;

let provider: AskAfresh | null = null;

/** The root layout's node status hands over its ask (app/NodeStatusContext.tsx). Returns the way to take it back. */
export function provideRecognitionAfresh(ask: AskAfresh): () => void {
    provider = ask;
    return () => { if (provider === ask) provider = null; };
}

/**
 * The phone is now on `url`: the recognition held (the community left's) is dropped before this returns, and `url` is asked.
 * Resolves the answer, 'unknown' with none or no provider. Never throws.
 */
export function askRecognitionAfresh(url: string): Promise<unknown> {
    if (!provider) return Promise.resolve('unknown');
    try {
        return provider(url).catch(() => 'unknown');
    } catch {
        return Promise.resolve('unknown');
    }
}

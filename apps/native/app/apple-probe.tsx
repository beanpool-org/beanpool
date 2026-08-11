/**
 * Apple Sign In `sub` parity probe — native half. Temporary, and inert outside dev builds.
 *
 * Pairs with `apps/server/src/routes/apple-probe.ts`. See that file for why this exists: the
 * sign-in keeper (docs/ONBOARDING.md K4) derives its unwrap key from Apple's subject claim, and
 * that only holds if the native App ID and the web Services ID are grouped under the same primary
 * App ID. If they are not, the same person gets a different `sub` here than in the browser, and a
 * fragment stored at signup will not unwrap during a recovery attempted from a laptop.
 *
 * Sign in here and on the web page with the same Apple ID, compare the two strings, write the
 * answer down, delete both files.
 *
 * ## Why the __DEV__ guard
 *
 * expo-router routes every file under `app/`, so this screen is reachable in a production build
 * via `beanpool://apple-probe` whether or not anything links to it. The guard makes it render
 * nothing useful outside a dev build — the diagnostic can't be reached by a real user, and can't
 * be demonstrated to one.
 *
 * Requires a development build: Sign in with Apple needs an entitlement tied to the bundle ID,
 * which Expo Go cannot provide.
 */

import React, { useEffect, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Clipboard from 'expo-clipboard';
import * as Crypto from 'expo-crypto';
import { Stack } from 'expo-router';
import { useIdentity } from './IdentityContext';
import { anchorUrl, signedPost } from '../utils/node-post';
import { SsoSignInError, fetchSsoNonce } from '../utils/sso-signin';
import type { BeanPoolIdentity } from '../utils/identity';

/**
 * Which form of the nonce Apple echoed — and this is a measurement, not a check.
 *
 * `apps/server/src/sso.ts` accepts either the nonce verbatim or its SHA-256 for Apple, on the
 * grounds that which one arrives "varies by platform and SDK". That tolerance was written from
 * the documentation. Nobody has ever seen which one this platform actually sends, because no
 * token has ever been produced. This is where that gets answered.
 *
 * Apple's own convention is a lowercase hex digest, so that is what the comparison uses.
 */
async function describeNonceEcho(sent: string, echoed: string): Promise<string> {
    if (echoed === sent) return 'VERBATIM — Apple echoed the nonce unchanged. The node accepts this.';
    const hashed = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, sent);
    if (echoed.toLowerCase() === hashed.toLowerCase()) {
        return 'HASHED — Apple echoed SHA-256(nonce). The node accepts this too (nonceMayBeHashed).';
    }
    // The one outcome that is a real problem: neither form matches, so the node will read this as
    // replay. Worth seeing here rather than as a 400 with no explanation.
    return `MISMATCH — echoed neither the nonce nor its SHA-256. Got: ${echoed.slice(0, 32)}…`;
}

/** Decode a JWT payload without verifying it — correct for a probe, wrong for anything else. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
        const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
        return JSON.parse(globalThis.atob(pad)) as Record<string, unknown>;
    } catch {
        return null;
    }
}

/**
 * Ask the node to verify a REAL Apple token — the one link in this chain that has never run.
 *
 * `verifyIdToken` has only ever seen test fixtures. Apple's live JWKS, a real RS256 signature, the
 * issuer, and the audience have never been checked against anything Apple actually issued.
 *
 * ## Why this deliberately sends the WRONG nonce
 *
 * `apps/server/src/sso.ts` verifies in a fixed order: shape, then Apple's JWKS, then the signature
 * — the code says "everything below this line is only meaningful because the signature held" — and
 * only then issuer, audience, expiry, and last of all the nonce. So a token rejected *for its
 * nonce* has already proved every expensive step passed against a live token. The failure IS the
 * measurement.
 *
 * Sending the correct nonce would instead deposit a fragment, and that is worse than it sounds: it
 * would be sealed with the pre-#248 HKDF key, and the entire argument for merging #248 now is that
 * no fragment exists yet to migrate. A probe must not manufacture the migration it exists to avoid.
 *
 * A 200 here is not a pass — it means the node accepted a nonce it never issued, which is the
 * replay protection failing open. That is why this reports three outcomes and not two.
 *
 * The placeholder ciphertext only exists to satisfy `parseShares`, which runs before verification.
 * It is never stored, because verification throws first.
 */
async function probeNodeVerification(
    url: string, identity: BeanPoolIdentity, idToken: string, nonce: string,
): Promise<string> {
    // Same length, same alphabet, one character different: it has to survive the "is a nonce
    // present" shape check and fail the "did this node issue it" check. An empty or malformed
    // value would be rejected early and would prove nothing.
    const wrongNonce = nonce.slice(0, -1) + (nonce.endsWith('A') ? 'B' : 'A');
    const body = {
        provider: 'apple',
        idToken,
        nonce: wrongNonce,
        shares: [{
            holderType: 'sso', holderRef: 'apple', shareIndex: 1,
            encryptedShare: 'cHJvYmU=', shareIv: 'cHJvYmU=', shareTag: 'cHJvYmU=',
        }],
    };

    let res: Response;
    try {
        res = await signedPost(url, '/api/recovery/shares/sso', body, identity);
    } catch (e) {
        return `UNREACHABLE — could not reach the node: ${(e as Error).message}`;
    }
    const text = await res.text().catch(() => '');

    if (res.status === 200) {
        return 'FAILED OPEN (200) — the node accepted a nonce it never issued. This is a replay '
            + 'protection bug, not a passing test. Do not ship until this is understood.';
    }
    // Everything the server can say about a nonce, kept broad on purpose: matching the exact
    // sentence would turn a reworded error message into a false failure.
    //
    // "could not be matched to this request" is the one that matters and the one this originally
    // missed — sso.ts phrases the nonce rejection without using the word "nonce" at all, because
    // the member-facing sentence should not name an internal mechanism. That cost a real reading:
    // the first live run reported STOPPED EARLIER when it had in fact passed every step. A
    // diagnostic that reads the server's prose has to be checked against the server's prose.
    if (/nonce|replay|already been used|not issued|could not be matched to this request/i.test(text)) {
        return `VERIFIED (${res.status}) — rejected on the nonce, which means Apple's JWKS, the `
            + `RS256 signature, the issuer, the audience and the expiry ALL passed against a real `
            + `token. Server said: ${text.slice(0, 200)}`;
    }
    return `STOPPED EARLIER (${res.status}) — it failed before reaching the nonce, so one of the `
        + `steps above it did not hold. Server said: ${text.slice(0, 300)}`;
}

/**
 * How the node half went. Held as one value rather than four booleans so the screen cannot show
 * a nonce and an error at once, which is exactly the ambiguity a diagnostic must not have.
 */
type NodeChain =
    | { stage: 'loading' }
    | { stage: 'no-identity' }
    | { stage: 'no-node' }
    | { stage: 'ready'; url: string; nonce: string; providers: string[] }
    | { stage: 'failed'; reason: string; detail: string };

export default function AppleProbeScreen() {
    const [available, setAvailable] = useState<boolean | null>(null);
    const [credentialUser, setCredentialUser] = useState<string | null>(null);
    const [tokenSub, setTokenSub] = useState<string | null>(null);
    const [audience, setAudience] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const { identity, isLoading } = useIdentity();
    const [chain, setChain] = useState<NodeChain>({ stage: 'loading' });
    /** What came back inside the token's `nonce` claim, checked against what the node issued. */
    const [nonceEcho, setNonceEcho] = useState<string | null>(null);
    /**
     * Held so the node can be asked to verify it. Apple's tokens are short-lived, so this is only
     * good for a minute or two after the sheet closes — sign in again if the node says expired.
     */
    const [idToken, setIdToken] = useState<string | null>(null);
    const [verifyResult, setVerifyResult] = useState<string | null>(null);
    const [verifying, setVerifying] = useState(false);

    useEffect(() => {
        if (!__DEV__) return;
        AppleAuthentication.isAvailableAsync().then(setAvailable).catch(() => setAvailable(false));
    }, []);

    /**
     * Fetch the nonce on mount rather than behind the button.
     *
     * The node half is the half that can be checked WITHOUT a human: signing a request, reaching
     * the node, and getting a nonce back needs no Apple ID and no tap, so opening this screen is
     * itself the test. Only the sheet needs a finger. Putting the fetch behind the button would
     * have made both halves untestable together.
     */
    useEffect(() => {
        if (!__DEV__ || isLoading) return;
        if (!identity) { setChain({ stage: 'no-identity' }); return; }
        let live = true;
        (async () => {
            const url = await anchorUrl();
            if (!live) return;
            if (!url) { setChain({ stage: 'no-node' }); return; }
            try {
                const { nonce, providers } = await fetchSsoNonce(url, identity);
                if (live) setChain({ stage: 'ready', url, nonce, providers });
            } catch (e) {
                if (!live) return;
                setChain({
                    stage: 'failed',
                    reason: e instanceof SsoSignInError ? e.reason : 'unknown',
                    detail: (e as Error).message,
                });
            }
        })();
        return () => { live = false; };
    }, [identity, isLoading]);

    if (!__DEV__) {
        return (
            <View style={styles.centre}>
                <Stack.Screen options={{ title: 'Not available' }} />
                <Text style={styles.muted}>This screen is a development diagnostic.</Text>
            </View>
        );
    }

    const signIn = async () => {
        setError(null);
        setNonceEcho(null);
        setIdToken(null);
        setVerifyResult(null);
        // The node's nonce when there is one. Without it the sheet still works and the sub-parity
        // half of this probe is unaffected — that measurement predates the nonce and does not need
        // it — but the chain is not being tested, and the screen says which of the two happened.
        const nonce = chain.stage === 'ready' ? chain.nonce : undefined;
        try {
            const credential = await AppleAuthentication.signInAsync({
                requestedScopes: [
                    AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
                    AppleAuthentication.AppleAuthenticationScope.EMAIL,
                ],
                ...(nonce ? { nonce } : {}),
            });

            // `credential.user` is Apple's stable per-team identifier. The identity token's `sub`
            // should be the same string — shown separately because the web probe can only read
            // the token, so comparing token-to-token is the like-for-like check.
            setCredentialUser(credential.user);
            setIdToken(credential.identityToken ?? null);

            const claims = credential.identityToken ? decodeJwtPayload(credential.identityToken) : null;
            setTokenSub(claims?.sub ? String(claims.sub) : null);
            setAudience(claims?.aud ? String(claims.aud) : null);

            if (nonce && claims?.nonce) {
                setNonceEcho(await describeNonceEcho(nonce, String(claims.nonce)));
            } else if (nonce) {
                setNonceEcho('Apple returned no nonce claim at all — the node would reject this token.');
            }
        } catch (e: any) {
            if (e?.code === 'ERR_REQUEST_CANCELED') return;
            setError(String(e?.message || e));
        }
    };

    return (
        <ScrollView contentContainerStyle={styles.container}>
            <Stack.Screen options={{ title: 'Apple sub probe' }} />

            <View style={styles.banner}>
                <Text style={styles.bannerText}>
                    Diagnostic screen. Sign in here and on the web probe with the same Apple ID, then
                    compare the two values.
                </Text>
            </View>

            {/*
              The node half, rendered before the button because it runs before the button. It is
              also the only part observable without a finger — a screenshot of this section is a
              complete test of "can this app get a nonce from its node", which is half the chain
              and the half that has never run.
            */}
            <Text style={styles.label}>1 · Node chain</Text>
            {chain.stage === 'loading' && <Text style={styles.muted}>Asking the node for a nonce…</Text>}
            {chain.stage === 'no-identity' && (
                <Text style={styles.error} accessibilityRole="alert">
                    No identity on this device. Finish signup first — the nonce request has to be signed.
                </Text>
            )}
            {chain.stage === 'no-node' && (
                <Text style={styles.error} accessibilityRole="alert">
                    No node configured. Join one first; there is nobody to ask for a nonce.
                </Text>
            )}
            {chain.stage === 'failed' && (
                <>
                    <Text style={styles.error} accessibilityRole="alert">FAILED ({chain.reason})</Text>
                    <Text style={styles.mono}>{chain.detail}</Text>
                </>
            )}
            {chain.stage === 'ready' && (
                <>
                    <Text style={styles.ok}>✓ nonce issued</Text>
                    <Text style={styles.mono}>{chain.nonce}</Text>
                    <Text style={styles.muted}>
                        from {chain.url}
                        {chain.providers.length > 0 && ` · accepts: ${chain.providers.join(', ')}`}
                    </Text>
                </>
            )}

            <Text style={styles.label}>2 · Apple sheet</Text>
            {chain.stage !== 'ready' && (
                <Text style={styles.muted}>
                    No node nonce, so signing in still measures the sub but does NOT test the chain.
                </Text>
            )}
            {Platform.OS !== 'ios' ? (
                <Text style={styles.muted}>Sign in with Apple is iOS only — run this on an iPhone.</Text>
            ) : available === false ? (
                <Text style={styles.muted}>
                    Not available on this device. Needs iOS 13+ and a development build (Expo Go cannot
                    provide the entitlement).
                </Text>
            ) : (
                <AppleAuthentication.AppleAuthenticationButton
                    buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
                    buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
                    cornerRadius={8}
                    style={styles.button}
                    onPress={signIn}
                />
            )}

            {error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}

            {nonceEcho && (
                <>
                    <Text style={styles.label}>3 · Nonce binding — the answer nobody has had</Text>
                    <Text style={nonceEcho.startsWith('MISMATCH') ? styles.error : styles.ok}>
                        {nonceEcho}
                    </Text>
                    <Text style={styles.muted}>
                        The server tolerates both forms on documentation alone. This is the first
                        time anything has measured which one arrives.
                    </Text>
                </>
            )}

            {idToken && chain.stage === 'ready' && identity && (
                <>
                    <Text style={styles.label}>4 · Does the node accept a real token?</Text>
                    <Text style={styles.muted}>
                        Sends this token to the node with a deliberately wrong nonce. Rejection ON
                        THE NONCE is the pass — it means the signature, issuer and audience all held
                        against Apple&apos;s live keys. Nothing is stored either way.
                    </Text>
                    <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel="Ask the node to verify this Apple token"
                        accessibilityState={{ disabled: verifying }}
                        disabled={verifying}
                        style={[styles.verifyButton, verifying && styles.verifyButtonBusy]}
                        onPress={async () => {
                            setVerifying(true);
                            setVerifyResult(null);
                            try {
                                setVerifyResult(
                                    await probeNodeVerification(chain.url, identity, idToken, chain.nonce),
                                );
                            } catch (e) {
                                setVerifyResult(`THREW — ${(e as Error).message}`);
                            } finally {
                                setVerifying(false);
                            }
                        }}
                    >
                        <Text style={styles.verifyButtonText}>
                            {verifying ? 'Asking the node…' : 'Ask the node to verify'}
                        </Text>
                    </TouchableOpacity>
                    {verifyResult && (
                        <Text style={verifyResult.startsWith('VERIFIED') ? styles.ok : styles.error}>
                            {verifyResult}
                        </Text>
                    )}
                </>
            )}

            {tokenSub && (
                <>
                    <Text style={styles.label}>Token sub — compare this with the web probe</Text>
                    <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel="Copy the token sub to the clipboard"
                        accessibilityHint="Copies the value so you can compare it with the web probe"
                        onPress={() => Clipboard.setStringAsync(tokenSub)}
                    >
                        <Text style={styles.value}>{tokenSub}</Text>
                        <Text style={styles.muted}>tap to copy</Text>
                    </TouchableOpacity>
                </>
            )}

            {credentialUser && (
                <>
                    <Text style={styles.label}>credential.user</Text>
                    <Text style={styles.mono}>{credentialUser}</Text>
                    <Text style={styles.muted}>
                        {credentialUser === tokenSub
                            ? 'matches the token sub, as expected'
                            : 'DIFFERS from the token sub — worth understanding before Phase E'}
                    </Text>
                </>
            )}

            {audience && (
                <>
                    <Text style={styles.label}>Audience (the native bundle ID)</Text>
                    <Text style={styles.mono}>{audience}</Text>
                    <Text style={styles.muted}>
                        The web probe's audience will be the Services ID. Different audiences are
                        expected; different subs are the problem.
                    </Text>
                </>
            )}
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: { padding: 20, paddingBottom: 60 },
    centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
    banner: {
        backgroundColor: '#fbeee9', borderLeftWidth: 4, borderLeftColor: '#a8442f',
        padding: 12, borderRadius: 4, marginBottom: 20,
    },
    bannerText: { fontSize: 13, color: '#5c2b20' },
    button: { width: 220, height: 44, alignSelf: 'center', marginVertical: 12 },
    label: {
        fontSize: 11, textTransform: 'uppercase', letterSpacing: 1,
        color: '#66625a', marginTop: 22, marginBottom: 6,
    },
    value: {
        fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
        fontSize: 15, borderWidth: 2, borderColor: '#2f6b46', borderRadius: 6,
        padding: 12, backgroundColor: '#fff',
    },
    mono: {
        fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
        fontSize: 13, backgroundColor: '#fff', borderWidth: 1, borderColor: '#e3ded3',
        borderRadius: 6, padding: 10,
    },
    verifyButton: {
        backgroundColor: '#2f6b46', borderRadius: 8, paddingVertical: 12,
        alignItems: 'center', marginTop: 12,
    },
    verifyButtonBusy: { backgroundColor: '#7d9a89' },
    verifyButtonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
    muted: { fontSize: 12, color: '#66625a', marginTop: 6 },
    error: { color: '#a8442f', marginTop: 14, fontSize: 13 },
    ok: { color: '#2f6b46', marginTop: 8, fontSize: 13, fontWeight: '600' },
});

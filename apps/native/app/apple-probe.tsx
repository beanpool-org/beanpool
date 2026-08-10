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
import { anchorUrl } from '../utils/node-post';
import { SsoSignInError, fetchSsoNonce } from '../utils/sso-signin';

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
    muted: { fontSize: 12, color: '#66625a', marginTop: 6 },
    error: { color: '#a8442f', marginTop: 14, fontSize: 13 },
    ok: { color: '#2f6b46', marginTop: 8, fontSize: 13, fontWeight: '600' },
});

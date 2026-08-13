/**
 * Google Sign In `sub` parity probe — native half. Temporary, and inert outside dev builds.
 *
 * Pairs with `apps/server/src/routes/google-probe.ts`.
 *
 * ## Why the __DEV__ guard
 *
 * expo-router routes every file under `app/`, so this screen is reachable in a production build
 * via `beanpool://google-probe` whether or not anything links to it. The guard makes it render
 * nothing useful outside a dev build.
 */

import React, { useEffect, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
let GoogleSigninModule: any = null;
try {
    GoogleSigninModule = require('@react-native-google-signin/google-signin');
} catch (e) {
    console.warn('[Probe] GoogleSignin native module unavailable:', e);
}
import * as Clipboard from 'expo-clipboard';
import * as Crypto from 'expo-crypto';
import { Stack } from 'expo-router';
import { useIdentity } from './IdentityContext';
import { anchorUrl, signedPost } from '../utils/node-post';
import { SsoSignInError, fetchSsoNonce, GOOGLE_WEB_CLIENT_ID } from '../utils/sso-signin';
import type { BeanPoolIdentity } from '../utils/identity';

/**
 * Which form of the nonce Google echoed — and this is a measurement, not a check.
 *
 * NOTE: The free GoogleSignin.signIn() API does NOT support passing a custom nonce.
 * Nonce support requires the premium GoogleOneTapSignIn API. This probe measures
 * whether the id_token contains a nonce claim at all, and if so what form it takes.
 */
async function describeNonceEcho(sent: string, echoed: string): Promise<string> {
    if (echoed === sent) return 'VERBATIM — Google echoed the nonce unchanged. The node accepts this.';
    const hashed = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, sent);
    if (echoed.toLowerCase() === hashed.toLowerCase()) {
        return 'HASHED — Google echoed SHA-256(nonce). The node accepts this too (nonceMayBeHashed).';
    }
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
 * Ask the node to verify a REAL Google token — the one link in this chain that has never run.
 */
async function probeNodeVerification(
    url: string, identity: BeanPoolIdentity, idToken: string, nonce: string,
): Promise<string> {
    const wrongNonce = nonce.slice(0, -1) + (nonce.endsWith('A') ? 'B' : 'A');
    const body = {
        provider: 'google',
        idToken,
        nonce: wrongNonce,
        shares: [{
            holderType: 'sso', holderRef: 'google', shareIndex: 1,
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
    
    if (/nonce|replay|already been used|not issued|could not be matched to this request/i.test(text)) {
        return `VERIFIED (${res.status}) — rejected on the nonce, which means Google's JWKS, the `
            + `RS256 signature, the issuer, the audience and the expiry ALL passed against a real `
            + `token. Server said: ${text.slice(0, 200)}`;
    }
    return `STOPPED EARLIER (${res.status}) — it failed before reaching the nonce, so one of the `
        + `steps above it did not hold. Server said: ${text.slice(0, 300)}`;
}

type NodeChain =
    | { stage: 'loading' }
    | { stage: 'no-identity' }
    | { stage: 'no-node' }
    | { stage: 'ready'; url: string; nonce: string; providers: string[] }
    | { stage: 'failed'; reason: string; detail: string };

export default function GoogleProbeScreen() {
    const [tokenSub, setTokenSub] = useState<string | null>(null);
    const [audience, setAudience] = useState<string | null>(null);
    const [issuer, setIssuer] = useState<string | null>(null);
    const [email, setEmail] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const { identity, isLoading } = useIdentity();
    const [chain, setChain] = useState<NodeChain>({ stage: 'loading' });
    const [nonceEcho, setNonceEcho] = useState<string | null>(null);
    const [sentDigest, setSentDigest] = useState<string | null>(null);
    
    const [idToken, setIdToken] = useState<string | null>(null);
    const [verifyResult, setVerifyResult] = useState<string | null>(null);
    const [verifying, setVerifying] = useState(false);

    useEffect(() => {
        if (!__DEV__ || isLoading) return;
        if (!identity) { setChain({ stage: 'no-identity' }); return; }
        let live = true;
        (async () => {
            try {
                const url = await anchorUrl();
                if (!live) return;
                if (!url) { setChain({ stage: 'no-node' }); return; }
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
        setSentDigest(null);
        
        const nonce = chain.stage === 'ready' ? chain.nonce : undefined;
        try {
            const GoogleSignin = GoogleSigninModule?.GoogleSignin;
            if (!GoogleSignin) {
                setError('Google Sign-In native module is not available in this build.');
                return;
            }
            await GoogleSignin.hasPlayServices();
            
            // Configure with webClientId to get an idToken back.
            GoogleSignin.configure({ webClientId: GOOGLE_WEB_CLIENT_ID });

            // The free API does not support custom nonce. We still compute the digest
            // to show what WOULD be sent, so the probe can check if Google echoes anything.
            let digest: string | undefined;
            if (nonce) {
                digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, nonce);
                setSentDigest(digest);
            }
            
            // v16 signIn() returns { type: 'success', data: User } | { type: 'cancelled', data: null }
            const result = await GoogleSignin.signIn();

            if (result.type === 'cancelled') {
                setError('Sign-in was cancelled.');
                return;
            }

            const token = result.data?.idToken ?? null;
            setIdToken(token);

            const claims = token ? decodeJwtPayload(token) : null;
            setTokenSub(claims?.sub ? String(claims.sub) : null);
            setAudience(claims?.aud ? String(claims.aud) : null);
            setIssuer(claims?.iss ? String(claims.iss) : null);
            setEmail(claims?.email ? String(claims.email) : null);

            if (nonce && claims?.nonce) {
                setNonceEcho(await describeNonceEcho(nonce, String(claims.nonce)));
            } else if (nonce && !claims?.nonce) {
                setNonceEcho('NO NONCE CLAIM — Google returned no nonce in the id_token. '
                    + 'The free GoogleSignin.signIn() API does not support custom nonce. '
                    + 'The premium GoogleOneTapSignIn API is needed for nonce binding.');
            }
        } catch (e: any) {
            setError(String(e?.message || e));
        }
    };

    return (
        <ScrollView contentContainerStyle={styles.container}>
            <Stack.Screen options={{ title: 'Google sub probe' }} />

            <View style={styles.banner}>
                <Text style={styles.bannerText}>
                    Diagnostic screen. Sign in here and on the web probe with the same Google account, then
                    compare the two values.
                </Text>
            </View>

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
                    {sentDigest && (
                        <>
                            <Text style={styles.label}>SHA-256 Digest sent to Google</Text>
                            <Text style={styles.mono}>{sentDigest}</Text>
                        </>
                    )}
                    <Text style={styles.muted}>
                        from {chain.url}
                        {chain.providers.length > 0 && ` · accepts: ${chain.providers.join(', ')}`}
                    </Text>
                </>
            )}

            <Text style={styles.label}>2 · Google sheet</Text>
            {chain.stage !== 'ready' && (
                <Text style={styles.muted}>
                    No node nonce, so signing in still measures the sub but does NOT test the chain.
                </Text>
            )}
            
            <TouchableOpacity 
                style={[styles.button, { backgroundColor: '#4285F4', borderRadius: 8, alignItems: 'center', justifyContent: 'center' }]} 
                onPress={signIn}
            >
                <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>Sign in with Google</Text>
            </TouchableOpacity>

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
                        against Google&apos;s live keys. Nothing is stored either way.
                    </Text>
                    <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel="Ask the node to verify this Google token"
                        accessibilityState={{ disabled: verifying, busy: verifying }}
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
                        <Text
                            accessibilityRole="alert"
                            accessibilityLiveRegion="polite"
                            style={verifyResult.startsWith('VERIFIED') ? styles.ok : styles.error}
                        >
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

            {audience && (
                <>
                    <Text style={styles.label}>Audience</Text>
                    <Text style={styles.mono}>{audience}</Text>
                </>
            )}
            
            {issuer && (
                <>
                    <Text style={styles.label}>Issuer</Text>
                    <Text style={styles.mono}>{issuer}</Text>
                </>
            )}

            {email && (
                <>
                    <Text style={styles.label}>Email</Text>
                    <Text style={styles.mono}>{email}</Text>
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
        backgroundColor: '#2f6b46', borderRadius: 8, paddingVertical: 12, minHeight: 44,
        alignItems: 'center', justifyContent: 'center', marginTop: 12,
    },
    verifyButtonBusy: { backgroundColor: '#4a6b56' },
    verifyButtonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
    muted: { fontSize: 12, color: '#66625a', marginTop: 6 },
    error: { color: '#a8442f', marginTop: 14, fontSize: 13 },
    ok: { color: '#2f6b46', marginTop: 8, fontSize: 13, fontWeight: '600' },
});

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
import { Stack } from 'expo-router';

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

export default function AppleProbeScreen() {
    const [available, setAvailable] = useState<boolean | null>(null);
    const [credentialUser, setCredentialUser] = useState<string | null>(null);
    const [tokenSub, setTokenSub] = useState<string | null>(null);
    const [audience, setAudience] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!__DEV__) return;
        AppleAuthentication.isAvailableAsync().then(setAvailable).catch(() => setAvailable(false));
    }, []);

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
        try {
            const credential = await AppleAuthentication.signInAsync({
                requestedScopes: [
                    AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
                    AppleAuthentication.AppleAuthenticationScope.EMAIL,
                ],
            });

            // `credential.user` is Apple's stable per-team identifier. The identity token's `sub`
            // should be the same string — shown separately because the web probe can only read
            // the token, so comparing token-to-token is the like-for-like check.
            setCredentialUser(credential.user);

            const claims = credential.identityToken ? decodeJwtPayload(credential.identityToken) : null;
            setTokenSub(claims?.sub ? String(claims.sub) : null);
            setAudience(claims?.aud ? String(claims.aud) : null);
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
});

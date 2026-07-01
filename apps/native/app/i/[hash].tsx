import { useEffect } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useIdentity } from '../IdentityContext';

export default function InviteProxyScreen() {
    const { hash } = useLocalSearchParams();
    const router = useRouter();
    const { identity, isLoading } = useIdentity();

    useEffect(() => {
        if (isLoading) return;

        if (identity) {
            // Already logged in, let the global deep link handler show the dialog.
            // Just redirect to tabs to keep the UI clean.
            router.replace('/(tabs)');
            return;
        }

        if (hash) {
            router.replace({ pathname: '/welcome', params: { invite: hash } });
        } else {
            router.replace('/welcome');
        }
    }, [hash, identity, isLoading]);

    return null;
}

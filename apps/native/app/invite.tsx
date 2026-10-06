import React from 'react';
import { Redirect, useLocalSearchParams, ErrorBoundary } from 'expo-router';

export { ErrorBoundary };

/**
 * Route alias for legacy `beanpool://invite` URIs
 * Redirects to `/welcome` passing through `invite` and `server` params
 */
export default function InviteRouteAlias() {
    const params = useLocalSearchParams<{ invite?: string | string[]; code?: string | string[]; server?: string | string[] }>();
    const rawInvite = params.invite;
    const rawCode = params.code;
    const rawServer = params.server;

    const inviteStr = Array.isArray(rawInvite) ? rawInvite[0] : rawInvite;
    const codeStr = Array.isArray(rawCode) ? rawCode[0] : rawCode;
    const serverStr = Array.isArray(rawServer) ? rawServer[0] : rawServer;

    const code = inviteStr || codeStr || '';
    const server = serverStr || '';

    return (
        <Redirect
            href={{
                pathname: '/welcome',
                params: {
                    ...(code ? { invite: code } : {}),
                    ...(server ? { server } : {}),
                },
            }}
        />
    );
}

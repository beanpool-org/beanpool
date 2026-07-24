import React from 'react';
import { Redirect, useLocalSearchParams } from 'expo-router';

/**
 * Route alias for legacy `beanpool://invite` URIs
 * Redirects to `/welcome` passing through `invite` and `server` params
 */
export default function InviteRouteAlias() {
    const params = useLocalSearchParams();
    const code = (params.invite || params.code || '') as string;
    const server = (params.server || '') as string;

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

/**
 * The refusal of a local community's listings to anyone but its members, which the apps turn into their sign-in page:
 * the read gate's (https-server.ts), and the peek read's for a link that opens nothing (routes/peek.ts), so a stopped,
 * run-out or forged link reads exactly as a stranger's read of a listing does.
 */
import { word } from '@beanpool/core';

export const LISTINGS_MEMBERS_ONLY = {
    error: word("This community's listings are for its members. Join with an invite from a member, or look around the global community at global.beanpool.org."),
    code: 'members_only',
    global: 'https://global.beanpool.org',
} as const;

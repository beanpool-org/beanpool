/**
 * "Start a community" (design §3.4): what a community's node is, the ways to run one, and the member's details
 * copied so the new node's settings can be filled in from the phone.
 *
 * The global node can't start a community for anyone: a community's web address belongs to its own node's key
 * (the registrar), and it is claimed from that node's settings app. Once the node is running and listed in the
 * directory (its operator turns on "publish location"), it shows under "near you" within an hour, and everyone
 * watching that place is told.
 */

import { BEANPOOL_WEBSITE_URL, t, word } from '@beanpool/core';
import type { NodeProfile } from './node-profile';

/** The website's own page on running a community's node (beanpool.org/start): only where the community's node names no page of its own. */
export const RUN_A_NODE_URL = `${BEANPOOL_WEBSITE_URL}/start`;

/**
 * Where "How to run a node" leads: the page the community's node names (`startCommunityUrl`, read by readNodeProfile),
 * else beanpool.org's. No community needs our domain (memory no-domain-lock-in).
 */
export function runANodeUrl(profile: Pick<NodeProfile, 'startCommunityUrl'> | null | undefined): string {
    return profile?.startCommunityUrl ?? RUN_A_NODE_URL;
}

/** The link's words, naming the site it opens, in the member's language. */
export function runANodeLabel(url: string): string {
    if (url === RUN_A_NODE_URL) return t(START_COMMUNITY_COPY.website);
    try { return t('How to run a node, on {host}', { host: new URL(url).hostname }); } catch { return t('How to run a node'); }
}

/** The screen's words: word() keys, shown through t() where they are drawn (app/start-community.tsx). */
export const START_COMMUNITY_COPY = {
    title: word('Start a community'),
    intro: word("Every community runs on its own node: a small server that holds that community's members, posts and trades. Someone local runs it. If your town or valley doesn't have one yet, it could be you."),
    ways: [
        { icon: '💻', title: word('A spare computer'), body: word('An old laptop, a Mini PC, a NAS or a Raspberry Pi at home runs a node. It stays on, and it needs the internet.') },
        { icon: '☁️', title: word('A small rented server'), body: word('A small virtual server from a hosting company, for a few dollars a month. Nobody needs to keep a machine at home.') },
        { icon: '🤝', title: word('Ask for help'), body: word('Post a Need here on BeanPool worldwide, such as "Someone to help run a community in my town". Someone near you may already know how.') },
    ],
    after: word('Once your node is running, you name your community in its settings app, invite the first members, and they invite the rest. Turn on "publish location" there, and people near you who asked to be told will hear about it.'),
    website: word('How to run a node, on beanpool.org'),
    copyButton: word("Copy my community's details"),
    copied: word("Copied. Paste them into your node's settings app."),
} as const;

export interface CommunityDetails {
    /** What the member wants to call their community. */
    name: string;
    /** Where it is: a town or area. */
    place: string;
    /** How members can reach its organiser. */
    contact: string;
    /** The member's own name on BeanPool. */
    organiser?: string | null;
}

/** The text copied to the clipboard: plain lines the node's settings app can be filled from. */
export function communityDetailsText(d: CommunityDetails): string {
    const line = (label: string, value: string | null | undefined) => {
        const v = (value ?? '').replace(/\s+/g, ' ').trim();
        return v ? `${label}: ${v}` : null;
    };
    return [
        line('Community name', d.name),
        line('Place', d.place),
        line('Organiser', d.organiser),
        line('Contact', d.contact),
    ].filter((l): l is string => l !== null).join('\n');
}

/** Whether there is anything worth copying yet. */
export function canCopyDetails(d: CommunityDetails): boolean {
    return d.name.trim().length >= 2;
}

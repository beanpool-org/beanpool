/**
 * "Start a community" in the web app (scratch/global-node/DESIGN-global-showcase-fable.md §3): the phone's
 * /start-community (apps/native/utils/start-community.ts) in the same words, plus the four things to know before the
 * link (what it costs, who hosts, what they take on, what they never see) and the claim step the phone's screen lacks.
 *
 * - **The same words as the phone.** START_COMMUNITY_COPY is the phone's, kept equal by start-community.test.ts (the
 *   exampleListings precedent: two copies and a test that they match), so W3 can change both together.
 * - **Nothing needs our domain.** "How to run a node" is the node's own `startCommunityUrl` (lib/features.ts); the
 *   setup chapter is a page to read, never something the node or the app depends on.
 */

import { BEANPOOL_WEBSITE_URL } from '@beanpool/core';

/**
 * The operator manual's setup chapter on the website: the first start, `beanpool claim` and the phone. Published there
 * with W5 (Marty's pick 8, 13 Oct 2026: the setup chapter alone goes on beanpool.org).
 */
export const SETUP_CHAPTER_URL = `${BEANPOOL_WEBSITE_URL}/guide/operators/first-time-setup.html`;

/** The phone's words (apps/native/utils/start-community.ts START_COMMUNITY_COPY). */
export const START_COMMUNITY_COPY = {
    title: 'Start a community',
    intro: "Every community runs on its own node: a small server that holds that community's members, posts and trades. "
        + "Someone local runs it. If your town or valley doesn't have one yet, it could be you.",
    ways: [
        { icon: '💻', title: 'A spare computer', body: 'An old laptop, a Mini PC, a NAS or a Raspberry Pi at home runs a node. It stays on, and it needs the internet.' },
        { icon: '☁️', title: 'A small rented server', body: 'A small virtual server from a hosting company, for a few dollars a month. Nobody needs to keep a machine at home.' },
        { icon: '🤝', title: 'Ask for help', body: 'Post a Need here on BeanPool worldwide, such as "Someone to help run a community in my town". Someone near you may already know how.' },
    ],
    after: "Once your node is running, you name your community in its settings app, invite the first members, and they invite the rest. "
        + 'Turn on "publish location" there, and people near you who asked to be told will hear about it.',
    website: 'How to run a node, on beanpool.org',
    copyButton: "Copy my community's details",
    copied: "Copied. Paste them into your node's settings app.",
} as const;

/** What to know before the link (design §3, in four lines), and the steps the website page walks through. */
export const START_COMMUNITY_KNOW = {
    heading: 'Before you start',
    lines: [
        { label: 'What it costs', body: 'A spare computer, or a few dollars a month for a rented server. The software is free.' },
        { label: 'Who hosts it', body: 'You do, on your machine or the one you rent. It never needs beanpool.org: your own web address works too.' },
        { label: 'What you take on', body: 'Reports from your members come to you. The data folder is yours to back up, with a recovery code. Keep two owners, and keep the server on and up to date.' },
        { label: 'What you never see', body: "Your members' direct messages." },
    ],
    steps: 'About half an hour if you can follow a recipe: paste one block of commands, then run beanpool claim on the server and scan its code with your phone to become the owner.',
    setupChapter: 'The setup chapter: the first start and claiming it with your phone',
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

/** The text copied to the clipboard: plain lines the node's settings app can be filled from (as the phone's). */
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

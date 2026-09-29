// Types for guide.mjs, for the TypeScript tests that read the pages themselves (apps/manager's manual tests): what a
// page says is pinned on the pages, since the bundled copy only changes when the director publishes.

export const GUIDE_SCHEMA: number;
export const ABOUT_SECTION: string;

export type GuideBlock =
    | { type: 'h2' | 'h3' | 'p'; text: string }
    | { type: 'ul'; items: string[] }
    | { type: 'img'; src: string; alt: string; href?: string };

export interface GuideCollection {
    schema: number;
    /** null for the pages as they stand: a collection gets its version when it is published. */
    version: number | null;
    hash: string;
    sections: Array<{ id: string; title: string; summary: string; slugs: string[] }>;
    guides: Array<{ slug: string; title: string; summary: string; section: string; related: string[]; video?: string; blocks: GuideBlock[] }>;
}

export function loadGuide(
    contentDir: string,
    options?: { aboutSection?: string | null; allowImages?: boolean; version?: number | null },
): GuideCollection;

export function contentHash(content: unknown): string;

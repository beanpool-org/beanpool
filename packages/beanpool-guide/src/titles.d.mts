// Types for titles.mjs, for the TypeScript tests that check the apps against the guide's titles tooling (the member apps'
// guide tests): the same hash, the same per-language title cap.

import type { GuideCollection } from './guide.mjs';

export const TITLES_FILE: string;
export const SOURCE_HASH_LENGTH: number;
export const TITLE_GROWTH: number;
export const TITLE_FLOOR_COLUMNS: number;
export const TITLE_FIELDS: { section: Record<'title' | 'summary', number>; page: Record<'title' | 'summary' | 'help', number> };

export interface TitleEntry { text: string; sourceHash: string }
export interface TitlesFile {
    _meta?: Record<string, unknown>;
    sections?: Record<string, Partial<Record<'title' | 'summary', TitleEntry>>>;
    pages?: Record<string, Partial<Record<'title' | 'summary' | 'help', TitleEntry>>>;
}

export function guideSourceHash(english: string): string;
export function displayColumns(text: string): number;
export function titleCap(english: string): number;
export function titleEntries(guide: GuideCollection): Array<{ kind: 'section' | 'page'; id: string; field: string; key: string; english: string }>;
export function readGuideTitles(contentDir: string): { files: Record<string, unknown>; problems: string[] };
export function checkGuideTitles(guide: GuideCollection, read: { files: Record<string, unknown>; problems?: string[] }): {
    problems: string[];
    stale: Record<string, Array<{ key: string; english: string }>>;
    counts: Record<string, { translated: number; stale: number; missing: number; total: number }>;
};
export function draftGuideTitles(guide: GuideCollection, file: unknown): TitlesFile;

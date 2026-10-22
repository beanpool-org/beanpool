// devvit.json, read the way the Devvit CLI reads it before every playtest, upload and publish, and held to what the
// code expects of it.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAppConfig } from '@devvit/shared-types/schemas/config-file.v1.js';
import { NTFY_HOSTS } from './ntfy';

const raw = readFileSync(new URL('../devvit.json', import.meta.url), 'utf8');
const json = JSON.parse(raw);
// The endpoint's path, as src/server/server.ts serves it (that file imports Devvit's runtime, so it is read, not run).
const served = /export const NEW_ITEM = '([^']+)'/.exec(readFileSync(new URL('./server/server.ts', import.meta.url), 'utf8'))?.[1];

describe('devvit.json', () => {
    it('passes the Devvit CLI\'s own validation (its JSON schema, version 0.15.0)', () => {
        expect(() => parseAppConfig(raw, false)).not.toThrow();
    });

    it('asks to fetch only the hosts the code sends to', () => {
        expect(json.permissions.http).toEqual({ enable: true, domains: NTFY_HOSTS });
    });

    it('has no Reddit API at all: the app cannot post, comment, vote or message', () => {
        expect(json.permissions.reddit).toBe(false);
        expect(Object.keys(json)).not.toContain('menu');
        expect(Object.keys(json)).not.toContain('post');
    });

    it('sends new posts and new comments, and nothing else, to the one endpoint', () => {
        expect(served).toBe('/internal/triggers/new-item');
        expect(json.triggers).toEqual({ onPostCreate: served, onCommentCreate: served });
    });

    it('keeps the topic and token as secrets with nothing in the repo', () => {
        const global = json.settings.global;
        expect(Object.keys(global).sort()).toEqual(['ntfyToken', 'ntfyUrl']);
        for (const name of ['ntfyUrl', 'ntfyToken']) {
            expect(global[name]).toMatchObject({ type: 'string', isSecret: true });
            // The 0.15.0 schema refuses a default on a secret (the docs' example has one; the CLI would refuse it).
            expect(global[name]).not.toHaveProperty('defaultValue');
        }
    });

    it('lets the moderators name the team\'s own accounts, on the install settings page, not in the repo', () => {
        expect(json.settings.subreddit).toEqual({
            quietUsernames: expect.objectContaining({ type: 'string', defaultValue: '' }),
        });
        expect(json.settings.subreddit.quietUsernames).not.toHaveProperty('isSecret');
    });
});

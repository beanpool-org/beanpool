/**
 * The map's Offer/Need form where Beans are off (rehearsal 2026-10-14 B4; global review M2, S6): a newcomer's first post
 * may be a Need, with no Offer listed first, no listing photo and no profile photo. Where Beans are on, or the node says
 * nothing yet, every rule stays.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { composerNeedsProfilePhoto, postFormRules, postFormSubmitLabel, type PostFormState } from '../market-global';
import { readNodeProfile } from '../node-profile';

const GLOBAL = readNodeProfile({ profile: 'global', features: { beans: false, escrow: false } })!;
const LOCAL = readNodeProfile({ profile: 'local', features: { beans: true, escrow: true } })!;
const OLD = readNodeProfile({})!;

const needNoPhoto: PostFormState = {
    posting: false, needBlocked: false, postType: 'need', category: 'general', hasLocation: true, photoCount: 0,
    credits: '', title: 'Help moving a couch', description: 'Saturday morning',
};

describe('postFormRules', () => {
    it('Beans off: a blocked newcomer\'s Need is not blocked, its photo is optional, and no profile photo is asked for', () => {
        expect(postFormRules(GLOBAL.features, 'need', true)).toEqual({ needBlocked: false, photoRequired: false, profilePhoto: false });
        // An Offer still carries a photo.
        expect(postFormRules(GLOBAL.features, 'offer', true).photoRequired).toBe(true);
    });

    it('Beans on, or a node that says nothing: the Need waits for an Offer, and both photos are required', () => {
        for (const features of [LOCAL.features, OLD.features, null, undefined]) {
            expect(postFormRules(features, 'need', true)).toEqual({ needBlocked: true, photoRequired: true, profilePhoto: true });
            expect(postFormRules(features, 'need', false).needBlocked).toBe(false);
            expect(postFormRules(features, 'offer', true)).toEqual({ needBlocked: false, photoRequired: true, profilePhoto: true });
        }
    });

    it('the button: a Need with no photo is ready where Beans are off, and asks for one where they are on', () => {
        const off = postFormRules(GLOBAL.features, 'need', true);
        expect(postFormSubmitLabel({ ...needNoPhoto, needBlocked: off.needBlocked, photoRequired: off.photoRequired }, GLOBAL.features)).toBe('Post Need');
        const on = postFormRules(LOCAL.features, 'need', true);
        expect(postFormSubmitLabel({ ...needNoPhoto, needBlocked: on.needBlocked, photoRequired: on.photoRequired }, LOCAL.features))
            .toBe('🟢 List an Offer first to post Needs');
        expect(postFormSubmitLabel({ ...needNoPhoto, photoRequired: on.photoRequired, credits: '5' }, LOCAL.features)).toBe('📷 Add a photo');
    });

    it('map.tsx reads the rules, never the raw blocked flag or a bare photo count', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../../app/(tabs)/map.tsx'), 'utf-8');
        expect(src).toContain('const { needBlocked, photoRequired } = postFormRules(nodeFeatures, postType, blockedFromTrading);');
        expect(src).toContain("if (photoRequired && postPhotos.length < 1) errors.add('photos');");
        expect(src).toContain('|| !postCategory || (photoRequired && postPhotos.length < 1);');
        expect(src).toContain("const avatarOk = !(await composerNeedsProfilePhoto(nodeFeatures, readCachedProfile)) || await hasUsableAvatar();");
        expect(src).not.toContain('const needBlocked = blockedFromTrading');
        // The photo label says "* (min 1)" only where a photo is required (review #1936 N4).
        expect(src).toContain("Photos{photoRequired ? <>{' '}<Text style={styles.requiredStar}>*</Text>{' '}<Text style={styles.sectionLabelHint}>(min 1)</Text></> : null}</Text>");
        expect(src).not.toContain('Photos <Text style={styles.requiredStar}>*</Text>');
    });
});

/*
 * The post form opened from another tab (review #1936 N1): a `?newPost=` link mounts the map and opens the form before
 * the screen has the node's profile (useNodeProfile is still null), so the phone's saved copy decides the photo rule.
 */
describe('composerNeedsProfilePhoto', () => {
    const never = async () => { throw new Error('the saved copy is not read when the screen has the profile'); };

    it('the screen has no profile yet: the saved copy of the global node says no profile photo', async () => {
        expect(await composerNeedsProfilePhoto(null, async () => GLOBAL)).toBe(false);
        expect(await composerNeedsProfilePhoto(undefined, async () => GLOBAL)).toBe(false);
    });

    it('the screen has no profile yet: a local copy, no copy, or one that cannot be read keeps the photo', async () => {
        expect(await composerNeedsProfilePhoto(null, async () => LOCAL)).toBe(true);
        expect(await composerNeedsProfilePhoto(null, async () => null)).toBe(true);
        expect(await composerNeedsProfilePhoto(null, async () => { throw new Error('storage'); })).toBe(true);
    });

    it('the screen has the profile: it decides, and the saved copy is not read', async () => {
        expect(await composerNeedsProfilePhoto(GLOBAL.features, never)).toBe(false);
        expect(await composerNeedsProfilePhoto(LOCAL.features, never)).toBe(true);
    });
});

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseNewPostParam } from '../compose-options';

/**
 * Every door to the listing form (MAP-FORM): the form left app/(tabs)/map.tsx for app/new-listing.tsx, and each door that
 * opened it on the map opens that screen, with the `newPost` it passed before. Read from the sources, so a new door that
 * still sends the member to the map's old form, or one that drops its `newPost`, fails here. The doors that render are
 * also pressed in their own suites: the map's + and link (map-words-render), Home's steps (home-screen-render), the tool
 * doors (tools-template, shop-screens, things-screens).
 */
const NATIVE = path.join(__dirname, '..', '..');

function sources(): { file: string; src: string }[] {
    const out: { file: string; src: string }[] = [];
    const walk = (dir: string) => {
        for (const name of fs.readdirSync(dir)) {
            const full = path.join(dir, name);
            if (fs.statSync(full).isDirectory()) {
                if (name !== '__tests__' && name !== 'node_modules') walk(full);
            } else if (/\.tsx?$/.test(name)) {
                out.push({ file: path.relative(NATIVE, full).split(path.sep).join('/'), src: fs.readFileSync(full, 'utf8') });
            }
        }
    };
    for (const dir of ['app', 'components', 'tools', 'utils']) walk(path.join(NATIVE, dir));
    return out;
}

const ALL = sources();

describe('the doors to the listing form', () => {
    it('nothing sends a member to the map for the form any more', () => {
        for (const { file, src } of ALL) {
            expect(src, file).not.toMatch(/pathname:\s*'\/(\(tabs\)\/)?map',\s*params:\s*\{\s*newPost/);
            expect(src, file).not.toMatch(/['"`]\/(\(tabs\)\/)?map\?newPost=/);
        }
    });

    it('each door opens /new-listing with the newPost it passed to the map', () => {
        const doors: Record<string, string[]> = {};
        for (const { file, src } of ALL) {
            const found = [
                ...[...src.matchAll(/router\.push\(\{\s*pathname:\s*'\/new-listing',\s*params:\s*\{\s*newPost:\s*([^}]+?)\s*\}\s*\}\)/g)].map((m) => m[1]),
                ...[...src.matchAll(/router\.push\('\/new-listing\?newPost=(\w+)'\)/g)].map((m) => `'${m[1]}'`),
            ];
            if (found.length) doors[file] = found;
        }
        expect(doors).toEqual({
            // The map's + (the chooser), and its own `?newPost=` link, passed on as it came.
            'app/(tabs)/map.tsx': ['params.newPost', "'true'"],
            // "Post your first Offer", the activity list's create, the empty Market's "+ Post a Deal", and the chooser's pick.
            'app/(tabs)/market.tsx': ["'true'", "'true'", "'true'", 'type'],
            // Home's "post an Offer" steps, and Home's chooser's pick.
            'app/(tabs)/index.tsx': ["'offer'", 'type'],
            // A pulse post's "Post Your Own Offer →", and "Contribution Required"'s "➕ Create an Offer".
            'app/post/[id].tsx': ["'true'", "'true'"],
            // A tool's Offer (through the List sheet) and its Need.
            'tools/doors.ts': ["'offer'", "'need'"],
        });
        // Every fixed value a door passes is one the screen reads.
        for (const v of ['true', 'offer', 'need', 'poll', 'event']) expect(parseNewPostParam(v), v).not.toBeNull();
    });

    it('the screen is a route of its own, over the screen that opened it', () => {
        expect(fs.existsSync(path.join(NATIVE, 'app', 'new-listing.tsx'))).toBe(true);
        const layout = fs.readFileSync(path.join(NATIVE, 'app', '_layout.tsx'), 'utf8');
        expect(layout).toContain(`<Stack.Screen name="new-listing" options={{ presentation: 'transparentModal', animation: 'fade', contentStyle: { backgroundColor: 'transparent' } }} />`);
    });

    it('map.tsx keeps no form: no composer state, no submit, no pin for a post', () => {
        const map = fs.readFileSync(path.join(NATIVE, 'app', '(tabs)', 'map.tsx'), 'utf8');
        for (const gone of ['showNewPost', 'createPost', 'handleSubmit', 'pinDropMode', 'OFFER_DRAFT_KEY', 'NewPostTypeSheet', 'NewEventModal', 'NewPollModal', 'KeyboardAvoidingView']) {
            expect(map, gone).not.toContain(gone);
        }
        // What draws the map is all still there.
        for (const kept of ['const ClusterMarker', 'const CustomMapMarker', 'const EventMapMarker', 'renderCluster={renderCluster}', '<MapMarkerManager', '<ClusterCaptureManager', 'getCachedClusterImage(displayCount)']) {
            expect(map, kept).toContain(kept);
        }
    });
});

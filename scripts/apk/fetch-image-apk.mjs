#!/usr/bin/env node
// fetch-image-apk.mjs — the Android APK for the node image (lights-out H3; apps/server/src/services/apk-release.ts).
//
//   node --experimental-strip-types scripts/apk/fetch-image-apk.mjs --out <layer dir> --cache <cache dir>
//
// Run by .github/workflows/docker-publish.yml before the image build: it reads the android-v* releases from GitHub, takes
// the newest at or above 1.2.93, downloads its APK (unless the cache already holds that one), checks its SHA-256 against the
// release notes and its signature against BeanPool's pinned signing certificate, and writes it into <layer dir>/beanpool-apk/
// with fixed times and modes. The Dockerfile copies that folder in as a layer of its own, so a build with the same APK makes
// the same layer and a node's update does not download it again.
//
// When the newest cannot be listed, fetched or checked, the APK the cache kept from an earlier build is checked again and
// used, with a warning naming it and saying why. With no such APK it exits 1: the build fails rather than ship an image
// without one. GH_TOKEN (the workflow's own token) is sent only to api.github.com, for its rate limit; it is never printed.
//
// Prints the APK's version for the workflow (GITHUB_OUTPUT: tag=, version=, reused=).
import fs from 'node:fs';
import { githubApkSource, prepareImageApk } from '../../apps/server/src/services/apk-release.ts';

function arg(name) {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
}
const out = arg('--out');
const cache = arg('--cache');
if (!out || !cache) {
    console.error('usage: fetch-image-apk.mjs --out <layer dir> --cache <cache dir>');
    process.exit(2);
}

try {
    const { info, reusedBecause } = await prepareImageApk(out, cache, githubApkSource(process.env.GH_TOKEN || undefined));
    const name = `${info.version} (${info.versionCode}), ${info.fileName}, ${info.size} bytes, SHA-256 ${info.sha256}`;
    if (reusedBecause) {
        console.log(`::warning title=Android APK reused::The image carries the earlier checked APK ${name}, because the newest could not be used: ${reusedBecause}`);
    } else {
        console.log(`The image carries the Android APK ${name}, signed by certificate ${info.certSha256}.`);
    }
    if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `tag=${info.tag}\nversion=${info.version}\nreused=${reusedBecause ? 'true' : 'false'}\n`);
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Android APK in the image\n\n${reusedBecause ? `**Reused** the earlier checked APK, because: ${reusedBecause}\n\n` : ''}${name}\n`);
    }
} catch (e) {
    console.log(`::error title=No Android APK for the image::${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
}

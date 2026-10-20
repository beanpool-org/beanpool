// The tool fence (eslint.config.mjs, DESIGN-tool-template-fable.md §1.4): each door a tool may use stays open and every
// other one shut, linted through the repository's own config at the paths a tool's files would have. Nothing is written.
//
//   node --test scripts/tools/fence.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ESLint } from 'eslint';
import { ROOT } from './registry.mjs';

const eslint = new ESLint({ cwd: ROOT });
const FENCE = /talks to the app through host/;

/** The fence's errors on `code` linted as if it were the file `rel`. */
async function fenced(rel, code) {
    const [r] = await eslint.lintText(code, { filePath: path.join(ROOT, rel) });
    return r.messages.filter((m) => FENCE.test(m.message)).map((m) => m.message);
}
const opens = async (rel, code) => assert.deepEqual(await fenced(rel, code), [], `${rel}: ${code}`);
const shut = async (rel, code) => assert.ok((await fenced(rel, code)).length > 0, `${rel}: ${code} should be refused`);

test('a phone tool: React, core, its own folder, the host and the primitives; nothing else', async () => {
    const top = 'apps/native/tools/demo/screens.tsx';
    for (const code of [
        "import { useState } from 'react';",
        "import { t, type ToolScreenProps } from '@beanpool/core';",
        "import { Row } from './row';",
        "import { Row } from './parts/row';",
        "import type { ToolHost } from '../host';",
        "import { ToolRow } from '../ui';",
        "export const s = () => require('./screens');",
    ]) await opens(top, code);
    for (const code of [
        "import { View } from 'react-native';",
        "import type { ViewStyle } from 'react-native';",
        "import * as Notifications from 'expo-notifications';",
        "import { getDb } from '../../utils/db';",
        "import { colors } from '../../constants/colors';",
        "import { TOOL_APPS } from '../index';",
        "import other from '../other/screens';",
        "import { Row } from './../../utils/db';",
        "import { KeyboardProvider } from 'react-native-keyboard-controller';",
        "export * from '../../services/api';",
        "const db = require('../../utils/db');",
        "const x = require(name);",
        "const m = import('expo-file-system');",
        "fetch('https://example.org');",
        "localStorage.setItem('a', 'b');",
        "window.fetch('https://example.org');",
        "globalThis.fetch('https://example.org');",
        "const f = self.fetch;",
        "window['fetch']('https://example.org');",
        "const w = globalThis; w.fetch('https://example.org');",
        "const { fetch: f } = window;",
        "window.localStorage.setItem('a', 'b');",
        "globalThis.window.sessionStorage.clear();",
        "new window.WebSocket('wss://example.org');",
        "navigator.sendBeacon('https://example.org', 'x');",
    ]) await shut(top, code);
    const nested = 'apps/native/tools/demo/parts/row.tsx';
    await opens(nested, "import { THING } from '../manifest-words';");
    await opens(nested, "import { ToolRow } from '../../ui';");
    await opens(nested, "import { Chip } from '../ui';"); // the tool's own demo/ui, not the template's
    await shut(nested, "import { homeStyles } from '../../../components/home/HomeParts';");
    await shut(nested, "import { getDb } from '../../../utils/db';");
});

test('a web tool: the same doors', async () => {
    const top = 'apps/pwa/src/tools/demo/screens.tsx';
    await opens(top, "import { t } from '@beanpool/core';");
    await opens(top, "import { ToolRow } from '../ui';");
    for (const code of [
        "import { api } from '../../lib/api';",
        "import { useNavigate } from 'react-router-dom';",
        "import { HomePage } from '../../pages/HomePage';",
        "const chunk = import('../../pages/MapPage');",
        "indexedDB.open('x');",
        "window.indexedDB.open('x');",
        "window.localStorage.setItem('a', 'b');",
        "globalThis.fetch('https://example.org');",
        "window.navigator.sendBeacon('https://example.org', 'x');",
        "caches.open('x');",
        "window.caches.open('x');",
        "document.cookie = 'a=b';",
        "window.document.cookie = 'a=b';",
        "globalThis.document.cookie = 'a=b';",
        "const d = document; d.cookie = 'a=b';",
        "const { cookie } = document;",
    ]) await shut(top, code);
});

test('a core tool: its own folder, the template and core, never a package or a Node built-in', async () => {
    const top = 'packages/beanpool-core/src/tools/demo/manifest.ts';
    for (const code of [
        "import { word } from '../../words.js';",
        "import type { ToolManifest } from '../manifest.js';",
        "import type { ToolFixtures } from '../check.js';",
        "import { readDemoDoc } from './doc.js';",
    ]) await opens(top, code);
    for (const code of [
        "import { readFileSync } from 'node:fs';",
        "import { sha256 } from '@noble/hashes/sha2';",
        "import { TOOLS } from '../index.js';",
        "import { t } from '../../index.js';",
        "import { CLDR_DATE_WORDS } from '../../words-dates/fr.js';",
        "import { THINGS } from '../things/index.js';",
        "import React from 'react';",
    ]) await shut(top, code);
});

test("a tool's tests are outside the fence; the template's own files beside the folders are not fenced", async () => {
    await opens('packages/beanpool-core/src/tools/demo/__tests__/demo.test.ts', "import { describe } from 'vitest'; import fs from 'node:fs';");
    await opens('apps/native/tools/demo/__tests__/screens.test.ts', "import { vi } from 'vitest';");
    await opens('apps/native/tools/host.ts', "import { getDb } from '../utils/db';");
    await opens('apps/pwa/src/tools/ui.tsx', "import { clsx } from 'clsx';");
});

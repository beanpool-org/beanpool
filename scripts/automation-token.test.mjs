// Tests for scripts/automation-token.mjs, the owner scripts' token check. Run by test-all.sh (the `token_scripts` check):
// node --test scripts/automation-token.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTOMATION_TOKEN_SHAPE, isAutomationTokenShape, automationTokenProblem, headerValueProblem } from './automation-token.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = `bp_${'0123456789ab'}_${'f'.repeat(64)}`;

test('the scripts check the same shape as the server', () => {
    const src = fs.readFileSync(path.join(ROOT, 'apps/server/src/automation-tokens.ts'), 'utf8');
    const m = /const TOKEN_SHAPE = \/(.+)\/;/.exec(src);
    assert.ok(m, 'TOKEN_SHAPE is in automation-tokens.ts');
    // The server captures the id and the secret; the scripts only test, so the groups are dropped before comparing.
    assert.equal(m[1].replace(/[()]/g, ''), AUTOMATION_TOKEN_SHAPE.source);
});

test('a whole token passes; anything else is refused in words that never repeat it', () => {
    assert.equal(isAutomationTokenShape(TOKEN), true);
    assert.equal(automationTokenProblem('BEANPOOL_TOKEN', TOKEN), null);
    for (const bad of [
        'bp_', 'bp_short', `${TOKEN}\n`, ` ${TOKEN}`, `${TOKEN.slice(0, 40)}\n${TOKEN.slice(40)}`, TOKEN.toUpperCase(),
        `${TOKEN}0`, TOKEN.slice(0, -1), 'my-admin-password', '',
    ]) {
        assert.equal(isAutomationTokenShape(bad), false, JSON.stringify(bad));
        const why = automationTokenProblem('BEANPOOL_TOKEN', bad);
        assert.ok(why?.startsWith('BEANPOOL_TOKEN is not an automation token'), why);
        if (bad.length > 4) assert.ok(!why.includes(bad.trim().slice(4, 24)), `the value is not repeated: ${why}`);
    }
    assert.equal(isAutomationTokenShape(undefined), false);
});

test('a password with a control character is refused before it is sent, without repeating it', () => {
    assert.equal(headerValueProblem('ADMIN_PASSWORD', 'plain pass with spaces'), null);
    const why = headerValueProblem('ADMIN_PASSWORD', 'secret-pw\r\n');
    assert.ok(why?.includes('control character') && !why.includes('secret-pw'), why);
});

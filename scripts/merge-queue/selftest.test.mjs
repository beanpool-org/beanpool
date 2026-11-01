// The test scripts/merge-queue/self-test.sh makes fail. Its throwaway PRs add these markers and nothing else: this is a real
// assertion in the `workflows` check, so the walk goes red the way any broken PR does. Main holds none of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const marker = (name) => existsSync(join(HERE, `selftest-${name}.marker`));

test('gate self-test: the red PR always fails', () => {
    assert.equal(marker('red'), false, 'selftest-red.marker: a PR made to fail (self-test.sh, step 1)');
});

test('gate self-test: two PRs, each green alone, fail together', () => {
    assert.equal(marker('a') && marker('b'), false, 'selftest-a.marker and selftest-b.marker: green alone, red together (self-test.sh, step 2)');
});

/**
 * No write takes an id from the sample community (sample-id-guard.ts; DESIGN-global-showcase-fable.md §6 W1, the
 * safety line "no number from the fixture may ever reach a ledger or any API write"), over a REAL HTTPS round trip
 * through every middleware the server mounts.
 *
 *   1. the guard's own reading: a sample id under an id key at any depth, arrays included, in any case, spacing or
 *      width, or as a token inside a longer id, is found; so is one that is a whole value under any other key; a body
 *      deeper than the guard walks is refused; free text and a word that only looks like one are not
 *   2. the sweep: every write route the server serves (each POST, PUT, PATCH and DELETE on its routers), three ways —
 *      a sample id in its path (each parameter), in its query, and in its body (rotating through the id keys the apps
 *      send) — answers 400 `sample_id`, and no table changes
 *   3. the spellings a review sent past the first guard (#1845 review, bypass.mts), through the real middleware: each
 *      answers 400 `sample_id`; a body the parser doesn't read as JSON reaches the route as `{}`, so it carries nothing
 *   4. the guard is the guard and nothing else: the same routes with the same sample word under a free-text key, or a
 *      real-shaped id, never answer `sample_id`; reads (GET) with a sample id in the path are never refused by it
 *   5. every body field the server's routes read (a static walk of src/, aliases, getters and helpers included): sent a
 *      sample id under that field, each route answers 400 `sample_id`, unless the field is free text; every free-text
 *      key is one some route reads, and none names an id
 *   6. the guard costs about what the JSON parse did, on bodies of up to 3 MB (it runs before the signature check)
 *   7. the Start a community owner route refuses an unsigned caller (and the address stays)
 *
 * Local only: it talks to the server it starts on localhost and nothing else.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-sample-id-guard.ts
 */
// A module, not a global script: everything loads by `await import`, and without this its `main` collides with the one
// in phone-door-test-harness.ts (TS2393 in the server build).
export {};

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** One body field a server source reads: where, the route whose handler reads it (if the read is inside one), the key path. */
type FieldRead = { at: string; route: string | null; path: string[] };

/**
 * Every body field the server's own sources read (not tests or harnesses), statically: `ctx.requestBody` and
 * `ctx.request.body` in any cast, the variables that hold one, the getters that return one (`bodyOf(ctx)`), and the
 * parameters of functions a body is handed to, to a fixed point across files; then each property read, element read
 * and destructuring off any of them, with nested paths.
 */
function bodyFieldReads(ts: typeof import('typescript'), files: string[], read: (file: string) => string, rel: (file: string) => string): FieldRead[] {
    const sources = files.map(f => ts.createSourceFile(f, read(f), ts.ScriptTarget.Latest, true));
    const unwrap = (n: import('typescript').Node): import('typescript').Node => {
        while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n) || ts.isSatisfiesExpression(n)) n = n.expression;
        return n;
    };
    const scopeOf = (n: import('typescript').Node): import('typescript').Node => {
        let p = n.parent;
        while (p && !ts.isFunctionLike(p) && !ts.isSourceFile(p)) p = p.parent;
        return p ?? n.getSourceFile();
    };
    const aliases = new Map<import('typescript').Node, Set<string>>();
    const getters = new Set<string>();
    const bodyParams = new Map<string, Set<number>>();
    const isAlias = (id: import('typescript').Identifier): boolean => {
        for (let p: import('typescript').Node | undefined = id; p; p = p.parent) if (aliases.get(p)?.has(id.text)) return true;
        return false;
    };
    const isBody = (raw: import('typescript').Node): boolean => {
        const n = unwrap(raw);
        if (ts.isPropertyAccessExpression(n)) {
            if (n.name.text === 'requestBody') return true;
            const e = unwrap(n.expression);
            if (n.name.text === 'body' && ts.isPropertyAccessExpression(e) && e.name.text === 'request') return true;
        }
        if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.BarBarToken || n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) return isBody(n.left) || isBody(n.right);
        if (ts.isConditionalExpression(n)) return isBody(n.whenTrue) || isBody(n.whenFalse);
        if (ts.isIdentifier(n)) return isAlias(n);
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && getters.has(n.expression.text)) return true;
        return false;
    };
    const addAlias = (scope: import('typescript').Node, name: string): boolean => {
        const set = aliases.get(scope) ?? new Set<string>();
        aliases.set(scope, set);
        if (set.has(name)) return false;
        set.add(name);
        return true;
    };
    const fnName = (fn: import('typescript').Node): string | null => {
        if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
        if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) return fn.parent.name.text;
        return null;
    };
    const returnsBody = (fn: import('typescript').SignatureDeclaration): boolean => {
        const b = (fn as any).body as import('typescript').Node | undefined;
        if (!b) return false;
        if (!ts.isBlock(b)) return isBody(b);
        let found = false;
        (function v(n: import('typescript').Node) {
            if (found || (n !== b && ts.isFunctionLike(n))) return;
            if (ts.isReturnStatement(n) && n.expression && isBody(n.expression)) found = true;
            ts.forEachChild(n, v);
        })(b);
        return found;
    };
    // To a fixed point: aliases, getters and the parameters a body is handed to, across every file.
    for (let grew = true, round = 0; grew && round < 8; round++) {
        grew = false;
        for (const sf of sources) {
            (function v(n: import('typescript').Node) {
                if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && !ts.isFunctionLike(n.initializer) && isBody(n.initializer)) grew = addAlias(scopeOf(n), n.name.text) || grew;
                if (ts.isFunctionLike(n)) {
                    const name = fnName(n);
                    if (name && !getters.has(name) && returnsBody(n)) { getters.add(name); grew = true; }
                    const idx = name ? bodyParams.get(name) : undefined;
                    if (idx) n.parameters.forEach((p, i) => { if (idx.has(i) && ts.isIdentifier(p.name)) grew = addAlias(n, p.name.text) || grew; });
                }
                // A body handed to a function by name (a helper in src/); a method of some object (`re.test(v)`) is not followed.
                if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
                    const callee = n.expression.text;
                    if (!getters.has(callee)) n.arguments.forEach((a, i) => {
                        if (!isBody(a)) return;
                        const set = bodyParams.get(callee) ?? new Set<number>();
                        if (!set.has(i)) { set.add(i); bodyParams.set(callee, set); grew = true; }
                    });
                }
                if (ts.isBindingElement(n) && n.dotDotDotToken && ts.isIdentifier(n.name)) {
                    // `const { a, ...rest } = body`: rest holds the other fields.
                    let pat: import('typescript').Node = n.parent;
                    while (ts.isBindingElement(pat.parent) || ts.isObjectBindingPattern(pat.parent)) pat = pat.parent;
                    const decl = pat.parent;
                    if (ts.isVariableDeclaration(decl) && decl.initializer && isBody(decl.initializer) && pat === n.parent) grew = addAlias(scopeOf(decl), n.name.text) || grew;
                }
                ts.forEachChild(n, v);
            })(sf);
        }
    }
    const routeOf = (n: import('typescript').Node): string | null => {
        for (let p = n.parent; p; p = p.parent) {
            if (!ts.isCallExpression(p) || !ts.isPropertyAccessExpression(p.expression)) continue;
            const m = p.expression.name.text;
            const first = p.arguments[0];
            if (/^(post|put|patch|delete|get)$/.test(m) && first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) && first.text.startsWith('/')) {
                return `${m.toUpperCase()} ${first.text}`;
            }
        }
        return null;
    };
    const readPath = (raw: import('typescript').Node): string[] | null => {
        const n = unwrap(raw);
        if (isBody(n)) return [];
        if (ts.isPropertyAccessExpression(n)) { const p = readPath(n.expression); return p && [...p, n.name.text]; }
        if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) { const p = readPath(n.expression); return p && [...p, n.argumentExpression.text]; }
        return null;
    };
    const out: FieldRead[] = [];
    for (const sf of sources) {
        const add = (n: import('typescript').Node, path: string[]) => {
            if (path.length) out.push({ at: `${rel(sf.fileName)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`, route: routeOf(n), path });
        };
        const pattern = (pat: import('typescript').ObjectBindingPattern, prefix: string[]) => {
            for (const el of pat.elements) {
                if (el.dotDotDotToken) continue;
                const key = el.propertyName ? (ts.isIdentifier(el.propertyName) || ts.isStringLiteralLike(el.propertyName) ? el.propertyName.text : null) : (ts.isIdentifier(el.name) ? el.name.text : null);
                if (!key) continue;
                add(el, [...prefix, key]);
                if (ts.isObjectBindingPattern(el.name)) pattern(el.name, [...prefix, key]);
            }
        };
        (function v(n: import('typescript').Node) {
            // A field, not a method called on one (`body.url.trim()`) nor its length.
            const called = !!n.parent && ts.isCallExpression(n.parent) && n.parent.expression === n;
            if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && !called && !(ts.isPropertyAccessExpression(n) && n.name.text === 'length')) {
                const p = readPath(n);
                if (p) add(n, p);
            }
            if (ts.isVariableDeclaration(n) && n.initializer && ts.isObjectBindingPattern(n.name)) { const p = readPath(n.initializer); if (p) pattern(n.name, p); }
            if (ts.isFunctionLike(n)) {
                const name = fnName(n);
                const idx = name ? bodyParams.get(name) : undefined;
                if (idx) n.parameters.forEach((p, i) => { if (idx.has(i) && ts.isObjectBindingPattern(p.name)) pattern(p.name, []); });
            }
            ts.forEachChild(n, v);
        })(sf);
    }
    return out;
}

async function main() {
    const { bodyCarriesSampleId, urlCarriesSampleId, SAMPLE_ID_REFUSAL, FREE_TEXT_KEYS, MAX_DEPTH, namesAnId } = await import('./sample-id-guard.js');
    const nest = (depth: number, leaf: unknown): unknown => Array.from({ length: depth }).reduce<unknown>(acc => ({ n: acc }), leaf);

    console.log('── 1. what the guard reads ──');
    const found: [unknown, boolean, string][] = [
        [{ id: 'sample-tx-bread' }, true, 'a top-level id'],
        [{ postId: 'sample-deal-shelves' }, true, 'postId'],
        [{ transactionIds: ['real-1', 'sample-tx-gift'] }, true, 'an array of ids'],
        [{ vote: { decisionId: 'sample-decision-compost-bay' } }, true, 'a nested decisionId'],
        [{ to: 'sample-community-example-valley' }, true, 'to'],
        [{ targetPubkey: 'sample-x' }, true, 'targetPubkey'],
        [{ items: [{ enterpriseId: 'sample-enterprise-bakery' }] }, true, 'an id inside an array of objects'],
        [{ participants: ['abc', 'sample-x'] }, true, 'participants'],
        [{ members: ['sample-x'] }, true, 'members'],
        [{ createdBy: 'sample-x' }, true, 'createdBy'],
        [{ id: 'Sample-tx' }, true, 'an id in capitals (read lower-case)'],
        [{ to: 'SAMPLE-X' }, true, 'an id all in capitals'],
        [{ to: ' sample-x\n' }, true, 'an id with spaces around it'],
        [{ to: ' sample-x' }, true, 'an id after a no-break space'],
        [{ to: 'ｓample-x' }, true, 'an id with a fullwidth s (read NFKC)'],
        [{ id: 'sample_tx_bread' }, true, 'an id with underscores'],
        [{ id: 'escrow_sample-tx' }, true, 'a sample id inside a longer id'],
        [{ id: 'a sample-tx' }, true, 'a sample id as a word inside an id'],
        [{ decision: 'sample-decision-compost-bay' }, true, 'a whole sample id under a key that does not say id'],
        [{ category: 'Sample-X ' }, true, 'the same, in another spelling'],
        [['sample-x'], true, 'a bare array body'],
        ['sample-x', true, 'a bare string body'],
        [nest(MAX_DEPTH + 1, { title: 'deep' }), true, `a body deeper than ${MAX_DEPTH} (refused, not walked)`],
        [nest(MAX_DEPTH - 2, { id: 'sample-x' }), true, 'a sample id just within the depth'],
        [nest(MAX_DEPTH - 2, { id: 'abc' }), false, 'a deep body with no sample id'],
        [{ title: 'sample-sale' }, false, 'a title that is the word "sample-sale" (free text is not read)'],
        [{ description: 'sample-tx-bread' }, false, 'a description'],
        [{ name: 'Sample-Garden', slug: 'sample-garden-x7k2pq' }, false, 'a group\'s name and the slug made from it'],
        [{ poll: { question: 'q', title: 'sample-x' } }, false, 'free text nested under another key'],
        [{ category: 'a sample-x' }, false, 'a sample id inside a value under a key that does not say id'],
        [{ url: 'https://example.org/sample-page' }, false, 'a link with the word in it'],
        [{ id: 'resample-1' }, false, 'an id where the word is part of a longer word'],
        [{ id: 'sample' }, false, 'the bare word'],
        [{ id: 'abc123' }, false, 'a real-shaped id'],
        [{ id: 42, amount: 1, ok: true }, false, 'numbers and booleans'],
        [null, false, 'no body'],
    ];
    for (const [body, want, label] of found) {
        assert(bodyCarriesSampleId(body) === want, `body ${label}: ${want ? 'refused' : 'passed'}`);
    }
    const urls: [string, Record<string, unknown>, boolean, string][] = [
        ['/api/decisions/sample-decision-compost-bay/vote', {}, true, 'a sample id in a path segment'],
        ['/api/decisions/sample%2Ddecision/vote', {}, true, 'percent-encoded'],
        ['/api/decisions/%2573ample-decision/vote', {}, true, 'double-encoded'],
        ['/api/decisions/SAMPLE-DECISION/vote', {}, true, 'in capitals'],
        ['/api/decisions/%20sample-decision/vote', {}, true, 'after an encoded space'],
        ['/api/decisions/sample-decision;x/vote', {}, true, 'with ;x after it'],
        ['/api/decisions/sample-decision.json', {}, true, 'with .json after it'],
        ['/api/marketplace/posts', { id: 'sample-tx' }, true, 'in the query'],
        ['/api/marketplace/posts', { id: ['x', 'sample-tx'] }, true, 'a repeated query value'],
        ['/api/marketplace/posts', { id: ' sample-tx' }, true, 'a query value after a space (a + in the URL)'],
        ['/api/marketplace/posts', { 'id[a]': 'SAMPLE-TX' }, true, 'under a bracket key, in capitals'],
        ['/api/marketplace/posts/abc', { q: 'sample' }, false, 'a plain path and query'],
        ['/api/decisions/resample-1/vote', {}, false, 'a segment where the word is part of a longer word'],
    ];
    for (const [path, query, want, label] of urls) {
        assert(urlCarriesSampleId(path, query) === want, `url ${label}: ${want ? 'refused' : 'passed'}`);
    }

    console.log('\n── 2. the sweep: every write route, through the real middleware ──');
    const { db } = await import('./db/db.js');
    const { initStateEngine } = await import('./state-engine.js');
    const { initTls } = await import('./services/tls.js');
    const https = await import('./https-server.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    // The walk in step 5 holds this process's loop for seconds on CI; localFetch lets the server close the stale socket first.
    const { localFetch } = await import('./keepalive-test-fetch.js');
    initStateEngine();
    await initTls();
    const port = await https.startHttpsServer(0);
    const BASE = `https://localhost:${port}`;

    const app: any = https.getKoaApp();
    const served = [...new Set<string>(app.middleware.filter((m: any) => m.router).flatMap((m: any) => m.router.stack)
        .flatMap((l: any) => (l.methods as string[]).map((m) => `${m} ${l.path}`)))].sort();
    const writes = served.filter(r => WRITE_METHODS.has(r.split(' ')[0]));
    const reads = served.filter(r => r.startsWith('GET '));
    assert(writes.length > 150, `the server serves many write routes, every one swept (${writes.length})`);
    const withParams = writes.filter(r => /:[A-Za-z0-9_]+/.test(r));
    assert(withParams.length > 40, `many of them take an id in the path (${withParams.length})`);

    const materialise = (p: string, value: string) => p.replace(/:([A-Za-z0-9_]+)\??/g, value).replace(/\(\.\*\)/g, 'x');
    const callRaw = async (method: string, url: string, body?: string, contentType = 'application/json') => {
        // The limiters in front of the parser count every call from this one address; reset, each call meets the guard.
        resetGatewayRateLimit();
        https.resetAdminRateLimit();
        const res = await localFetch(`${BASE}${url}`, {
            method, headers: body === undefined ? {} : { 'content-type': contentType }, body, signal: AbortSignal.timeout(5000),
        });
        const text = await res.text();
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        return { status: res.status, code: json?.code as string | undefined };
    };
    const call = (method: string, url: string, body?: unknown) => callRaw(method, url, body === undefined ? undefined : JSON.stringify(body));
    const refused = (r: { status: number; code?: string }) => r.status === 400 && r.code === SAMPLE_ID_REFUSAL;

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('event_reminders_sent')").all() as { name: string }[]).map(t => t.name);
    const counts = () => Object.fromEntries(tables.map(t => [t, (db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get() as { c: number }).c]));
    const before = counts();

    // The id keys the apps send, in turn, so the sweep covers flat, array and nested shapes across the routes.
    const BODIES: ((v: string) => unknown)[] = [
        v => ({ id: v }),
        v => ({ postId: v }),
        v => ({ transactionId: v }),
        v => ({ transactionIds: ['00000000', v] }),
        v => ({ decisionId: v, choice: 'for' }),
        v => ({ enterpriseId: v, amount: 1 }),
        v => ({ to: v, amount: 1 }),
        v => ({ targetPubkey: v }),
        v => ({ nested: { treasuryId: v } }),
        v => ({ list: [{ projectId: v }] }),
    ];
    const missed: string[] = [];
    let i = 0;
    for (const route of writes) {
        const [method, routePath] = route.split(' ');
        const ways: [string, string, unknown][] = [
            ['body', `${materialise(routePath, 'sentinel')}`, BODIES[i++ % BODIES.length]('sample-sweep-body')],
            ['query', `${materialise(routePath, 'sentinel')}?id=sample-sweep-query`, undefined],
        ];
        if (/:[A-Za-z0-9_]+/.test(routePath)) ways.push(['path', materialise(routePath, 'sample-sweep-path'), {}]);
        for (const [way, url, body] of ways) {
            const r = await call(method, url, body);
            if (!refused(r)) missed.push(`${route} (${way}: ${r.status} ${r.code ?? ''})`);
        }
    }
    assert(missed.length === 0, `every write route answers 400 ${SAMPLE_ID_REFUSAL} to a sample id in its path, query and body (${writes.length} routes; missed: ${missed.slice(0, 10).join(', ') || 'none'})`);

    console.log('\n── 3. the spellings that got past the first guard, through the real middleware ──');
    // The #1845 review's bypass.mts, each against a member route that takes ids in its body and one with an id in its path.
    const S = 'sample-decision-compost-bay';
    const BODY_ROUTE = '/api/ledger/transfer';
    const PATH_ROUTE = (seg: string) => `/api/enterprise/${seg}/decisions/x/vote`;
    const variants: [string, string, string?][] = [
        ['baseline {to: sample}', JSON.stringify({ to: S, amount: 1 })],
        ['case SAMPLE-…', JSON.stringify({ to: S.toUpperCase(), amount: 1 })],
        ['case Sample-…', JSON.stringify({ to: 'S' + S.slice(1), amount: 1 })],
        ['leading space', JSON.stringify({ to: ' ' + S, amount: 1 })],
        ['trailing newline', JSON.stringify({ to: S + '\n', amount: 1 })],
        ['NBSP prefix', JSON.stringify({ to: ' ' + S, amount: 1 })],
        ['fullwidth s', JSON.stringify({ to: 'ｓ' + S.slice(1), amount: 1 })],
        ['JSON \\u escape', `{"to":"\\u0073ample-decision-compost-bay","amount":1}`],
        ['underscore', JSON.stringify({ to: 'sample_decision_compost_bay', amount: 1 })],
        ['composite prefix', JSON.stringify({ to: 'escrow_' + S, amount: 1 })],
        ['array under id key', JSON.stringify({ postIds: ['x', S] })],
        ['array under non-id key (members)', JSON.stringify({ members: [S] })],
        ['object under non-id key, id inside', JSON.stringify({ vote: { decisionId: S } })],
        ['non-id key (decision)', JSON.stringify({ decision: S })],
        ['top-level array', JSON.stringify([S])],
        ['top-level string', JSON.stringify(S)],
        ['depth 40', JSON.stringify(nest(40, { id: S }))],
        ['dup key, last wins', `{"to":"realkey","to":"${S}","amount":1}`],
        ['__proto__ key', `{"__proto__":{"id":"${S}"}}`],
        ['content-type charset', JSON.stringify({ to: S, amount: 1 }), 'application/json; charset=utf-8'],
        ['content-type +json', JSON.stringify({ to: S, amount: 1 }), 'application/vnd.api+json'],
    ];
    const bodyMissed: string[] = [];
    for (const [label, body, ct] of variants) {
        const r = await callRaw('POST', BODY_ROUTE, body, ct);
        if (!refused(r)) bodyMissed.push(`${label} (${r.status} ${r.code ?? ''})`);
    }
    assert(bodyMissed.length === 0, `each of ${variants.length} body spellings answers 400 ${SAMPLE_ID_REFUSAL} (missed: ${bodyMissed.join(', ') || 'none'})`);
    const paths: [string, string][] = [
        ['baseline', S], ['percent-encoded', encodeURIComponent(S).replace('s', '%73')], ['double-encoded', '%2573ample-decision-compost-bay'],
        ['UPPER', S.toUpperCase()], ['trailing %20', S + '%20'], ['leading %20', '%20' + S], ['matrix ;x', S + ';x'], ['dot suffix', S + '.json'],
    ];
    const pathMissed: string[] = [];
    for (const [label, seg] of paths) {
        const r = await call('POST', PATH_ROUTE(seg), {});
        if (!refused(r)) pathMissed.push(`${label} (${r.status} ${r.code ?? ''})`);
    }
    assert(pathMissed.length === 0, `each of ${paths.length} path spellings answers 400 ${SAMPLE_ID_REFUSAL} (missed: ${pathMissed.join(', ') || 'none'})`);
    const queries: [string, string][] = [
        ['baseline', `?id=${S}`], ['repeated', `?id=x&id=${S}`], ['bracket key', `?id[a]=${S}`], ['plus space', `?id=+${S}`], ['UPPER', `?id=${S.toUpperCase()}`],
    ];
    const queryMissed: string[] = [];
    for (const [label, q] of queries) {
        const r = await call('POST', `${BODY_ROUTE}${q}`, {});
        if (!refused(r)) queryMissed.push(`${label} (${r.status} ${r.code ?? ''})`);
    }
    assert(queryMissed.length === 0, `each of ${queries.length} query spellings answers 400 ${SAMPLE_ID_REFUSAL} (missed: ${queryMissed.join(', ') || 'none'})`);
    // A body the parser doesn't read as JSON (a content type it doesn't match) reaches the route as `{}`: no id rides in it.
    const empty = await call('POST', BODY_ROUTE, {});
    for (const ct of ['APPLICATION/JSON', 'text/plain']) {
        const r = await callRaw('POST', BODY_ROUTE, JSON.stringify({ to: S, amount: 1 }), ct);
        assert(r.status === empty.status && r.code === empty.code && r.code !== SAMPLE_ID_REFUSAL,
            `a ${ct} body is not read, so the route answers as to {} (${r.status} ${r.code ?? ''} = ${empty.status} ${empty.code ?? ''})`);
    }
    const after = counts();
    const changed = tables.filter(t => before[t] !== after[t]);
    assert(changed.length === 0, `and through steps 2 and 3 no table changed (${changed.join(', ') || 'none'})`);

    console.log('\n── 4. the guard refuses sample ids, and nothing else ──');
    // Free text and real-shaped ids pass the guard to whatever comes next (a 401, a 404, a 400 of the route's own): never
    // `sample_id`. Only member routes here: an admin route's refusals are tarpitted (memory http-sweep-test-gotchas).
    const memberWrites = writes.filter(r => !/ \/api\/(local\/admin|manager|admin)\//.test(r)).slice(0, 60);
    const falseHits: string[] = [];
    for (const route of memberWrites) {
        const [method, routePath] = route.split(' ');
        for (const body of [
            { title: 'sample-sale', description: 'sample-sweep', message: 'sample-x', name: 'Sample-Garden', slug: 'sample-garden-x7k2pq' },
            { id: 'abc123', postId: 'f00d', note: 'a sample-x in words', link: 'https://example.org/sample-page' },
        ]) {
            const r = await call(method, materialise(routePath, 'sentinel'), body);
            if (r.code === SAMPLE_ID_REFUSAL) falseHits.push(`${route} ${JSON.stringify(body)}`);
        }
    }
    assert(memberWrites.length > 30 && falseHits.length === 0,
        `free text and real-shaped ids are never refused as sample ids (${memberWrites.length} routes; hits: ${falseHits.slice(0, 5).join(', ') || 'none'})`);
    const readHits: string[] = [];
    for (const route of reads.filter(r => /:[A-Za-z0-9_]+/.test(r) && !/ \/api\/(local\/admin|manager|admin)\//.test(r)).slice(0, 40)) {
        const r = await call('GET', materialise(route.split(' ')[1], 'sample-sweep-read'));
        if (r.code === SAMPLE_ID_REFUSAL) readHits.push(route);
    }
    assert(readHits.length === 0, `a read with a sample id in its path is not the guard's to refuse (${readHits.join(', ') || 'none'})`);

    console.log('\n── 5. every body field the routes read ──');
    const fs = await import('node:fs');
    const nodePath = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const ts = (await import('typescript')).default;
    const srcDir = nodePath.dirname(fileURLToPath(import.meta.url));
    const files: string[] = [];
    (function walk(d: string) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = nodePath.join(d, e.name);
            if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '__tests__') walk(p); }
            else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') && !/^test-|harness|\.test\.ts$/.test(e.name)) files.push(p);
        }
    })(srcDir);
    // The guard reads a body as data, not as fields: it is what is being checked, not a reader of it.
    files.splice(files.indexOf(nodePath.join(srcDir, 'sample-id-guard.ts')), 1);
    const fieldReads = bodyFieldReads(ts, files, f => fs.readFileSync(f, 'utf8'), f => nodePath.relative(srcDir, f));
    const conversation = fieldReads.filter(f => f.route === 'POST /api/messages/conversation').map(f => f.path.join('.'));
    assert(fieldReads.length > 300 && ['participants', 'createdBy'].every(k => conversation.includes(k)),
        `the walk finds the fields the routes read (${fieldReads.length} reads in ${new Set(fieldReads.map(f => f.at.split(':')[0])).size} files), destructured ones too (POST /api/messages/conversation: ${conversation.join(', ')})`);
    const isFreeText = (path: string[]) => path.some(k => FREE_TEXT_KEYS.has(k.toLowerCase()));
    const leafKeys = new Set(fieldReads.flatMap(f => f.path.map(k => k.toLowerCase())));
    const unread = [...FREE_TEXT_KEYS].filter(k => !leafKeys.has(k));
    assert(unread.length === 0, `every free-text key the guard skips is a field some route reads (${FREE_TEXT_KEYS.size} keys; not read: ${unread.join(', ') || 'none'})`);
    const idLike = [...FREE_TEXT_KEYS].filter(k => namesAnId(k));
    assert(idLike.length === 0, `and none of them names an id (${idLike.join(', ') || 'none'})`);
    // Each route sent a sample id under each field its own handler reads (nested where it reads nested); a field read in
    // a helper the walk can't tie to a route goes to a member write route instead. Free-text fields are not the guard's.
    const writeSet = new Set(writes);
    const checks = new Map<string, { route: string; path: string[] }>();
    for (const f of fieldReads) {
        if (isFreeText(f.path)) continue;
        const route = f.route && writeSet.has(f.route) ? f.route : (f.route?.startsWith('GET ') ? null : `POST ${BODY_ROUTE}`);
        if (route) checks.set(`${route} ${f.path.join('.')}`, { route, path: f.path });
    }
    const fieldMissed: string[] = [];
    for (const { route, path } of checks.values()) {
        const [method, routePath] = route.split(' ');
        const body = path.reduceRight<unknown>((acc, k) => ({ [k]: acc }), 'sample-sweep-field');
        const r = await call(method, materialise(routePath, 'sentinel'), body);
        if (!refused(r)) fieldMissed.push(`${route} ${path.join('.')} (${r.status} ${r.code ?? ''})`);
    }
    const routesChecked = new Set([...checks.values()].map(c => c.route)).size;
    assert(checks.size > 250 && fieldMissed.length === 0,
        `each route refuses a sample id under each field it reads (${checks.size} route × field pairs on ${routesChecked} routes; missed: ${fieldMissed.slice(0, 10).join(', ') || 'none'})`);

    console.log('\n── 6. what the guard costs, before the signature is checked ──');
    const median = (xs: number[]) => {
        const s = [...xs].sort((a, b) => a - b);
        return s[Math.floor(s.length / 2)];
    };
    for (const [label, text] of [
        ['2 MB array of 0s', JSON.stringify({ a: new Array(1_000_000).fill(0) })],
        ['2 MB array of short strings', JSON.stringify({ a: new Array(400_000).fill('x') })],
        ['3 MB array of {id}', JSON.stringify({ items: Array.from({ length: 200_000 }, (_, k) => ({ id: 'x' + k })) })],
        ['2 MB of ids under an id key', JSON.stringify({ postIds: Array.from({ length: 150_000 }, (_, k) => 'post-' + k.toString(36).padStart(6, '0')) })],
    ] as const) {
        const parsed = JSON.parse(text);
        // Warm up JIT and ICs so cold start doesn't skew early runs.
        JSON.parse(text);
        bodyCarriesSampleId(parsed);
        const parses: number[] = [];
        const guards: number[] = [];
        for (let r = 0; r < 15; r++) {
            if (r % 2 === 0) {
                const t0 = performance.now(); JSON.parse(text); const t1 = performance.now();
                const t2 = performance.now(); bodyCarriesSampleId(parsed); const t3 = performance.now();
                parses.push(t1 - t0); guards.push(t3 - t2);
            } else {
                const t0 = performance.now(); bodyCarriesSampleId(parsed); const t1 = performance.now();
                const t2 = performance.now(); JSON.parse(text); const t3 = performance.now();
                guards.push(t1 - t0); parses.push(t3 - t2);
            }
        }
        // A bound in proportion to the parse, so it holds on a machine of any speed: measured on Node 22 the guard over 2 MB
        // of ids costs 2.45× the parse (here and on a CI runner ten times slower, 55.6 against 22.7 ms) and the other bodies
        // under 0.6×. The 2× + 10 ms it replaced passed only where 10 ms was large beside the parse (on a fast machine it let
        // the ids through at 6×). A guard ten times as slow fails on the bodies of strings; the 1 ms is the timer's grain.
        const parse = median(parses);
        const guard = median(guards);
        assert(guard <= 4 * parse + 1, `${label}: the guard ${guard.toFixed(1)} ms against the parse's ${parse.toFixed(1)} ms (at most 4× + 1 ms; median of 15, interleaved)`);
    }

    console.log('\n── 7. the Start a community owner route ──');
    const { getStartCommunityUrl } = await import('./config/start-community.js');
    const was = getStartCommunityUrl();
    const unsigned = await call('POST', '/api/local/admin/start-community-url', { url: 'https://elsewhere.example.org/start' });
    assert((unsigned.status === 401 || unsigned.status === 403) && getStartCommunityUrl() === was,
        `an unsigned caller can't change where Start a community leads (${unsigned.status})`);

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exit(1);
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });

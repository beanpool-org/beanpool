// The vault-image workflow's inputs for a RELEASE image (.github/workflows/vault-image.yml, run by hand): the public
// custodian list, the version, the host profile and the two network settings. Checked here, in seconds, before the
// builds; build.sh and the bundle script check each one again themselves.
//
//   node image/release-inputs.mjs [--event <file>]
//
// It reads the inputs from the run's event file (default $GITHUB_EVENT_PATH), never from the command line or the
// environment: a step's env: values are printed at the top of its log, and a refused value may be something that must
// never be printed (a custodian's key file, a seed, a passphrase pasted by mistake). So a refusal says what is wrong and
// never repeats the custodian list, nor another field's value unless it is plain setting text (letters, digits and
// . : / , _ -, and no key's worth of hex). On success it prints the settings and the three public keys (public: anyone
// may rebuild the image and compare) and, when $GITHUB_OUTPUT is set, writes them there for the build job: keys (the
// list as build.sh reads it), version, host, network, network6 and artifact (vault-image-<version>-<host>).
//
// All five empty is the workflow's throwaway build, as it always was: the release jobs do not run at all. Anything
// given needs custodian_keys and version; host is then `none` when empty, network `dhcp` and network6 `ra` (build.sh's
// own defaults), each checked by image-settings.mjs, the code build.sh asks.
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseNetwork, parseNetwork6, readHostProfile } from './image-settings.mjs';

export const INPUTS = ['custodian_keys', 'version', 'host', 'network', 'network6'];
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const PUBLIC_KEY = /^[0-9a-f]{64}$/;
const PLAIN_SETTING = /^[A-Za-z0-9.:/,_-]{1,100}$/;
const SHAPE = '{"genesisCustodians":["<64 hex>","<64 hex>","<64 hex>"]}';
// A custodian key file (custodian/keyfile.ts: v, publicKey, kdf, nonce, ct; an old one: seed) or anything naming a
// private half: refused by name, so the message can say to never paste one.
const SECRET_FIELDS = ['seed', 'ct', 'kdf', 'nonce', 'secretKey', 'privateKey', 'private', 'secret', 'passphrase', 'password', 'mnemonic'];

function refuseKeys(why) {
    throw new Error(`custodian_keys: ${why}. It is the PUBLIC list, ${SHAPE}; nothing secret. (The value is not repeated here.)`);
}

// Ed25519 (RFC 8032 §5.1.3): is this 32-byte encoding a point on the curve? Every public key is one; a custodian's
// 32-byte seed (its private key) has the same length and is one only about half the time, so this catches about half
// of the seeds pasted by mistake, and every key with a typo in it about as often. The real check is the run's printout
// of the three keys, compared with the custodians' own.
const P = 2n ** 255n - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
const mod = (a) => ((a % P) + P) % P;
function pow(base, exp) {
    let result = 1n;
    let b = mod(base);
    for (let e = exp; e > 0n; e >>= 1n) {
        if (e & 1n) result = (result * b) % P;
        b = (b * b) % P;
    }
    return result;
}
export function isEd25519Point(hex) {
    if (typeof hex !== 'string' || !PUBLIC_KEY.test(hex)) return false;
    const bytes = Buffer.from(hex, 'hex');
    const xOdd = (bytes[31] & 0x80) !== 0;
    bytes[31] &= 0x7f;
    const y = BigInt(`0x${Buffer.from(bytes).reverse().toString('hex')}`);
    if (y >= P) return false; // not canonical
    const y2 = (y * y) % P;
    const x2 = mod((y2 - 1n) * pow(D * y2 + 1n, P - 2n));
    if (x2 === 0n) return !xOdd; // x = 0 has no odd root
    return pow(x2, (P - 1n) / 2n) === 1n; // x² must be a square
}

/** The public custodian list, strictly: exactly three different public keys, in the order given. Anything else throws. */
export function parseCustodianKeys(text) {
    if (typeof text !== 'string' || text.trim() === '') refuseKeys('empty');
    if (text.length > 1024) refuseKeys(`${text.length} characters, far longer than three public keys`);
    if (/-----BEGIN|PRIVATE KEY/.test(text)) refuseKeys('this looks like a PEM private key: never paste one');
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        refuseKeys('not JSON (twelve or twenty-four words, a passphrase or a bare key are not the list)');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) refuseKeys('not a JSON object');
    const fields = Object.keys(parsed);
    if (fields.some((f) => SECRET_FIELDS.includes(f)) || (fields.includes('v') && fields.includes('publicKey'))) {
        refuseKeys('this looks like a custodian KEY FILE, or has a field for a private key or passphrase: never paste one');
    }
    if (fields.length !== 1 || fields[0] !== 'genesisCustodians') refuseKeys(`${fields.length} field(s); the only field is genesisCustodians`);
    const keys = parsed.genesisCustodians;
    if (!Array.isArray(keys)) refuseKeys('genesisCustodians is not a list');
    if (keys.length !== 3) refuseKeys(`genesisCustodians has ${keys.length} entries, not 3`);
    keys.forEach((k, i) => {
        if (typeof k !== 'string') refuseKeys(`key ${i + 1} is not text`);
        if (/^[0-9a-fA-F]{128}$/.test(k)) refuseKeys(`key ${i + 1} is 128 hex characters: a private key with its public half. Never paste one`);
        if (!PUBLIC_KEY.test(k)) refuseKeys(`key ${i + 1} is not 64 lower-case hex characters`);
        if (!isEd25519Point(k)) refuseKeys(`key ${i + 1} is not an Ed25519 public key (no point on the curve): a typo, or a seed (private key), which has the same length`);
    });
    if (new Set(keys).size !== 3) refuseKeys('two of the keys are the same');
    return [...keys];
}

/**
 * The release image's settings from the workflow's inputs ({custodian_keys, version, host, network, network6}, each
 * a string or absent), or null when every one is empty (the throwaway build). Throws, saying why, on anything else.
 */
export function releaseInputs(inputs) {
    const given = {};
    for (const name of INPUTS) {
        const value = inputs?.[name];
        if (value !== undefined && value !== null && typeof value !== 'string') throw new Error(`${name}: not text`);
        given[name] = (value ?? '').trim();
    }
    if (INPUTS.every((name) => given[name] === '')) return null;
    // The other fields are plain settings, and their own checks (below, and image-settings.mjs) repeat the value in a
    // refusal. So first: anything else there (the list or a key file pasted into the wrong field, a key's worth of hex)
    // is refused without repeating it.
    for (const name of INPUTS.slice(1)) {
        if (given[name] !== '' && (!PLAIN_SETTING.test(given[name]) || /[0-9a-fA-F]{32}/.test(given[name]))) {
            throw new Error(`${name}: not a setting (letters, digits and . : / , _ - only, and never a key; the value is not repeated here)`);
        }
    }
    if (given.custodian_keys === '') {
        throw new Error('custodian_keys is empty but other settings are given: a release image needs the public custodian list (leave every field empty for the throwaway build)');
    }
    if (given.version === '') throw new Error('version is empty: a release image needs its version, e.g. 1.1.0');
    if (!VERSION.test(given.version)) throw new Error(`version ${JSON.stringify(given.version)} is not MAJOR.MINOR.PATCH, e.g. 1.1.0`);
    const keys = parseCustodianKeys(given.custodian_keys);
    const profile = readHostProfile(given.host || 'none');
    const network = parseNetwork(given.network || 'dhcp');
    const network6 = parseNetwork6(given.network6 || 'ra');
    if (network.kind === 'dhcp' && network6.kind !== 'ra') throw new Error('network6 static needs network static (build.sh refuses it too)');
    return {
        keys,
        version: given.version,
        host: profile.profile,
        network: network.value,
        network6: network6.value,
        artifact: `vault-image-${given.version}-${profile.profile}`,
    };
}

/** The `name=value` lines for $GITHUB_OUTPUT. Every value is one line (checked above), so no delimiter form is needed. */
export function outputLines(r) {
    const values = {
        keys: JSON.stringify({ genesisCustodians: r.keys }),
        version: r.version, host: r.host, network: r.network, network6: r.network6, artifact: r.artifact,
    };
    for (const [k, v] of Object.entries(values)) if (/[\r\n]/.test(v)) throw new Error(`${k}: more than one line`);
    return Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join('');
}

// A workflow command's message: % and line breaks escaped, as the runner reads them.
export const commandText = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

function isMain() {
    try {
        return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
}

if (isMain()) {
    const fail = (why) => {
        process.stdout.write(`::error title=Release image inputs refused::${commandText(why)}\n`);
        process.stderr.write(`release-inputs: ${why}\n`);
        process.exit(2);
    };
    const args = process.argv.slice(2);
    let eventFile = process.env.GITHUB_EVENT_PATH;
    if (args.length === 2 && args[0] === '--event') eventFile = args[1];
    else if (args.length !== 0) fail('usage: release-inputs.mjs [--event <file>]');
    if (!eventFile) fail('no event file ($GITHUB_EVENT_PATH or --event)');
    let inputs;
    try {
        inputs = JSON.parse(readFileSync(eventFile, 'utf8')).inputs ?? {};
    } catch {
        fail('could not read the inputs from the event file');
    }
    let r;
    try {
        r = releaseInputs(inputs);
    } catch (e) {
        fail(e instanceof Error ? e.message : 'refused');
    }
    if (r === null) fail('only spaces were given: leave every field empty for the throwaway build, or give custodian_keys and version for a release image');
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, outputLines(r));
    process.stdout.write([
        `release image ${r.version}, host ${r.host}, network ${r.network}, network6 ${r.network6}; artifact ${r.artifact}`,
        'custodian keys (public, in this order; compare each with the custodian\'s own):',
        ...r.keys.map((k, i) => `  ${i + 1}. ${k}`),
        '',
    ].join('\n'));
}

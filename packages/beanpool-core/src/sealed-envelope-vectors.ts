/**
 * Fixed `bpseal/v1` vectors, and the checks that run them — shared by core's vitest suite, the
 * native app's test runner and the PWA's, so all three prove the SAME bytes open the same way.
 *
 * The envelopes below were sealed once and are frozen. If a change to `sealed-envelope.ts` stops
 * any of these opening, that change has broken every envelope already on a standby or in a backup:
 * fix the change, never regenerate the vectors.
 *
 * Kept out of the main index (import `@beanpool/core/sealed-envelope-vectors`) so no app bundle
 * carries it unless a test imports it. The checks throw a plain Error on failure and depend on no
 * test framework, which is what lets one list run under three runners.
 *
 * How they were made: owner and node seeds are SHA-256("bpseal/v1 test vector: <label>"); the
 * recovery code's entropy is the first 16 bytes of SHA-256("bpseal/v1 test vector: recovery code 3")
 * and its salt SHA-256("bpseal/v1 test vector: recovery code 3 salt"), with `codePub` computed
 * straight from the §2.6 formula (scrypt N=16384 r=8 p=1 → X25519), independently of the module.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
    SealedEnvelopeError,
    checkRecoveryCode,
    formatRecoveryCode,
    openEnvelope,
    parseRecoveryCode,
    readSealedHeader,
    verifySealedHeader,
    type SealedEnvelopeKey,
} from './sealed-envelope.js';

export const SEALED_ENVELOPE_VECTORS = {
  "nodeSeedHex": "4a002696020e5dead5216532ee1c3c03442ab4ae5ae1ac4414b437b23cdab776",
  "nodePubkeyHex": "941cc932392eb68b5779eb13007d27b1cfa9d798c143c8fb41215eec12436e51",
  "owners": [
    {
      "callsign": "alice",
      "seedHex": "5616115dfff6fc94b08c8f8b2616a91839c581c17e3c3ceb1b1d36e2c73a780a",
      "pkcs8Hex": "302e020100300506032b6570042204205616115dfff6fc94b08c8f8b2616a91839c581c17e3c3ceb1b1d36e2c73a780a",
      "pubkey": "a480c9649c8c0e3c373176a6e77a60f1f10cb854722782eb44788a8632978d0a"
    },
    {
      "callsign": "bob",
      "seedHex": "6656f535aa556721102095d736a3ebe292f809dbf3088dc25dc4ce25ffb68fb9",
      "pkcs8Hex": "302e020100300506032b6570042204206656f535aa556721102095d736a3ebe292f809dbf3088dc25dc4ce25ffb68fb9",
      "pubkey": "c0c332ad95ed91e26a2ce5e12c99493596fe33459d87f42849ba8ccfbbb65d5f"
    },
    {
      "callsign": "carol",
      "seedHex": "f0503ad9c7c1ded3e5ab8d764dbe53ad3d97b0281044e78ad30ef9c6c336fff5",
      "pkcs8Hex": "302e020100300506032b657004220420f0503ad9c7c1ded3e5ab8d764dbe53ad3d97b0281044e78ad30ef9c6c336fff5",
      "pubkey": "6360daffbf2d1eec8975036db4a1c52447126c7802cbc927de4d04477706094b"
    }
  ],
  "recoveryCode": {
    "codeId": 3,
    "entropyHex": "80214cf562481556e61f98588c899647",
    "printed": "BPRC-3  G0GM-SXB2-90AN-DSGZ-K1C8-S2CP-8W21",
    "record": {
      "codeId": 3,
      "codePub": "a/qFP2NS5ABKY/5mFO5+SZo6Y1XI4ZgD3RbREkFYZwY=",
      "salt": "UhDfUOM74URF7sklsDclKnIwMFIVugmCNX7Sb+rheKA=",
      "N": 16384,
      "r": 8,
      "p": 1,
      "createdAt": "2026-09-19T00:00:00.000Z"
    }
  },
  "takeover": {
    "payloadUtf8": "{\"libp2p_key\":\"vector\",\"note\":\"take-over bundle vector\"}",
    "envelopeHex": "0000061c7b226368756e6b53697a65223a313034383537362c22636f6d6d756e6974794964223a22766563746f722d636f6d6d756e697479222c22637265617465644174223a22323032362d30392d31395430303a30303a30302e3030305a222c22656e76656c6f70654964223a226366366436303936373037616535626662656436613231626231393264363337222c226b696e64223a2274616b656f766572222c226e6f6465506565724964223a22313244334b6f6f57566563746f724e6f6465506565724964222c22726563697069656e7473223a5b7b2263616c6c7369676e223a22616c696365222c22657068223a22386e4b6c5468553577702b656f59416d6a4d39782b64434534637a686267364a415a2f416a656a77697a6f3d222c226e6f6e6365223a22734e4659534d3833476b532f3441546b2f5846612b5631474e2f694d4d544c66222c227075626b6579223a2261343830633936343963386330653363333733313736613665373761363066316631306362383534373232373832656234343738386138363332393738643061222c2274797065223a226f776e6572222c227772617070656444656b223a2257324b42657a74594c63732b46793951336b7961595961353270574c35562b586173684155503864514a70414f4e2b6b5361774272786c4e32454a3772666539227d2c7b2263616c6c7369676e223a22626f62222c22657068223a224b4155416b536f5078347644316a42357a59353935523048706138734b5a443466793678464f734d3443733d222c226e6f6e6365223a22314536314266464c7354575551613547764367614958437073724a59596b5761222c227075626b6579223a2263306333333261643935656439316532366132636535653132633939343933353936666533333435396438376634323834396261386363666262623635643566222c2274797065223a226f776e6572222c227772617070656444656b223a224e50736b72665665542f46726c44666554624850444b6f746257483668693376576c4d3566494f336f49584a45795732674d3874492b5238666571526c2b2f79227d2c7b2263616c6c7369676e223a226361726f6c222c22657068223a226b6b6b486a483252795069506d634453324343512b5571593034537a6339526f713869387a5742774d6c343d222c226e6f6e6365223a222b4e546630514e4543374e6e3055785376454c4d6e70454b332f70344b634553222c227075626b6579223a2236333630646166666266326431656563383937353033366462346131633532343437313236633738303263626339323764653464303434373737303630393462222c2274797065223a226f776e6572222c227772617070656444656b223a2257306e77762f30377641726d795678346a366f5936384e4b573363587466754647416a74724572414665536944457655496a2b443754623950502f4d6f746955227d2c7b224e223a31363338342c22636f64654964223a332c22636f6465507562223a22612f714650324e533541424b592f356d464f352b535a6f3659315849345a674433526252456b46595a77593d222c22637265617465644174223a22323032362d30392d31395430303a30303a30302e3030305a222c22657068223a224a6a33415161495664592b616f7454737030785a42515a4a2f705464774d525856714232326f65362b77673d222c226e6f6e6365223a226a514a516b2b48796578677742344f5a434e576c726242794539724e7361726a222c2270223a312c2272223a382c2273616c74223a2255684466554f4d373455524637736b6c7344636c4b6e49774d46495675676d434e583753622b7268654b413d222c2274797065223a22636f6465222c227772617070656444656b223a224f79592b3978665338436d7734455746657952735842796c76797a4f55524471634742794b4c794645362b74456f3877326b5767543430797939704c74504e69227d5d2c22736967223a224a454c754c6f30357275666e352b32677857444b7934505859457345347464774f374e6c5633575965427846506752696f6c6f312b356c564b75486f655a7a396f3654453277512b6d754a34766144514e2b395543773d3d222c2276223a2262707365616c2f7631227d735ee798d79696160a48df996243f17dfa6d6263f08b3701cad55ca0ac095702d6e6201e3fcaed8773a0711ad42e2f054ae453b78432ae0b62fa4c448dd1051a3144d7e86790374f"
  },
  "backup": {
    "payloadSha256Hex": "beb91347db44f7a0e0fef7f837786197a931f969cfe3961cd47c41f3a86f147a",
    "payloadLength": 2500,
    "envelopeHex": "000003d97b226368756e6b53697a65223a313032342c22636f6d6d756e6974794964223a22766563746f722d636f6d6d756e697479222c22637265617465644174223a22323032362d30392d31395430303a30303a30302e3030305a222c22656e76656c6f70654964223a226264353531343736393530623234353738646333373963626464666464643263222c226b696e64223a226261636b7570222c226e6f6465506565724964223a22313244334b6f6f57566563746f724e6f6465506565724964222c22726563697069656e7473223a5b7b2263616c6c7369676e223a22616c696365222c22657068223a225031466378584559486b44354634675238577a6259616f77754a6163694a454b586952464d364d317947673d222c226e6f6e6365223a2234414b7475785144696c454b6e645363332f544e36534268516d346b35443059222c227075626b6579223a2261343830633936343963386330653363333733313736613665373761363066316631306362383534373232373832656234343738386138363332393738643061222c2274797065223a226f776e6572222c227772617070656444656b223a2237466e456279772b4d4f4f36416342775577726f723967594d6645544363707478396a614878395535504d756e6e7056704c5a7549583145376671542b51644a227d2c7b224e223a31363338342c22636f64654964223a332c22636f6465507562223a22612f714650324e533541424b592f356d464f352b535a6f3659315849345a674433526252456b46595a77593d222c22637265617465644174223a22323032362d30392d31395430303a30303a30302e3030305a222c22657068223a224e33542f4e5a35332f62687a30664c7534365276783870744f5044656d50613157533967337230343533593d222c226e6f6e6365223a2265766338647563756f53595a7543447a3279394a356f325278423667727a4c30222c2270223a312c2272223a382c2273616c74223a2255684466554f4d373455524637736b6c7344636c4b6e49774d46495675676d434e583753622b7268654b413d222c2274797065223a22636f6465222c227772617070656444656b223a223749592b354c504e527854634a733136584c756b333378782b476c51592f4f64344f33724278334531476f735075306e576e396f385261752b74667955624c58227d5d2c22736967223a2235315a634e7750525479647664546f6c3431746b474533416c794b6f4579376e4463772f4a533237556a5943432f4f3268485241474b6c68314e5a37767678396f4d595a6a6d7873613733425a747730442f706441673d3d222c2276223a2262707365616c2f7631227db510d4cfee2824a4a2d4170663b8d711fdd6669e0adb30238b07d67640d6659e662471b5bab8e431a1292680536edaf42bbe12c226cc7308c2b8a6ea0cb0b3613d3347fa9f9a39868c08cb11f29573b6421fbe6f94cc55d6d8d2905e545958df301a4a5dc666010a6b56cbfc6f5273f69ecececb02ec269fc3095f407363dc884e563b4b939b0ecc138430bc0ab7062cb8e5eaa96ce1b9f6be3774979520c4db9cdc24a0c1561687a5e82cd1e2384b9e94b243ec44f454fce0d7d2d551d3e0d69f2da38b882bb184a22b9e4756ae0bbf9f9b181f3e1c8e34d55d5a8575218df7e133ad1eb8af05d0f439937d1483dddbc4687d70fd9ff1bb47358d8d2dd89a72105268b33889bac404cfb43dd1edc2e1cf362eacb995b66b67d0d5858022d707f098718b5340f928a6dcdb28e6727d2fd732811d7dea29d4811dea994d6415d0fb5ff900373819dc01abd67c862f36002b3a8e3e027ff7e6418f0a1056d2200ead092e2a0387bdce9fd18d1e611f0ac1b683e99cdb3879f1d73ff5cf842cc36ba9a3e90edfe2bea04fc63eda67ebeaa929fd3601cfb4a96225b4f8769b353616b550a3c68b216e03337aae202ad5974085db8ab6e79f3213f4c0f50089cc1e6a219369e010623fc13758b6a621b26fdaaa5679ce3894abc04473f8a6ded30e333cccd5996509a8cd90d2a7fc70573fb072dfb3ca14fcc909ef53ce72abf9cb0f7b888d78412c02691ca8a712b987b85d66367babb5bde24dcf3cc7a48059e1e7f1c1235adbc974b9eaaea00097223fff589df24d9a949f8bff547f8413210b4584df7804d4fd2030ea8c55b76f4d3689cdb26a0287dc374d4846358b70e9eca9a1bbf36fe7a6b75ce1af82e22abd8c4d1d81198966c7203bd5237c180a2c4caa1bbe3737aecfd1fa96d2653b0fbf93832a380437950fb737e645cf7c22a32d7bcf630238c375f035b0ae936760668122461b0b13064b3c93b516e611fb18f9e7c70e51aa80e36a12eca314a9695decf527825e77d8bb9a37065fd3f125539d1f74c50dcee0647279887dcfabc5e1a2c5ecdbc7a710b562f65c494fcd83ee3bea1c7f957388eb6ae3238508a4d1e64c5756a2266c2330e057402cbefda828164ddff5b6eb37492d8f04d2534e5423ada59a0b4cf34d7810efa2a18a9c0ba3f029ba0b2eb9244c67d85c852f57c170519166f692402eab0c106206bd3bf57edca657db24e4117db79aa29a49d9124d965186103cf667bdcffbbaccee1dc8fe37e925d6c651ef4bc9049eb6b51e27c1c6548977c3f67243ec6e897b12c383078f25756178a8817ed1f5901a04d7ba40c69205a31dc41d1f59f1e050300ee4ca20e9c2caa4f2f0e3e1dfa927c6cd24e4d9e2bca3d4db17c2169bb7f0efd42312267efa40f5205b9ea9658353ca9dbfca73a3f8058c808c2626316fcc4c804427047c72e8846f2a8b4abfa537ce73d7d636aeabf9de143095aca31791f093356beccc1c59d1fc28f05f2f6fb89c00a44d5815e9355f115b65a08f8832633a27ad93e58376ceee03265d255fe09acdb573d9035f5753699f345b682d5cb77c97d07c545d04f4c7a803848aab3644a7a81212539c3f9a264cf21278431e4d954352073a25582cf8d8867dfbcb07a0ef26142e41a357cea49eb71bc594ed2a760fb923717b33c6c34650a50e4a4d8f7de098e4722ea55b8e22059a4b8ac992043df473d61f611b7132444ee100a567214611a4e80a86f832c8236ce9a99596559c91942f732793b9139b3ad2f40f5ec47576872f819badb8c546f799a751d97bb6e321afa7c71c4f507dd877c5190cc8d3286dd9a1c7e3b5379c126983980414c7548a7b153551520827fc25a57aa45523118aef2c45c7fd60dfbe5683f92c3e33d13a9b96db973eda07e4979d2beea5aa0ba7afb3be92f453b37bfbff87e240b8b1877891f5e35bde4ebe4e6abc15bf12f0751e5c63a0b39b5642a63acc878fab252c273c40a8dbbc91f35f111adbbb7649b8d97bb25fd490085357ee547a07cdfc49ba5c69bcc9122080ffc7634138e6fa400ced3a6d571728c68ef139d67be12f7488f33994f6751eb022e6157c83f7b54f33c5f679edac689b673f9d1f63c9c3d0cf3cdf4603577e55ebbe4bc1351f20c38ba7134a08bb6f9787002cc6fedae9363c124b3912caf1de0dad781ed1a501996144a23b712507276c9f686e68bc40a20b8fbc138d9985c93b50f7f872d3745c80fc0606b1ea3a9cbe159fd23dec38fc18ce129806af72ff5d8210091866ba1098cd26c0e3ff2e91b03ced2f97f99342a926cf2086fced5ef34d9255f4c4a38a8c503f1c107987022f174c7aeed95ef9bbd3637ff6738e180c5c503ac05a9d5f0f85ec9f6cb0ccecb1e25a59f58a68f914f9559dfacaded3aa989ab065380d57dfdd6232f350c600964a8196d6a0e427f589f38e0043c107bbb3824fafce950e0011e07dd5414470da26f2ffdde3eb9c8787131a973666eace44589b5e4cb0a503702f61d8faa27609a2c753ba7c24deb83d04d50203fe3afe7d6753c5cde9e5821761a4d93ee82f995b9b4e74aa95a0a34cf0089b22db09bd4fb3cb8517d9adbd196ede7dff6cec50a29464d26f0106ae52cad385ea09dce2c92c29a8aeb1fa65950e5803a3819793569e56533575e7c783f23e8e9ac3bc2f32e8cc08f5a60bae31a8089d9e8e820304b01dbe1102f21e9087d52a765c9e9e4ecbef6f6f8f45dbdb9f3688570b2bd84ec96823338282cacb58d370204d0bf569a75c9c4f51595cdc5d9422b377c48a3a23459a38bfdd9f5fd3272b35ac92cbbc9e1f0d3bab19615dc3edf1de2b612222a3fe2bb48ad57ef353abf8bad2b942182aed6bd2fa236698cddfe5a55714f3939304b6a5ad1a0d786e823ea7e90300f6586598eb3297b67bda5f5949ea30d3e4ceafaa1514d1770dfeb1549d7d6c0f6f45a75ff5b5344c42b32da3cb78521a36f2323409064f8e76ffe20c81df9516e60bf27acb8abec792814f7555a933779884606df80b92f0d57d74112282ab37bea6fccba2e4b9128d49f886b5ab2009a34722b045db2161c75093f6a9151a2116411e491d8397c80a96ea5ddf7bb4bc57b48644bc6fda45f60cc3630fc6c7b44136da8af5ee5632df08177b570de37fd4445996a803ab0b994cb1d6e2cde4f7c71a7718adcb7842d71cc975a345e996b9ca34b1b62dfe788facdb801ba5f79fa10100073392de6ac7a168daa843d6da729d9cdd364eeb9218a7fa81d1c57b8f6c732abfc01f04a81256689d8d7b77bc9ed548bf64410cef850de2f5f45929465b9b62c42837cb3aa7101eabb4bbbdce09ad9b541b1686d9eafebd4c9f61c9ad8dca8400a2666b31df655fd294f655cae9c5ab2345c75f585edeb308092e4c36809b2b67ded210aa32d4acc879895a0ef86d7c05467dd14f4ef83988f29c4d48f8401f34009502a41655d485c42fd4a48fe89385f3ca81a84a89dd5512a69736bec300523128ffa8df3d9064f490a13f8881a19116b176db84f6a4797eb4d104809feda70b38d5d92ef83775015769e41ea3fd0cec216f4cf17d2ba5d4300a9a2b93785329d4a8ca0609da43"
  }
} as const;

export interface SealedEnvelopeVectorCheck {
    name: string;
    run: () => Promise<void>;
}

function check(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(`sealed-envelope vector: ${message}`);
}

async function expectRefusal(fn: () => Promise<unknown>, what: string, message?: RegExp): Promise<SealedEnvelopeError> {
    try {
        await fn();
    } catch (e) {
        check(e instanceof SealedEnvelopeError, `${what}: threw ${(e as Error)?.name}, not SealedEnvelopeError`);
        check(!message || message.test(e.message), `${what}: message '${e.message}' does not match ${message}`);
        return e;
    }
    throw new Error(`sealed-envelope vector: ${what} was not refused`);
}

function textOf(bytes: Uint8Array): string {
    // No TextDecoder: Hermes. The vector payload is ASCII.
    return String.fromCharCode(...bytes);
}

/** Every owner key in all four shapes the apps hold it in. */
function ownerKeyShapes(owner: { seedHex: string; pkcs8Hex: string }): [string, SealedEnvelopeKey][] {
    return [
        ['32-byte seed, hex', { type: 'owner', privateKey: owner.seedHex }],
        ['32-byte seed, bytes', { type: 'owner', privateKey: hexToBytes(owner.seedHex) }],
        ['48-byte PKCS8, hex', { type: 'owner', privateKey: owner.pkcs8Hex }],
        ['48-byte PKCS8, bytes', { type: 'owner', privateKey: hexToBytes(owner.pkcs8Hex) }],
    ];
}

export const SEALED_ENVELOPE_VECTOR_CHECKS: SealedEnvelopeVectorCheck[] = (() => {
    const V = SEALED_ENVELOPE_VECTORS as unknown as VectorShape;
    const takeover = () => hexToBytes(V.takeover.envelopeHex);
    const backup = () => hexToBytes(V.backup.envelopeHex);
    const checks: SealedEnvelopeVectorCheck[] = [];

    checks.push({
        name: 'the recovery code prints and parses exactly as frozen',
        run: async () => {
            const printed = formatRecoveryCode(V.recoveryCode.codeId, hexToBytes(V.recoveryCode.entropyHex));
            check(printed === V.recoveryCode.printed, `printed ${printed}, expected ${V.recoveryCode.printed}`);
            const parsed = parseRecoveryCode(V.recoveryCode.printed.toLowerCase());
            check(parsed.codeId === V.recoveryCode.codeId, 'code number did not parse');
            check(bytesToHex(parsed.entropy) === V.recoveryCode.entropyHex, 'entropy did not round-trip');
        },
    });

    checks.push({
        name: 'the take-over header is signed by the node key and lists all four recipients',
        run: async () => {
            const header = readSealedHeader(takeover());
            check(header.v === 'bpseal/v1' && header.kind === 'takeover', 'wrong version or kind');
            check(header.recipients.length === 4, `expected 4 recipients, got ${header.recipients.length}`);
            check(verifySealedHeader(header, V.nodePubkeyHex), 'signature did not verify against the node key');
            check(!verifySealedHeader(header, V.owners[0].pubkey), 'signature verified against the wrong key');
        },
    });

    for (const owner of V.owners) {
        for (const [shape, key] of ownerKeyShapes(owner)) {
            checks.push({
                name: `owner ${owner.callsign} opens the take-over envelope with a ${shape}`,
                run: async () => {
                    const { payload } = await openEnvelope(takeover(), key, { kind: 'takeover' });
                    check(textOf(payload) === V.takeover.payloadUtf8, 'payload differs');
                },
            });
        }
    }

    checks.push({
        name: 'the printed recovery code opens the take-over envelope and checks true',
        run: async () => {
            const { payload } = await openEnvelope(takeover(), { type: 'code', code: V.recoveryCode.printed }, { kind: 'takeover' });
            check(textOf(payload) === V.takeover.payloadUtf8, 'payload differs');
            check(await checkRecoveryCode(V.recoveryCode.printed, V.recoveryCode.record), 'checkRecoveryCode said false');
        },
    });

    checks.push({
        name: 'the three-chunk backup opens for its owner and for the code',
        run: async () => {
            for (const key of [
                { type: 'owner', privateKey: V.owners[0].pkcs8Hex },
                { type: 'code', code: V.recoveryCode.printed },
            ] as SealedEnvelopeKey[]) {
                const { header, payload } = await openEnvelope(backup(), key, { kind: 'backup' });
                check(header.chunkSize === 1024, 'chunk size');
                check(payload.length === V.backup.payloadLength, `length ${payload.length}`);
                check(bytesToHex(sha256(payload)) === V.backup.payloadSha256Hex, 'payload hash differs');
            }
        },
    });

    checks.push({
        name: 'a PKCS8 key with a wrong header throws SealedEnvelopeError naming PKCS8',
        run: async () => {
            const bad = hexToBytes(V.owners[0].pkcs8Hex);
            bad[9] ^= 0x01; // the Ed25519 OID
            const err = await expectRefusal(
                () => openEnvelope(takeover(), { type: 'owner', privateKey: bad }, { kind: 'takeover' }),
                'wrong-header PKCS8', /PKCS8/,
            );
            check(err.name === 'SealedEnvelopeError', `name is ${err.name}`);
        },
    });

    checks.push({
        name: 'an owner who is not a recipient is refused',
        run: async () => {
            await expectRefusal(
                () => openEnvelope(backup(), { type: 'owner', privateKey: V.owners[1].seedHex }, { kind: 'backup' }),
                'non-recipient owner', /not one of the owners/,
            );
        },
    });

    checks.push({
        name: 'a take-over envelope is refused when a backup is expected',
        run: async () => {
            await expectRefusal(
                () => openEnvelope(takeover(), { type: 'owner', privateKey: V.owners[0].seedHex }, { kind: 'backup' }),
                'wrong kind', /'takeover' envelope/,
            );
        },
    });

    checks.push({
        name: 'the same seed derives the same public key the header names',
        run: async () => {
            const header = readSealedHeader(takeover());
            const names = header.recipients.filter((r) => r.type === 'owner').map((r) => (r as { pubkey: string }).pubkey);
            check(JSON.stringify(names) === JSON.stringify(V.owners.map((o) => o.pubkey)), 'owner pubkeys differ');
        },
    });

    return checks;
})();

interface VectorShape {
    nodeSeedHex: string;
    nodePubkeyHex: string;
    owners: { callsign: string; seedHex: string; pkcs8Hex: string; pubkey: string }[];
    recoveryCode: {
        codeId: number; entropyHex: string; printed: string;
        record: { codeId: number; codePub: string; salt: string; N: number; r: number; p: number; createdAt: string };
    };
    takeover: { payloadUtf8: string; envelopeHex: string };
    backup: { payloadSha256Hex: string; payloadLength: number; envelopeHex: string };
}

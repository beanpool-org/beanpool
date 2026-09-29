# @beanpool/vault — BeanPool's key vault

A small server that keeps each member's locked sign-in recovery copy, and gives one back only after it has checked
the Google, Apple or Facebook sign-in itself. No community keeps a copy or can ask for one. The design is
`scratch/global-node/DESIGN-key-vault-opus.md` (V2: the two programs; V3: the image, releases and the custodian
tool), with `DESIGN-vault-host-tee-opus.md` §5.1 for the host checks.

**Where it stands (say it this way, and no other).** The unlock is built 2 of 3, but until the reshare to the other
custodians one person, BeanPool's founder, holds all three shares, every release key and the hosting login. The host
(1984 Hosting in Iceland, not bought yet) is an ordinary rented server: **the host can read the vault's memory, and
nothing proves in hardware what it runs** (`platform: none`). Nothing here holds a real member's copy until the
reshare is done.

## Two programs, the launcher and the install step

- **`vault-keyholder`** (`src/keyholder/`) holds the shares while they arrive, the master secret `M` for as long as
  it takes to use it, and the working keys. It never hands out a key but one: `K_disk`, to root on the same machine,
  for the kernel's dm-crypt (root can read its memory anyway). What it does is a fixed list: HMAC a copy's indexes,
  wrap an envelope (from a deposit box it opens itself), read an envelope's metadata, release a copy sealed to the
  restoring device's key, sign a ticket or the daily report, seal and open backups; and the ceremonies: genesis,
  unlock, reshare, taking a backup's state into a fresh vault. It listens on a Unix socket, and has no network.
- **`vault-api`** (`src/api/`) is plain `node:http`: the routes, the SQLite database (`node:sqlite`, no native
  module), holds, Expo pushes, rate limits, backups, `/v1/report`, and the hourly release check. It holds no key and
  never sees a copy in the clear.
- **`vault-launcher`** (`src/launcher/`) is what systemd starts for the API. It runs the image's API, and hands over
  to a newer release's API without a restart or an unlock (below). It changes only with the image.
- **`vault-install`** (`src/install/`) is root's step at the monthly restart: it installs a new image the API staged
  only if its own check from the pinned keys passes (below). It changes only with the image.

Any restart of the keyholder leaves the vault locked until two custodians unlock it. While locked, every route but
`/v1/health` and `/v1/unlock/*` answers 503 `{locked: true}`.

## The keys

`M` (32 bytes) is split 2 of 3 in SLIP-0039 (`src/keyholder/slip39.ts`, checked against the 45 official vectors), each
share sealed to one custodian's pinned Ed25519 key. `M` opens `DK`, the working keys: `K_index` (the `sub_index` and
`pk_index` HMACs), `K_wrap` (envelopes), `K_disk` (the data partition's LUKS2 key), `K_backup`, the Ed25519 ticket
key and the X25519 deposit key. The apps pin the last two. A reshare changes `M`, `K_wrap` and `K_backup` and keeps
the rest.

A genesis or a reshare is two steps. The new state waits beside the old one (`state.next.json`), and the new shares,
sealed to their custodians, can be fetched again (`/v1/unlock/pending`), also after the switch, until the keyholder
restarts. The vault switches only when two of the new custodians show they hold their share: each signs a check of
its words (`/v1/unlock/confirm`), or two of them unlock with the new shares. Until then the old shares are the ones in
force, so no lost answer or restart can leave a vault that nobody can open. Two current custodians can drop a reshare
nobody finished (`/v1/unlock/cancel`); a genesis nobody finished is replaced by the next one.

**All three new custodians fetch and confirm their share**, the third one after the switch too (`vault-custodian
fetch-share`): `/v1/report`'s `shares` says how many of the three have (`{generation, confirmed, of}`, known since the
keyholder's last start). Custodians keep their old shares until the vault has switched (the confirm answer says
`switched`), and destroy them then.

## Routes

| route | signed by | does |
|---|---|---|
| `GET /v1/health` | nobody | `{state, release, since}`: `release` is the image the vault booted |
| `POST /v1/ticket` | the member key, or a throwaway key to restore | a ticket; the provider nonce is `base64url(SHA-256(ticket))` |
| `POST /v1/copies` | the member key | a deposit: `{ticket, provider, idToken, box}` |
| `POST /v1/copies/status`, `/delete`, `/v1/push-token` | the member key | connected sign-ins and open holds; disconnect; this device's push token |
| `POST /v1/restore`, `/v1/restore/collect` | the throwaway key | every restore is held 24 hours (D2), then released sealed to that key |
| `POST /v1/holds/approve`, `/cancel` | the member key | "Yes, it's me" (released now), or Stop (never released) |
| `GET /v1/report` | nobody | signed daily totals, nothing per member (below) |
| `POST /v1/unlock/*`, `/v1/reshare/*` | a custodian key | hello, genesis, share, restore-from-backup; pending, confirm, cancel (a genesis or reshare waiting); reshare |

Requests are signed in BeanPool's request format 2 (`@beanpool/core` `request-signing.ts`) for the vault's own host
name. The wire formats the phone shares (tickets, deposit boxes, releases) are `@beanpool/core` `vault-wire.ts`.

The sign-ins it keeps copies for are one list, `src/shared/providers.ts`. A provider dropped from it (GitHub was, on
2026-09-29: its `sub` is the account's public user id) is refused everywhere, and its copies go, each with its deletion
record, whenever the database next opens.

## Never stored

Callsigns, emails, IP addresses, raw `sub`s, tokens, community lists, or a copy of what a release handed out. A copy's
row is `{id, sub_index, pk_index, envelope, updated_day}`.

## Releases (design §3; host design §5.1 item 3)

A release is two files and their assets, published as a GitHub release whose tag starts `vault-v`:

- `vault-release.json`, the manifest (`src/shared/release.ts`):
  `{v: 1, version, previous, imageHash, image: {ukiSha256, roothash}, apiBundleHash, custodianKeys, hostPolicy, notes?}`.
  `imageHash = SHA-256("beanpool-vault-image/1\n" ‖ ukiSha256 ‖ "\n" ‖ roothash ‖ "\n")` (hex): the boot file and
  the dm-verity root hash of the system partition it names. `apiBundleHash` is the SHA-256 of `vault-api.mjs`.
  `custodianKeys` are the three keys that sign the **next** release. `hostPolicy` is what custodians' tools check the
  host against: `{platform: "none"}` on 1984. `previous` is the SHA-256 of the manifest before it (null for the first).
- `vault-release.sigs.json`: Ed25519 signatures (RFC 8032, the custodians' ceremony keys) over
  `"beanpool-vault-release/1\n" ‖ hex(SHA-256(vault-release.json))`. Two are needed.
- Assets: `vault-api.mjs`; for a release with a new image also `vault.efi` (the UKI), `vault-root.raw` and
  `vault-root-verity.raw` (the system partition and its verity tree).

**Trust.** Every build pins the vault's genesis custodian keys (`scripts/bundle.mjs` bakes them in; a config file
can't change them). Releases form one chain from them: the first needs two signatures from the genesis keys, each
next one names the one before and needs two signatures from the keys that one named. So after a reshare, the old
custodians sign a release naming the new keys, and from then on only the new ones can sign. Two different releases
signed as the next after one (a fork, which takes two custodians' keys), or a signed release that is malformed, stop
the chain there: the API takes nothing after it, and the custodian tool refuses to unlock until custodians sort it out.

**Making one** (each step on the custodian's own computer, with the built `vault-custodian.mjs`):

```
vault-custodian release status                       # the chain as the vault will see it
vault-custodian release propose --version 1.1.0 --same-image --same-custodians \
    --api-bundle out/bundles/vault-api.mjs --out proposal/          # or --image out/image.json for a new image
vault-custodian release sign --dir proposal/ --key my-key.json      # each of two custodians; shows every line first
vault-custodian release verify --dir proposal/                      # "the vault would take it"
gh release create vault-v1.1.0 proposal/vault-release.json proposal/vault-release.sigs.json proposal/vault-api.mjs
```

## Updates without anyone logging in (design §3)

- **The API.** At start and every hour, the API reads the feed and walks the chain. The release whose API bundle is
  its own file and whose image is the one it booted (from the file root leaves in `/run/beanpool-vault-image.json` at
  boot, as the keyholder reads it: the ESP is root's alone) is the one it runs; a newer release for the same image is
  taken: its bundle is downloaded and checked against `apiBundleHash`, the launcher checks the release again from its
  own pinned keys, runs the bundle's `--self-test` (it must report the same pinned keys and its own hash), starts it
  beside the old API, and once the new one listens (it points `api.sock` at its own socket in one rename) tells the
  old one to finish what it has and exit. The keyholder isn't touched: no unlock. Never backwards: only a release
  newer than the one running, and an API that can't find itself in the feed takes nothing. The launcher holds to this
  too, whatever the API asks: it takes only a release newer than the one whose bundle is in service (and than any it
  switched to), for the same image.
- **A new image** (system, kernel, keyholder, Node): the API downloads it into its inbox
  (`/var/lib/beanpool-vault/staged`), with the chain of releases up to it, and `/v1/report` says `imageWaiting`. That
  decides nothing: the API is what this guards against. At the monthly restart root's install step
  (`vault-install.mjs`, built with the genesis keys like the launcher, on the verified system partition;
  `src/install/install.ts`) walks the chain from those keys itself and checks, on its own copies: two custodian
  signatures, a release newer than the running one, file names carrying its version (and the partitions' names its
  root hash), the UKI's SHA-256 and `veritysetup verify` against its `roothash`. Only then does it move the files into
  `/var/lib/beanpool-vault/install` (root's alone; the API's user can write neither it nor anything root runs), where
  systemd-sysupdate installs them into the other system slot; systemd-boot boots the new one and falls back to the old
  one if it fails to boot three times. Anything else is refused, logged and deleted. Then two custodians unlock. Not
  yet run end to end: a real signed next image installed by systemd-sysupdate and booted. The test image checks the
  refusals on the image; `install.test.ts` checks the checks and the move.
- **Debian's security fixes** come as a new image built from a newer snapshot: the system partition is read-only
  under dm-verity, so nothing installs itself on the running vault (this replaces design §3's "install themselves";
  the imageHash would mean nothing otherwise). An urgent one gets an extra planned restart.

## The image (`image/`; host design §5.1 items 5 and 6)

`image/build.sh --custodian-keys <file> --version <x.y.z> --out <dir>` builds it with mkosi in a pinned container:

- Debian 13 from snapshot.debian.org at the time in `image/pins.env` (security updates from the same snapshot), the
  official Node build (SHA-256 pinned), the esbuild bundles of the keyholder, launcher and API, Caddy.
- One UKI (`EFI/Linux/beanpool-vault_<version>.efi`: kernel, initrd, and a command line naming the dm-verity
  `roothash=` of the erofs system partition), booted by systemd-boot (no menu, no editor). `/var` is a separate state
  partition, made at the first boot with the second system slot and the data partition (`usr/lib/repart.d`).
- The data partition is LUKS2 under `K_disk`: after an unlock, a root helper takes the key from the keyholder's
  root-only socket, opens the partition (formats it the first time), and mounts it in the machine's own mount
  namespace (its unit has no setting that makes one), where the API sees it; the API opens no database before, and
  opens it by itself once the partition is there. A restore from backup waits for the unlock on the state partition
  (`/var/lib/beanpool-vault/restore`, the API's user's alone; it is sealed under `K_backup`), not in the mount point,
  which the mount would hide; it is deleted once the restore lands.
- No SSH server, no getty, no rescue or debug shell, root locked, no login shell for any account.
- Firewall (`etc/nftables.conf`): in, 443 and 80 (certificates); out, each kind only from the one user that needs it:
  HTTPS from the API and Caddy, only to addresses the vault's own resolver (dnsmasq,
  `etc/beanpool-vault/dnsmasq.conf`) has just returned for the allowed names (the providers' key endpoints, Expo push,
  GitHub (the release feed), Let's Encrypt); DNS from the resolver, only to Quad9; NTP from timesyncd, only to the
  pool's addresses; DHCP from networkd's client (UDP 67 and 547 are refused to every other user: checked in the test
  image). Past those, only ICMP errors, echo replies and IPv6 neighbour discovery. The backup store is added with its
  client.
- The kernel command line (fixed in the UKI) also carries `systemd.import_credentials=no`: nothing the host hands in
  through firmware (SMBIOS, fw_cfg) becomes a unit or a setting.
- Memory hygiene: the keyholder runs with `LimitCORE=0` and `--disable-sigusr1` (it refuses to start without them),
  under its own user, with no network (`PrivateNetwork=yes`); no swap, `kernel.yama.ptrace_scope = 3`,
  `core_pattern` to nothing, kexec disabled, no hibernation, `lockdown=confidentiality`, `init_on_free=1`.
  `mlockall` is not used (Node has no call for it and the vault ships no native module): no swap is what keeps the
  keys off disk. `image/.../check-hygiene` checks all of this at every boot and prints it on the console.

**Checking a build.** Build it yourself with the release's custodian keys and version, and compare: `image.json`
(`{version, ukiSha256, roothash, imageHash}`) must be the release's `image` and `imageHash`, and every file the same
bytes. `root-files.txt`, `uki-sections.txt`, `initrd-files.txt`, `esp-files.txt` and `partitions.txt` list every file
of the system tree, the UKI and its initrd, the ESP and the install image's partitions with their hashes, to find
where two builds differ.

- **Across machines** (checked 2026-09-29): an arm64 Mac (Docker Desktop, the image's x86-64 package scripts through
  Rosetta) and GitHub's x86-64 runner built every file byte for byte the same with the same keys: `vault.efi`, the
  system partition and its verity tree, the install image, the bundles. Two things had to be made so: Rosetta leaves
  an empty `/.cache/rosetta` in the trees it runs in (removed from the system tree and the initrd), and
  systemd-repart fills the ESP's FAT in the build machine's directory order (`rebuild-esp.py` makes it again in a
  fixed order). zstd gives the same output at any thread count (checked at 1, 4 and 12).
- **CI** (`.github/workflows/vault-image.yml`, on every change to `image/`, the programs, the bundle script or the
  workflow): two builds on the runner must be byte-identical (`image.json`, `vault.efi`, `vault-root.raw`,
  `vault-root-verity.raw`, the install image, the bundles); then `image/boot-test.sh` boots the first under QEMU (KVM,
  UEFI, a network that reaches nothing outside) and passes only when the hygiene check prints `hygiene: ALL PASS` on
  the serial port and the vault's `/v1/health` reports the build's `imageHash` as its release. Before that,
  `image/data-test.mjs` runs the data partition helper as root on loop devices: a blank partition is formatted and
  mounted once the vault opens, opened (not formatted) again after a restart, and left alone under another key or when
  it holds a file system. It prints the throwaway public keys it used, so anyone can build the same image and compare.
- **The test image** (CI, after those): the same image plus the boot test's driver and three throwaway custodian keys
  made for the run, private halves included (`image/test-image/make.mjs`, `build.sh --extra`; never published, and its
  hash is not a release's). `boot-test.sh --verdict vault-test` boots it, and the driver
  (`src/__tests__/image-boot-driver.ts`) runs as root inside: a genesis through the API's socket, then `/v1/health`
  must say `open` with the data partition mounted in the machine's namespace and the database open on it, and
  `/v1/report`'s `update.image` must be the image that booted (the API reads root's file). As the API's user it stages
  a boot file and partitions no release signs, and fails to write root's install directories; the install step must
  refuse them and empty the inbox, and `systemd-sysupdate list` still show the running release as current. UDP to the
  DHCP ports as the API's user or `nobody` must get EPERM, and a lease renewal by networkd pass the firewall (its
  rule's counter goes up). (A signed next release installed and booted is not in it: that needs a second image build
  and a reboot.)
- **test-all** (every push): the bundles are the same bytes on two builds; the manifest, chain and `imageHash` vector.

The full build needs Docker; the first one downloads about 300 MB from snapshot.debian.org, which can be slow
(`--cache` keeps the packages; apt checks each against the snapshot's signed index either way).

**Before buying the host** (host design §6 adds these): the image boots with UEFI only (systemd-boot and a UKI), so
1984 must boot our own disk image in UEFI mode (OVMF), not legacy BIOS; and it takes its address by DHCP and router
advertisements (`etc/systemd/network/80-wan.network`), to change if 1984 assigns static addresses.

## The custodian tool (`vault-custodian`; design §2.2, host design §5.1 item 4)

Key files are sealed under a passphrase (`new-key`; asked on the terminal, or `VAULT_CUSTODIAN_PASSPHRASE`). Before
genesis, an unlock, a reshare or a restore, the tool:

1. reads the releases (the repo's GitHub Releases, or `--feed-dir`) and walks them from the genesis keys built into
   it; no release, a fork or a malformed one: nothing is sent;
2. says hello with a fresh 32-byte nonce and computes `bind` itself;
3. checks the vault's `release` (the image it booted) against the newest release's `imageHash` (an older one only with
   `--accept-release <version>`, when a new image is waiting for its restart);
4. checks the host against the newest release's `hostPolicy`, never anything the vault says. On `none` it prints:
   *"This vault's host can read its memory. There is no hardware proof of what it runs."* and sends your part only
   when you type yes (or passed `--no-hardware-proof`). `tdx` and `sev-snp` need evidence and a checker for it
   (`src/custodian/checker.ts`, V8); until then they are refused. An unknown platform is refused.

These checks catch mistakes (an image nobody signed, an old one still running), not a hostile host, which can answer
with any hash it likes. What guards against a planted image: a compromised API can't get one booted, since only root's
check from the pinned keys installs anything, so a planned restart boots a two-signed image. A hostile host, on
`none`, can boot anything it likes: against that there is nothing technical, only the reinstall-before-unlock rule after
a restart nobody planned and the split hosting login (design §2.2, §2.5).

```
vault-custodian unlock --url https://vault.beanpool.org --key my-key.json --share share-1-1-xxxx.json
vault-custodian fetch-share --url https://vault.beanpool.org --key my-key.json --out shares/   # after a genesis or reshare
```

## The monthly restart (D3)

The first Sunday of each month at 09:00 UTC (`beanpool-vault-monthly-restart.timer`; `/v1/report` says when the next
one is). It installs a new image the API staged, only if root's check from the pinned keys passes (above), and
restarts. The vault comes back locked: two custodians unlock it, within the 24-hour target. After a restart nobody
planned, the rule stands: reinstall from the signed image first, then unlock.

## Monitoring (design §3)

- `/v1/health` is public: `{state: open | locked, release, since}` (`locked` also while a restore from backup or the
  data partition is still being opened). Global checks it every minute.
- `/v1/report` (while open) is signed with the ticket key and holds nothing per member: counts, copies, re-wrap
  progress, backups, pushes, memory hygiene, how many new custodians confirmed their share, and `api` (the running
  bundle's hash), `update` (the image this API knows it booted, the release it runs, the newest, a waiting image,
  anything refused and why, the last handover), `nextRestart`.

## Tests

`pnpm --filter @beanpool/vault test`: vitest over real HTTP and real Unix sockets, with a stub JWKS, a stub Expo, a
directory standing in for GitHub Releases, and an injected clock. No provider, host, feed or object store is
contacted. `handover.test.ts` runs the bundled keyholder, launcher and API as processes.

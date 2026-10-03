#!/usr/bin/env bash
# Builds the key vault's image (key vault design §3; host design §5.1 items 5 and 6).
#
#   apps/vault/image/build.sh --custodian-keys <file> --version <x.y.z> --out <dir> [--network <setting>] [--extra <tree>]
#
# <file> is {"genesisCustodians": ["<hex>", "<hex>", "<hex>"]}: the three custodian PUBLIC keys, pinned into the image
# (the keyholder takes a genesis only from them; the API and launcher check releases from them).
#
# Needs Docker (with binfmt emulation of x86-64 when the machine isn't x86-64), Node 22.14 or later and a workspace
# where `pnpm install` has run and @beanpool/core and @beanpool/signin are built. It writes into <dir>:
#
#   beanpool-vault_<version>.raw   the disk image to install (ESP, system partition, its verity tree)
#   vault.efi                      the boot file (UKI), as in the disk image's ESP
#   vault-root.raw                 the system partition alone, and its verity tree: with vault.efi, a new image's
#   vault-root-verity.raw          release assets (installed into the other slot at a monthly restart)
#   image.json                     {version, ukiSha256, roothash, imageHash}: what a release names (and
#                                  `network` when it is not dhcp, below)
#   root-files.txt, uki-sections.txt, initrd-files.txt, partitions.txt, esp-files.txt
#                                  every file of the system tree, every section of the UKI, every file of its
#                                  initrd and every partition of the install image, with its hash: to compare two
#                                  builds file by file
#   bundles/                       the programs, as built into the image
#
# Two runs from the same commit, pins.env and keys give the same bytes: compare image.json (and the files) of two
# runs, on any machine.
#
# `--cache <dir>` (default ~/.cache/beanpool-vault-image) keeps the downloaded packages between runs: the snapshot
# serves them slowly, and apt checks each one against the snapshot's signed index whether it came from there or the
# cache. Node's tarball is kept there too.
#
# `--network dhcp|static:<ipv4>/<prefix>,<gateway>` (default dhcp, the image as it always was) is the host's network:
# a host that hands out no address (1984 VPS #1) gets a static one, written into the image (image-settings.mjs). It
# is public, changes the image and its hash, and image.json records it: a rebuild for the comparison passes the same.
# Anything but those two forms, strictly, refuses to build.
#
# `--extra <tree>` lays more files over the image's (a TEST image: image/test-image/make.mjs, for the boot test). It
# changes the image and its hash: a release is built without it.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
vault="$(cd "${here}/.." && pwd)"
# shellcheck source=pins.env
. "${here}/pins.env"

keys="" version="" out="" cache="${HOME}/.cache/beanpool-vault-image" more="" network="dhcp"
while [ $# -gt 0 ]; do
    case "$1" in
        --custodian-keys) keys="$2"; shift 2 ;;
        --version) version="$2"; shift 2 ;;
        --out) out="$2"; shift 2 ;;
        --cache) cache="$2"; shift 2 ;;
        --extra) more="$(cd "$2" && pwd)"; shift 2 ;;
        --network) network="$2"; shift 2 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done
if [ -z "${keys}" ] || [ -z "${version}" ] || [ -z "${out}" ]; then
    echo "usage: $0 --custodian-keys <file> --version <x.y.z> --out <dir> [--network dhcp|static:<ipv4>/<prefix>,<gateway>]" >&2
    exit 2
fi
if ! printf '%s' "${version}" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
    echo "--version is MAJOR.MINOR.PATCH" >&2
    exit 2
fi
# Fail closed: go on only when the answer is exactly the setting given (no answer, or another one, stops the build).
checked="$(node "${here}/image-settings.mjs" check "${network}")" || exit 2
if [ -z "${checked}" ] || [ "${checked}" != "${network}" ]; then
    echo "build.sh: image-settings.mjs check gave ${checked:-no answer} for --network ${network}: not building" >&2
    exit 2
fi
mkdir -p "${out}" "${cache}/packages"
out="$(cd "${out}" && pwd)"
cache="$(cd "${cache}" && pwd)"
keys="$(cd "$(dirname "${keys}")" && pwd)/$(basename "${keys}")"

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# 1. The programs, with the custodian keys baked in (scripts/bundle.mjs: the same bytes on every machine).
rm -rf "${out}/bundles"
node "${vault}/scripts/bundle.mjs" --custodian-keys "${keys}" --out "${out}/bundles" >/dev/null

# 2. Node, the official Linux x64 build, checked against the pinned hash.
node_txz="${cache}/node-v${NODE_VERSION}-linux-x64.tar.xz"
if [ ! -f "${node_txz}" ] || [ "$(sha256 "${node_txz}")" != "${NODE_SHA256}" ]; then
    curl -fsSL -o "${node_txz}.part" "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
    mv "${node_txz}.part" "${node_txz}"
fi
if [ "$(sha256 "${node_txz}")" != "${NODE_SHA256}" ]; then
    echo "node-v${NODE_VERSION}-linux-x64.tar.xz is not the pinned file" >&2
    exit 1
fi

# 3. The mkosi tree: the repo's, plus what this build adds.
work="${out}/work"
rm -rf "${work}"
cp -R "${here}/mkosi" "${work}"
extra="${work}/mkosi.extra"
mkdir -p "${extra}/opt/node/bin" "${extra}/usr/lib/beanpool-vault" "${extra}/etc/beanpool-vault"
tar -xJf "${node_txz}" -C "${extra}/opt/node/bin" --strip-components=2 "node-v${NODE_VERSION}-linux-x64/bin/node"
tar -xJf "${node_txz}" -C "${extra}/opt/node" --strip-components=1 "node-v${NODE_VERSION}-linux-x64/LICENSE"
for f in vault-keyholder.mjs vault-api.mjs vault-launcher.mjs vault-install.mjs vault-egress.mjs; do
    cp "${out}/bundles/${f}" "${extra}/usr/lib/beanpool-vault/${f}"
done
node -e '
    const keys = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).genesisCustodians;
    process.stdout.write(JSON.stringify({
        stateDir: "/var/lib/beanpool-vault/keyholder",
        socketPath: "/run/beanpool-vault/keyholder/keyholder.sock",
        socketMode: 0o660,
        diskKeySocket: "/run/beanpool-vault/disk-key/disk.sock",
        imageIdentityFile: "/run/beanpool-vault-image.json",
        genesisCustodians: keys,
    }, null, 2) + "\n");
' "${keys}" > "${extra}/etc/beanpool-vault/keyholder.json"
# The host network: nothing changes for dhcp; the static form's file replaces the DHCP one.
# It must answer with the setting; for dhcp the image's own file must be left exactly as it is, and for static the file's
# settings (comments and blank lines aside) must be exactly these ten lines, nothing more.
wan="${extra}/etc/systemd/network/80-wan.network"
wrote="$(node "${here}/image-settings.mjs" write "${network}" "${wan}")"
case "${network}" in
    dhcp) [ "${wrote}" = "dhcp" ] && cmp -s "${wan}" "${here}/mkosi/mkosi.extra/etc/systemd/network/80-wan.network" ;;
    *) address="${network#static:}"
       [ "${wrote}" = "${network}" ] && [ -f "${wan}" ] \
           && [ "$(grep -v -e '^#' -e '^$' "${wan}")" = "$(printf '%s\n' '[Match]' 'Type=ether' 'Kind=!*' '[Network]' \
                "Address=${address%%,*}" "Gateway=${network##*,}" 'IPv6AcceptRA=yes' 'LinkLocalAddressing=ipv6' \
                '[IPv6AcceptRA]' 'UseDNS=no')" ] ;;
esac || { echo "build.sh: image-settings.mjs write did not write ${wan} for --network ${network}: not building" >&2; exit 2; }
if [ -n "${more}" ]; then
    echo "build.sh: adding ${more} (not a release image)" >&2
    cp -R "${more}/." "${extra}/"
fi
mkdir -p "${work}/mkosi.sandbox/etc/apt/sources.list.d" "${work}/mkosi.sandbox/etc/apt/apt.conf.d"
cat > "${work}/mkosi.sandbox/etc/apt/sources.list.d/mkosi.sources" <<EOF
Types: deb
URIs: http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}/
Suites: trixie trixie-updates
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg

Types: deb
URIs: http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}/
Suites: trixie-security
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
EOF
printf 'Acquire::Check-Valid-Until "false";\n' > "${work}/mkosi.sandbox/etc/apt/apt.conf.d/10-snapshot.conf"

# 4. The builder, then the build. The builder runs natively (mkosi's sandbox needs mount_setattr, which emulation
# lacks) and builds the x86-64 image; on another architecture the image's own package scripts run through the host's
# binfmt emulation (Docker Desktop has it).
builder="beanpool-vault-builder:$(docker version -f '{{.Server.Arch}}')-$(cat "${here}/builder/Dockerfile" "${here}/pins.env" | (sha256sum 2>/dev/null || shasum -a 256) | cut -c1-16)"
if ! docker image inspect "${builder}" >/dev/null 2>&1; then
    docker build -q -t "${builder}" --build-arg "BUILDER_BASE=${BUILDER_BASE}" --build-arg "DEBIAN_SNAPSHOT=${DEBIAN_SNAPSHOT}" "${here}/builder" >/dev/null
fi
rm -rf "${out}/mkosi.output"
mkdir -p "${out}/mkosi.output"
docker run --rm --privileged \
    -v "${work}:/work" -v "${out}/mkosi.output:/output" -v "${cache}/packages:/pkgcache" \
    -e "SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}" \
    "${builder}" \
    mkosi -C /work --image-version="${version}" --seed="${IMAGE_SEED}" --source-date-epoch="${SOURCE_DATE_EPOCH}" \
        --output-directory=/output --package-cache-dir=/pkgcache --force build

# 5. The release's files, and what it names: the UKI's hash and the root hash on its command line, and imageHash.
o="${out}/mkosi.output"
rm -f "${out}/vault.efi" "${out}/vault-root.raw" "${out}/vault-root-verity.raw" "${out}"/beanpool-vault_*.raw
mv "${o}/beanpool-vault.efi" "${out}/vault.efi"
mv "${o}/beanpool-vault.root-x86-64.raw" "${out}/vault-root.raw"
mv "${o}/beanpool-vault.root-x86-64-verity.raw" "${out}/vault-root-verity.raw"
mv "${o}/beanpool-vault.raw" "${out}/beanpool-vault_${version}.raw"
mv "${o}/beanpool-vault.root-files.txt" "${out}/root-files.txt"
# The install image's ESP again, in a fixed order (rebuild-esp.py): otherwise its FAT follows the build machine's
# directory order, and the install image differs between machines though nothing in it that boots does.
docker run --rm -e "SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}" -v "${out}:/output" -v "${here}:/image:ro" "${builder}" \
    python3 /image/rebuild-esp.py "/output/beanpool-vault_${version}.raw" > "${out}/esp-files.txt"
# Each section of the UKI (kernel, initrd, command line, os-release...) with its SHA-256: where two builds differ.
docker run --rm -v "${out}:/output" "${builder}" \
    python3 -c 'import hashlib,pefile,sys; pe=pefile.PE(sys.argv[1]); [print(s.Name.rstrip(b"\0").decode(), hashlib.sha256(s.get_data()).hexdigest()) for s in pe.sections]' \
    /output/vault.efi > "${out}/uki-sections.txt"
docker run --rm -v "${out}:/output" -v "${here}:/image:ro" "${builder}" python3 /image/list-initrd.py /output/vault.efi > "${out}/initrd-files.txt"
# Each partition of the install image, and its partition table, with its hash.
docker run --rm -v "${out}:/output" "${builder}" python3 -c '
import hashlib, json, subprocess, sys
raw = sys.argv[1]
table = json.loads(subprocess.run(["sfdisk", "-J", raw], capture_output=True, check=True).stdout)["partitiontable"]
with open(raw, "rb") as f:
    print("gpt", hashlib.sha256(f.read(34 * 512)).hexdigest())
    for p in table["partitions"]:
        f.seek(p["start"] * 512)
        h = hashlib.sha256()
        left = p["size"] * 512
        while left:
            chunk = f.read(min(left, 1 << 20))
            h.update(chunk)
            left -= len(chunk)
        print(p.get("name", "?"), p["type"], p["uuid"], h.hexdigest())
' "/output/beanpool-vault_${version}.raw" > "${out}/partitions.txt"
roothash="$(docker run --rm -v "${out}:/output" "${builder}" \
    python3 -c 'import pefile,re,sys; pe=pefile.PE(sys.argv[1]); c=[s.get_data().rstrip(b"\0").decode() for s in pe.sections if s.Name.rstrip(b"\0")==b".cmdline"][0]; print(re.search(r"\broothash=([0-9a-f]+)", c).group(1))' \
    /output/vault.efi)"
uki_sha="$(sha256 "${out}/vault.efi")"
image_hash="$(printf 'beanpool-vault-image/1\n%s\n%s\n' "${uki_sha}" "${roothash}" | (sha256sum 2>/dev/null || shasum -a 256) | cut -d' ' -f1)"
node "${here}/image-settings.mjs" image-json "${version}" "${uki_sha}" "${roothash}" "${image_hash}" "${network}" > "${out}/image.json"
# Never an empty, partial or wrong image.json: exactly this build's fields, and the setting only when it is not dhcp.
if ! node -e '
    const [file, version, ukiSha256, roothash, imageHash, network] = process.argv.slice(1);
    const want = { version, ukiSha256, roothash, imageHash, ...(network === "dhcp" ? {} : { network }) };
    let got; try { got = JSON.parse(require("fs").readFileSync(file, "utf8")); } catch { process.exit(1); }
    process.exit(JSON.stringify(got) === JSON.stringify(want) ? 0 : 1);
' "${out}/image.json" "${version}" "${uki_sha}" "${roothash}" "${image_hash}" "${network}"; then
    echo "build.sh: image-settings.mjs image-json did not write ${out}/image.json for --network ${network}" >&2
    rm -f "${out}/image.json"
    exit 2
fi
cat "${out}/image.json"

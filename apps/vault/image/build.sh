#!/usr/bin/env bash
# Builds the key vault's image (key vault design §3; host design §5.1 items 5 and 6).
#
#   apps/vault/image/build.sh --custodian-keys <file> --version <x.y.z> --out <dir>
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
#   image.json                     {version, ukiSha256, roothash, imageHash}: what a release names
#   root-files.txt, uki-sections.txt, initrd-files.txt
#                                  every file of the system tree, every section of the UKI and every file of its
#                                  initrd, with its hash: to compare two builds file by file
#   bundles/                       the programs, as built into the image
#
# Two runs from the same commit, pins.env and keys give the same bytes: compare image.json (and the files) of two
# runs, on any machine.
#
# `--cache <dir>` (default ~/.cache/beanpool-vault-image) keeps the downloaded packages between runs: the snapshot
# serves them slowly, and apt checks each one against the snapshot's signed index whether it came from there or the
# cache. Node's tarball is kept there too.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
vault="$(cd "${here}/.." && pwd)"
# shellcheck source=pins.env
. "${here}/pins.env"

keys="" version="" out="" cache="${HOME}/.cache/beanpool-vault-image"
while [ $# -gt 0 ]; do
    case "$1" in
        --custodian-keys) keys="$2"; shift 2 ;;
        --version) version="$2"; shift 2 ;;
        --out) out="$2"; shift 2 ;;
        --cache) cache="$2"; shift 2 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done
if [ -z "${keys}" ] || [ -z "${version}" ] || [ -z "${out}" ]; then
    echo "usage: $0 --custodian-keys <file> --version <x.y.z> --out <dir>" >&2
    exit 2
fi
if ! printf '%s' "${version}" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
    echo "--version is MAJOR.MINOR.PATCH" >&2
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
for f in vault-keyholder.mjs vault-api.mjs vault-launcher.mjs; do
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
# Each section of the UKI (kernel, initrd, command line, os-release...) with its SHA-256: where two builds differ.
docker run --rm -v "${out}:/output" "${builder}" \
    python3 -c 'import hashlib,pefile,sys; pe=pefile.PE(sys.argv[1]); [print(s.Name.rstrip(b"\0").decode(), hashlib.sha256(s.get_data()).hexdigest()) for s in pe.sections]' \
    /output/vault.efi > "${out}/uki-sections.txt"
docker run --rm -v "${out}:/output" -v "${here}:/image:ro" "${builder}" python3 /image/list-initrd.py /output/vault.efi > "${out}/initrd-files.txt"
roothash="$(docker run --rm -v "${out}:/output" "${builder}" \
    python3 -c 'import pefile,re,sys; pe=pefile.PE(sys.argv[1]); c=[s.get_data().rstrip(b"\0").decode() for s in pe.sections if s.Name.rstrip(b"\0")==b".cmdline"][0]; print(re.search(r"\broothash=([0-9a-f]+)", c).group(1))' \
    /output/vault.efi)"
uki_sha="$(sha256 "${out}/vault.efi")"
image_hash="$(printf 'beanpool-vault-image/1\n%s\n%s\n' "${uki_sha}" "${roothash}" | (sha256sum 2>/dev/null || shasum -a 256) | cut -d' ' -f1)"
printf '{\n  "version": "%s",\n  "ukiSha256": "%s",\n  "roothash": "%s",\n  "imageHash": "%s"\n}\n' "${version}" "${uki_sha}" "${roothash}" "${image_hash}" > "${out}/image.json"
cat "${out}/image.json"

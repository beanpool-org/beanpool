#!/usr/bin/env bash
# Builds the key vault's image (key vault design §3; host design §5.1 items 5 and 6).
#
#   apps/vault/image/build.sh --custodian-keys <file> --version <x.y.z> --out <dir> [--network <setting>]
#                             [--network6 <setting>] [--name <dns name>] [--host <profile>] [--acpi-off] [--extra <tree>]
#
# <file> is {"genesisCustodians": ["<hex>", "<hex>", "<hex>"]}: the three custodian PUBLIC keys, pinned into the image
# (the keyholder takes a genesis only from them; the API and launcher check releases from them).
#
# Needs Docker (with binfmt emulation of x86-64 when the machine isn't x86-64), Node 22.14 or later and a workspace
# where `pnpm install` has run and @beanpool/core and @beanpool/signin are built. It writes into <dir>:
#
#   beanpool-vault_<version>.raw   the disk image to install (ESP, system partition, its verity tree)
#   beanpool-vault_<version>.qcow2 the same disk image, compressed: the release file a host takes by URL + SHA-256
#                                  (Servury: "Disk image"; a raw file of the whole disk is too big to publish)
#   SHA256SUMS                     the release files' hashes, in sha256sum's format
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
#   host-policy.json               with --host: the release's starting host policy (the launch measurement and the
#                                  profile's floor) for `vault-custodian release propose --host-policy`
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
# `--network6 ra|static:<ipv6>/<prefix>,<gateway>` (default ra: router advertisements, the image as it always was):
# a host that sets IPv6 by hand too (Servury) gets its address and gateway in the same file; it needs the static IPv4
# form. `--name <dns name>` (default vault.beanpool.org, the image as it always was) is the vault's own name, in Caddy's
# site and the API's hosts. Both are checked strictly, public, change the image, and image.json records them.
#
# `--host <profile>` (default none: the image as it always was) builds for a confidential host
# (image/host-profiles/<profile>.json; vault comeback design §2.5, §2.6, §3.2): the keyholder's attestor becomes
# sev-snp, image/host-snp/ is laid over the image (the guest's report driver, root's report helper, the boot check's
# SNP lines), and after the build the chip's launch measurement of this UKI on that host is computed with
# sev-snp-measure (pinned in pins.env) from the host's firmware (pinned by SHA-256 in the profile; both downloaded into
# --cache and checked). image.json records it as `host`; host-policy.json carries it with the profile's floor (guest
# policy, minimum firmware levels) for the release. The floor is not in the image, so raising it needs no new image.
# `--acpi-off` adds acpi=off to the UKI's fixed command line (design §2.7, BadAML; only once test T6 has shown the host
# boots that way). image.json records it as `kernelExtra`.
#
# `--extra <tree>` lays more files over the image's (a TEST image: image/test-image/make.mjs, for the boot test). It
# changes the image and its hash: a release is built without it.
#
# File modes in the image never depend on the caller: a build run under umask 077 (the go-live scripts keep their key
# files private that way) once made every copied file 600/700, so the keyholder, API and Caddy could not read their own
# files and networkd could not read 80-wan.network (vault-v1.0.0, 7 Oct). So: umask 022 here, the tree normalised to
# what git holds (644, 755 for executables and directories) before mkosi reads it, and a refusal if any file is still
# unreadable. On a normal checkout under umask 022 this changes nothing, so the image hash is the same as before.
set -euo pipefail
umask 022

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
vault="$(cd "${here}/.." && pwd)"
# shellcheck source=pins.env
. "${here}/pins.env"

keys="" version="" out="" cache="${HOME}/.cache/beanpool-vault-image" more="" network="dhcp" network6="ra"
name="vault.beanpool.org" host="none" acpi="acpi"
while [ $# -gt 0 ]; do
    case "$1" in
        --custodian-keys) keys="$2"; shift 2 ;;
        --version) version="$2"; shift 2 ;;
        --out) out="$2"; shift 2 ;;
        --cache) cache="$2"; shift 2 ;;
        --extra) more="$(cd "$2" && pwd)"; shift 2 ;;
        --network) network="$2"; shift 2 ;;
        --network6) network6="$2"; shift 2 ;;
        --name) name="$2"; shift 2 ;;
        --host) host="$2"; shift 2 ;;
        --acpi-off) acpi="acpi-off"; shift ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done
if [ -z "${keys}" ] || [ -z "${version}" ] || [ -z "${out}" ]; then
    echo "usage: $0 --custodian-keys <file> --version <x.y.z> --out <dir> [--network dhcp|static:<ipv4>/<prefix>,<gateway>]" \
        "[--network6 ra|static:<ipv6>/<prefix>,<gateway>] [--name <dns name>] [--host <profile>] [--acpi-off]" >&2
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
# The same for the other settings, each answered back exactly or no build.
checked6="$(node "${here}/image-settings.mjs" check6 "${network6}")" || exit 2
checked_name="$(node "${here}/image-settings.mjs" check-name "${name}")" || exit 2
checked_host="$(node "${here}/image-settings.mjs" host "${host}" profile)" || exit 2
platform="$(node "${here}/image-settings.mjs" host "${host}" platform)" || exit 2
if [ "${checked6}" != "${network6}" ] || [ "${checked_name}" != "${name}" ] || [ "${checked_host}" != "${host}" ]; then
    echo "build.sh: image-settings.mjs did not answer --network6 ${network6} --name ${name} --host ${host} back: not building" >&2
    exit 2
fi
if [ "${network}" = dhcp ] && [ "${network6}" != ra ]; then
    echo "build.sh: --network6 static needs --network static: not building" >&2
    exit 2
fi
case "${platform}" in none|sev-snp) ;; *) echo "build.sh: host platform ${platform} unknown: not building" >&2; exit 2 ;; esac
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

# 2b. For a confidential host: its firmware (the profile pins it) and the measurement calculator (pins.env), each
# checked against its hash. Only for the measurement after the build: neither goes into the image.
if [ "${platform}" = sev-snp ]; then
    fetch_pinned() { # <url> <file> <sha256>
        if [ ! -f "$2" ] || [ "$(sha256 "$2")" != "$3" ]; then
            curl -fsSL -o "$2.part" "$1"
            mv "$2.part" "$2"
        fi
        if [ "$(sha256 "$2")" != "$3" ]; then
            echo "build.sh: $1 is not the pinned file (SHA-256 $3)" >&2
            exit 1
        fi
    }
    fw_sha="$(node "${here}/image-settings.mjs" host "${host}" firmware-sha256)"
    fw_file="${cache}/firmware/${fw_sha}-$(node "${here}/image-settings.mjs" host "${host}" firmware-name)"
    mkdir -p "${cache}/firmware"
    fetch_pinned "$(node "${here}/image-settings.mjs" host "${host}" firmware-url)" "${fw_file}" "${fw_sha}"
    measure_whl="${cache}/sev_snp_measure-${SEV_SNP_MEASURE_VERSION}-py3-none-any.whl"
    fetch_pinned "${SEV_SNP_MEASURE_URL}" "${measure_whl}" "${SEV_SNP_MEASURE_SHA256}"
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
        // An SEV-SNP host image names its attestor; without a profile the field is absent (none), as before.
        ...(process.argv[2] === "sev-snp" ? { attestor: "sev-snp", attestSocket: "/run/beanpool-vault/attest/attest.sock" } : {}),
    }, null, 2) + "\n");
' "${keys}" "${platform}" > "${extra}/etc/beanpool-vault/keyholder.json"
# An SEV-SNP host image: the guest's report driver, root's report helper and its group, and what the boot check reads.
if [ "${platform}" = sev-snp ]; then
    cp -R "${here}/host-snp/." "${extra}/"
    printf '{\n  "profile": "%s",\n  "platform": "sev-snp"\n}\n' "${host}" > "${extra}/etc/beanpool-vault/host.json"
fi
# The vault's own name: the default leaves both files exactly as they are; another is in both, once, and nothing else.
caddyfile="${extra}/etc/caddy/Caddyfile" apijson="${extra}/etc/beanpool-vault/api.json"
wrote_name="$(node "${here}/image-settings.mjs" write-name "${name}" "${caddyfile}" "${apijson}")"
if [ "${name}" = vault.beanpool.org ]; then
    [ "${wrote_name}" = "${name}" ] && cmp -s "${caddyfile}" "${here}/mkosi/mkosi.extra/etc/caddy/Caddyfile" \
        && cmp -s "${apijson}" "${here}/mkosi/mkosi.extra/etc/beanpool-vault/api.json"
else
    [ "${wrote_name}" = "${name}" ] && [ "$(grep -c -x -F "${name} {" "${caddyfile}")" = 1 ] && ! grep -q -x 'vault\.beanpool\.org {' "${caddyfile}" \
        && [ "$(node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).hosts))' "${apijson}")" = "[\"${name}\"]" ]
fi || { echo "build.sh: image-settings.mjs write-name did not put --name ${name} in the image: not building" >&2; exit 2; }
# acpi=off on the UKI's fixed command line, only when asked (design §2.7: once test T6 shows the host boots so).
if [ "${acpi}" = acpi-off ]; then
    node -e '
        const fs = require("fs"); const f = process.argv[1]; const lines = fs.readFileSync(f, "utf8").split("\n");
        const i = lines.findIndex(l => l.startsWith("KernelCommandLine=")); if (i < 0 || lines.filter(l => l.startsWith("KernelCommandLine=")).length !== 1) process.exit(1);
        lines[i] += " acpi=off"; fs.writeFileSync(f, lines.join("\n"));
    ' "${work}/mkosi.conf" && grep -q '^KernelCommandLine=.* acpi=off$' "${work}/mkosi.conf" \
        || { echo "build.sh: could not add acpi=off to the command line: not building" >&2; exit 2; }
fi
# The host network: nothing changes for dhcp; the static form's file replaces the DHCP one.
# It must answer with the setting; for dhcp the image's own file must be left exactly as it is, and for static the file's
# settings (comments and blank lines aside) must be exactly these ten lines, nothing more.
wan="${extra}/etc/systemd/network/80-wan.network"
n6="${network6:-ra}"
wrote="$(node "${here}/image-settings.mjs" write "${network}" "${wan}" "${n6}")"
case "${network}" in
    dhcp) [ "${n6}" = ra ] && [ "${wrote}" = "dhcp" ] && cmp -s "${wan}" "${here}/mkosi/mkosi.extra/etc/systemd/network/80-wan.network" ;;
    *) address="${network#static:}" address6="${n6#static:}"
       if [ "${n6}" = ra ]; then
           want="$(printf '%s\n' '[Match]' 'Type=ether' 'Kind=!*' '[Network]' "Address=${address%%,*}" "Gateway=${network##*,}" \
                'IPv6AcceptRA=yes' 'LinkLocalAddressing=ipv6' '[IPv6AcceptRA]' 'UseDNS=no')"
       else
           want="$(printf '%s\n' '[Match]' 'Type=ether' 'Kind=!*' '[Network]' "Address=${address%%,*}" "Gateway=${network##*,}" \
                "Address=${address6%%,*}" "Gateway=${n6##*,}" 'IPv6AcceptRA=no' 'LinkLocalAddressing=ipv6')"
       fi
       [ "${wrote}" = "${network}" ] && [ -f "${wan}" ] && [ "$(grep -v -e '^#' -e '^$' "${wan}")" = "${want}" ] ;;
esac || { echo "build.sh: image-settings.mjs write did not write ${wan} for --network ${network}: not building" >&2; exit 2; }
if [ -n "${more}" ]; then
    echo "build.sh: adding ${more} (not a release image)" >&2
    cp -R "${more}/." "${extra}/"
fi
# A checkout or an --extra tree made under a private umask carries 600/700 files: give the tree git's modes back.
chmod -R u+rwX,go=rX "${work}"
unreadable="$(find "${work}" ! -type l \( ! -perm -0004 -o \( -type d ! -perm -0001 \) \) -print | sed -n '1,5p')"
if [ -n "${unreadable}" ]; then
    printf 'build.sh: not readable by every user, so the image would not run:\n%s\n' "${unreadable}" >&2
    exit 2
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
# The install image as a release file: compressed qcow2 (Servury takes raw or qcow2 by URL + SHA-256; the raw disk is
# too big to publish), made by the builder's pinned qemu-img so two builds give the same bytes. And the release files'
# hashes.
rm -f "${out}"/beanpool-vault_*.qcow2 "${out}/SHA256SUMS"
docker run --rm -v "${out}:/output" "${builder}" \
    qemu-img convert -f raw -O qcow2 -c "/output/beanpool-vault_${version}.raw" "/output/beanpool-vault_${version}.qcow2"
(cd "${out}" && for f in vault.efi vault-root.raw vault-root-verity.raw "beanpool-vault_${version}.qcow2"; do
    printf '%s  %s\n' "$(sha256 "$f")" "$f"
done) > "${out}/SHA256SUMS"
# The chip's launch measurement of this UKI on the profile's host (design §2.5): the host's firmware, its CPU count and
# model, the guest features, this vault.efi as the kernel and an empty host command line (the UKI carries its own).
measurement=""
rm -f "${out}/host-policy.json"
if [ "${platform}" = sev-snp ]; then
    measurement="$(docker run --rm -v "${out}:/output:ro" -v "${cache}:/cache:ro" "${builder}" \
        python3 -I -c 'import sys; sys.path.insert(0, sys.argv[1]); from sevsnpmeasure.cli import main; sys.argv = ["sev-snp-measure"] + sys.argv[2:]; sys.exit(main())' \
        "/cache/$(basename "${measure_whl}")" --mode snp \
        --vcpus "$(node "${here}/image-settings.mjs" host "${host}" vcpus)" \
        --vcpu-type "$(node "${here}/image-settings.mjs" host "${host}" vcpu-type)" \
        --guest-features "$(node "${here}/image-settings.mjs" host "${host}" guest-features)" \
        --ovmf "/cache/firmware/$(basename "${fw_file}")" --kernel /output/vault.efi --append '' --output-format hex | tr -d '\r\n')"
    if ! printf '%s' "${measurement}" | grep -Eq '^[0-9a-f]{96}$'; then
        echo "build.sh: sev-snp-measure gave ${measurement:-no answer}, not a 48-byte measurement" >&2
        exit 2
    fi
    node "${here}/image-settings.mjs" host-policy "${host}" "${measurement}" > "${out}/host-policy.json"
    echo "build.sh: launch measurement on host ${host}: ${measurement}" >&2
fi
image_hash="$(printf 'beanpool-vault-image/1\n%s\n%s\n' "${uki_sha}" "${roothash}" | (sha256sum 2>/dev/null || shasum -a 256) | cut -d' ' -f1)"
node "${here}/image-settings.mjs" image-json "${version}" "${uki_sha}" "${roothash}" "${image_hash}" "${network}" \
    "${network6}" "${name}" "${host}" "${measurement}" "${acpi}" > "${out}/image.json"
# Never an empty, partial or wrong image.json: exactly this build's fields, and each setting only when it is not the
# default.
if ! node -e '
    const [file, version, ukiSha256, roothash, imageHash, network, network6 = "", name = "", host = "", measurement = "", acpi = ""] = process.argv.slice(1);
    const want = { version, ukiSha256, roothash, imageHash, ...(network === "dhcp" ? {} : { network }),
        ...(network6 === "" || network6 === "ra" ? {} : { network6 }), ...(name === "" || name === "vault.beanpool.org" ? {} : { name }),
        ...(acpi === "acpi-off" ? { kernelExtra: "acpi=off" } : {}), ...(host === "" || host === "none" ? {} : { host: { profile: host, measurement } }) };
    let got; try { got = JSON.parse(require("fs").readFileSync(file, "utf8")); } catch { process.exit(1); }
    process.exit(JSON.stringify(got) === JSON.stringify(want) ? 0 : 1);
' "${out}/image.json" "${version}" "${uki_sha}" "${roothash}" "${image_hash}" "${network}" "${network6}" "${name}" "${host}" "${measurement}" "${acpi}"; then
    echo "build.sh: image-settings.mjs image-json did not write ${out}/image.json for --network ${network}" >&2
    rm -f "${out}/image.json"
    exit 2
fi
cat "${out}/image.json"

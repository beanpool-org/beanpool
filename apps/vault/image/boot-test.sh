#!/usr/bin/env bash
# Boots a built vault image and checks its memory hygiene from inside (host design §5.1 item 6):
#
#   apps/vault/image/boot-test.sh --image <build.sh's --out dir> [--limit <seconds>]
#
# A copy of the disk image, grown to 8 GB so the first boot can add its partitions, boots under QEMU with UEFI in a
# container (x86-64 emulated on other machines: several minutes). The guest's network reaches nothing outside, so
# nothing is contacted (Caddy can't fetch a certificate and the release check finds no feed; both only log it). It
# passes when image/.../check-hygiene prints "hygiene: ALL PASS" on the serial port. The serial log is left in
# <dir>/boot-test/serial.log.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pins.env
. "${here}/pins.env"
image="" limit=1500
while [ $# -gt 0 ]; do
    case "$1" in
        --image) image="$2"; shift 2 ;;
        --limit) limit="$2"; shift 2 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done
[ -n "${image}" ] || { echo "usage: $0 --image <dir> [--limit <seconds>]" >&2; exit 2; }
image="$(cd "${image}" && pwd)"
raw="$(ls "${image}"/mkosi.output/beanpool-vault_*.raw | grep -v -e '\.root-' -e '\.esp\.' | head -n1)"
work="${image}/boot-test"
rm -rf "${work}"
mkdir -p "${work}"
cp "${raw}" "${work}/disk.raw"
truncate -s 8G "${work}/disk.raw"

tester="beanpool-vault-boot-test:$(docker version -f '{{.Server.Arch}}')-$(cat "${here}/boot-test/Dockerfile" "${here}/boot-test/run.sh" "${here}/pins.env" | (sha256sum 2>/dev/null || shasum -a 256) | cut -c1-16)"
if ! docker image inspect "${tester}" >/dev/null 2>&1; then
    docker build -q -t "${tester}" --build-arg "BUILDER_BASE=${BUILDER_BASE}" --build-arg "DEBIAN_SNAPSHOT=${DEBIAN_SNAPSHOT}" "${here}/boot-test" >/dev/null
fi
docker run --rm -v "${work}:/w" "${tester}" sh /run.sh "${limit}"

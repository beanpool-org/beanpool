# QEMU and UEFI firmware (OVMF) for image/boot-test.sh, from the same Debian snapshot as the image.
ARG BUILDER_BASE
FROM ${BUILDER_BASE}
ARG DEBIAN_SNAPSHOT
RUN rm -f /etc/apt/sources.list /etc/apt/sources.list.d/* \
 && printf 'Types: deb\nURIs: http://snapshot.debian.org/archive/debian/%s/\nSuites: trixie trixie-updates\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n' \
      "${DEBIAN_SNAPSHOT}" > /etc/apt/sources.list.d/debian.sources \
 && apt-get -o Acquire::Check-Valid-Until=false update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends qemu-system-x86 ovmf \
 && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY run.sh /run.sh

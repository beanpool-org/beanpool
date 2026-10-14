# The vault image's build environment (image/build.sh). The base is pinned by digest and every tool comes from the
# same Debian snapshot as the image, so a rebuild months later uses the same mkosi, systemd-repart, ukify and
# mkfs.erofs. This container is not itself a release artifact; only what it builds is.
ARG BUILDER_BASE
FROM ${BUILDER_BASE}
ARG DEBIAN_SNAPSHOT
RUN rm -f /etc/apt/sources.list /etc/apt/sources.list.d/* \
 && printf 'Types: deb\nURIs: http://snapshot.debian.org/archive/debian/%s/\nSuites: trixie trixie-updates\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n\nTypes: deb\nURIs: http://snapshot.debian.org/archive/debian-security/%s/\nSuites: trixie-security\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n' \
      "${DEBIAN_SNAPSHOT}" "${DEBIAN_SNAPSHOT}" > /etc/apt/sources.list.d/debian.sources \
 && apt-get -o Acquire::Check-Valid-Until=false update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      mkosi systemd-ukify systemd-repart systemd-boot-efi erofs-utils dosfstools mtools cryptsetup-bin bubblewrap \
      debian-archive-keyring apt zstd xz-utils ca-certificates python3-pefile cpio kmod \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

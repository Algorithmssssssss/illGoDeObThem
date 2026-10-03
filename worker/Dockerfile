FROM python:3.12-slim

ENV HOME=/tmp
WORKDIR /app

# Pinned radare2 release (Debian's packaged version is stale). radare2
# publishes its .deb releases per Debian arch (amd64, arm64, ...), so the
# arch is read from dpkg inside the image being built rather than from
# Docker's $TARGETARCH — the legacy (non-BuildKit) builder that older Linux
# Docker installs and docker-compose v1 still use leaves $TARGETARCH empty,
# and dpkg is right on every builder, native or emulated. `curl -f` makes a
# missing release asset fail the build here instead of saving a 404 page
# that apt-get then chokes on with a misleading error.
ARG R2_VERSION=6.2.2
RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    ARCH="$(dpkg --print-architecture)" && \
    { curl -fsSL -o /tmp/radare2.deb "https://github.com/radareorg/radare2/releases/download/${R2_VERSION}/radare2_${R2_VERSION}_${ARCH}.deb" || \
        { echo "radare2 ${R2_VERSION} has no prebuilt .deb for '${ARCH}'" >&2; exit 1; }; } && \
    apt-get install -y --no-install-recommends /tmp/radare2.deb && \
    rm /tmp/radare2.deb && \
    apt-get purge -y curl && apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

# r2ghidra: exposes Ghidra's actual decompiler (a native C++ core, no JVM
# involved) as radare2's `pdg` command — built from source via r2pm so the
# same step works on every arch. Confirmed against Debian bookworm: the
# plain `radare2` .deb ships no pkg-config files, so r2ghidra's build can't
# find libradare2 without also installing `radare2-dev` (which has them).
# Both the plugin (~17MB) and its sleigh processor-spec data (~13MB) default
# to installing under $HOME — but $HOME is /tmp here, which is tmpfs-mounted
# fresh at container runtime and would silently swallow them — so we install
# to r2's own system plugin dir instead, which is a normal image layer.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git build-essential cmake pkg-config unzip curl ca-certificates && \
    curl -fsSL -o /tmp/radare2-dev.deb "https://github.com/radareorg/radare2/releases/download/${R2_VERSION}/radare2-dev_${R2_VERSION}_$(dpkg --print-architecture).deb" && \
    apt-get install -y --no-install-recommends /tmp/radare2-dev.deb && \
    rm /tmp/radare2-dev.deb && \
    HOME=/root r2pm -U && \
    HOME=/root r2pm -ci r2ghidra && \
    HOME=/root r2pm -ci r2ghidra-sleigh && \
    R2_PLUGDIR="$(r2 -H R2_LIBR_PLUGINS)" && \
    mv /root/.local/share/radare2/plugins/core_ghidra.so "$R2_PLUGDIR/" && \
    mv /root/.local/share/radare2/plugins/r2ghidra_sleigh "$R2_PLUGDIR/r2ghidra_sleigh" && \
    apt-get purge -y git build-essential cmake pkg-config unzip curl radare2-dev && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/* /root/.local/share/radare2

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY worker ./worker

CMD ["celery", "-A", "worker.celery_app", "worker", "--loglevel=INFO", "--concurrency=1"]

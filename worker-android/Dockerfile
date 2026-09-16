FROM python:3.12-slim

ENV HOME=/tmp
WORKDIR /app

# Pinned JADX (dex→Java decompiler) and apktool (smali disassembler) releases.
# Both are plain Java tools (no native arch-specific builds), so unlike
# worker/Dockerfile's radare2 install this doesn't need a $TARGETARCH split.
ARG JADX_VERSION=1.5.6
ARG APKTOOL_VERSION=3.0.3

RUN apt-get update && apt-get install -y --no-install-recommends \
        openjdk-21-jre-headless curl unzip ca-certificates && \
    curl -sL -o /tmp/jadx.zip "https://github.com/skylot/jadx/releases/download/v${JADX_VERSION}/jadx-${JADX_VERSION}.zip" && \
    unzip -q /tmp/jadx.zip -d /opt/jadx && \
    chmod +x /opt/jadx/bin/jadx && \
    rm /tmp/jadx.zip && \
    curl -sL -o /opt/apktool.jar "https://github.com/iBotPeaches/Apktool/releases/download/v${APKTOOL_VERSION}/apktool_${APKTOOL_VERSION}.jar" && \
    apt-get purge -y curl unzip && apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

ENV JADX_BIN=/opt/jadx/bin/jadx
ENV APKTOOL_JAR=/opt/apktool.jar

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY worker_android ./worker_android

CMD ["celery", "-A", "worker_android.celery_app", "worker", "--loglevel=INFO", "--concurrency=1"]

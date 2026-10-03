FROM python:3.12-slim

ENV HOME=/tmp
WORKDIR /app

# reFlutter shells out to Java tooling when it repackages an APK (zip/align),
# so a headless JRE needs to be on PATH. ca-certificates lets it fetch the
# matching pre-patched Flutter engine over HTTPS from GitHub at patch time.
RUN apt-get update && apt-get install -y --no-install-recommends \
        default-jre-headless ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY reflutter_svc ./reflutter_svc

CMD ["celery", "-A", "reflutter_svc.celery_app", "worker", "-Q", "reflutter", "--loglevel=INFO", "--concurrency=1"]

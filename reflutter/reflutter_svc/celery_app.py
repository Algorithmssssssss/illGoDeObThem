import os

from celery import Celery

celery_app = Celery(
    "reflutter",
    broker=os.environ.get("REDIS_URL", "redis://redis:6379/0"),
)
celery_app.conf.update(
    task_default_queue="reflutter",
    # Patching downloads a pre-patched engine and repackages the app, which is
    # a lot slower than the other workers' tasks — give it generous headroom.
    task_time_limit=1800,
    task_soft_time_limit=1740,
    worker_hijack_root_logger=False,
)

# Ensure tasks module is registered with this app
from . import tasks  # noqa: E402,F401

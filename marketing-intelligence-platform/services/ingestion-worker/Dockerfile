# Ingestion worker — Celery worker + beat. Railway background service (no public port).
FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends libpq5 && rm -rf /var/lib/apt/lists/*

COPY services/ingestion-worker/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Shared package (DB + ERP client) then the worker code (main.py + tasks/).
COPY shared /app/shared
COPY services/ingestion-worker/ /app/

ENV PYTHONUNBUFFERED=1 PYTHONPATH=/app SERVICE_NAME=ingestion-worker

# Single service runs the worker with an embedded beat scheduler.
CMD ["celery", "-A", "main", "worker", "--beat", "--loglevel=info", "--concurrency=2"]

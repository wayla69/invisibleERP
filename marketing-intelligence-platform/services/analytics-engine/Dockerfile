# Analytics engine — MMM / RFM / TOWS. Runs as a Railway worker/job (invoked by the ingestion-worker's
# run_analytics task, or on demand: `python run.py`). No public port.
FROM python:3.11-slim

WORKDIR /app

# System deps for psycopg2 + scientific wheels.
RUN apt-get update && apt-get install -y --no-install-recommends libpq5 && rm -rf /var/lib/apt/lists/*

COPY services/analytics-engine/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Shared package (DB + ERP client) then the engine code.
COPY shared /app/shared
COPY services/analytics-engine/ /app/

ENV PYTHONUNBUFFERED=1 SERVICE_NAME=analytics-engine

CMD ["python", "run.py"]

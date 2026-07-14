# Dashboard UI — Streamlit. Railway WEB service (the only public one). Binds to $PORT.
FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends libpq5 && rm -rf /var/lib/apt/lists/*

COPY services/dashboard-ui/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY shared /app/shared
COPY services/dashboard-ui/ /app/

ENV PYTHONUNBUFFERED=1 PYTHONPATH=/app SERVICE_NAME=dashboard-ui \
    STREAMLIT_SERVER_HEADLESS=true STREAMLIT_BROWSER_GATHER_USAGE_STATS=false

EXPOSE 8501
# Railway injects $PORT; shell form so it expands. Falls back to 8501 locally.
CMD streamlit run app.py --server.port ${PORT:-8501} --server.address 0.0.0.0

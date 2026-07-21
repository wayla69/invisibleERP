# Invisible ERP forecast-engine (docs/54) — stateless SCM planning compute service.
# Prophet >= 1.1.6 ships manylinux wheels with the compiled cmdstan model, so no toolchain build.
#
# BUILD CONTEXT = repo root. The Railway service uses Root Directory `/` (like invisibleERP), and
# railway.json points dockerfilePath at `services/forecast-engine/Dockerfile` (repo-root-relative),
# so `railway up` / the dashboard build both send the whole repo as the Docker context. The COPY
# sources below are therefore repo-root-relative — NOT `pyproject.toml`/`app`, which would resolve to
# the repo root and fail ("/pyproject.toml": not found).
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /srv

COPY services/forecast-engine/pyproject.toml ./
COPY services/forecast-engine/app ./app
RUN pip install --no-cache-dir .

# Non-root: the engine never writes to disk (pure compute).
RUN useradd --system --uid 10001 engine && chown -R engine /srv
USER engine

EXPOSE 8000

# Warm the wheels at build time so the first request doesn't pay the import cost.
RUN python -c "import prophet, pulp; print('deps ok')"

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4).status==200 else 1)"

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers ${UVICORN_WORKERS:-2}"]

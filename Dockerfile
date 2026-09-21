FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY data ./data
COPY frontend ./frontend

# The mock CRM creates this directory at first run. Keeping it outside source
# directories makes the SQLite volume explicit in docker-compose.yml.
RUN mkdir -p /app/runtime

EXPOSE 8000

# Hosting platforms commonly provide PORT at runtime. Keep 8000 as the local
# default while allowing the same image to bind to the assigned public port.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]

FROM node:22-bookworm-slim

# Both DriveHub (Node) and the full original Car Search Hub (Python +
# headless Chromium) run in ONE Railway service/container and share /data.
ENV NODE_ENV=production \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    CHROMIUM_PATH=/usr/bin/chromium \
    DATA_DIR=/data \
    ENVIRONMENT=production

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip chromium ca-certificates \
    fonts-liberation libatomic1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY tools/car-search/legacy/requirements.txt /tmp/car-search-requirements.txt
RUN python3 -m venv /opt/car-search-venv \
    && /opt/car-search-venv/bin/pip install --no-cache-dir -r /tmp/car-search-requirements.txt \
    && /opt/car-search-venv/bin/python -m playwright --version \
    && /usr/bin/chromium --version

COPY . .
RUN chmod 755 /app/scripts/start-drivehub.sh
EXPOSE 8080
CMD ["/app/scripts/start-drivehub.sh"]

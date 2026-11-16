FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 ENVIRONMENT=production DATA_DIR=/data CHROMIUM_PATH=/usr/bin/chromium PORT=3000
RUN apt-get update && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation libatomic1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
# Fail the image build if the Playwright Node driver cannot start.
RUN python -m playwright --version && chromium --version
COPY . .
RUN mkdir -p /data && chown -R nobody:nogroup /data /app
USER nobody
EXPOSE 3000
CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT:-3000} --workers 1"]

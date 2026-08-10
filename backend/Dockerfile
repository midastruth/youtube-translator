FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml README.md ./
COPY src/ ./src/
COPY .env.example ./.env

RUN python -m pip install --no-cache-dir -e .

RUN mkdir -p /app/cache

EXPOSE 8787

ENV HOST=0.0.0.0
ENV PORT=8787
ENV CACHE_DIR=/app/cache

CMD ["youtube-ingest-server"]

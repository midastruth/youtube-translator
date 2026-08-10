.PHONY: start start-backend test lint clean

# ── 启动 ─────────────────────────────────────────────────────────────

start: start-backend
	@echo "Backend running at http://localhost:8787"
	@echo "Load extension/ in Chrome to use"

start-backend:
	cd backend && .venv/bin/uvicorn youtube_ingest.server:app --host 0.0.0.0 --port 8787 --reload

# ── 测试 ─────────────────────────────────────────────────────────────

test:
	cd backend && PYTHONPATH=src .venv/bin/python -m unittest discover -s tests -v

# ── Docker ────────────────────────────────────────────────────────────

docker-up:
	docker compose up -d

docker-down:
	docker compose down

docker-build:
	docker compose build

# ── 安装 ─────────────────────────────────────────────────────────────

install:
	cd backend && python3 -m venv .venv
	cd backend && .venv/bin/pip install -e .
	@echo "minimal-extension is static; no frontend dependencies to install"

build-extension:
	@echo "minimal-extension/public is ready to load directly in Chrome"

# ── 清理 ─────────────────────────────────────────────────────────────

clean:
	cd backend && rm -rf .venv __pycache__ .pytest_cache cache/
	find backend -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true
	find backend -name "*.pyc" -delete 2>/dev/null || true

.PHONY: start start-server start-backend test test-ts test-backend lint clean build-extension

# ── 启动 ─────────────────────────────────────────────────────────────

# 默认启动统一 TypeScript 服务（单端口 8787，内置 Worker）
start: start-server

start-server:
	npm start

# 历史兼容实现：原 Python FastAPI 后端（需单独启动 Python + Worker）
start-backend:
	cd backend && .venv/bin/uvicorn youtube_ingest.server:app --host 0.0.0.0 --port 8787 --reload

# ── 测试 ─────────────────────────────────────────────────────────────

test: test-ts

test-ts:
	npm test

# 历史兼容实现：原 Python 后端测试
test-backend:
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
	npm ci
	@echo "TypeScript 统一服务端已安装完成。"
	@echo "若需要运行旧版 Python 后端，请执行：cd backend && python3 -m venv .venv && .venv/bin/pip install -e ."

build-extension:
	npm run build:extension

# ── 清理 ─────────────────────────────────────────────────────────────

clean:
	rm -rf dist/ tmp/
	cd backend && rm -rf .venv __pycache__ .pytest_cache cache/
	find backend -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true
	find backend -name "*.pyc" -delete 2>/dev/null || true

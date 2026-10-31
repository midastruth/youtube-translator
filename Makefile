.PHONY: start start-server test test-ts lint clean build-extension

# ── 启动 ─────────────────────────────────────────────────────────────

# 默认启动统一 TypeScript 服务（单端口 8787，内置 Worker）
start: start-server

start-server:
	npm start

# ── 测试 ─────────────────────────────────────────────────────────────

test: test-ts

test-ts:
	npm test

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

build-extension:
	npm run build:extension

# ── 清理 ─────────────────────────────────────────────────────────────

clean:
	rm -rf dist/ tmp/

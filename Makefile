HOST := $(shell grep '^HOST=' .env | cut -d '=' -f 2)

# ─── Local ─────────────────────────────────────────────────

run:
	node src/index.js

# ─── Docker ────────────────────────────────────────────────

build:
	docker build -t jocker-bot:latest .

# ─── Deploy ────────────────────────────────────────────────

.PHONY: install deploy logs

install:
	@echo "📦 Installing on $(HOST)..."
	ssh -t root@$(HOST) "mkdir -p /opt/jocker-bot/data && chown 1000:1000 /opt/jocker-bot/data"
	scp ./.env root@$(HOST):/opt/jocker-bot/.env
	scp ./docker-compose.yml root@$(HOST):/opt/jocker-bot/docker-compose.yml
	rsync ./data/* root@$(HOST):/opt/jocker-bot/data/
	ssh -t root@$(HOST) "chown -R 1000:1000 /opt/jocker-bot/data"

deploy:
	@echo "🚀 Deploying to $(HOST)..."
	ssh root@$(HOST) "docker pull ghcr.io/mikhail-angelov/jocker-bot:latest"
	-ssh root@$(HOST) "cd /opt/jocker-bot && docker compose down"
	ssh root@$(HOST) "cd /opt/jocker-bot && docker compose up -d"
	@echo "✅ Done! Check logs with: make logs"

logs:
	ssh root@$(HOST) "docker logs -f jocker-bot"

restart:
	ssh root@$(HOST) "cd /opt/jocker-bot && docker compose restart"

status:
	ssh root@$(HOST) "cd /opt/jocker-bot && docker compose ps"

# ─── Help ──────────────────────────────────────────────────

help:
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@echo "  run          Run bot locally"
	@echo "  build        Build Docker image"
	@echo "  install      Prepare server (mkdir + check .env)"
	@echo "  deploy       Build, push, and deploy to server"
	@echo "  logs         Tail server logs"
	@echo "  restart      Restart bot on server"
	@echo "  status       Show container status on server"
	@echo ""
	@echo "Config:"
	@echo "  Add HOST=user@ip to .env   (required for deploy)"
	@echo "  ./env.production            (on server, not in repo)"

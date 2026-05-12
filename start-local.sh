#!/usr/bin/env bash
# Local launcher for factory demo.
#
# Sequence:
#   1. Check backend/.env (Supabase service key + Anthropic key)
#   2. Install deps if needed
#   3. Apply migrations 008+008b? (skipped — assumed done in Supabase UI)
#   4. Seed demo data
#   5. Start backend (background)
#   6. Wait for backend health
#   7. Start frontend (foreground; Ctrl+C to stop both)
#
# Usage:
#   ./start-local.sh
#   ./start-local.sh --skip-seed   # if demo data already loaded

set -euo pipefail

cd "$(dirname "$0")"

# ── 1. Env check ─────────────────────────────────────────
if [ ! -f backend/.env ]; then
  echo "❌ backend/.env missing. Copy from template and fill in keys:"
  echo "     cp backend/.env.example backend/.env"
  echo "     # then edit backend/.env to add SUPABASE_SERVICE_KEY + ANTHROPIC_API_KEY"
  exit 1
fi

# Source it for the checks below
set -a; . backend/.env; set +a

missing=()
[ -z "${SUPABASE_URL:-}" ]         && missing+=("SUPABASE_URL")
[ -z "${SUPABASE_SERVICE_KEY:-}" ] && missing+=("SUPABASE_SERVICE_KEY")
[ -z "${ANTHROPIC_API_KEY:-}" ]    && missing+=("ANTHROPIC_API_KEY")

if [ ${#missing[@]} -gt 0 ]; then
  echo "❌ Missing required env vars in backend/.env:"
  for v in "${missing[@]}"; do echo "     $v"; done
  exit 1
fi

if [ ! -f frontend/.env.local ]; then
  echo "❌ frontend/.env.local missing. Need VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY"
  exit 1
fi

echo "✓ env files OK"

# ── 2. Install deps ──────────────────────────────────────
if [ ! -d backend/node_modules ]; then
  echo "→ installing backend deps..."
  (cd backend && npm install)
fi
if [ ! -d frontend/node_modules ]; then
  echo "→ installing frontend deps..."
  (cd frontend && npm install)
fi

# ── 3. Optional seed ─────────────────────────────────────
if [ "${1:-}" != "--skip-seed" ]; then
  echo "→ seeding demo data..."
  (cd backend && npm run demo:seed) || {
    echo "⚠ seed failed (continuing — DB may already have data)"
  }
else
  echo "→ skipping seed (--skip-seed)"
fi

# ── 4. Start backend (background) ────────────────────────
echo "→ starting backend on :3001..."
(cd backend && npm run dev) &
BACKEND_PID=$!

# Trap to clean up on exit
cleanup() {
  echo ""
  echo "→ stopping backend (PID $BACKEND_PID)..."
  kill $BACKEND_PID 2>/dev/null || true
  wait $BACKEND_PID 2>/dev/null || true
  echo "✓ stopped"
}
trap cleanup EXIT INT TERM

# ── 5. Wait for backend health ───────────────────────────
echo "→ waiting for backend health..."
for i in {1..30}; do
  if curl -s -f http://localhost:3001/api/health > /dev/null 2>&1; then
    echo "✓ backend healthy"
    break
  fi
  sleep 1
  if [ $i -eq 30 ]; then
    echo "❌ backend failed to start within 30s"
    exit 1
  fi
done

# Show backend health
echo ""
echo "── Backend health ──"
curl -s http://localhost:3001/api/health | head -1
echo ""

# ── 6. Start frontend (foreground) ───────────────────────
echo "→ starting frontend on :5173 (Ctrl+C to stop everything)..."
echo ""
echo "  Open: http://localhost:5173"
echo "  Login: alex@qimoclothing.com (or whoever has access)"
echo ""

cd frontend && npm run dev

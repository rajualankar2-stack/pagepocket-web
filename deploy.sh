#!/usr/bin/env bash
#
# Deploy PagePocket Web to Vercel, under the same team as the other projects
# on this machine (team_cYwhvlK1rtXWMKQFA3B7WYUd).
#
# Run this once interactively: `vercel login` opens a browser, which is the only
# part that cannot be automated.
set -euo pipefail

TEAM="team_cYwhvlK1rtXWMKQFA3B7WYUd"
PROJECT="pagepocket-web"

cd "$(dirname "$0")"

if ! command -v vercel >/dev/null 2>&1; then
  echo "Vercel CLI not found. Install it with:  npm install -g vercel"
  exit 1
fi

if ! vercel whoami >/dev/null 2>&1; then
  echo "Not signed in. Opening the browser to authenticate…"
  echo "(This is the one step that has to be done by a human.)"
  vercel login
fi

echo
echo "Signed in as: $(vercel whoami 2>/dev/null | tail -1)"

# Link to the existing team so this project sits alongside the others, rather
# than under a personal scope.
if [ ! -f .vercel/project.json ]; then
  echo "Linking project…"
  vercel link --yes --project "$PROJECT" --scope "$TEAM"
fi

echo
echo "Deploying to production…"
vercel deploy --prod --yes --scope "$TEAM"

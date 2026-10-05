#!/bin/zsh
# Synchronisation automatique quotidienne (#12), lancée par launchd.
# Un journal par jour dans data/logs (comptes uniquement), journaux de plus de 30 jours supprimés.

set -u
cd "$(dirname "$0")/.." || exit 1

mkdir -p data/logs
log="data/logs/sync-$(date +%F).log"

./node_modules/.bin/tsx src/sync-run.ts --auto >> "$log" 2>&1
code=$?

find data/logs -name 'sync-*.log' -mtime +30 -delete
exit $code

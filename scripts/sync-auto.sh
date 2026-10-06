#!/bin/zsh
# Synchronisation automatique quotidienne (#12), lancée par launchd toutes les heures.
# Usage : sync-auto.sh <heure de début>
#
# Une seule synchronisation par jour, à partir de l'heure de début : les lancements suivants
# s'arrêtent tout de suite. Sans réseau (Mac en veille, en déplacement), on réessaie simplement
# à l'heure suivante.
# Un journal par jour dans data/logs (comptes uniquement), journaux de plus de 30 jours supprimés.

set -u
cd "$(dirname "$0")/.." || exit 1

start_hour=${1:-8}
(( $(date +%H) < start_hour )) && exit 0

mkdir -p data/logs
today=$(date +%F)
done_marker="data/logs/.terminee-$today"
[[ -e $done_marker ]] && exit 0

log="data/logs/sync-$today.log"
./node_modules/.bin/tsx src/sync-run.ts --auto >> "$log" 2>&1
code=$?

# Seule l'absence de réseau (4) mène à un nouvel essai à l'heure suivante. Les autres cas sont
# réglés pour la journée : terminée, plafond atteint, ou problème déjà notifié (on ne le
# renotifie pas toutes les heures).
(( code != 4 )) && touch "$done_marker"

find data/logs -name 'sync-*.log' -mtime +30 -delete
find data/logs -name '.terminee-*' -mtime +2 -delete
exit $code

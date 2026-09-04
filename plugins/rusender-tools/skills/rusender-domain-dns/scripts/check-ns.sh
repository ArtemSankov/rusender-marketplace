#!/usr/bin/env bash
# Определяет зону, у которой есть NS-записи, и DNS-провайдера.
# Использование: check-ns.sh <fqdn>
# Вывод (по строке): ZONE=..., NS=..., PROVIDER=timeweb|other|none
set -euo pipefail

fqdn="${1:?usage: check-ns.sh <fqdn>}"
fqdn="${fqdn%.}"

if ! command -v dig >/dev/null 2>&1; then
  echo "ERROR: dig не найден (macOS: входит в систему; Linux: apt install dnsutils)" >&2
  exit 2
fi

zone="$fqdn"
ns=""
while [[ "$zone" == *.* ]]; do
  ns="$(dig NS "$zone" +short 2>/dev/null | sed 's/\.$//' | sort | tr '\n' ' ' | sed 's/ *$//')"
  if [[ -n "$ns" ]]; then
    break
  fi
  zone="${zone#*.}"
done

if [[ -z "$ns" ]]; then
  echo "ZONE=$fqdn"
  echo "NS="
  echo "PROVIDER=none"
  exit 0
fi

provider="other"
if echo "$ns" | grep -qi 'timeweb'; then
  provider="timeweb"
fi

echo "ZONE=$zone"
echo "NS=$ns"
echo "PROVIDER=$provider"

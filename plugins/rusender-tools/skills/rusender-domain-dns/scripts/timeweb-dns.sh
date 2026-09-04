#!/usr/bin/env bash
# Обёртка над Timeweb Cloud API для DNS-записей.
# Токен берётся ТОЛЬКО из переменной окружения TIMEWEB_CLOUD_TOKEN.
#
# Использование:
#   timeweb-dns.sh list   <zone>
#   timeweb-dns.sh add    <zone> <TYPE> <value> [subdomain] [priority]
#   timeweb-dns.sh delete <zone> <record_id>
#
# Примеры:
#   timeweb-dns.sh add example.com TXT 'v=DKIM1;k=rsa;p=...' 'mdmdmail._domainkey'
#   timeweb-dns.sh add example.com TXT 'v=spf1 include:rsndr.ru ~all'
set -euo pipefail

API="https://api.timeweb.cloud/api/v1"
cmd="${1:-}"
zone="${2:-}"

if [[ -z "${TIMEWEB_CLOUD_TOKEN:-}" ]]; then
  echo "ERROR: переменная TIMEWEB_CLOUD_TOKEN не задана. Запросите токен у пользователя и передайте его так:" >&2
  echo "  TIMEWEB_CLOUD_TOKEN=... $0 $*" >&2
  exit 2
fi
if [[ -z "$cmd" || -z "$zone" ]]; then
  sed -n '2,14p' "$0" >&2
  exit 2
fi

auth=(-H "Authorization: Bearer $TIMEWEB_CLOUD_TOKEN" -H "Content-Type: application/json")

pretty() {
  python3 -c 'import json,sys
raw=sys.stdin.read().rstrip("\n")
body, _, status = raw.rpartition("\n")
try:
    print(json.dumps(json.loads(body), ensure_ascii=False, indent=2))
except Exception:
    print(body)
print(status)'
}

case "$cmd" in
  list)
    curl -sS -w '\nHTTP %{http_code}\n' "${auth[@]}" "$API/domains/$zone/dns-records?limit=100" | pretty
    ;;
  add)
    type="${3:?TYPE required (A, AAAA, CNAME, MX, TXT, SRV)}"
    value="${4:?value required}"
    subdomain="${5:-}"
    priority="${6:-}"
    body="$(python3 - "$type" "$value" "$subdomain" "$priority" <<'PY'
import json, sys
t, v, sub, prio = sys.argv[1:5]
body = {"type": t.upper(), "value": v}
if sub:
    body["subdomain"] = sub
if prio:
    body["priority"] = int(prio)
print(json.dumps(body, ensure_ascii=False))
PY
)"
    curl -sS -w '\nHTTP %{http_code}\n' -X POST "${auth[@]}" -d "$body" "$API/domains/$zone/dns-records" | pretty
    ;;
  delete)
    record_id="${3:?record_id required}"
    curl -sS -w '\nHTTP %{http_code}\n' -X DELETE "${auth[@]}" "$API/domains/$zone/dns-records/$record_id" | pretty
    ;;
  *)
    echo "ERROR: неизвестная команда '$cmd'" >&2
    sed -n '2,14p' "$0" >&2
    exit 2
    ;;
esac

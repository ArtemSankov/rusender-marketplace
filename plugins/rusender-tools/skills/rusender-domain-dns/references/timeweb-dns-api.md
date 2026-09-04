# Timeweb Cloud API: DNS-записи домена

Источник: официальный OpenAPI-бандл `https://timeweb.cloud/api-docs-data/bundle.json`, раздел «Домены».

- База: `https://api.timeweb.cloud`
- Авторизация: `Authorization: Bearer <JWT>`. Токен создаётся в панели Timeweb Cloud, раздел «API и Terraform».
- Лимит: не более 20 запросов в секунду на эндпоинт, иначе 429.
- Все ответы содержат `response_id` для обращения в поддержку.

## Эндпоинты, которые использует скилл (v1)

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/api/v1/domains` | Список доменов аккаунта (`?limit&offset&idn_name&linked_ip`) |
| GET | `/api/v1/domains/{fqdn}/dns-records` | Пользовательские DNS-записи зоны |
| POST | `/api/v1/domains/{fqdn}/dns-records` | Добавить запись |
| PATCH | `/api/v1/domains/{fqdn}/dns-records/{record_id}` | Обновить запись |
| DELETE | `/api/v1/domains/{fqdn}/dns-records/{record_id}` | Удалить запись |
| GET | `/api/v1/domains/{fqdn}/default-dns-records` | Записи по умолчанию (отдельно от пользовательских) |

Тело POST/PATCH (v1, плоское):

```json
{ "type": "TXT", "value": "v=DKIM1;k=rsa;p=...", "subdomain": "mdmdmail._domainkey", "ttl": 60, "priority": 10 }
```

- `type`: `A`, `AAAA`, `CNAME`, `MX`, `TXT`, `SRV` (обязательно)
- `value`: значение (обязательно)
- `subdomain`: префикс относительно зоны, без имени зоны. Для апекса не передавать. Проверено на реальной зоне: запись `_dmarc.example.com` хранится как `"subdomain": "_dmarc"`, апексная SPF как `"subdomain": null`. Отдельно создавать поддомен для этого не нужно.
- `priority`: только для MX/SRV.
- `ttl`: секунды, опционально.

Ответ на GET:

```json
{
  "meta": { "total": 2 },
  "dns_records": [
    { "id": 92130191, "type": "TXT", "ttl": 60, "fqdn": "example.com",
      "data": { "subdomain": null, "value": "v=spf1 include:rsndr.ru ~all" } },
    { "id": 92128981, "type": "TXT", "ttl": 60, "fqdn": "example.com",
      "data": { "subdomain": "_dmarc", "value": "v=DMARC1; p=none; rua=mailto:..." } }
  ],
  "response_id": "..."
}
```

## Коды ошибок

- 401: токен неверный или просрочен.
- 404 `Domain not found`: домена нет на этом аккаунте Timeweb (хотя NS могут быть timeweb-овские, домен может лежать на другом аккаунте).
- 409: конфликт, обычно дубликат записи.
- 429: превышен лимит запросов.

## v2 (для справки, скилл не использует)

`POST/PATCH/DELETE /api/v2/domains/{fqdn}/dns-records[/{record_id}]`: тело типизировано по `type`, у SRV отдельные поля `service`, `protocol`, `port`, `host`, у A есть `app_id`. В v2 запись на поддомене требует, чтобы поддомен был создан заранее через `POST /api/v1/domains/{fqdn}/subdomains/{subdomain}`, а в `{fqdn}` передавалось полное имя с поддоменом. Для служебных префиксов вроде `_dmarc` удобнее v1.

## Прочее из раздела «Домены»

- `PATCH /api/v1/domains/{fqdn}`: `is_autoprolong_enabled`, `linked_ip`.
- `GET/PUT /api/v1/domains/{fqdn}/name-servers`: NS домена (`name_servers: [{host, ips[]}]`), ответ включает `task_status`.
- `POST/DELETE /api/v1/domains/{fqdn}/subdomains/{subdomain}`: в путь передаётся только префикс.
- `GET /api/v1/check-domain/{fqdn}`, `POST /api/v1/add-domain/{fqdn}`, `/api/v1/domains-requests`, `/api/v1/tlds`, `/api/v1/persons`: регистрация, продление, трансфер, зоны, администраторы.

## Соответствие записей RuSender

RuSender отдаёт `dnsRecords.{dkim,spf,dmarc}` с полями `type` (TXT), `host` (полный хост), `data` (значение), `isVerified`. `subdomain` для Timeweb = `host` минус `.<zone>`; для `host == zone` поле не передаётся.

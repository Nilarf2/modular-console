# NewAPI connection

Use a **user access token** from NewAPI account/security settings, plus that account's numeric user ID. A model API key (typically used for `/v1` model requests) is a different credential and cannot authenticate this account connector. Where supported, grant only the account/profile and usage-log read scopes.

Configure the service's HTTP(S) base URL, including any reverse proxy prefix. The connector supports localhost, private LAN addresses and Tailscale addresses. Embedded credentials, query strings, fragments, link-local addresses and redirects are rejected. Use the final canonical service URL. HTTPS protects the access token in transit.

The connector performs only these GET requests:

- `/api/user/self`, authenticated with `Authorization: Bearer …` and `New-Api-User: …`, for username, remaining quota, lifetime used quota and lifetime request count.
- `/api/log/self/stat?type=2&start_timestamp=…&end_timestamp=…`, for today's consumed quota. Today starts at midnight in **Asia/Shanghai (UTC+8)**, regardless of the console server's timezone.

The inspected NewAPI source returns `quota`, `rpm` and `tpm` from the statistics endpoint. The latter two represent the last minute, so this connector leaves today's token/request totals unavailable (`null`). Missing or invalid numeric fields and unavailable statistics also remain `null`; actual zero values remain zero. Remaining quota can be negative.

Quota is returned in NewAPI's raw quota units. Configure `quotaPerUnit` and `currency` for display; the connector does not infer exchange rates or model prices. It reads neither administrator data nor other accounts, and never modifies upstream state. Each request has an eight-second deadline and a 256 KiB response limit. Failures expose only sanitized messages, without response bodies or credentials.

The API field mapping and canonical paths were checked against the local QuantumNous NewAPI source snapshot `7d8b912` (`controller/user.go`, `controller/log.go`, `model/log.go`, `router/api-router.go`). No production service connection was made during implementation.

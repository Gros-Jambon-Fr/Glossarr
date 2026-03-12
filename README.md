<p align="center">
  <img src="logo.png" alt="Glossarr" width="280" />
</p>

<p align="center">
  Translate Sonarr's show, season, and episode metadata into your language, using TVDB and/or TMDB as sources.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/node-20-green" alt="Node 20" />
  <img src="https://img.shields.io/badge/docker-ready-blue" alt="Docker" />
  <img src="https://img.shields.io/badge/dependencies-none-brightgreen" alt="Zero dependencies" />
</p>

---

Sonarr fetches TV metadata from Skyhook, which is almost exclusively in English. **Glossarr** is a lightweight HTTP/HTTPS proxy that sits transparently between Sonarr and Skyhook, intercepts metadata requests, and replaces titles and overviews with translations from [TVDB](https://thetvdb.com) and/or [TMDB](https://www.themoviedb.org) — for shows, seasons, and episodes.

## Features

- Translates **show**, **season**, and **episode** metadata (title + overview)
- Supports **TVDB** and **TMDB** as translation sources, with automatic field-level fallback
- Granular per-field control: `always`, `never`, or `native` (translate only if the show's original language matches yours)
- Dual-source support: fetch from both TVDB and TMDB in parallel, merge field by field
- Zero npm dependencies — plain Node.js 20
- Transparent passthrough for all other Skyhook routes

## Security

Glossarr has **zero npm dependencies**. There is no `node_modules`, no third-party package to audit, and no supply chain attack surface. The entire codebase is a single `proxy.js` file and a few shell scripts — readable end to end in a few minutes.

If you're evaluating whether to run this on your homelab, that's the shortest security audit you'll ever do.

The TLS certificates are generated locally by `generate-certs.sh` using `openssl` — the private key never leaves your machine. The custom CA is scoped to `skyhook.sonarr.tv` only, so trusting it in Sonarr cannot be leveraged to intercept any other traffic.

## How it works

Sonarr connects to `skyhook.sonarr.tv` over HTTPS to fetch metadata. Glossarr intercepts this traffic by:

1. Overriding DNS resolution for `skyhook.sonarr.tv` inside Sonarr's container (via `extra_hosts`)
2. Serving a TLS endpoint using a self-signed certificate issued by a custom CA
3. Making Sonarr trust that CA

Glossarr then forwards the request to the real Skyhook, enriches the response with translations, and returns it transparently.

## Prerequisites

- Docker & Docker Compose
- A free [TVDB API key](https://thetvdb.com/api-information) — required if using TVDB
- A free [TMDB Read Access Token](https://www.themoviedb.org/settings/api) — required if using TMDB

## Installation

### 1. Create a `docker-compose.yml`

```yaml
services:
  glossarr:
    image: ghcr.io/gros-jambon-fr/glossarr:latest
    container_name: glossarr
    restart: unless-stopped
    ports:
      - "443:3443"
      - "3000:3000"
    environment:
      - TVDB_API_KEY=your_tvdb_api_key
      - TMDB_API_KEY=your_tmdb_api_key
      - LANGUAGE=fra
      - PRIMARY_TRANSLATION_SOURCE=tvdb
      - SECONDARY_TRANSLATION_SOURCE=tmdb
      - CERT_DIR=/certs
    volumes:
      - ./certs:/certs
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
```

See the [Configuration](#configuration) section for all available options.

### 2. Start Glossarr

```bash
docker compose up -d
```

On first startup, Glossarr automatically generates a custom CA and a TLS certificate for `skyhook.sonarr.tv` in the `./certs/` directory. No manual steps required.

Glossarr listens on:
- Port `3000` — HTTP (healthcheck)
- Port `443` — HTTPS (Sonarr traffic)

### 3. Integrate with Sonarr

Add the following to your Sonarr `docker-compose.yml`:

```yaml
extra_hosts:
  - "skyhook.sonarr.tv:<your_host_ip>"
volumes:
  - /path/to/Glossarr/certs/ca.crt:/custom-cont-init.d/glossarr-ca.crt:ro
  - /path/to/Glossarr/trust-glossarr-ca.sh:/custom-cont-init.d/trust-glossarr-ca.sh:ro
```

Replace `<your_host_ip>` with the IP address of the host running Glossarr (the machine where port 443 is exposed).

Then restart Sonarr:

```bash
docker compose restart sonarr
```

Sonarr will now route all Skyhook requests through Glossarr.

> **Note:** The `custom-cont-init.d` mechanism is supported by [linuxserver/sonarr](https://docs.linuxserver.io/images/docker-sonarr/). If you use a different image, trust the CA according to that image's documentation.

> **Port 443 conflict:** If port 443 is already in use on your host (e.g. by a reverse proxy), see [Advanced: TCP passthrough](#advanced-tcp-passthrough).

## Configuration

All configuration is done via environment variables passed to the Glossarr container.

### API Keys

| Variable | Required | Description |
|---|---|---|
| `TVDB_API_KEY` | If using TVDB | TVDB v4 API key |
| `TMDB_API_KEY` | If using TMDB | TMDB Read Access Token |

### Language

| Variable | Default | Description |
|---|---|---|
| `LANGUAGE` | `fra` | Target language as ISO 639-2 code (`fra`, `eng`, `spa`, `deu`, `ita`, `jpn`, `kor`…) |

### Translation sources

| Variable | Default | Values | Description |
|---|---|---|---|
| `PRIMARY_TRANSLATION_SOURCE` | `tvdb` | `tvdb`, `tmdb` | Primary source for translations |
| `SECONDARY_TRANSLATION_SOURCE` | _(none)_ | `tvdb`, `tmdb` | Fallback source if a field is missing from the primary |

When both sources are configured, Glossarr fetches from both in parallel and merges results field by field — title and overview are resolved independently.

### Translation modes

Each field can be controlled independently:

| Variable | Default | Description |
|---|---|---|
| `SHOW_TITLE_MODE` | `native` | Show title |
| `SHOW_OVERVIEW_MODE` | `always` | Show overview |
| `SEASON_TITLE_MODE` | `native` | Season name |
| `SEASON_OVERVIEW_MODE` | `always` | Season overview |
| `EPISODE_TITLE_MODE` | `native` | Episode title |
| `EPISODE_OVERVIEW_MODE` | `always` | Episode overview |

Available modes:

| Mode | Behavior |
|---|---|
| `always` | Always replace with the translated value |
| `never` | Never replace — keep the original Skyhook value |
| `native` | Replace only if the show's original language matches your configured `LANGUAGE` |

> **Example:** With `LANGUAGE=fra` and `SHOW_TITLE_MODE=native`, a French show like *Les Revenants* will have its title translated, but *Breaking Bad* will keep its original title.

### TLS

| Variable | Default | Description |
|---|---|---|
| `CERT_DIR` | _(none)_ | Path inside the container where TLS certificates are stored. If set and certificates are absent, they are generated automatically on first startup. |

## Health check

```
GET /health
```

```json
{ "status": "ok", "language": "fra", "primary": "tvdb", "secondary": "tmdb" }
```

## Advanced: TCP passthrough

If port 443 is already in use on your host (e.g. by Traefik or nginx), you can configure your reverse proxy to forward TCP traffic for `skyhook.sonarr.tv` directly to Glossarr's HTTPS port, without TLS termination.

**Example with Traefik** (`dynamic.yml`):

```yaml
tcp:
  routers:
    skyhook:
      entryPoints:
        - websecure
      rule: HostSNI(`skyhook.sonarr.tv`)
      service: skyhook
      tls:
        passthrough: true
  services:
    skyhook:
      loadBalancer:
        servers:
          - address: glossarr:3443
```

In this case, remove the `ports: ["443:3443"]` mapping from Glossarr's `docker-compose.yml` and make sure Glossarr is on the same Docker network as Traefik.

## License

MIT — see [LICENSE](LICENSE)

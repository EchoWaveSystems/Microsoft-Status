# Microsoft Status Board

A live dashboard for the public feeds behind https://status.cloud.microsoft.

```bash
npm start          # or: node server.js   → http://localhost:5050
```

No dependencies; Node 18+.

| Env var         | Default     | Meaning                                                                 |
|-----------------|-------------|-------------------------------------------------------------------------|
| `PORT`          | `5050`      | HTTP port                                                               |
| `HOST`          | `127.0.0.1` | Interface to listen on. `0.0.0.0` makes the board reachable on the LAN |
| `ALLOWED_HOSTS` | (none)      | Extra comma-separated Host names to accept, e.g. `mypc,192.168.1.20`   |
| `POLL_SECONDS`  | `60`        | How often the server polls Microsoft (minimum 30)                       |
| `AUTH_USERNAME` | (none)      | Enable authentication with required username                            |
| `AUTH_PASSWORD` | (none)      | Optional password requirement. If omitted, asks for username only       |

Authentication modes:
- **No authentication**: Leave `AUTH_USERNAME` empty.
- **Username only**: Set `AUTH_USERNAME=admin` (leave `AUTH_PASSWORD` empty).
- **Username + Password**: Set both `AUTH_USERNAME=admin` and `AUTH_PASSWORD=secret`.

To share the board on your network:

```bash
HOST=0.0.0.0 ALLOWED_HOSTS=mypc,192.168.1.20 node server.js
```

## Why a server

`status.cloud.microsoft/api/posts/*` sends no CORS headers, so a browser page cannot call it directly.
`server.js` proxies the four feeds (`mac`, `m365Consumer`, `azure`, `ppac`), keeps the last good copy if
a fetch fails, and writes every status change to `data/history.json`. That file drives the change timeline,
which therefore only covers the time this server has been running.

## Endpoints

All endpoints are `GET`/`HEAD` only.

- `GET /api/status`: `?refresh=1` forces an upstream fetch, at most once every 15 s
- `GET /api/history`
- `GET /api/history/download`: downloads `data/history.json` as an attachment. It always serves that one fixed file and takes no parameters
- `GET /api/raw/<feed>`

## Security

- Listens on loopback only unless `HOST` is set. Requests with an unknown `Host` header get a 421 response, which blocks DNS rebinding.
- Static files are served only from `public/`, and only `.html .css .js .svg .png`. Traversal, encoded slashes, NUL bytes and NTFS streams are rejected.
- A strict Content-Security-Policy (no inline script, no framing), plus `nosniff`, `no-referrer` and COOP/CORP on every response. SVG icons get a script-free sandbox CSP.
- Upstream responses are capped at 5 MB, must be JSON objects or arrays of objects, and redirects are refused.
- Remote text is rendered with `textContent` only. Error details are logged to the console, never sent to the client.
- Header and request timeouts limit slow-connection attacks.

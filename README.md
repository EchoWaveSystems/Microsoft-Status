# Microsoft Status Board

A live dashboard for the public feeds behind https://status.cloud.microsoft.

```bash
npm start          # or: node server.js   → http://localhost:5050
```

No dependencies; Node 18+.

| Env var        | Default | Meaning                               |
|----------------|---------|---------------------------------------|
| `PORT`         | `5050`  | HTTP port                             |
| `POLL_SECONDS` | `60`    | How often the server polls Microsoft  |

## Why a server

`status.cloud.microsoft/api/posts/*` sends no CORS headers, so a browser page cannot call it directly.
`server.js` proxies the four feeds (`mac`, `m365Consumer`, `azure`, `ppac`), keeps the last good copy if
a fetch fails, and writes every status change to `data/history.json`. That file drives the change timeline,
which therefore only covers the time this server has been running.

## Endpoints

- `GET /api/status` (`?refresh=1` forces an upstream fetch)
- `GET /api/history`
- `GET /api/raw/<feed>`

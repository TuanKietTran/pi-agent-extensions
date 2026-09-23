# Pi Cloud Admin

A Pi extension for administering **Cloudflare** and **Tailscale** through their official REST APIs.

Credentials are held only in the extension's memory and are erased on logout, reload, session switch, or Pi shutdown. They are never added to the Pi transcript, tool arguments, or files.

## Security model

- Interactive secrets are entered through a masked TUI prompt.
- API permissions are determined by the Cloudflare token or Tailscale key/OAuth client you supply.
- Every non-GET request requires an interactive confirmation.
- Non-GET requests are blocked in print/JSON mode where confirmation is unavailable.
- API paths are restricted to the provider's fixed HTTPS API origin; absolute URLs and redirects are rejected.
- JSON fields with secret-like names are redacted from tool output.
- Responses are limited to 2,000 lines or 50 KB and are never written to disk.
- Use `dry_run: true` before consequential mutations.

Admin credentials remain powerful. Prefer narrowly scoped, short-lived tokens and review each mutation before approving it.

## Run

```bash
cd /Users/handlerone/Downloads/pi-cloud-admin
npm install
npm run check
pi -e /Users/handlerone/Downloads/pi-cloud-admin
```

Or install persistently:

```bash
pi install /Users/handlerone/Downloads/pi-cloud-admin
```

## Session login commands

```text
/cloud-admin-login cloudflare
/cloud-admin-login tailscale
/cloud-admin-status
/cloud-admin-logout cloudflare
/cloud-admin-logout tailscale
/cloud-admin-logout all
```

Cloudflare login accepts an API token and verifies it with `GET /user/tokens/verify`.

Tailscale login supports:

- API access token (`tskey-api-...`)
- OAuth client ID and secret; the extension exchanges them for a short-lived bearer token

No slash-command argument accepts a credential, preventing secrets from entering the saved conversation.

## Environment login

Set credentials before starting Pi if interactive login is unavailable:

```bash
export CLOUDFLARE_API_TOKEN='...'
export TAILSCALE_API_KEY='...'
pi -e /Users/handlerone/Downloads/pi-cloud-admin
```

Tailscale OAuth is also supported:

```bash
export TAILSCALE_OAUTH_CLIENT_ID='...'
export TAILSCALE_OAUTH_CLIENT_SECRET='...'
```

Environment values are read into session memory. Remember that environment variables remain available to other processes/tools launched by the same Pi process; masked interactive login offers stronger isolation from Pi's built-in shell tool.

## LLM tools

### `cloudflare_admin_api`

Calls paths below:

```text
https://api.cloudflare.com/client/v4
```

Examples:

```json
{"method":"GET","path":"/accounts"}
```

```json
{"method":"GET","path":"/zones?per_page=20"}
```

### `tailscale_admin_api`

Calls paths below:

```text
https://api.tailscale.com/api/v2
```

Examples:

```json
{"method":"GET","path":"/tailnet/-/devices"}
```

```json
{"method":"POST","path":"/device/DEVICE_ID/authorized","body":"{\"authorized\":true}","dry_run":true}
```

The tools are deliberately generic so they can manage all API resources allowed by the supplied credential while keeping the destination origin fixed.

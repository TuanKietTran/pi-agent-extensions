# Pi Cloud Admin

A Pi extension for administering **Cloudflare** and **Tailscale** through their official REST APIs.

Verified Cloudflare tokens are saved in the current user's macOS Login Keychain and loaded automatically in later Pi sessions. Tailscale credentials remain session-scoped. Credentials are never added to the Pi transcript, tool arguments, repository files, or plaintext configuration files.

## Security model

- Interactive secrets are entered through a masked TUI prompt.
- Cloudflare tokens are stored as a generic Login Keychain item with service `pi-cloud-admin.cloudflare` and the current macOS username as its account.
- `/cloud-admin-logout cloudflare` removes both the in-memory credential and its Keychain item.
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

Cloudflare login accepts an API token, verifies it with `GET /user/tokens/verify`, and saves it in macOS Login Keychain. On subsequent starts, the extension loads that Keychain item automatically. Environment credentials take precedence when present.

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

Environment values are read into session memory and take precedence over Keychain values. Remember that environment variables remain available to other processes/tools launched by the same Pi process; masked interactive login backed by Login Keychain offers stronger isolation from Pi's built-in shell tool.

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

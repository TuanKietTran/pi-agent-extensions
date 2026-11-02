# muse-proxy provider for pi

Registers the `muse` provider, which talks to a
[muse-proxy](https://github.com/uezo/muse-proxy) over its OpenAI-compatible
`/v1/chat/completions` API.

```sh
pi --provider muse --model muse
```

## Configuration

First match wins:

1. `PI_MUSE_PROXY_URL` (default `http://pi4:8766/v1`) and `PI_MUSE_PROXY_KEY`
2. `~/.pi/agent/muse-proxy.json`, mode `0600`:
   ```json
   { "baseUrl": "http://pi4:8766/v1", "apiKey": "<proxy api_key>" }
   ```

`PI_MUSE_PROXY_MAX_CHARS` (default 15000) caps one request; keep it at or below
the proxy's `max_message_chars` (16000 by default).

The key is the proxy's own `api_key` from `proxy.toml`, not a Muse credential.

## Behaviour and limits

- **Chat only, no pi tools.** Muse runs its own tools in its own sandbox. The
  proxy rejects client-supplied tool definitions (`400 Client-supplied tools are
  not supported`), and Muse refuses a text tool-call protocol when asked to use
  one. The provider therefore drops pi's tools; Muse answers in text and cannot
  read or edit files on your machine.
- **Server-side history.** Muse keeps the conversation per `session_id` and the
  proxy forwards only the last user message. The provider keeps one Muse session
  per pi conversation and sends only the messages Muse has not seen. The first
  turn (and any turn after a rewind or pi restart) sends pi's system prompt
  (clipped) plus the history, newest messages first when it must be cut.
- **Latency.** Requests are non-streaming; expect roughly 10 to 20 seconds per
  turn.
- Each pi conversation creates a Muse side chat; use the proxy only for this.

## Setting up the proxy

See the muse-proxy README. Pairing uses the Muse Gadget SDK on a Linux machine
with Bluetooth LE, then the three credential files are copied into the proxy's
`state_dir`. Bind the proxy to a private interface (for example the Tailscale
address) and keep its `api_key` secret.

## Tests

```sh
node --test muse-proxy/*.test.ts
```

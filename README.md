# SOLO Proxy

A Telegram proxy with a web panel, built to run on [Railway](https://railway.com). One service runs **one protocol at a time**, chosen with radio buttons in the panel:

| Protocol | Telegram link | Transport on Railway |
| --- | --- | --- |
| **Web proxy** | `tg://webproxy` | HTTPS + WebSocket on the public domain |
| **MTProto** | `tg://proxy` | Railway TCP Proxy |
| **SOCKS5** | `tg://socks` | Railway TCP Proxy |
| **HTTP** | none (enter by hand, Telegram Desktop only) | Railway TCP Proxy |

The Web proxy is a Node port of the CF Proxy Cloudflare Worker, including its decoy page, bridge page and QR code. SOCKS5 and HTTP only reach Telegram's official address ranges.

## Deploy on Railway

1. Create a new Railway project from this repository.
2. **Add a Volume** to the service, mounted at `/app/data`. It holds the database (settings, secret, statistics).
3. Under **Settings → Networking**, generate a public domain.
4. For MTProto, SOCKS5 or HTTP, also add a **TCP Proxy** with application port `8443` (the `PROXY_PORT` default). The Web proxy does not need it.
5. Set the variable `ADMIN_PASSWORD` before the first start. Without it the password is `admin`.
6. Open `https://<your-domain>/panel`, sign in and pick a protocol.

The decoy page is served at `/`; the panel lives only under `/panel`.

## Variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `ADMIN_PASSWORD` | Initial admin password (first start only) | `admin` |
| `SESSION_SECRET` | Signs session cookies | generated and stored |
| `DATA_DIR` | Database folder | Volume mount path, else `./data` |
| `SECRET` | Initial proxy secret, 32 hex characters (first start only) | random |
| `PROXY_PORT` | Port of the TCP listener for MTProto, SOCKS5 and HTTP | `8443` |

`PORT` is set by Railway.

## Panel

- Switch the active protocol and enable or disable the proxy.
- Change or regenerate the secret (Web proxy and MTProto).
- Change or regenerate the username and password (SOCKS5 and HTTP).
- Usage statistics per protocol: upload, download, connections.
- Link, copy button and QR code for the active protocol.

Changing the protocol, the secret or the credentials disconnects everyone who is connected.

## Railway limits

- Only one TCP Proxy per service, so only one raw TCP protocol can run at a time.
- No UDP.
- Raw TCP goes through the address and port Railway assigns (shown in the panel).
- Check Railway's Acceptable Use Policy before running a proxy. Accounts can be restricted.

## Run locally

```
npm install
npm start
```

Open `http://localhost:3000/panel`. Data is stored in `./data`.

## License

MIT

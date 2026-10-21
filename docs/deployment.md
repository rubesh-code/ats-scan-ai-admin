# Deployment

The dashboard is a static build (`dist/`) served by nginx. It holds no secrets:
all data comes from `/api/admin` on the ATS Scan AI backend, which nginx
proxies on the same origin.

Target: **`https://admin.atsscanai.com`**, proxied by Cloudflare with
**Cloudflare Access** in front (set up manually). Until then, use the SSH
tunnel below; do not open a public port.

## Port note

Browsers refuse `http://` on ports **5060 and 5061** (SIP; blocked against NAT
slipstreaming) with `ERR_UNSAFE_PORT`, so the originally proposed
`http://51.21.242.89:5060` cannot be opened in Chrome, Edge or Firefox. The
dev/preview server defaults to **5070** (`ADMIN_PORT` to change it). In
production the port does not matter: nginx serves the site on 443.

## Build

```bash
npm ci
npm test
npm run build          # type-checks, then builds dist/
npm run check:bundle   # fails if a secret-looking string or mock data reached dist/
```

## Layout on the server

```
/var/www/ats-admin/
  releases/<git-sha>/     one directory per deployed build (contents of dist/)
  current -> releases/<git-sha>
```

Deploy = copy `dist/` to a new `releases/<sha>/`, then switch the symlink
atomically (`ln -sfn releases/<sha> current.tmp && mv -T current.tmp current`).
No nginx reload is needed for a static release.

## Rollback

Point `current` back at the previous release and you're done:

```bash
cd /var/www/ats-admin
ls -1t releases | head -3                                   # newest first
ln -sfn releases/<previous-sha> current.tmp && mv -T current.tmp current
```

Keep at least the last three releases. Backend admin routes should sit behind
an `ADMIN_API_ENABLED` flag so they can be switched off independently.

## nginx (sketch, for review before use)

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name admin.atsscanai.com;

    # Cloudflare Origin Certificate (Full (strict) mode).
    ssl_certificate     /etc/ssl/cloudflare/admin.atsscanai.com.pem;
    ssl_certificate_key /etc/ssl/cloudflare/admin.atsscanai.com.key;

    root /var/www/ats-admin/current;
    index index.html;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
    add_header X-Robots-Tag "noindex, nofollow" always;

    # Only the admin API is reachable on this host, never the user API.
    location /api/admin/ {
        proxy_pass http://127.0.0.1:<backend-port>;   # confirm: 5000 or 5050
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location /api/ { return 404; }

    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files $uri =404;
    }
    location / {
        add_header Cache-Control "no-cache";
        try_files $uri /index.html;
    }
}
```

Network: the security group needs **no** new rule for this. 443 already serves
the main site; restricting 443 to Cloudflare's published IP ranges is a
further hardening step.

## Testing before Cloudflare: SSH tunnel

Serve the build on the server's loopback only, then tunnel to it:

```bash
# on the server: listen on 127.0.0.1 only
server { listen 127.0.0.1:5070; root /var/www/ats-admin/current; ... same locations ... }

# on your PC
ssh -N -L 5070:127.0.0.1:5070 ubuntu@51.21.242.89
# then open http://localhost:5070
```

Nothing is exposed to the internet and nothing crosses it unencrypted.

## Release checklist

- [ ] `npm test`, `npm run build`, `npm run check:bundle` all pass
- [ ] Backend admin endpoints deployed and passing the checks in `docs/admin-api.md`
- [ ] Cloudflare Access policy limited to named admin emails
- [ ] Response headers verified (`curl -sI https://admin.atsscanai.com`)
- [ ] A non-admin account is refused (`403`) end to end
- [ ] Previous release kept for rollback

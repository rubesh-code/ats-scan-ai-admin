#!/usr/bin/env bash
# Linux CI only (GitHub-hosted Ubuntu runner: passwordless sudo, systemd as
# PID 1). Verifies the production access model with real OS users:
#
#   - the service runs as ats-admin with the systemd settings from
#     deploy/ats-admin-auth.service (RuntimeDirectory 0750, UMask 0077, ...);
#   - the socket ends up 0660 ats-admin:ats-admin in a 0750 directory;
#   - a member of group ats-admin (standing in for nginx) can connect;
#   - any other user cannot (the CI user, a fresh user, nobody);
#   - the service refuses a socket directory others can enter, or not its own;
#   - secret files named by an environment variable must be 0600, while
#     systemd credentials are accepted as systemd provides them;
#   - the CLI reads its systemd credential and shows only a generic error.
#
# It creates system users and writes under /opt and /run, so it refuses to
# run anywhere but a CI runner. No database and no secrets are involved: the
# harness uses in-memory PGlite, and the "database URLs" below point at a
# closed local port with throwaway credentials.
#
# Usage (from auth-service/, after npm ci && npm run build):
#   sudo CI=true NODE_BIN="$(command -v node)" bash test/linux/socket-access.sh
set -euo pipefail

[[ $(id -u) -eq 0 ]] || { echo "must run as root (sudo)" >&2; exit 2; }
[[ "${CI:-}" == "true" ]] || { echo "refusing: this creates system users; CI runners only (CI=true)" >&2; exit 2; }
NODE="${NODE_BIN:?set NODE_BIN to the Node 22 binary}"
[[ "$("$NODE" --version)" == v22.* ]] || { echo "NODE_BIN is not Node 22" >&2; exit 2; }

SRC="$(cd "$(dirname "$0")/../.." && pwd)"
INSTALL=/opt/ats-admin-auth-ci
UNIT=ats-admin-auth-ci
RUNDIR=/run/ats-admin-auth
SOCK="$RUNDIR/auth.sock"
HOST='ats-admin.localhost:5070'
ORIGIN='http://ats-admin.localhost:5070'
CI_USER="${SUDO_USER:-runner}"
FAKE_DB_URL='postgresql://ci_fake:ci_fake@127.0.0.1:1/ci_fake'   # nothing listens on port 1
WORK="$(mktemp -d)"
failures=0

pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; failures=$((failures + 1)); }

cleanup() {
  systemctl stop "$UNIT" >/dev/null 2>&1 || true
  if (( failures > 0 )); then journalctl -u "$UNIT" --no-pager -n 50 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "== users and groups (as in deploy/ats-admin-auth.service)"
id ats-admin >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin --user-group ats-admin
id ci-nginx  >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin ci-nginx
id ci-other  >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin ci-other
usermod -aG ats-admin ci-nginx   # the production step for nginx: usermod -aG ats-admin www-data
if id -nG "$CI_USER" | tr ' ' '\n' | grep -qx ats-admin; then
  echo "unexpected: $CI_USER is in group ats-admin" >&2; exit 2
fi

echo "== root-owned, read-only install (as /opt/ats-admin-auth/current would be)"
rm -rf "$INSTALL"
install -d -m 0755 "$INSTALL" "$INSTALL/test/linux"
cp -r "$SRC/dist" "$SRC/db" "$SRC/node_modules" "$SRC/package.json" "$INSTALL/"
cp "$SRC/test/linux/socket-harness.mjs" "$INSTALL/test/linux/"
chown -R root:root "$INSTALL"
chmod -R go-w,a+rX "$INSTALL"

echo "== start the harness under systemd with the unit's settings"
systemd-run --unit "$UNIT" --collect --quiet \
  -p User=ats-admin -p Group=ats-admin \
  -p RuntimeDirectory=ats-admin-auth -p RuntimeDirectoryMode=0750 \
  -p UMask=0077 -p NoNewPrivileges=yes \
  -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes \
  -p RestrictAddressFamilies="AF_UNIX AF_INET AF_INET6" \
  -E ADMIN_AUTH_SOCKET="$SOCK" -E ADMIN_AUTH_ALLOWED_ORIGINS="$ORIGIN" \
  "$NODE" "$INSTALL/test/linux/socket-harness.mjs"

# Ready once the socket exists and has been narrowed to its final mode.
for _ in $(seq 1 60); do
  [[ -S "$SOCK" && "$(stat -c '%a' "$SOCK")" == 660 ]] && break
  sleep 0.5
done
[[ -S "$SOCK" ]] || { fail "socket never appeared"; exit 1; }

echo "== ownership and modes"
expect_stat() { # path expected
  local got; got="$(stat -c '%a %U %G' "$1")"
  if [[ "$got" == "$2" ]]; then pass "$1 is $got"; else fail "$1 is '$got', expected '$2'"; fi
}
expect_stat "$RUNDIR" '750 ats-admin ats-admin'
expect_stat "$SOCK" '660 ats-admin ats-admin'

echo "== who can connect"
# Prints the HTTP status, or "denied" if the connection itself was refused.
probe() { # user [extra curl args...]
  local user="$1"; shift
  local status
  if status="$(sudo -u "$user" curl -sS -o /dev/null -w '%{http_code}' --max-time 5 \
      --unix-socket "$SOCK" -H "Host: $HOST" "$@" http://localhost/api/admin/auth/me 2>"$WORK/curl.err")"; then
    echo "$status"
  elif grep -qiE 'permission denied|couldn.t connect' "$WORK/curl.err"; then
    echo denied
  else
    echo "error: $(cat "$WORK/curl.err")"
  fi
}
expect_probe() { # user expected description
  local got; got="$(probe "$1")"
  if [[ "$got" == "$2" ]]; then pass "$3 ($1 -> $got)"; else fail "$3 ($1 -> '$got', expected '$2')"; fi
}
expect_probe ats-admin   401    'the service user reaches the app (401: no session)'
expect_probe ci-nginx    401    'a member of group ats-admin (nginx stand-in) reaches the app'
expect_probe ci-other    denied 'an unrelated user is refused at the socket'
expect_probe "$CI_USER"  denied 'the CI login user (not in the group) is refused'
expect_probe nobody      denied 'nobody is refused'

# Two barriers: the 0750 directory and the 0660 socket. Open the directory
# briefly to prove the socket's own mode also refuses other users.
chmod 0755 "$RUNDIR"
expect_probe ci-other    denied 'the socket mode alone refuses others (directory opened to 0755)'
chmod 0750 "$RUNDIR"

status="$(sudo -u ci-nginx curl -sS -o /dev/null -w '%{http_code}' --max-time 5 --unix-socket "$SOCK" \
  -H 'Host: evil.example' http://localhost/api/admin/auth/me || true)"
[[ "$status" == 421 ]] && pass "unknown Host is refused over the socket (421)" || fail "unknown Host gave $status"

systemctl stop "$UNIT"
[[ ! -e "$RUNDIR" ]] && pass "RuntimeDirectory removed on stop" || fail "$RUNDIR left behind after stop"

echo "== the service refuses an unsafe socket directory"
expect_refusal() { # dir owner mode expected-message description
  rm -rf "$1"; install -d -m "$3" -o "$2" -g "$2" "$1"
  local out code=0
  out="$(sudo -u ats-admin env ADMIN_AUTH_SOCKET="$1/auth.sock" ADMIN_AUTH_ALLOWED_ORIGINS="$ORIGIN" \
    "$NODE" "$INSTALL/test/linux/socket-harness.mjs" 2>&1)" || code=$?
  if [[ $code -eq 3 && "$out" == *"$4"* ]]; then pass "$5"; else fail "$5 (exit $code: $out)"; fi
  [[ ! -e "$1/auth.sock" ]] || fail "$5: a socket was created anyway"
  rm -rf "$1"
}
expect_refusal /run/ats-admin-ci-open ats-admin 0755 'accessible to other users' 'directory other users can enter'
expect_refusal /run/ats-admin-ci-root root      0750 'not owned by the service user' 'directory owned by someone else'

echo "== secret files"
run_server() { # db-url-file -> prints combined output; never connects anywhere real
  sudo -u ats-admin env ADMIN_AUTH_ALLOWED_ORIGINS="$ORIGIN" ADMIN_AUTH_HOST=127.0.0.1 ADMIN_AUTH_PORT=5071 \
    ADMIN_AUTH_DATABASE_URL_FILE="$1" "$NODE" "$INSTALL/dist/server.js" 2>&1 || true
}
secret="$WORK/db-url"
chmod 0755 "$WORK"
printf '%s\n' "$FAKE_DB_URL" > "$secret"
chown ats-admin:ats-admin "$secret"

for mode in 0644 0640 0604 0660; do
  chmod "$mode" "$secret"
  out="$(run_server "$secret")"
  [[ "$out" == *'refusing to start'*'chmod 600'* ]] && pass "secret file mode $mode refused" || fail "secret file mode $mode accepted: $out"
done

chmod 0600 "$secret"
out="$(run_server "$secret")"
# Past every configuration check, it fails only at the (deliberately absent) database.
if [[ "$out" != *'refusing to start'* && "$out" == *ECONNREFUSED* ]]; then
  pass "secret file mode 0600 accepted (then no database, as intended)"
else
  fail "secret file mode 0600: $out"
fi
[[ "$out" != *ci_fake@* ]] && pass "the database URL is not echoed" || fail "the database URL appeared in output"

echo "== systemd credentials (LoadCredential)"
# A root-owned 0644 source file is fine here: systemd copies it into a
# directory private to the unit, which is what the service reads.
cred_src="$WORK/cred-db-url"
printf '%s\n' "$FAKE_DB_URL" > "$cred_src"
chown root:root "$cred_src"; chmod 0644 "$cred_src"
out="$(systemd-run --wait --pipe --collect --quiet -p User=ats-admin -p Group=ats-admin \
  -p LoadCredential=db-url:"$cred_src" \
  -E ADMIN_AUTH_ALLOWED_ORIGINS="$ORIGIN" -E ADMIN_AUTH_HOST=127.0.0.1 -E ADMIN_AUTH_PORT=5071 \
  "$NODE" "$INSTALL/dist/server.js" 2>&1 || true)"
if [[ "$out" != *'refusing to start'* && "$out" == *ECONNREFUSED* ]]; then
  pass "service reads its URL from a systemd credential"
else
  fail "systemd credential for the service: $out"
fi

out="$(systemd-run --wait --pipe --collect --quiet -p User=ats-admin -p Group=ats-admin \
  -p LoadCredential=manager-db-url:"$cred_src" \
  "$NODE" "$INSTALL/dist/cli.js" unlock alice 2>&1 || true)"
expected='Failed: the database operation did not complete (code ECONNREFUSED). The change was not applied.'
if [[ "$out" == *"$expected"* && "$out" != *ci_fake* && "$out" != *127.0.0.1* ]]; then
  pass "CLI reads its credential and shows only a generic error"
else
  fail "CLI output: $out"
fi

echo
if (( failures > 0 )); then echo "$failures check(s) failed"; exit 1; fi
echo "all socket and secret-file checks passed"

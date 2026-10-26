#!/usr/bin/env bash
#
# DeepSeek Harness container entrypoint.
#
# Process model (same shape as the other community builds, deliberately):
#
#   Caddy :PORT (0.0.0.0)  --proxy-->  dsh web 127.0.0.1:DSH_INTERNAL_PORT
#
# `dsh web` refuses wildcard bind addresses, and its browser-trust fence
# (node_modules/@deepseek-ai/dsh-client-connection) requires the Host header to
# be loopback / the listener bind IP / a declared --trusted-host, with any
# attached Origin matching that Host. Caddy therefore owns the listener, injects
# the launch token into the browser's first navigation, and presents DSH a Host
# it will accept. Two modes:
#
#   edge : PUBLIC_URL set. Caddy forwards Host=<authority>, keeps Origin, and
#          rejects any request whose Origin is not PUBLIC_URL. Use this behind
#          SWAG/Authelia (or any HTTPS front end).
#   lan  : PUBLIC_URL empty. Caddy forwards Host=127.0.0.1:<internal>, strips
#          Origin, and warns. DNS-rebinding and cross-site defence stay in
#          force: the Host fence cannot be forged by a rebound browser, and the
#          fence still rejects Sec-Fetch-Site: cross-site.
#
# AUTH_MODE decides who guards the UI:
#   builtin (default) : the container's own password gate. The password must come
#                       from DSH_PASSWORD or DSH_PASSWORD_FILE; a builtin gate with
#                       neither refuses to start.
#   none              : authentication belongs to the edge proxy (SWAG/Authelia,
#                       VPN, ...) or to a trusted network.
# Anything else fails closed.
set -Eeuo pipefail

# The identity everything runs as. PUID/PGID choose it, and both default to the image's
# own unprivileged `node` account (1000:1000), so a deployment that says nothing behaves
# exactly as before. The point of the pair is a NAS: there the directory behind /data
# already belongs to somebody — Unraid's appdata is `nobody` (99) in group `users` (100)
# — and a process running as a third identity can neither read what is there nor write
# what it creates. PUID=99, PGID=100 is what the Unraid template recommends; compose and
# plain `docker run` keep 1000:1000. The variables use the spelling every NAS image uses,
# so it is the one an operator recognizes; two consequences the rest of this file
# carries: the writable volumes are taken over as PUID:PGID at start (nothing else can
# make them usable), and the passwd entry is synthesized, because both `setpriv` and a
# `~` resolve through it while the image only ships `node` at 1000.
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
# Optional. 022 is the default and what other images ship; 002 is what a shared
# group-writable workspace needs. Applied to the processes we spawn, not to the
# entrypoint's own writes (those set their modes explicitly).
UMASK="${UMASK:-022}"
# A handover that has to rewrite a whole node_modules tree can take a while on a NAS
# filesystem; the entrypoint may not hang on it, so it is bounded and a bounded-out
# handover is reported instead of silently half-done.
REPAIR_TIMEOUT_S=180

PORT="${PORT:-8080}"
DSH_INTERNAL_PORT="${DSH_INTERNAL_PORT:-3080}"
# AUTH_MODE unset means "whatever this image considers safe": a password gate,
# because a default install must not be usable by everybody who can reach the port.
AUTH_MODE="${AUTH_MODE:-builtin}"
# The template ships this as a required field (default dsh): a login prompt that asks
# for a user name the operator cannot find anywhere in the UI is a bad first run.
AUTH_USER="${AUTH_USER:-dsh}"
AUTH_COOKIE_NAME="${AUTH_COOKIE_NAME:-dsh_gate}"
AUTH_COOKIE_MAX_AGE="${AUTH_COOKIE_MAX_AGE:-604800}"
DSH_PASSWORD="${DSH_PASSWORD:-}"
DSH_PASSWORD_FILE="${DSH_PASSWORD_FILE:-}"
# The Unraid template (in MeiXu6693/dsh-unraid) ships this as the Password field's
# default so that a fresh install has a working login. It is public, so it protects
# nothing until it is changed; the entrypoint therefore says so at every start (and
# the README and that template's description tell the operator to change it). A
# compose/CLI deployment must set DSH_PASSWORD (or DSH_PASSWORD_FILE), or set
# AUTH_MODE=none when an authenticating proxy fronts it.
DEFAULT_TEMPLATE_PASSWORD="12345678"
DSH_HOME="${DSH_HOME:-/data/dsh}"
DSH_AGENTS_HOME="${DSH_AGENTS_HOME:-${DSH_HOME}/agents}"
DSH_WORKSPACE="${DSH_WORKSPACE:-/workspace}"
DSH_TRUSTED_HOSTS="${DSH_TRUSTED_HOSTS:-}"
PUBLIC_URL="${PUBLIC_URL:-}"
# Remote sign-in (see docs/remote-signin.md). The DeepSeek platform only returns a
# browser sign-in to a loopback address, so a browser that is not on this machine
# cannot sign in with an account at all. `on` (the default) loads the plugin that
# claims such an address and puts the paste step into the DSH page itself; `off`
# keeps upstream behaviour bit-for-bit. The claim is a loopback origin *string*
# nothing ever listens on: any port works, and a port unlikely to be occupied on
# the operator's own machine is chosen so a stray local service can never receive
# the authorization code.
#
# The plugin is github.com/MeiXu6693/dsh-remote-signin, installed by the Dockerfile
# and maintained there; this image only decides whether to load it and with which claim.
# It is loaded through this image's own patch file, by absolute path: the launcher
# resolves entry names from the installation and the profile, and a plugin the image
# installs is in neither (the patch file itself explains the measurement).
REMOTE_SIGNIN="${REMOTE_SIGNIN:-on}"
REMOTE_SIGNIN_ORIGIN="${REMOTE_SIGNIN_ORIGIN:-}"
REMOTE_SIGNIN_DEFAULT_ORIGIN="http://127.0.0.1:47821"
REMOTE_SIGNIN_DIR="/app/node_modules/dsh-remote-signin"
REMOTE_SIGNIN_PATCH="/etc/dsh/remote-signin.patch.yml"
REMOTE_SIGNIN_MODULE="${REMOTE_SIGNIN_DIR}/src/index.js"
REMOTE_SIGNIN_ACTIVE=0

CADDY_DIR="/etc/caddy"
CADDY_CONFIG_HOME="${DSH_HOME%/dsh}/caddy/config"
CADDY_DATA_HOME="${DSH_HOME%/dsh}/caddy/data"
DSH_STARTUP_LOG="${TMPDIR:-/tmp}/dsh-startup-$$.log"
DSH_VERSION_FILE="/etc/dsh-version"

DSH_PID=""
CADDY_PID=""
DSH_LAUNCH_TOKEN=""
DSH_UPSTREAM_HOST=""
PUBLIC_ORIGIN=""
EXTRA_TRUSTED_HOSTS=()

log() { printf '[entrypoint] %s\n' "$*"; }
warn() { printf '[entrypoint] WARNING: %s\n' "$*" >&2; }
fatal() { printf '[entrypoint] ERROR: %s\n' "$*" >&2; exit 1; }

trim() {
    local value="$1"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    printf '%s' "${value}"
}

validate_port() {
    local name="$1" value="$2" numeric
    [[ "${value}" =~ ^[0-9]{1,5}$ ]] || fatal "${name} must be an integer between 1 and 65535 (got '${value}')"
    numeric=$((10#${value}))
    (( numeric >= 1 && numeric <= 65535 )) || fatal "${name} must be between 1 and 65535 (got '${value}')"
}

read_image_version() {
    [[ -r "${DSH_VERSION_FILE}" ]] || return 0
    local line
    while IFS= read -r line; do
        [[ "${line}" == DSH_VERSION=* ]] && printf '%s' "${line#DSH_VERSION=}" && return 0
    done < "${DSH_VERSION_FILE}"
}

# PUID/PGID have to be usable before anything else happens: they decide which identity
# owns the volumes, and a wrong value (a typo, or 0) has to be refused here rather than
# half-applied. Refused: not a positive integer, 0 (the container's own root), 65534
# (`nobody`, the uid a kernel hands to an unmapped one — never an identity to run an
# agent as), and a value outside uid_t's range.
#
# Numbers that merely *collide with a name* are accepted on purpose, and that is a
# correction: the obvious check ("refuse a uid the image's own system accounts hold")
# refuses the very deployment this feature exists for, because Debian's gid 100 is
# literally called `users`. Unraid's appdata is 99:100. A uid:gid pair is a number — the
# container's account database names are irrelevant to what a process owns — so the only
# collisions worth stopping are the two that change what the process means: root and
# nobody. The passwd entry is synthesized separately (see sync_app_account).
resolve_identity() {
    [[ "${PUID}" =~ ^[0-9]{1,10}$ ]] || fatal "PUID must be a positive integer (got '${PUID}')"
    [[ "${PGID}" =~ ^[0-9]{1,10}$ ]] || fatal "PGID must be a positive integer (got '${PGID}')"
    APP_UID=$((10#${PUID}))
    APP_GID=$((10#${PGID}))
    (( APP_UID > 0 )) || fatal "PUID must not be 0: the container's own root is not an identity to run the agent as"
    (( APP_GID > 0 )) || fatal "PGID must not be 0: group 0 is root's group"
    (( APP_UID < 4294967295 )) || fatal "PUID is outside the range of uid_t (got '${PUID}')"
    (( APP_GID < 4294967295 )) || fatal "PGID is outside the range of gid_t (got '${PGID}')"
    (( APP_UID != 65534 )) || fatal "PUID must not be 65534: that is 'nobody', the identity a kernel gives to an unmapped uid — pick the uid that owns your data directory (Unraid's appdata is usually 99)"
    (( APP_GID != 65534 )) || fatal "PGID must not be 65534: that is 'nogroup' — pick the gid that owns your data directory (Unraid's appdata is usually 100)"
}

validate_umask() {
    [[ "${UMASK}" =~ ^[0-7]{3,4}$ ]] || fatal "UMASK must be an octal file mode (e.g. 022 or 002), got '${UMASK}'"
    umask "${UMASK}"
}

prepare_directory() {
    local path="$1" current="" part
    local -a parts=()
    [[ "${path}" == /* ]] || fatal "persistent paths must be absolute: ${path}"
    IFS='/' read -r -a parts <<< "${path#/}"
    for part in "${parts[@]}"; do
        [[ -n "${part}" ]] || continue
        current="${current}/${part}"
        [[ -L "${current}" ]] && fatal "${current} must not be a symbolic link"
        [[ -e "${current}" && ! -d "${current}" ]] && fatal "${current} must be a directory"
    done
    install -d -m 0750 -o "${APP_UID}" -g "${APP_GID}" "${path}"
}

# ------------------------------------------------------------------- ownership
#
# The volume handover: `$DSH_HOME`, `/home/node` and `/data/caddy` are taken over as
# PUID:PGID before anything drops privileges, because DSH runs as PUID:PGID and those are
# the paths it writes. It is the handover every NAS image does in its init step — PUID's
# only meaning — and it is idempotent by construction: a probe decides, and a path already
# owned by the pair costs one `find` and one `chown -R`. Modes and contents are never
# touched (0600 credentials, an operator's executables), and neither is anything outside
# these paths: `${volume}/plugin-backup` is a whole-node_modules backup no running process
# reads, and the workspace is passed a depth of 1 so its projects keep whatever ownership
# they have — they may belong to other services. The probe walks as deep as the handover
# rewrites: a root-owned `0600` file three levels down is exactly what broke a profile,
# and a probe that stopped short of it would miss it and hand over on every single start.
# The reasoning, and what changing PUID later implies, is in docs/extending.md.
prepare_ownership() {
    local volume="$1" label="$2" depth="${3:-}" offending report line
    local -a limits=()
    [[ -n "${depth}" ]] && limits=(-maxdepth "${depth}")

    offending="$(find "${volume}" -xdev "${limits[@]}" \
        \( -path "${volume}/plugin-backup" -o -path "${volume}/plugin-backup/*" \) -prune -o \
        \( ! -user "${APP_UID}" -o ! -group "${APP_GID}" \) -print -quit 2>/dev/null)" || true
    [[ -n "${offending}" ]] || return 0

    report="$(find "${volume}" -xdev "${limits[@]}" \
        \( -path "${volume}/plugin-backup" -o -path "${volume}/plugin-backup/*" \) -prune -o \
        \( ! -user "${APP_UID}" -o ! -group "${APP_GID}" \) -printf '%u:%g %m %p\n' 2>/dev/null | head -n 20)" || true
    while IFS= read -r line; do
        [[ -n "${line}" ]] && warn "${label}: ${line}"
    done <<< "${report}"

    if ! timeout "${REPAIR_TIMEOUT_S}" find "${volume}" -xdev "${limits[@]}" \
        \( -path "${volume}/plugin-backup" -o -path "${volume}/plugin-backup/*" \) -prune -o \
        -exec chown "${APP_UID}:${APP_GID}" -- {} + 2>/dev/null; then
        warn "${volume}: the ownership handover did not finish within ${REPAIR_TIMEOUT_S}s; some files may still be unusable by uid ${APP_UID} (it resumes at the next start)"
    else
        log "ownership of ${volume} is now ${APP_UID}:${APP_GID} (was not; PUID/PGID changed, or something wrote there as another identity)"
    fi
}

as_app_user() {
    # util-linux is always present in the base image; no gosu needed. Supplementary groups
    # are cleared rather than initialized: the identity is a uid:gid pair, not an account,
    # so there is nothing to look up — and `--init-groups` aborts for every PUID the image
    # does not ship, which is the whole point of the pair.
    setpriv --reuid "${APP_UID}" --regid "${APP_GID}" --clear-groups -- "$@"
}

# `setpriv` takes plain numbers, but the account *names* are what everything else
# resolves: a `~`, `whoami`, git's and ssh's idea of the home directory, and the shells an
# agent runs all go through the passwd database. Without an entry for PUID they land on
# `/`, which is root's, so the failure reads as a mysterious EACCES on `~/.ssh` rather
# than as a missing account. Synthesize one, keeping HOME's own path — the single home
# this image maintains however the uid is chosen, since moving it per identity would
# strand `~/.ssh` and the npm cache on every PUID change.
sync_app_account() {
    local entry
    entry="$(getent passwd "${APP_UID}" 2>/dev/null || true)"
    [[ -z "${entry}" ]] || return 0
    if ! printf 'dsh:x:%s:%s:DeepSeek Harness:%s:/bin/bash\n' "${APP_UID}" "${APP_GID}" "${HOME}" >> /etc/passwd 2>/dev/null; then
        warn "could not add a passwd entry for uid ${APP_UID} (/etc is not writable); commands that resolve a home from the account database fall back to HOME=${HOME}"
        return 0
    fi
    log "added a passwd entry for uid ${APP_UID} (home ${HOME})"
}

shutdown_children() {
    local pid
    for pid in "${CADDY_PID}" "${DSH_PID}"; do
        if [[ -n "${pid}" ]]; then
            kill -TERM "${pid}" 2>/dev/null || true
        fi
    done
    rm -f "${DSH_STARTUP_LOG}" 2>/dev/null || true
}

# The bundled Caddyfiles carry three markers. ACCESS_CONTROL is replaced by the
# rules built from ALLOWED_CLIENTS; TRUSTED_PROXIES is replaced by the Caddy
# trusted-proxy options when TRUSTED_PROXY_CIDRS is set (and removed otherwise);
# PASSWORD_GATE is replaced by the built-in password gate when AUTH_MODE=builtin
# (and removed otherwise).
render_caddyfile() {
    local source="$1" target="$2" line
    : > "${target}"
    while IFS= read -r line || [[ -n "${line}" ]]; do
        case "${line}" in
            *'# ACCESS_CONTROL'*)
                printf '%s\n' "${ACCESS_BLOCK[@]}" >> "${target}"
                ;;
            *'# TRUSTED_PROXIES'*)
                if (( ${#TRUSTED_BLOCK[@]} > 0 )); then
                    printf '%s\n' "${TRUSTED_BLOCK[@]}" >> "${target}"
                fi
                ;;
            *'# PASSWORD_GATE'*)
                if (( ${#GATE_BLOCK[@]} > 0 )); then
                    printf '%s\n' "${GATE_BLOCK[@]}" >> "${target}"
                fi
                ;;
            *)
                printf '%s\n' "${line}" >> "${target}"
                ;;
        esac
    done < "${source}"
}

# ------------------------------------------------------------ access control

# ALLOWED_CLIENTS — the only peers that may talk to this container. IP addresses
# and CIDRs are matched against the peer address, hostnames against the Host
# header. Loopback is always permitted so the bundled healthcheck keeps working
# however the list is edited.
ALLOWED_CLIENTS="${ALLOWED_CLIENTS:-127.0.0.1}"
ALLOWED_IPS=("127.0.0.1" "::1")
ALLOWED_HOSTS=()
IFS=',' read -r -a allowed_entries <<< "${ALLOWED_CLIENTS}"
for entry in "${allowed_entries[@]}"; do
    entry="$(trim "${entry}")"
    [[ -n "${entry}" ]] || continue
    if [[ "${entry}" =~ ^[0-9A-Fa-f:.]+(/[0-9]{1,3})?$ && "${entry}" =~ [0-9] ]]; then
        # skip duplicates so the generated matcher stays readable
        duplicate=0
        for seen in "${ALLOWED_IPS[@]}"; do [[ "${seen}" == "${entry}" ]] && duplicate=1; done
        (( duplicate == 1 )) || ALLOWED_IPS+=("${entry}")
    elif [[ "${entry}" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$ ]]; then
        duplicate=0
        for seen in "${ALLOWED_HOSTS[@]}"; do [[ "${seen}" == "${entry}" ]] && duplicate=1; done
        (( duplicate == 1 )) || ALLOWED_HOSTS+=("${entry}")
    else
        fatal "ALLOWED_CLIENTS entries must be IP addresses, CIDRs or hostnames (got '${entry}')"
    fi
done
(( ${#ALLOWED_IPS[@]} <= 32 )) || fatal "ALLOWED_CLIENTS lists too many addresses"
(( ${#ALLOWED_HOSTS[@]} <= 32 )) || fatal "ALLOWED_CLIENTS lists too many hostnames"

# TRUSTED_PROXY_CIDRS — optional. When a reverse proxy sits in front, list its
# addresses here and Caddy will read the real client address from
# X-Forwarded-For *only* for connections coming from those peers. Never list a
# range that untrusted clients can originate from: they could then forge XFF and
# talk their way past ALLOWED_CLIENTS.
TRUSTED_PROXY_CIDRS="${TRUSTED_PROXY_CIDRS:-}"
TRUSTED_PROXY_LIST=()
if [[ -n "${TRUSTED_PROXY_CIDRS}" ]]; then
    IFS=',' read -r -a proxy_entries <<< "${TRUSTED_PROXY_CIDRS}"
    for entry in "${proxy_entries[@]}"; do
        entry="$(trim "${entry}")"
        [[ -n "${entry}" ]] || continue
        [[ "${entry}" =~ ^[0-9A-Fa-f:.]+(/[0-9]{1,3})?$ && "${entry}" =~ [0-9] ]] \
            || fatal "TRUSTED_PROXY_CIDRS entries must be IP addresses or CIDRs (got '${entry}')"
        TRUSTED_PROXY_LIST+=("${entry}")
    done
    (( ${#TRUSTED_PROXY_LIST[@]} <= 16 )) || fatal "TRUSTED_PROXY_CIDRS lists too many entries"
fi

# ---------------------------------------------------------------- validation

# The identity first: it decides the ownership of everything below, so an unusable
# PUID/PGID stops the container before it takes anything over.
resolve_identity
validate_umask

case "${AUTH_MODE}" in
    builtin|none) ;;
    *) fatal "AUTH_MODE='${AUTH_MODE}' is not supported (use 'builtin' for the built-in password gate, or 'none' when an authenticating proxy or a trusted network is in front)" ;;
esac

# ------------------------------------------------------------- remote sign-in

case "${REMOTE_SIGNIN}" in
    on|off) ;;
    *) fatal "REMOTE_SIGNIN='${REMOTE_SIGNIN}' is not supported (use 'on' to load the remote sign-in plugin, or 'off' for upstream's loopback-only sign-in)" ;;
esac

if [[ "${REMOTE_SIGNIN}" == "on" ]]; then
    [[ -n "${REMOTE_SIGNIN_ORIGIN}" ]] || REMOTE_SIGNIN_ORIGIN="${REMOTE_SIGNIN_DEFAULT_ORIGIN}"
    if [[ ! "${REMOTE_SIGNIN_ORIGIN}" =~ ^http://(127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})$ ]]; then
        fatal "REMOTE_SIGNIN_ORIGIN must be a loopback http origin with an explicit port, e.g. ${REMOTE_SIGNIN_DEFAULT_ORIGIN} (got '${REMOTE_SIGNIN_ORIGIN}')"
    fi
    remote_signin_port="${BASH_REMATCH[2]}"
    (( 10#${remote_signin_port} >= 1 && 10#${remote_signin_port} <= 65535 )) \
        || fatal "REMOTE_SIGNIN_ORIGIN has an out-of-range port: ${REMOTE_SIGNIN_ORIGIN}"

    # The plugin is optional by construction: a missing or unreadable one must never be
    # the reason an agent will not start, so every problem here only disables the feature
    # (loudly) and leaves upstream's behaviour in place.
    if [[ ! -r "${REMOTE_SIGNIN_PATCH}" || ! -r "${REMOTE_SIGNIN_MODULE}" ]]; then
        warn "REMOTE_SIGNIN=on but the dsh-remote-signin plugin is not installed at ${REMOTE_SIGNIN_DIR}; account sign-in stays loopback-only"
    elif ! node --check "${REMOTE_SIGNIN_MODULE}" >/dev/null 2>&1; then
        warn "the dsh-remote-signin plugin does not parse; account sign-in stays loopback-only"
    else
        REMOTE_SIGNIN_ACTIVE=1
    fi
fi

validate_port PORT "${PORT}"
validate_port DSH_INTERNAL_PORT "${DSH_INTERNAL_PORT}"
PORT=$((10#${PORT}))
DSH_INTERNAL_PORT=$((10#${DSH_INTERNAL_PORT}))
(( PORT != DSH_INTERNAL_PORT )) || fatal "PORT and DSH_INTERNAL_PORT must differ"

if [[ -n "${PUBLIC_URL}" ]]; then
    parsed="$(node -e '
      const raw = process.argv[1];
      let url;
      try { url = new URL(raw); } catch { process.exit(2); }
      if (!["http:", "https:"].includes(url.protocol)) process.exit(3);
      if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) process.exit(4);
      process.stdout.write(url.origin + "\n" + url.host + "\n");
    ' "${PUBLIC_URL}")" || fatal "PUBLIC_URL must be an http(s) origin without credentials, path, query, or fragment (got '${PUBLIC_URL}')"
    PUBLIC_ORIGIN="$(sed -n '1p' <<< "${parsed}")"
    DSH_UPSTREAM_HOST="$(sed -n '2p' <<< "${parsed}")"
    [[ -n "${DSH_UPSTREAM_HOST}" ]] || fatal "PUBLIC_URL has no authority"
    if [[ "${PUBLIC_ORIGIN}" == http://* ]]; then
        warn "PUBLIC_URL is plain HTTP; use HTTPS at the edge before exposing this to an untrusted network"
    fi
fi

if [[ -n "${DSH_TRUSTED_HOSTS}" ]]; then
    IFS=',' read -r -a raw_hosts <<< "${DSH_TRUSTED_HOSTS}"
    for host in "${raw_hosts[@]}"; do
        host="$(trim "${host}")"
        [[ -n "${host}" ]] || continue
        [[ "${host}" =~ ^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(:([0-9]{1,5}))?$ ]] \
            || fatal "DSH_TRUSTED_HOSTS entries must be bare host[:port] authorities (got '${host}')"
        port="${BASH_REMATCH[3]:-}"
        if [[ -n "${port}" ]] && (( 10#${port} < 1 || 10#${port} > 65535 )); then
            fatal "DSH_TRUSTED_HOSTS entry has an out-of-range port: ${host}"
        fi
        EXTRA_TRUSTED_HOSTS+=("${host}")
    done
    if [[ -z "${PUBLIC_URL}" ]]; then
        warn "DSH_TRUSTED_HOSTS is ignored without PUBLIC_URL: in lan mode the Host presented to DSH is loopback"
        EXTRA_TRUSTED_HOSTS=()
    fi
fi

# ------------------------------------------------------------------ preparation

prepare_directory /data
prepare_directory "${DSH_HOME}"
prepare_directory "${DSH_AGENTS_HOME}"
prepare_directory "${DSH_WORKSPACE}"
prepare_directory "${CADDY_CONFIG_HOME}"
prepare_directory "${CADDY_DATA_HOME}"

# --------------------------------------------------------- operator CLI tools

# A tool an operator installs belongs on the persistent volume: the layered
# filesystem — and with it anything `npm i -g` wrote — is thrown away when the
# container is recreated. These two layouts are picked up and put on PATH for the
# DSH process, and therefore for everything DSH spawns: the commands the agent runs,
# and any plugin that shells out to a CLI.
#
#   ${DSH_HOME}/bin                             plain executables: drop or symlink
#   ${DSH_HOME}/tools/<name>/node_modules/.bin  what `npm i --prefix` leaves behind
#
# Generic on purpose: the image bakes in no tool and installs nothing at boot, so an
# operator who installs nothing sees no difference at all. Appended, never
# prepended — a tool dropped in here must not be able to shadow the image's own
# node/git/curl. Note that `docker exec` runs with the container's *configured*
# environment and so never sees this PATH; call those tools by absolute path there.
OPERATOR_TOOL_PATH=()
for operator_tool_dir in "${DSH_HOME}/bin" "${DSH_HOME}"/tools/*/node_modules/.bin; do
    [[ -d "${operator_tool_dir}" ]] && OPERATOR_TOOL_PATH+=("${operator_tool_dir}")
done
if (( ${#OPERATOR_TOOL_PATH[@]} > 0 )); then
    operator_tool_path="$(IFS=:; printf '%s' "${OPERATOR_TOOL_PATH[*]}")"
    PATH="${PATH}:${operator_tool_path}"
    export PATH
    log "operator tools on PATH: ${operator_tool_path}"
fi

# ------------------------------------------------------------- password gate

# AUTH_MODE=builtin serves a gate of our own: a fresh install must not be usable
# by everyone who can reach the port. The password is asked for once through HTTP
# basic auth, and that successful check mints a cookie whose value is an HMAC of
# the password and a per-install salt. The cookie then carries the session for
# ordinary requests *and* for the client's WebSocket handshake: browsers do not
# reliably attach cached HTTP credentials to a WebSocket upgrade, which is why the
# gate is not "basic auth on every request".
#
# Changing the password (or deleting the salt file) invalidates every issued cookie.
GATE_BLOCK=()
if [[ "${AUTH_MODE}" == "builtin" ]]; then
    password=""
    password_source=""
    if [[ -n "${DSH_PASSWORD_FILE}" ]]; then
        [[ -r "${DSH_PASSWORD_FILE}" ]] || fatal "DSH_PASSWORD_FILE is not readable: ${DSH_PASSWORD_FILE} (a mounted secret is often root-only, and this container reads it as uid ${APP_UID} — make it readable to PUID, or use DSH_PASSWORD instead)"
        # $(<file) already drops trailing newlines
        password="$(<"${DSH_PASSWORD_FILE}")"
        password_source="DSH_PASSWORD_FILE"
    elif [[ -n "${DSH_PASSWORD}" ]]; then
        password="${DSH_PASSWORD}"
        password_source="DSH_PASSWORD"
    else
        fatal "AUTH_MODE=builtin requires a password: set DSH_PASSWORD or DSH_PASSWORD_FILE, or set AUTH_MODE=none when an authenticating proxy is in front"
    fi
    (( ${#password} >= 8 )) || fatal "the password must be at least 8 characters (got ${#password}); set DSH_PASSWORD or DSH_PASSWORD_FILE"
    [[ ! "${password}" =~ [[:space:]] ]] || fatal "the password must not contain whitespace"
# The user name ends up as a token in the Caddyfile (user hash) and is shown in the
# browser's login prompt, so keep it to something that cannot break the directive.
[[ "${AUTH_USER}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
    || fatal "AUTH_USER (the gate's user name) must match [A-Za-z0-9][A-Za-z0-9._-]* — got '${AUTH_USER}'"

    salt_file="${CADDY_DATA_HOME}/auth-gate-salt"
    if [[ ! -s "${salt_file}" ]]; then
        node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))' > "${salt_file}"
        chmod 0600 "${salt_file}"
    fi
    gate_secret="$(node -e '
      const { createHmac } = require("node:crypto");
      const fs = require("node:fs");
      const salt = fs.readFileSync(process.argv[1], "utf8").trim();
      process.stdout.write(createHmac("sha256", salt).update(process.argv[2]).digest("base64url"));
    ' "${salt_file}" "${password}")"

    password_hash="$(caddy hash-password --plaintext "${password}")" \
        || fatal "could not hash the password (caddy hash-password failed)"

    secure_flag=""
    [[ "${PUBLIC_URL}" == https://* ]] && secure_flag="; Secure"

    GATE_BLOCK=(
        '	# --- password gate (AUTH_MODE=builtin; rendered by the entrypoint) ---'
        '	# /healthz stays open so the container healthcheck keeps working.'
        '	@dsh_gate_needed {'
        '		not path /healthz'
        "		not header Cookie *${AUTH_COOKIE_NAME}=${gate_secret}*"
        '	}'
        '	route @dsh_gate_needed {'
        '		basic_auth {'
        "			${AUTH_USER} ${password_hash}"
        '		}'
        "		header Set-Cookie \"${AUTH_COOKIE_NAME}=${gate_secret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${AUTH_COOKIE_MAX_AGE}${secure_flag}\""
        '	}'
    )

    log "authentication: built-in password gate, user '${AUTH_USER}' (password from ${password_source})"
    if [[ "${password}" == "${DEFAULT_TEMPLATE_PASSWORD}" ]]; then
        warn "SECURITY: 口令仍是默认值 '${DEFAULT_TEMPLATE_PASSWORD}'（公开值）。任何能访问本端口的人都能操作你的智能体：在 ${DSH_WORKSPACE} 里执行命令、读取 ${DSH_HOME} 里的凭据。请在容器设置里改 Password / DSH_PASSWORD（用户名是 '${AUTH_USER}'）。"
        warn "SECURITY: the password is still the default '${DEFAULT_TEMPLATE_PASSWORD}', which is public. Anybody who can reach this port can drive the agent: run commands in ${DSH_WORKSPACE}, read the credentials in ${DSH_HOME}. Change the Password setting (DSH_PASSWORD) in the container settings (user name: '${AUTH_USER}')."
    fi
    [[ -z "${PUBLIC_URL}" ]] || warn "AUTH_MODE=builtin with PUBLIC_URL set: if the proxy in front already authenticates, set AUTH_MODE=none to avoid a second login"
    unset password password_hash
elif [[ -n "${PUBLIC_URL}" ]]; then
    log "authentication: none — delegated to the proxy in front (AUTH_MODE=none)"
else
    warn "AUTH_MODE=none: anybody who can reach this port can drive the agent (with access to the mounted workspace and stored credentials). Use it only on a trusted network or behind an authenticating proxy."
fi

# HOME must be readable and writable by the account we drop to. The base image
# leaves it at /root, which uid 1000 cannot even list, and DSH surfaces that as a
# bewildering failure deep inside the UI ("cannot list /root: EACCES") when a file
# or workspace picker opens. The image sets HOME correctly; this repairs the case
# anyway, because an unwritable HOME stays silent until something opens a picker,
# and a forked or re-based build should not have to rediscover it.
if [[ ! -d "${HOME}" || ! -w "${HOME}" ]]; then
    fallback_home="/home/node"
    # Best effort, and never fatal: with errexit on, an unguarded install would turn
    # "the picker cannot list ~" into "the container refuses to start" on a read-only
    # root filesystem. Only switch when the fallback is genuinely usable.
    install -d -o "${APP_UID}" -g "${APP_GID}" -m 0755 "${fallback_home}" 2>/dev/null || true
    if [[ -w "${fallback_home}" ]]; then
        warn "HOME='${HOME}' is not writable by uid ${APP_UID}; using ${fallback_home} instead"
        export HOME="${fallback_home}"
    else
        warn "HOME='${HOME}' is not writable by uid ${APP_UID} and ${fallback_home} is unavailable; leaving HOME unchanged"
    fi
fi

if ! awk '$5 == "/data" { found = 1 } END { exit found ? 0 : 1 }' /proc/self/mountinfo; then
    warn "/data is not a mount point: sessions, credentials and the agent home will be lost when this container is recreated"
fi

# The identity made real: an account to resolve, and the writable paths taken over.
# Both are no-ops once they have happened — an entry already in passwd, a path already
# owned by PUID:PGID — so a restart costs a `getent` and a `find` per path.
sync_app_account
prepare_ownership "${DSH_HOME}" "${DSH_HOME}"
prepare_ownership /home/node "/home/node"
# Caddy's own state: the rendered Caddyfile, the gate's salt and its data directory. The
# entrypoint creates them, so they are root's until this runs — and everything after it
# runs as PUID.
prepare_ownership "${CADDY_CONFIG_HOME%/config}" "${CADDY_CONFIG_HOME%/config}"
prepare_ownership "${DSH_WORKSPACE}" "${DSH_WORKSPACE} (top level only)" 1

DSH_VERSION="$(read_image_version || true)"

if [[ -n "${PUBLIC_URL}" ]]; then
    CADDY_CONFIG="${CADDY_DIR}/Caddyfile.edge"
    MODE="edge"
else
    CADDY_CONFIG="${CADDY_DIR}/Caddyfile.lan"
    MODE="lan"
    warn "PUBLIC_URL is empty: running in lan mode (loopback Host, Origin stripped). Set PUBLIC_URL=https://dsh.example.com when a reverse proxy fronts this container"
fi

# Build the access-control rules and render the final Caddyfile from the bundled
# template (the markers are documented in docker/Caddyfile.*).
ACCESS_BLOCK=(
    "	# generated from ALLOWED_CLIENTS=${ALLOWED_CLIENTS}"
    "	handle {"
    "		@clients_denied not remote_ip ${ALLOWED_IPS[*]}"
    '		respond @clients_denied "403 Forbidden: this client is not listed in ALLOWED_CLIENTS" 403'
)
if (( ${#ALLOWED_HOSTS[@]} > 0 )); then
    ACCESS_BLOCK+=(
        "		@host_denied not host ${ALLOWED_HOSTS[*]}"
        '		respond @host_denied "403 Forbidden: this Host is not listed in ALLOWED_CLIENTS" 403'
    )
fi
# The rules must live inside a handle block. Measured behaviour of the bundled
# Caddyfiles: a bare `respond` at site level is ordered after `route`, and a
# matcher-less `route` loses to the `route /healthz` that follows it, so both
# spellings let a foreign client straight through to /healthz (200). A `handle`
# block is evaluated first, and because its handlers only fire for denied
# clients, permitted requests fall through to the real routes untouched.
ACCESS_BLOCK+=("	}")

TRUSTED_BLOCK=()
if (( ${#TRUSTED_PROXY_LIST[@]} > 0 )); then
    TRUSTED_BLOCK+=(
        "	servers {"
        "		trusted_proxies static ${TRUSTED_PROXY_LIST[*]}"
        "		client_ip_headers X-Forwarded-For X-Real-IP"
        "	}"
    )
fi

CADDY_TEMPLATE="${CADDY_CONFIG}"
CADDY_CONFIG="${CADDY_CONFIG_HOME}/Caddyfile"
if ! render_caddyfile "${CADDY_TEMPLATE}" "${CADDY_CONFIG}"; then
    fatal "could not render ${CADDY_CONFIG} from ${CADDY_TEMPLATE}"
fi
log "access control: clients ${ALLOWED_IPS[*]}${ALLOWED_HOSTS[0]:+ ; hosts ${ALLOWED_HOSTS[*]}}${TRUSTED_PROXY_LIST[0]:+ ; trusting XFF from ${TRUSTED_PROXY_LIST[*]}}"

trap shutdown_children TERM INT

# ------------------------------------------------------------------ dsh web

# Launcher flags (`--profile`, `--patch`) come first on purpose: the dsh launcher
# takes everything after the first token it does not recognise as the booted app's
# own arguments, so the app flags have to follow the profile selection.
DSH_ARGS=(--profile web)
if (( REMOTE_SIGNIN_ACTIVE == 1 )); then
    DSH_ARGS+=(--patch "${REMOTE_SIGNIN_PATCH}")
fi
DSH_ARGS+=(--host 127.0.0.1 --port "${DSH_INTERNAL_PORT}" --no-open)
if [[ -n "${DSH_UPSTREAM_HOST}" ]]; then
    DSH_ARGS+=(--public-url "${PUBLIC_ORIGIN}" --trusted-host "${DSH_UPSTREAM_HOST}")
    for host in "${EXTRA_TRUSTED_HOSTS[@]}"; do
        DSH_ARGS+=(--trusted-host "${host}")
    done
fi

: > "${DSH_STARTUP_LOG}"
log "starting DeepSeek Harness ${DSH_VERSION:-unknown} on 127.0.0.1:${DSH_INTERNAL_PORT} (mode=${MODE})"
if (( REMOTE_SIGNIN_ACTIVE == 1 )); then
    # The plugin puts the paste box into the DSH page by itself, so there is no address
    # to name here — only what to expect. The plugin's own "active" line, printed by
    # DSH, names the claim and the version it loaded.
    log "remote sign-in: on — a remote browser finishes the sign-in in the DSH page: when the login tab lands on the dead ${REMOTE_SIGNIN_ORIGIN} page, a panel appears there to paste its address into"
else
    log "remote sign-in: off — account sign-in needs a browser on this machine (or an ssh -L tunnel); an API key works from anywhere"
fi
(
    umask "${UMASK}"
    cd "${DSH_WORKSPACE}"
    exec setpriv --reuid "${APP_UID}" --regid "${APP_GID}" --clear-groups -- dsh "${DSH_ARGS[@]}"
) > >(tee "${DSH_STARTUP_LOG}") 2>&1 &
DSH_PID=$!

wait_for_dsh() {
    local status
    for _ in $(seq 1 60); do
        if ! kill -0 "${DSH_PID}" 2>/dev/null; then
            wait "${DSH_PID}" || true
            fatal "DeepSeek Harness exited before it became ready; see the log above"
        fi
        status="$(curl --silent --max-time 2 --output /dev/null --write-out '%{http_code}' \
            "http://127.0.0.1:${DSH_INTERNAL_PORT}/" 2>/dev/null || true)"
        [[ "${status}" =~ ^[1-4][0-9]{2}$ ]] && return 0
        sleep 1
    done
    fatal "DeepSeek Harness did not become ready within 60 seconds"
}

resolve_launch_token() {
    local line
    for _ in $(seq 1 60); do
        while IFS= read -r line; do
            if [[ "${line}" =~ ^dsh\ web:.*token=([A-Za-z0-9_.-]{16,512}) ]]; then
                DSH_LAUNCH_TOKEN="${BASH_REMATCH[1]}"
                return 0
            fi
            if [[ "${line}" == "dsh web: http://127.0.0.1:${DSH_INTERNAL_PORT}" ]]; then
                # Releases before the browser launch-token flow print the plain
                # local URL; Caddy is then a pure passthrough.
                DSH_LAUNCH_TOKEN=""
                return 0
            fi
        done < "${DSH_STARTUP_LOG}"
        kill -0 "${DSH_PID}" 2>/dev/null || fatal "DeepSeek Harness exited without publishing a launch token"
        sleep 1
    done
    printf '[entrypoint] no launch token found; last lines of the DSH startup log:\n' >&2
    tail -n 40 "${DSH_STARTUP_LOG}" >&2 || true
    fatal "DeepSeek Harness did not publish a launch token within 60 seconds"
}

wait_for_dsh
resolve_launch_token

if [[ -z "${DSH_UPSTREAM_HOST}" ]]; then
    DSH_UPSTREAM_HOST="127.0.0.1:${DSH_INTERNAL_PORT}"
fi

export PORT DSH_INTERNAL_PORT PUBLIC_URL PUBLIC_ORIGIN DSH_UPSTREAM_HOST DSH_LAUNCH_TOKEN MODE REMOTE_SIGNIN_ORIGIN

# ------------------------------------------------------------------ caddy

as_app_user env XDG_CONFIG_HOME="${CADDY_CONFIG_HOME}" XDG_DATA_HOME="${CADDY_DATA_HOME}" \
    caddy validate --config "${CADDY_CONFIG}" --adapter caddyfile \
    || fatal "the bundled Caddy configuration failed validation: ${CADDY_CONFIG}"

log "starting Caddy on 0.0.0.0:${PORT} (auth=${AUTH_MODE})"
as_app_user env XDG_CONFIG_HOME="${CADDY_CONFIG_HOME}" XDG_DATA_HOME="${CADDY_DATA_HOME}" \
    caddy run --config "${CADDY_CONFIG}" --adapter caddyfile &
CADDY_PID=$!

set +e
wait -n "${DSH_PID}" "${CADDY_PID}"
status=$?
set -e

log "a supervised process exited with status ${status}; shutting down"
shutdown_children
wait "${DSH_PID}" 2>/dev/null || true
wait "${CADDY_PID}" 2>/dev/null || true
exit "${status}"

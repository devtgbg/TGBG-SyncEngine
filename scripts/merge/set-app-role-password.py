"""
Give an application role a login password and hand the connection string to the application.

    python scripts/merge/set-app-role-password.py portal_app d474sjhh2no9xu6h93gwotbr
    python scripts/merge/set-app-role-password.py amc_app sti1wkudfqfsvk2s98sqn9df

The password is generated here, set through psql's stdin (never on a command line, never in a
file), and stored only in the Coolify application's environment as SUPABASE_DATABASE_URL —
runtime-only, not a build variable. Nothing secret is printed. Running it again rotates the
password; every application holding the old value must be updated the same way.

The URL uses the database container's name, which resolves once the application is attached
to the Supabase Docker network (docs/DATABASE-MERGE.md, "Getting there on the network").
"""

import json
import secrets
import subprocess
import sys
import urllib.error
import urllib.request

ROLE, *APPS = sys.argv[1:]
assert ROLE in ("portal_app", "amc_app"), "role must be portal_app or amc_app"
assert APPS, "name at least one Coolify application uuid"

HOST = "supabase-db-x123f7phha4w5nas4dtq2k50"
ENV_KEY = "SUPABASE_DATABASE_URL"
password = secrets.token_urlsafe(32)          # URL-safe: no escaping needed in the URL

# 1. The role.
sql = f"ALTER ROLE {ROLE} WITH LOGIN PASSWORD '{password}';\n"
done = subprocess.run(
    ["ssh", "-o", "ServerAliveInterval=15", "tgbgaws",
     "docker exec -i supabase-db-x123f7phha4w5nas4dtq2k50 psql -v ON_ERROR_STOP=1 -U supabase_admin -d postgres -q"],
    input=sql, text=True, capture_output=True,
)
if done.returncode != 0:
    sys.exit("could not set the password: " + done.stderr.replace(password, "***")[:300])
print(f"{ROLE}: LOGIN enabled, password set")

# 2. The applications.
cfg = {}
for line in open(r"C:\Projects\command-centers\tgbgaws-command-center\.env", encoding="utf-8"):
    if "=" in line and not line.lstrip().startswith("#"):
        k, v = line.split("=", 1)
        cfg[k.strip()] = v.strip().strip('"').strip("'")
API = cfg["COOLIFY_API_URL"].rstrip("/")
HEADERS = {"Authorization": "Bearer " + cfg["COOLIFY_API_TOKEN"], "Content-Type": "application/json"}


def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, headers=HEADERS,
                                 data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]


url = f"postgres://{ROLE}:{password}@{HOST}:5432/postgres?sslmode=disable"
for app in APPS:
    status, envs = call("GET", f"/applications/{app}/envs")
    exists = any(e["key"] == ENV_KEY and not e.get("is_preview") for e in (envs or []))
    body = {"key": ENV_KEY, "value": url, "is_preview": False, "is_buildtime": False, "is_runtime": True}
    status, _ = call("PATCH" if exists else "POST", f"/applications/{app}/envs", body)
    print(f"{app}: {ENV_KEY} {'updated' if exists else 'added'} (HTTP {status}); takes effect on the next deploy")

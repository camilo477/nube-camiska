#!/usr/bin/env bash
set -euo pipefail
umask 077

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
env_file=${NUBE_ENV_FILE:-"$HOME/.nube-camiska.env"}
mount_point=${NUBE_MOUNT_POINT:-/mnt/disco}
personal_dir=${NUBE_PERSONAL_DIR:-"$mount_point/nube"}
boot_dir=${NUBE_BOOT_DIR:-"$HOME/.local/share/nube-camiska"}
state_dir="$boot_dir/state"
demo_dir="$boot_dir/demo"
unavailable_dir="$boot_dir/unavailable-disk"

if [[ ! -f "$env_file" ]]; then
  echo "No existe el archivo de configuración: $env_file" >&2
  exit 1
fi
mkdir -p "$state_dir" "$demo_dir" "$unavailable_dir"
chmod 700 "$boot_dir" "$state_dir" "$demo_dir" "$unavailable_dir"
disk_mounted=false
disk_source=$(findmnt -n -o SOURCE --mountpoint "$mount_point" 2>/dev/null || true)
if mountpoint -q "$mount_point" && [[ -b "$disk_source" ]]; then disk_mounted=true; fi

# Migrate only small session/ownership metadata. Personal files are never copied
# to the boot card. A missing or unreadable disk is replaced by an EMPTY bind;
# the server's ownership-marker check rejects all private storage operations.
python3 - "$env_file" "$personal_dir" "$state_dir" "$disk_mounted" <<'PY'
import json, os, pathlib, sys
env_file, personal, state, mounted = sys.argv[1:]
personal, state = pathlib.Path(personal), pathlib.Path(state)
values = {}
for line in pathlib.Path(env_file).read_text().splitlines():
    if line.strip() and not line.lstrip().startswith("#") and "=" in line:
        key, value = line.split("=", 1)
        values[key.strip()] = value
users = json.loads(values.get("CLOUD_USERS_JSON") or "[]")
owner = values.get("CLOUD_LEGACY_USER") or values.get("CLOUD_USER") or next((user["username"] for user in users if user.get("role", "admin") == "admin"), None)
if not owner: raise SystemExit("Configura CLOUD_LEGACY_USER antes de desplegar.")
cached = state / ".accounts-layout.json"
marker = personal / ".accounts-layout.json"
layout = json.loads(cached.read_text()) if cached.exists() else None
disk_layout = None
ready = mounted == "true"
if ready:
    try:
        disk_layout = json.loads(marker.read_text())
    except FileNotFoundError:
        try:
            personal.mkdir(parents=True, exist_ok=True)
            disk_layout = layout or {"version": 1, "legacyOwner": owner}
            with marker.open("x") as target: json.dump(disk_layout, target)
        except OSError: ready = False
    except (OSError, ValueError): ready = False
if layout is None:
    layout = disk_layout if ready else {"version": 1, "legacyOwner": owner}
    with cached.open("x") as target: json.dump(layout, target)
if layout.get("version") != 1 or not isinstance(layout.get("legacyOwner"), str):
    raise SystemExit("La distribución de cuentas de la tarjeta no es válida.")
ready = ready and disk_layout == layout
session_file = state / ".security.json"
copied = False
if ready and not session_file.exists():
    try:
        original = (personal / ".security.json").read_bytes()
        parsed = json.loads(original)
        if not isinstance(parsed, dict): raise ValueError("invalid session state")
        with session_file.open("xb") as target: target.write(original)
        copied = True
    except (OSError, ValueError): pass
(state / ".personal-storage-ready").write_text("true" if ready else "false")
print(json.dumps({"personalDiskAvailable": bool(ready), "sessionsCopiedToBootCard": copied}))
PY

data_source="$unavailable_dir"
if [[ $(cat "$state_dir/.personal-storage-ready") == true ]]; then data_source="$personal_dir"; fi
cd "$repo_dir"
docker build -t nube-camiska:pending .

previous_stopped=false
previous_renamed=false
new_created=false
completed=false
rollback() {
  result=$?
  trap - EXIT
  if [[ $completed != true ]]; then
    if [[ $new_created == true ]]; then docker rm -f nube-camiska >/dev/null 2>&1 || true; fi
    if [[ $previous_renamed == true ]]; then docker rename nube-camiska-anterior nube-camiska || true; fi
    if [[ $previous_stopped == true ]]; then docker start nube-camiska || true; fi
  fi
  exit "$result"
}
trap rollback EXIT
if docker container inspect nube-camiska-anterior >/dev/null 2>&1; then
  if [[ $(docker inspect -f '{{.State.Running}}' nube-camiska-anterior) == true ]]; then
    echo "El contenedor anterior está funcionando; no se reemplazará." >&2
    exit 1
  fi
  docker rm nube-camiska-anterior >/dev/null
fi
if docker container inspect nube-camiska >/dev/null 2>&1; then
  docker stop nube-camiska >/dev/null
  previous_stopped=true
  docker rename nube-camiska nube-camiska-anterior
  previous_renamed=true
fi
docker run -d --name nube-camiska --restart unless-stopped \
  -p 3002:8080 --env-file "$env_file" \
  -e CLOUD_STORAGE_DIR=/data -e CLOUD_STATE_DIR=/state -e CLOUD_DEMO_STORAGE_DIR=/demo \
  --mount "type=bind,src=$data_source,dst=/data" \
  --mount "type=bind,src=$state_dir,dst=/state" \
  --mount "type=bind,src=$demo_dir,dst=/demo" \
  nube-camiska:pending
new_created=true
for attempt in {1..15}; do
  if curl --fail --silent --max-time 3 http://127.0.0.1:3002/api/config >/dev/null; then
    docker tag nube-camiska:pending nube-camiska:latest
    completed=true
    echo "Nube actualizada. Demo y sesiones pequeñas en $boot_dir."
    if [[ $data_source == "$unavailable_dir" ]]; then
      echo "El disco personal no está disponible; la demo funciona y el acceso a los archivos personales permanece bloqueado."
    fi
    exit 0
  fi
  sleep 1
done
echo "Nube no respondió; se restaurará el contenedor anterior." >&2
exit 1

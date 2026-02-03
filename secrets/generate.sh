#!/usr/bin/env sh
set -eu
DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
mkdir -p "$DIR"

rand() {
  # 64 chars hex
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

write_if_missing() {
  f="$1"
  if [ -f "$DIR/$f" ] && [ -s "$DIR/$f" ]; then
    echo "[OK] exists: $f"
    return 0
  fi
  rand > "$DIR/$f"
  echo "[NEW] created: $f"
}

write_if_missing postgres_password.txt
write_if_missing jwt_secret.txt
write_if_missing refresh_pepper.txt

# optional: SMTP pass can be empty; create file if missing
if [ ! -f "$DIR/smtp_pass.txt" ]; then
  : > "$DIR/smtp_pass.txt"
  echo "[NEW] created: smtp_pass.txt (empty)"
else
  echo "[OK] exists: smtp_pass.txt"
fi

echo "\nDone. Mount these via docker compose secrets."

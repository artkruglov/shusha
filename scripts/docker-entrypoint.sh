#!/bin/sh
set -eu

# Fail before migrations or network listeners when required runtime configuration is absent.
for name in AGENT_INTERNAL_TOKEN DATABASE_URL INVITATION_SIGNING_SECRET MODEL_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET_TOKEN TELEGRAM_BOT_USERNAME; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    printf '%s\n' "AGENT_REQUIRED_CONFIG_MISSING: Не задана обязательная настройка $name" >&2
    exit 1
  fi
done

# Invitation codes require a dedicated high-entropy signing secret for replay-safe derivation.
INVITATION_SIGNING_SECRET_MIN_LENGTH=32
if [ "${#INVITATION_SIGNING_SECRET}" -lt "$INVITATION_SIGNING_SECRET_MIN_LENGTH" ]; then
  printf '%s\n' "AGENT_INVITATION_CONFIG_MISSING: INVITATION_SIGNING_SECRET должен содержать минимум 32 символа" >&2
  exit 1
fi

# Both tokens are as long as the invitation secret, within what Telegram accepts for secret_token
# (1-256 of A-Z, a-z, 0-9, `_`, `-`). Telegram holds the webhook secret, so the drain route, the
# approval sweep and the workflow flow route take a different internal token.
is_strong_token() {
  case "$1" in
    *[!A-Za-z0-9_-]*) return 1 ;;
    *) [ "${#1}" -ge 32 ] && [ "${#1}" -le 256 ] ;;
  esac
}
if ! is_strong_token "$TELEGRAM_WEBHOOK_SECRET_TOKEN"; then
  printf '%s\n' "AGENT_TELEGRAM_WEBHOOK_SECRET_WEAK: TELEGRAM_WEBHOOK_SECRET_TOKEN должен содержать от 32 до 256 символов A-Z, a-z, 0-9, _ или -" >&2
  exit 1
fi
if ! is_strong_token "$AGENT_INTERNAL_TOKEN" || [ "$AGENT_INTERNAL_TOKEN" = "$TELEGRAM_WEBHOOK_SECRET_TOKEN" ]; then
  printf '%s\n' "AGENT_INTERNAL_TOKEN_WEAK: AGENT_INTERNAL_TOKEN должен содержать от 32 до 256 символов A-Z, a-z, 0-9, _ или - и отличаться от TELEGRAM_WEBHOOK_SECRET_TOKEN" >&2
  exit 1
fi

# Validate model IDs and context metadata before Eve opens a listener or accepts durable work.
node .runtime/scripts/validate-model-provider-config.js

# A compose run command is an explicit operator action and must terminate normally.
if [ "$#" -eq 1 ] && [ "$1" = "start-after-migration" ]; then
  exec npm run start -- --host 0.0.0.0 --port 3000
fi
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

# Production images contain the emitted migration runner, not TypeScript source files.
node .runtime/scripts/migrate.js
exec npm run start -- --host 0.0.0.0 --port 3000

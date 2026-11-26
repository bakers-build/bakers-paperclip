#!/bin/sh
# Seeds the local bakers.build and writes the PM agent's new service-account key and the Demo
# group's webhook secret into .env.
# Run from the repository root after `docker compose --profile bakers up -d`: pnpm bakers:seed
set -eu
out=$(docker compose exec -T bakers-php /var/www/html/vendor/bin/drush php:eval "$(tail -n +2 scripts/bakers-seed.php)")
value() { printf '%s\n' "$out" | sed -n "s/^$1=//p" | tail -1; }
key=$(value BAKERS_E2E_API_KEY)
secret=$(value BAKERS_E2E_WEBHOOK_SECRET)
[ -n "$key" ] && [ -n "$secret" ] || { printf '%s\n' "$out" >&2; echo "bakers-seed: no key or webhook secret" >&2; exit 1; }
touch .env
grep -v -e '^BAKERS_E2E_API_KEY=' -e '^BAKERS_E2E_WEBHOOK_SECRET=' .env > .env.tmp || true
printf 'BAKERS_E2E_API_KEY=%s\nBAKERS_E2E_WEBHOOK_SECRET=%s\n' "$key" "$secret" >> .env.tmp
mv .env.tmp .env
echo "bakers-seed: seeded; BAKERS_E2E_API_KEY and BAKERS_E2E_WEBHOOK_SECRET written to .env"

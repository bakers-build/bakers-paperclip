#!/bin/sh
# Seeds the local bakers.build and writes the PM agent's new service-account key into .env.
# Run from the repository root after `docker compose --profile bakers up -d`: pnpm bakers:seed
set -eu
out=$(docker compose exec -T bakers-php /var/www/html/vendor/bin/drush php:eval "$(tail -n +2 scripts/bakers-seed.php)")
key=$(printf '%s\n' "$out" | sed -n 's/^BAKERS_E2E_API_KEY=//p' | tail -1)
[ -n "$key" ] || { printf '%s\n' "$out" >&2; echo "bakers-seed: no key issued" >&2; exit 1; }
touch .env
grep -v '^BAKERS_E2E_API_KEY=' .env > .env.tmp || true
echo "BAKERS_E2E_API_KEY=$key" >> .env.tmp
mv .env.tmp .env
echo "bakers-seed: seeded; BAKERS_E2E_API_KEY written to .env"

#!/bin/sh
# Builds agent/plugin/ (gitignored) from pinned public sources, as hermes-bot's Dockerfile did:
# bb-create-ticket and both recipes with every bundle file their links reach, plus the
# recipes' method skills unchanged. Run from the repository root: pnpm skills
set -eu
BAKERS=a1604421ab259e7d70ead776e03a7773a16a961a      # bakers-build/bakers-build, branch next
SUPERPOWERS=bb92a77741419a4ab5f06e711a283343f1ada0c3 # obra/superpowers v7.0.0
MATTPOCOCK=d1478fcb140db0b93c0c8df17bcfd311844749d0  # mattpocock/skills v1.3.2

src=$(mktemp -d)
trap 'rm -rf "$src"' EXIT
fetch() {
  git init -q "$src/$1"
  git -C "$src/$1" fetch -q --depth 1 "https://github.com/$2.git" "$3"
  git -C "$src/$1" checkout -q FETCH_HEAD
}
fetch bakers bakers-build/bakers-build "$BAKERS"
fetch superpowers obra/superpowers "$SUPERPOWERS"
fetch mattpocock mattpocock/skills "$MATTPOCOCK"

# A Claude plugin the agent's CLI loads with --plugin-dir: .claude-plugin/plugin.json and skills/.
plugin=agent/plugin
out=$plugin/skills
rm -rf "$plugin"
node scripts/collect-skills.mjs "$src/bakers/.claude/skills/bakers-build" "$out" bb-create-ticket bb-recipe-superpowers bb-recipe-matt
mv "$out/.claude-plugin" "$plugin/"
cp -R "$src/superpowers/skills/brainstorming" "$src/superpowers/skills/writing-plans" "$out/"
cp -R "$src/mattpocock/skills/productivity/grilling" "$out/"
mkdir -p "$plugin/LICENSES"
cp "$src/superpowers/LICENSE" "$plugin/LICENSES/superpowers"
cp "$src/mattpocock/LICENSE" "$plugin/LICENSES/mattpocock"
echo "agent/plugin/skills: $(ls "$out" | tr '\n' ' ')"

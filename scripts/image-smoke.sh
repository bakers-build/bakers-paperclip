#!/bin/sh
# Checks a built bakers-paperclip image holds what the PM agent and the bridge load at runtime.
#   sh scripts/image-smoke.sh <image>
set -eu
docker run --rm --entrypoint sh "$1" -c '
  set -e
  cd /opt/bakers-paperclip
  for f in node_modules/@modelcontextprotocol/server-filesystem/dist/index.js node_modules/@paperclipai/mcp-server/dist/stdio.js agent/mcp.json agent/whois-mcp.mjs agent/plugin/.claude-plugin/plugin.json agent/plugin/skills/bb-create-ticket/SKILL.md bakers-bridge/manifest.mjs bakers-bridge/worker.mjs; do
    test -f "$f" || { echo "missing $f"; exit 1; }
  done
  cd bakers-bridge && node -e "Promise.all([import(\"@paperclipai/plugin-sdk\"), import(\"@modelcontextprotocol/sdk/client/index.js\")]).then(() => console.log(\"bridge dependencies resolve\"))"
  cd /tmp && echo hi | timeout 60 claude --print --output-format stream-json --verbose --tools Skill --plugin-dir /opt/bakers-paperclip/agent/plugin 2>/dev/null | head -1 \
    | node -e "let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>{const k=JSON.parse(s).skills.filter(x=>x.startsWith(\"bakers:\"));if(!k.includes(\"bakers:bb-create-ticket\"))process.exit(1);console.log(\"skills:\",k.join(\" \"))})"
'

#!/bin/sh
# Start the Copilot runtime with an allowlisted environment.
#
# A hosting platform can inject variables into every container it runs, such as
# a managed-identity endpoint and its secret header. The agent's shell inherits
# the runtime's environment, so the runtime starts from an empty environment
# plus only what it needs. Nothing else reaches the agent.
set -eu
: "${COPILOT_CONNECTION_TOKEN:?COPILOT_CONNECTION_TOKEN is required}"
exec env -i \
  PATH="/usr/local/bin:/usr/bin:/bin" \
  HOME="/home/agent" \
  XDG_CACHE_HOME="/opt/copilot-cache" \
  LANG="C.UTF-8" \
  COPILOT_CONNECTION_TOKEN="$COPILOT_CONNECTION_TOKEN" \
  ${HTTPS_PROXY:+HTTPS_PROXY="$HTTPS_PROXY"} \
  ${HTTP_PROXY:+HTTP_PROXY="$HTTP_PROXY"} \
  ${NO_PROXY:+NO_PROXY="$NO_PROXY"} \
  ${COPILOT_BROWSER_ALLOWED_HOSTS:+COPILOT_BROWSER_ALLOWED_HOSTS="$COPILOT_BROWSER_ALLOWED_HOSTS"} \
  copilot --headless --no-auto-update --host 0.0.0.0 --port 4321

#!/usr/bin/env bash
#
# setup-prod-environment.sh — one-time, OPERATOR-RUN checklist/script for the
# `prod` GitHub Environment's protection rules (cicd bicep-cicd-pipeline
# P01-T02; security C9).
#
# ============================================================================
# IMPACTFUL-ACTION-GATED. HUMAN-RUN ONLY. NEVER INVOKED BY CI.
# ============================================================================
# This script writes repository settings (an Impactful Action under the
# squad's Impactful-Action Gate). No workflow, job, or CI step in this
# repository calls it, and it must never be wired into one — the same
# convention host/oidc/deploy-aca.workflow.yml already uses for a clearly
# labeled, non-active reference file. Run it yourself, from your own machine
# or Codespace, after reading it.
#
# What it does:
#   * Creates/updates the `prod` GitHub Environment with:
#       - prevent_self_review: true
#       - reviewers: at least one team, or at least two users
#       - deployment_branch_policy: custom, restricted to exactly one branch
#         name pattern ("main" by default)
#   * Re-reads the environment straight back afterwards and FAILS LOUDLY if
#     any of the above did not take — running this script twice is safe, and
#     the second run still proves the settings hold (idempotent + self-
#     verifying).
#   * Reads (never writes) `main`'s branch protection, as an informational
#     check for the operator.
#
# What it deliberately does NOT do:
#   * It never sets `vars.INFRA_DEPLOY_ENABLED` (the deploy kill switch) or
#     any GitHub secret, and takes no secret as a command-line argument —
#     only non-secret identifiers (owner, repo, reviewer team slugs/usernames).
#   * It never sets "Allow administrators to bypass configured protection
#     rules" (security C9's "can_admins_bypass: false"). As of the GitHub
#     REST API version this script targets (2022-11-28), the "Create or
#     update an environment" endpoint has NO field for this setting — it is
#     Settings-UI-only (repo Settings -> Environments -> prod -> "Allow
#     administrators to bypass configured protection rules", which must be
#     left UNCHECKED). This script prints an unmissable reminder instead of
#     silently claiming to have set it; confirm it by hand in the UI. This is
#     exactly the "small field-name correction" the plan's own Risks table
#     flagged as possible — the read-back below is what would have caught a
#     mismatch on the fields the API DOES expose.
#
# Prerequisites: the `gh` CLI, authenticated (`gh auth login` / `gh auth
# status`) as a principal with `repo` admin / `Administration: write` on the
# target repository. `jq` is required.
#
# Usage:
#   ./setup-prod-environment.sh --owner <owner> --repo <repo> \
#     [--reviewer-team <team-slug>]... [--reviewer-user <username>]... \
#     [--branch <name>] [--wait-timer <minutes>] [--prune]
#
# `--prune` (optional, off by default): SEC-AC13 requires that EXACTLY one
# deployment branch/tag policy exist — a `branch`-type pattern named exactly
# `--branch` (default `main`) — never any other pattern, including a
# TAG-type policy that happens to share the same name. By default this
# script FAILS (does not silently warn) when any other pattern is found, and
# tells the operator to delete it by hand. Passing `--prune` instead lets
# this script delete the violating pattern(s) itself, via the API — no
# deletion happens unless this flag is explicitly given.
#
# Example (one team):
#   ./setup-prod-environment.sh --owner Peter-N91 --repo hve-squad-mcp \
#     --reviewer-team platform-approvers
#
# Example (two users, no team):
#   ./setup-prod-environment.sh --owner Peter-N91 --repo hve-squad-mcp \
#     --reviewer-user alice --reviewer-user bob
#
set -euo pipefail

ENVIRONMENT_NAME="prod"
BRANCH="main"
WAIT_TIMER=0
OWNER=""
REPO=""
PRUNE="false"
REVIEWER_TEAMS=()
REVIEWER_USERS=()

usage() {
  cat <<'USAGE'
usage: setup-prod-environment.sh --owner <owner> --repo <repo>
         [--reviewer-team <team-slug>]... [--reviewer-user <username>]...
         [--branch <name>] [--wait-timer <minutes>] [--prune]

Requires at least one --reviewer-team, or at least two --reviewer-user.
No secret is ever accepted as an argument. --prune deletes any deployment
branch/tag policy that is not exactly branch:<--branch> (SEC-AC13); without
it, such a policy is a hard failure, not a warning.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --owner)
      OWNER="$2"
      shift 2
      ;;
    --repo)
      REPO="$2"
      shift 2
      ;;
    --reviewer-team)
      REVIEWER_TEAMS+=("$2")
      shift 2
      ;;
    --reviewer-user)
      REVIEWER_USERS+=("$2")
      shift 2
      ;;
    --branch)
      BRANCH="$2"
      shift 2
      ;;
    --wait-timer)
      WAIT_TIMER="$2"
      shift 2
      ;;
    --prune)
      PRUNE="true"
      shift 1
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "::error::unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$OWNER" || -z "$REPO" ]]; then
  echo "::error::--owner and --repo are both required" >&2
  usage
  exit 2
fi

if [[ ${#REVIEWER_TEAMS[@]} -lt 1 && ${#REVIEWER_USERS[@]} -lt 2 ]]; then
  echo "::error::reviewers must be at least one team (--reviewer-team), or at least two users (--reviewer-user)" >&2
  exit 1
fi

for bin in gh jq; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "::error::required tool not found on PATH: $bin" >&2
    exit 2
  fi
done

if ! gh auth status >/dev/null 2>&1; then
  echo "::error::gh is not authenticated — run 'gh auth login' first (repo admin / Administration: write scope)" >&2
  exit 2
fi

echo "== setup-prod-environment.sh: $OWNER/$REPO, environment '$ENVIRONMENT_NAME', branch '$BRANCH' =="

# ----------------------------------------------------------------------------
# 1. Resolve every reviewer NAME to the numeric id the API requires. Prints
#    only the name being resolved, never a token or a secret.
# ----------------------------------------------------------------------------
REVIEWERS_JSON="[]"
for team in "${REVIEWER_TEAMS[@]}"; do
  echo "-- resolving team reviewer: $team"
  team_id=$(gh api "orgs/$OWNER/teams/$team" --jq '.id')
  REVIEWERS_JSON=$(jq --argjson id "$team_id" '. + [{"type":"Team","id":$id}]' <<<"$REVIEWERS_JSON")
done
for user in "${REVIEWER_USERS[@]}"; do
  echo "-- resolving user reviewer: $user"
  user_id=$(gh api "users/$user" --jq '.id')
  REVIEWERS_JSON=$(jq --argjson id "$user_id" '. + [{"type":"User","id":$id}]' <<<"$REVIEWERS_JSON")
done

# ----------------------------------------------------------------------------
# 2. Create/update the environment: prevent_self_review, reviewers, and a
#    CUSTOM deployment branch policy (the branch pattern itself is added in
#    step 3 — this call only turns custom_branch_policies on).
# ----------------------------------------------------------------------------
echo "-- creating/updating environment '$ENVIRONMENT_NAME'"
PUT_BODY=$(jq -n \
  --argjson reviewers "$REVIEWERS_JSON" \
  --argjson wait_timer "$WAIT_TIMER" \
  '{
     wait_timer: $wait_timer,
     prevent_self_review: true,
     reviewers: $reviewers,
     deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }
   }')
gh api --method PUT "repos/$OWNER/$REPO/environments/$ENVIRONMENT_NAME" --input - <<<"$PUT_BODY" >/dev/null

# ----------------------------------------------------------------------------
# 3. Ensure the deployment branch/tag policy set is EXACTLY one entry: a
#    `branch`-type pattern named `$BRANCH`. SEC-AC13: ANY other policy —
#    including a TAG-type policy that happens to share the branch's name —
#    is a hard failure, never merely a warning. `--prune` (off by default)
#    lets this script delete the violator(s) itself; without it, the
#    operator must delete them by hand and re-run.
# ----------------------------------------------------------------------------
echo "-- ensuring deployment branch policy is restricted to EXACTLY branch:'$BRANCH'"
EXISTING_POLICIES=$(gh api "repos/$OWNER/$REPO/environments/$ENVIRONMENT_NAME/deployment-branch-policies" --jq '.branch_policies')
HAS_TARGET=$(jq --arg b "$BRANCH" '[.[] | select(.name == $b and .type == "branch")] | length > 0' <<<"$EXISTING_POLICIES")
if [[ "$HAS_TARGET" != "true" ]]; then
  gh api --method POST "repos/$OWNER/$REPO/environments/$ENVIRONMENT_NAME/deployment-branch-policies" \
    -f name="$BRANCH" -f type="branch" >/dev/null
  echo "   added branch policy pattern: $BRANCH"
else
  echo "   branch policy pattern already present: $BRANCH"
fi

# A violation is anything that is NOT exactly (name == "$BRANCH" AND type ==
# "branch") — deliberately broader than `.name != $b` alone, which would
# miss e.g. a TAG-type policy also named "$BRANCH".
VIOLATIONS=$(jq --arg b "$BRANCH" '[.[] | select(.name != $b or .type != "branch")]' <<<"$EXISTING_POLICIES")
VIOLATION_COUNT=$(jq 'length' <<<"$VIOLATIONS")
if [[ "$VIOLATION_COUNT" != "0" ]]; then
  echo "::error::deployment branch/tag policy has $VIOLATION_COUNT pattern(s) that are not exactly branch:'$BRANCH' (SEC-AC13 requires ONLY that one):" >&2
  jq -r '.[] | "     - \(.name) (\(.type))"' <<<"$VIOLATIONS" >&2
  if [[ "$PRUNE" == "true" ]]; then
    echo "-- --prune given: deleting the violating pattern(s) above"
    jq -c '.[]' <<<"$VIOLATIONS" | while IFS= read -r policy; do
      policy_id=$(jq -r '.id' <<<"$policy")
      policy_name=$(jq -r '.name' <<<"$policy")
      policy_type=$(jq -r '.type' <<<"$policy")
      echo "   deleting policy id=$policy_id ($policy_name, $policy_type)"
      gh api --method DELETE "repos/$OWNER/$REPO/environments/$ENVIRONMENT_NAME/deployment-branch-policies/$policy_id" >/dev/null
    done
  else
    echo "::error::delete the pattern(s) above by hand (Settings -> Environments -> $ENVIRONMENT_NAME -> Deployment branch and tag rules), or re-run with --prune to delete them automatically. This is a hard failure, not a warning (SEC-AC13)." >&2
    exit 1
  fi
fi

# ----------------------------------------------------------------------------
# 4. Idempotent, self-verifying read-back. Fails loudly if any setting this
#    script is responsible for does not read back as set — running this
#    script twice must be safe, and the second run must still PROVE it.
# ----------------------------------------------------------------------------
echo "-- reading back '$ENVIRONMENT_NAME' to verify"
ENV_JSON=$(gh api "repos/$OWNER/$REPO/environments/$ENVIRONMENT_NAME")

FAILED=0

if [[ "$(jq -r '.protection_rules[]? | select(.type == "required_reviewers") | .prevent_self_review' <<<"$ENV_JSON")" != "true" ]]; then
  echo "::error::verification failed: prevent_self_review is not 'true' on '$ENVIRONMENT_NAME'" >&2
  FAILED=1
fi

REVIEWER_COUNT=$(jq -r '[.protection_rules[]? | select(.type == "required_reviewers") | .reviewers[]?] | length' <<<"$ENV_JSON")
TEAM_REVIEWER_COUNT=$(jq -r '[.protection_rules[]? | select(.type == "required_reviewers") | .reviewers[]? | select(.type == "Team" or .reviewer.type == "Team")] | length' <<<"$ENV_JSON")
if [[ "$REVIEWER_COUNT" -lt 1 ]] || { [[ "$TEAM_REVIEWER_COUNT" -lt 1 ]] && [[ "$REVIEWER_COUNT" -lt 2 ]]; }; then
  echo "::error::verification failed: reviewers do not satisfy 'at least one team, or at least two users' (found $REVIEWER_COUNT reviewer(s), $TEAM_REVIEWER_COUNT team(s))" >&2
  FAILED=1
fi

if [[ "$(jq -r '.deployment_branch_policy.custom_branch_policies' <<<"$ENV_JSON")" != "true" ]]; then
  echo "::error::verification failed: deployment_branch_policy.custom_branch_policies is not 'true'" >&2
  FAILED=1
fi
if [[ "$(jq -r '.deployment_branch_policy.protected_branches' <<<"$ENV_JSON")" != "false" ]]; then
  echo "::error::verification failed: deployment_branch_policy.protected_branches is not 'false'" >&2
  FAILED=1
fi

POLICIES_AFTER=$(gh api "repos/$OWNER/$REPO/environments/$ENVIRONMENT_NAME/deployment-branch-policies" --jq '.branch_policies')
if [[ "$(jq --arg b "$BRANCH" '[.[] | select(.name == $b and .type == "branch")] | length' <<<"$POLICIES_AFTER")" -lt 1 ]]; then
  echo "::error::verification failed: no branch policy pattern '$BRANCH' found after creation" >&2
  FAILED=1
fi
# SEC-AC13, re-applied at read-back time: the same "anything that is not
# exactly branch:'$BRANCH' is a violation" rule as step 3 above — catches a
# policy left over by --prune failing partway, or one added concurrently
# between step 3 and this read-back.
VIOLATIONS_AFTER=$(jq --arg b "$BRANCH" '[.[] | select(.name != $b or .type != "branch")]' <<<"$POLICIES_AFTER")
VIOLATION_AFTER_COUNT=$(jq 'length' <<<"$VIOLATIONS_AFTER")
if [[ "$VIOLATION_AFTER_COUNT" != "0" ]]; then
  echo "::error::verification failed: $VIOLATION_AFTER_COUNT deployment branch/tag policy pattern(s) other than exactly branch:'$BRANCH' still exist (SEC-AC13):" >&2
  jq -r '.[] | "     - \(.name) (\(.type))"' <<<"$VIOLATIONS_AFTER" >&2
  FAILED=1
fi

if [[ "$FAILED" -ne 0 ]]; then
  echo "::error::one or more settings did not verify — see above. Re-run after correcting, or check the current GitHub REST API field names by hand." >&2
  exit 1
fi
echo "OK   prevent_self_review, reviewers, and EXACTLY the '$BRANCH'-only deployment branch policy all verified."

# ----------------------------------------------------------------------------
# 5. Read-only informational check: main's own branch protection (never
#    created or modified here).
# ----------------------------------------------------------------------------
echo "-- checking (read-only) branch protection for '$BRANCH'"
if gh api "repos/$OWNER/$REPO/branches/$BRANCH/protection" >/dev/null 2>&1; then
  echo "OK   '$BRANCH' has branch protection configured."
else
  echo "::warning::'$BRANCH' has NO branch protection configured (informational only — this script does not set it)."
fi

# ----------------------------------------------------------------------------
# 6. The one setting this script CANNOT set or verify via the REST API.
# ----------------------------------------------------------------------------
cat <<'REMINDER'

================================================================================
MANUAL STEP STILL REQUIRED (security C9): "Allow administrators to bypass
configured protection rules" has NO REST API field as of GitHub API version
2022-11-28 — it is a Settings-UI-only toggle. Go to:
  Repo Settings -> Environments -> prod
and confirm "Allow administrators to bypass configured protection rules" is
UNCHECKED. This script has verified everything the API exposes; this one
setting needs your own eyes.
================================================================================
REMINDER

echo "Done. This script never touched vars.INFRA_DEPLOY_ENABLED or any secret."

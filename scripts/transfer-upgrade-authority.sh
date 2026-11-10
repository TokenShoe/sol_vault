#!/usr/bin/env bash
# =============================================================================
# Transfer the upgrade authority of the cross_vault program
#
# Usage:
#   ./scripts/transfer-upgrade-authority.sh <new-authority> [options]
#
#   <new-authority> can be:
#     - a wallet pubkey: e.g. a Squads multisig vault (a multisig cannot sign directly, so the script adds --skip-new-upgrade-authority-signer-check)
#     - a wallet keypair file path: the new authority co-signs, proving you really hold it (safer, recommended for regular wallets)
#
# Options:
#   -u, --url <cluster>         mainnet-beta / devnet / localhost or an RPC URL (default: solana config)
#   -k, --keypair <path>        keypair of the current upgrade authority (default: solana config wallet)
#   -p, --program-id <address>  program id (default: read from target/deploy/cross_vault-keypair.json)
#   --allow-uninitialized       allow transferring before the program is initialized (normally don't, see notes below)
#   -y, --yes                   skip confirmation (for CI; do not use manually)
#
# Notes:
#   1. initialize can only be called by the upgrade authority. Initialize first, then transfer;
#      otherwise initialize must later be sent by the new authority (e.g. the multisig). The script checks this by default.
#   2. A wrong address = upgrade ability lost forever (unless its holder transfers it back). The script asks you to type the last 4 chars of the program id.
#   3. Transferring the program admin is a different thing: use the program's transfer_admin + accept_admin.
#
# Examples:
#   # to a Squads multisig vault (mainnet)
#   ./scripts/transfer-upgrade-authority.sh 7gZufwwAo17y5kg8FMyJy2phgpvv9RSdzWtdXiWHjFr8 -u mainnet-beta
#   # to another regular wallet (devnet, the new wallet co-signs)
#   ./scripts/transfer-upgrade-authority.sh ~/.config/solana/new-owner.json -u devnet
# =============================================================================
set -euo pipefail

# ------------------------------ argument parsing ------------------------------
NEW_AUTH=""
URL_ARGS=()
KEYPAIR_ARGS=()
PROGRAM_ID=""
ALLOW_UNINIT=0
YES=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

log()  { echo -e "\033[36m[INFO]\033[0m $*"; }
warn() { echo -e "\033[33m[WARN]\033[0m $*"; }
die()  { echo -e "\033[31m[ERROR]\033[0m $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    -u|--url)            URL_ARGS=(-u "$2"); shift 2 ;;
    -k|--keypair)        KEYPAIR_ARGS=(-k "$2"); shift 2 ;;
    -p|--program-id)     PROGRAM_ID="$2"; shift 2 ;;
    --allow-uninitialized) ALLOW_UNINIT=1; shift ;;
    -y|--yes)            YES=1; shift ;;
    -h|--help)           sed -n '2,31p' "$0"; exit 0 ;;
    -*)                  die "unknown option: $1" ;;
    *)                   [[ -z "$NEW_AUTH" ]] || die "only one new authority can be given"; NEW_AUTH="$1"; shift ;;
  esac
done
[[ -n "$NEW_AUTH" ]] || die "missing <new-authority>, see -h for usage"
command -v solana >/dev/null || die "solana command not found"

# ${arr[@]+"${arr[@]}"}: does not trip set -u when the array is empty (compatible with macOS's built-in bash 3.2)
sol() { solana ${URL_ARGS[@]+"${URL_ARGS[@]}"} ${KEYPAIR_ARGS[@]+"${KEYPAIR_ARGS[@]}"} "$@"; }

# ------------------------------ 1. program id ------------------------------
if [[ -z "$PROGRAM_ID" ]]; then
  KP="$ROOT_DIR/target/deploy/cross_vault-keypair.json"
  [[ -f "$KP" ]] || die "${KP} not found, pass the program id with -p"
  PROGRAM_ID="$(solana-keygen pubkey "$KP")"
fi
CLUSTER="$(sol config get json_rpc_url 2>/dev/null | awk '{print $NF}')"
[[ ${#URL_ARGS[@]} -gt 0 ]] && CLUSTER="${URL_ARGS[1]}"
log "cluster:      $CLUSTER"
log "program id:   $PROGRAM_ID"

# ------------------------------ 2. current upgrade authority ------------------------------
SHOW="$(sol program show "$PROGRAM_ID" 2>&1)" || die "failed to query the program (is it deployed on this cluster?)\n$SHOW"
CURRENT_AUTH="$(echo "$SHOW" | awk -F': *' '/^Authority/{print $2}')"
[[ -n "$CURRENT_AUTH" ]] || die "cannot parse the current upgrade authority:\n$SHOW"
[[ "$CURRENT_AUTH" != "none" ]] || die "the program is already immutable (Authority: none), nothing to transfer"
SIGNER="$(sol address)"
log "current auth: $CURRENT_AUTH"
log "signer:       $SIGNER"
[[ "$SIGNER" == "$CURRENT_AUTH" ]] || die "the signer is not the upgrade authority (use -k to pass the right keypair)"

# ------------------------------ 3. new authority: keypair file or pubkey ------------------------------
EXTRA_FLAGS=()
if [[ -f "$NEW_AUTH" ]]; then
  NEW_PUBKEY="$(solana-keygen pubkey "$NEW_AUTH")"
  log "new auth:     ${NEW_PUBKEY} (keypair file, the new wallet will co-sign)"
else
  NEW_PUBKEY="$NEW_AUTH"
  # pubkey format check: base58, 32-44 chars
  [[ "$NEW_PUBKEY" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$ ]] || die "new authority is neither a file nor a valid pubkey: $NEW_AUTH"
  EXTRA_FLAGS=(--skip-new-upgrade-authority-signer-check)
  log "new auth:     ${NEW_PUBKEY} (pubkey, no signature from the new authority required; for Squads multisig vaults)"
  # hint: on-chain state of the new address (a multisig vault is usually a System account; not existing can also be normal)
  NEW_INFO="$(sol account "$NEW_PUBKEY" 2>&1 || true)"
  if echo "$NEW_INFO" | grep -q "AccountNotFound"; then
    warn "the new address does not exist on this cluster yet (no balance). If it is a Squads multisig vault, double-check it in the Squads UI."
  fi
fi
[[ "$NEW_PUBKEY" != "$CURRENT_AUTH" ]] || die "new authority equals the current one, nothing to do"

# ------------------------------ 4. check the program is initialized ------------------------------
CONFIG_PDA="$(solana find-program-derived-address "$PROGRAM_ID" string:config | awk '{print $1}')"
if sol account "$CONFIG_PDA" >/dev/null 2>&1; then
  log "Config:       ${CONFIG_PDA} (initialized ✓)"
else
  if [[ $ALLOW_UNINIT -eq 1 ]]; then
    warn "Config account does not exist, the program is not initialized! After the transfer only the new authority can initialize."
  else
    die "Config account $CONFIG_PDA does not exist, the program is not initialized.\n       initialize can only be called by the upgrade authority; initialize first, then transfer.\n       To transfer first anyway, add --allow-uninitialized"
  fi
fi

# ------------------------------ 5. confirm ------------------------------
echo
echo "================ about to execute ================"
echo "  cluster:      $CLUSTER"
echo "  program:      $PROGRAM_ID"
echo "  current auth: $CURRENT_AUTH"
echo "  new auth:     $NEW_PUBKEY"
echo "=========================================="
warn "After the transfer the current wallet can no longer upgrade the program. A wrong address means losing upgrade ability forever!"
if [[ $YES -ne 1 ]]; then
  read -r -p "Type the last 4 chars of the program id to confirm (${PROGRAM_ID: -4}): " CONFIRM
  [[ "$CONFIRM" == "${PROGRAM_ID: -4}" ]] || die "confirmation failed, cancelled"
fi

# ------------------------------ 6. execute ------------------------------
log "sending transaction..."
sol program set-upgrade-authority "$PROGRAM_ID" \
  --new-upgrade-authority "$NEW_AUTH" \
  ${EXTRA_FLAGS[@]+"${EXTRA_FLAGS[@]}"}

# ------------------------------ 7. verify ------------------------------
AFTER="$(sol program show "$PROGRAM_ID" | awk -F': *' '/^Authority/{print $2}')"
if [[ "$AFTER" == "$NEW_PUBKEY" ]]; then
  log "✅ transferred, current upgrade authority: $AFTER"
else
  die "on-chain authority is ${AFTER}, expected $NEW_PUBKEY, please check manually: solana program show $PROGRAM_ID"
fi

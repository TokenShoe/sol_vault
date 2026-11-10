#!/usr/bin/env bash
# =============================================================================
# Dump the CCTP V2 programs and config accounts from devnet for the local test validator (anchor test)
#
# Output (saved to tests/fixtures/cctp/):
#   - TokenMessengerMinterV2 / MessageTransmitterV2 program .so files
#   - CCTP config accounts: message_transmitter / token_messenger / token_minter /
#     remote_token_messenger(domain 0 = Ethereum) / local_token(Circle devnet USDC)
#   - Circle devnet USDC mint: its mint authority is replaced by the test key tests/fixtures/usdc-mint-authority.json,
#     so local tests can mint USDC themselves (affects only the local validator, not devnet)
#
# Usage: ./scripts/dump-cctp-fixtures.sh
# =============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/tests/fixtures/cctp"
mkdir -p "$OUT"
cd "$ROOT"

TMM=CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe
MT=CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC
USDC=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU

pda() { solana find-program-derived-address "$1" "${@:2}" | awk '{print $1}'; }

echo "Dumping CCTP programs..."
solana program dump "$TMM" "$OUT/token_messenger_minter_v2.so" -u devnet
solana program dump "$MT" "$OUT/message_transmitter_v2.so" -u devnet

echo "Dumping CCTP config accounts..."
declare -a ACCS=(
  "message_transmitter:$(pda $MT string:message_transmitter)"
  "token_messenger:$(pda $TMM string:token_messenger)"
  "token_minter:$(pda $TMM string:token_minter)"
  "remote_token_messenger_0:$(pda $TMM string:remote_token_messenger string:0)"
  "local_token:$(pda $TMM string:local_token pubkey:$USDC)"
)
for kv in "${ACCS[@]}"; do
  name="${kv%%:*}"; addr="${kv#*:}"
  solana account "$addr" --output json -u devnet > "$OUT/$name.json"
  echo "  $name  $addr"
done

echo "Dumping the USDC mint and replacing its mint authority with the test key..."
AUTH_KP="$ROOT/tests/fixtures/usdc-mint-authority.json"
[[ -f "$AUTH_KP" ]] || solana-keygen new --no-bip39-passphrase -s -o "$AUTH_KP" >/dev/null
AUTH="$(solana-keygen pubkey "$AUTH_KP")"
solana account "$USDC" --output json -u devnet > "$OUT/usdc_mint.raw.json"
python3 - "$OUT/usdc_mint.raw.json" "$OUT/usdc_mint.json" "$AUTH" <<'EOF'
import json, sys, base64
src, dst, auth = sys.argv[1:4]
A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
n = 0
for c in auth: n = n * 58 + A.index(c)
auth_bytes = n.to_bytes(32, 'big')
j = json.load(open(src))
data = bytearray(base64.b64decode(j['account']['data'][0]))
# SPL Mint layout: [0..4] mint_authority COption tag, [4..36] mint_authority
data[0:4] = (1).to_bytes(4, 'little')
data[4:36] = auth_bytes
j['account']['data'][0] = base64.b64encode(bytes(data)).decode()
json.dump(j, open(dst, 'w'))
EOF
rm "$OUT/usdc_mint.raw.json"
echo "  usdc_mint  ${USDC} (local mint authority = ${AUTH})"
echo "Done: $OUT"

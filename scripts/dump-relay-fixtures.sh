#!/usr/bin/env bash
# =============================================================================
# Dump the Relay Depository program and its config account from Solana MAINNET for the local test validator (anchor test)
# (Relay has no Solana devnet/testnet deployment, so local tests run against the real mainnet program)
#
# Output (saved to tests/fixtures/relay/):
#   - relay_depository.so      Relay Depository program (99vQ...)
#   - relay_depository.json    its config account, PDA ["relay_depository"] (owner / allocator / vault bump)
#
# Not dumped: the Relay vault PDA ["vault"] is only used as an address (token account owner) by deposit_token.
# The test creates ATA(USDC, Relay vault) itself before depositing, like it already exists on mainnet.
#
# Usage: ./scripts/dump-relay-fixtures.sh   (RPC_URL overrides the mainnet RPC)
# =============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/tests/fixtures/relay"
RPC="${RPC_URL:-mainnet-beta}"
mkdir -p "$OUT"

RELAY=99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2
DEPOSITORY="$(solana find-program-derived-address "$RELAY" string:relay_depository | awk '{print $1}')"

echo "Dumping the Relay Depository program..."
solana program dump "$RELAY" "$OUT/relay_depository.so" -u "$RPC"

echo "Dumping the Relay Depository config account $DEPOSITORY ..."
solana account "$DEPOSITORY" --output json -u "$RPC" > "$OUT/relay_depository.json"
echo "Done: $OUT"

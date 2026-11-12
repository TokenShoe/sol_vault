# cross_vault deployment guide

> 中文步骤版（只有步骤和命令）: [deployment-guide.zh-CN.md](deployment-guide.zh-CN.md)

Deploy and configure the program with **your own wallet**. Settings live in two files:

| File | Contents | In git? |
|---|---|---|
| `.env` | **secrets only**: base58 private keys exported from your browser wallet (Phantom / Solflare / Backpack), `NETWORK`, RPC URLs with API keys | ❌ never (`.gitignore`), template `.env.example` |
| `config.json` | **non-secret settings per network** (`localnet` / `devnet` / `mainnet`): pools (mint, watermark, per-tx limit), CCTP (domain map, destination vaults, attestation API), Relay (API, chains, default tokens), role addresses | ✅ committed, shared by the team |

```
.env + config.json  ->  yarn -s cli env-check  ->  yarn -s cli deploy  ->  yarn -s cli setup  ->  done
                          (check, no tx)          (deploy program)      (init + pools + routes)
```

> Run every command from the project root `internal_bridge_sol/`.
> The full flow (keygen / import-keys -> env-check -> deploy -> setup -> re-run setup -> business commands -> drain -> sweep-sol -> close-program) was tested on a local validator on 2026-11-12.
> For a full feature walkthrough on devnet (deposits, payouts, CCTP to Sepolia ...), see [devnet-testing-guide.md](devnet-testing-guide.md).

---

## 1. Roles

| Role | What it does | Private key in `.env` | Needs SOL |
|---|---|---|---|
| **admin** (you) | deploys the program (becomes the **upgrade authority**), initializes, creates pools, registers CCTP routes, pauses; may also call debit / rebalance | `ADMIN_PRIVATE_KEY` (**required** to deploy) | ~7 SOL on the first deploy, about half is refunded right after |
| operator | pays users (`debit`), used by the backend | `OPERATOR_PRIVATE_KEY`, **or** only its address in `config.json` `addresses.operator` | ~0.2 SOL |
| rebalancer | bridges the funds above the watermark (`rebalance_cctp` / `rebalance_relay`) | `REBALANCER_PRIVATE_KEY`, **or** `addresses.rebalancer` | ~0.2 SOL |
| feepayer | sponsors gas of user deposits | `FEEPAYER_PRIVATE_KEY` | ~0.2 SOL |
| fee-wallet | receives the platform fee on payouts | `FEE_WALLET_PRIVATE_KEY`, **or** `addresses.fee-wallet` | ❌ |
| user / user2 | test users (devnet only) | `USER_PRIVATE_KEY` / `USER2_PRIVATE_KEY` | ❌ |

- To **deploy and configure**, you only need `ADMIN_PRIVATE_KEY` plus the operator and rebalancer **addresses**, which go in `config.json` `addresses`. Their private keys can stay with the backend.
- If a role has both a private key in `.env` and an address in `config.json`, the two must match. Otherwise every command stops with an error.
- `initialize` can only be sent by the upgrade authority, so the same wallet deploys and initializes.
- Use **separate wallets** for admin, operator and rebalancer. `env-check` warns if any of them are the same.

---

## 2. Preparation (once per computer)

### 2.1 Tools

```bash
solana --version   # 4.1.2  (install: https://solana.com/docs/intro/installation)
anchor --version   # 1.2.2
node --version     # >= 22  (the CLI reads .env with Node's built-in loader)
```

### 2.2 Install and build

```bash
yarn install
anchor build       # -> target/deploy/cross_vault.so and target/idl/cross_vault.json
```

### 2.3 Program id (read this before the first deploy)

The program id is fixed in the code: `declare_id!` in `programs/cross_vault/src/lib.rs` = `A38GT8a6E1ySMM91Ly9rNCNbUPfFxLYgUt7X9dFmv2rK`.
The **first** deploy to a network needs the matching key file `target/deploy/cross_vault-keypair.json`. `target/` is not in git, so a fresh clone does not have it. Pick one:

| Situation | What to do |
|---|---|
| **A. Use the project's program id** (normal case) | Get `cross_vault-keypair.json` from the project owner over a private channel (never chat or git) and put it in `target/deploy/`. Check it with `solana-keygen pubkey target/deploy/cross_vault-keypair.json`: it must print `A38GT8a6…`. Each network can have that address deployed **once**. If it is already deployed there, you upgrade it instead (section 7). |
| **B. Your own program id** (your own test deployment, or a vanity address) | `solana-keygen new -o target/deploy/cross_vault-keypair.json --no-bip39-passphrase --force` (or `solana-keygen grind --starts-with <prefix>:1` and copy the result there), then `anchor keys sync`, then `anchor build`. This **changes code** (`lib.rs`, `Anchor.toml`): everyone using that deployment needs the same build. |

Upgrades do not need this file, only the admin key (the upgrade authority).

---

## 3. `.env`: secrets

```bash
cp .env.example .env
```

### 3.1 Export a private key from your wallet

Create a **new account** in the wallet for this. Do not use a personal wallet that holds other funds.

| Wallet | Where |
|---|---|
| Phantom | Settings -> Manage Accounts -> pick the account -> Show Private Key -> enter password |
| Solflare | Settings -> pick the wallet -> Export Private Key |
| Backpack | Settings -> pick the wallet -> Show Private Key |

You get a long base58 string (~88 characters). Paste it after `ADMIN_PRIVATE_KEY=` with no quotes or spaces.

> The **address** (~44 characters, shown on the wallet's main screen) is NOT the private key. If you paste the address, the CLI rejects it with `looks like a wallet ADDRESS`.
> A solana CLI key file content `[12,34,...]` is also accepted.

### 3.2 Variables

| Variable | Meaning |
|---|---|
| `NETWORK` | default network: `devnet` (default) / `mainnet` / `localnet`. Any command takes `--network devnet|mainnet|localnet` to override it, e.g. `yarn -s cli deploy --network mainnet`. **Every transaction is refused** if the RPC turns out to be a different network (checked against the chain's genesis hash). |
| `DEVNET_RPC_URL` / `MAINNET_RPC_URL` | RPC per network, optional (empty = `config.json` `rpc`, the public node). `RPC_URL` is a shared fallback. Use a free dedicated RPC (https://dashboard.helius.dev): the public node rate-limits the hundreds of transactions a deploy sends. Put it here, not in `config.json`, because the URL contains an API key. |
| `ADMIN_PRIVATE_KEY` ... `USER2_PRIVATE_KEY` | base58 private keys of the roles (section 1), used on devnet / localnet (`DEVNET_ADMIN_PRIVATE_KEY` etc. override them) |
| `MAINNET_ADMIN_PRIVATE_KEY` (+ `MAINNET_<ROLE>_PRIVATE_KEY`) | **mainnet reads private keys ONLY from `MAINNET_` names**, never the shared ones, so test wallets can never sign on mainnet |
| `ENCRYPTION_SECRET_KEY` | x25519 secret (base64) used to decrypt V2 deposits; `yarn -s cli keygen` creates one |
| `EVM_PRIVATE_KEY` | devnet only: EVM test wallet that receives the CCTP test transfer on Sepolia and pays `receiveMessage` gas |
| `RELAY_API_KEY`, `EVM_RPC_URL` | optional |

**Test wallets in one command** (devnet / local):

```bash
yarn -s cli keygen      # fills every EMPTY key in .env with a new wallet; existing keys are never overwritten
```

**Moving an old `keys/devnet` directory**: `yarn -s cli import-keys --dir keys/devnet` copies every key into `.env` and the `<token>-mint.txt` files into `config.json`. It never overwrites anything and lists any conflicts. Check the result with `yarn -s cli balances`, then delete the directory.

Variables set in the shell take priority over `.env`. `ENV_FILE=<path>` picks another file.

> Back up `.env` (password manager, encrypted disk). It is the **only** copy of the wallets.

---

## 4. `config.json`: settings

Edit the section of your network (`networks.devnet`, `networks.mainnet` ...):

```jsonc
"devnet": {
  "rpc": "https://api.devnet.solana.com",               // default RPC; DEVNET_RPC_URL in .env overrides it
  "addresses": {                                         // only for roles WITHOUT a private key in .env
    "operator": "CmASfSYYFpkKZVJqqpKZCKTKBofri1mqyhNe11Eh74Uf",
    "rebalancer": "HWc1pFon5BHW3EFFMSZMFDn2Ye6ntuYvsUwaYc9U3AZN",
    "fee-wallet": ""
  },
  "pools": {                                             // one pool per token; empty mint = skip that token
    "USDC": { "mint": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", "watermark": "5",  "maxDebit": "0" },
    "USDT": { "mint": "",                                             "watermark": "50", "maxDebit": "100" }
  },
  "cctp": {
    "attestationApi": "https://iris-api-sandbox.circle.com",   // Circle Iris: sandbox on devnet, https://iris-api.circle.com on mainnet
    "domains": { "ETHEREUM": 0, "AVALANCHE": 1, "OPTIMISM": 2, "ARBITRUM": 3, "BASE": 6, "POLYGON": 7 },
    "routes": { "ETHEREUM": "0xOurVaultOnSepolia..." },        // chain name (from domains) -> our vault; rebalance_cctp can ONLY send there
    "evmTestnet": { "name": "Ethereum Sepolia", "chainId": 11155111, "rpc": "...", "messageTransmitter": "0x...", "usdc": "0x...", "explorer": "..." }
  },
  "relay": {
    "api": "https://api.relay.link",
    "chains": { "BSC": 56, "ETHEREUM": 1, "BASE": 8453 },     // chain name -> Relay chain id (--chain BSC)
    "defaultChain": "BSC",
    "defaultRecipient": "",                                    // our vault on the destination chain; empty = EVM_PRIVATE_KEY address (testing)
    "defaultTokens": { "BSC": "0x55d398326f99059ff775485246999027b3197955" }   // BSC USDT
  }
}
```

(`//` comments are only for this guide. `config.json` itself is plain JSON and must not contain comments.)

| Field | Meaning |
|---|---|
| `pools.<TOKEN>.mint` | token mint. Mainnet USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, USDT `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`; devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. `--mint usdc` / `--mint usdt` in all commands refer to these. |
| `pools.<TOKEN>.watermark` | amount kept in the vault, **in tokens, as a string** (`"1000"` = 1000 USDC). Only the part above it can be rebalanced. Required once the mint is set. **Mainnet ships with it empty on purpose**: you must choose a value. |
| `pools.<TOKEN>.maxDebit` | max per `debit` instruction, in tokens. `""` / `"0"` = unlimited. On mainnet set it to the largest normal order. |
| `cctp.domains` | CCTP domain numbers (fixed by Circle, the same on testnet and mainnet). Commands accept the names: `--domain BASE`. |
| `cctp.routes` | our vault contract (`0x` + 40 hex) per chain name. `setup` registers them on chain. **Verify every address twice on mainnet**: funds sent to a wrong address cannot be recovered. |
| `cctp.evmTestnet` | used only by `cctp-receive` / `evm-balance` on devnet; `null` elsewhere |
| `relay.*` | defaults of `relay-quote` / `rebalance-relay` (each can be overridden with `--chain` / `--to-token` / `--recipient`) |

> The **on-chain** CCTP / Relay program addresses are not in `config.json`. They are constants compiled into the program (`rebalance_cctp.rs` / `rebalance_relay.rs`). If they lived in a config file, they could drift from what the program accepts. Changing them means upgrading the program.

---

## 5. Check (sends nothing)

```bash
yarn -s cli env-check
```

```
env file        /…/internal_bridge_sol/.env
config file     /…/internal_bridge_sol/config.json  [networks.devnet]
RPC_URL         https://devnet.helius-rpc.com/?api-key=...
network         devnet, RPC is devnet ✔
admin           AhLW…  (8.2 SOL)
operator        CmAS…  (private key in .env)
rebalancer      HWc1…  (address in config.json)

program id      A38GT8a6E1ySMM91Ly9rNCNbUPfFxLYgUt7X9dFmv2rK
deployed        no
  deploy needs   ~6.7 SOL (half is refunded after the deploy)
initialized     no

pools
  USDC  4zMM…  watermark 5  per-tx limit unlimited
CCTP routes
  ETHEREUM   domain 0  -> 0x…

next: yarn -s cli deploy
```

Check that `network` shows ✔, `admin` is your wallet's address, and no line has `⚠️`.

**Get SOL for admin**: on devnet use https://faucet.solana.com or `yarn -s cli airdrop --to admin --sol 2`. On mainnet send SOL from an exchange or another wallet. `yarn -s cli fund --sol 0.2` then sends 0.2 SOL each to operator, rebalancer and feepayer.

---

## 6. Deploy and configure

```bash
yarn -s cli deploy            # deploy (admin becomes the upgrade authority)
yarn -s cli setup --dry-run   # preview: initialize / roles / pools / CCTP routes
yarn -s cli setup             # apply
```

`deploy`:
- writes the admin key to a temporary file (mode 600) only while `solana program deploy` runs, then deletes it, even if the deploy fails
- checks `target/deploy/cross_vault-keypair.json` against the built program id first
- asks you to type `yes` on mainnet
- if it fails halfway, `yarn -s cli deploy --close-buffers` reclaims the SOL left in the buffer account; then deploy again

`setup` compares the chain with `config.json` (and the role keys in `.env`) and **only sends the differences**, one transaction per step. Re-running it is safe:

| You change | Re-running `setup` sends |
|---|---|
| nothing | nothing (`on-chain config already matches config.json`) |
| operator / rebalancer (key in `.env` or `addresses`) | `set_config` |
| `pools.<TOKEN>.watermark` / `maxDebit` | `set_pool_config` |
| a new `pools.<TOKEN>.mint` | `create_pool` (a pool cannot be deleted later, so double-check the mint) |
| a new or changed `cctp.routes.<CHAIN>` | `set_cctp_route` |
| a route removed from `config.json` | **nothing**. `setup` never removes routes; it prints a note. Remove it explicitly with `yarn -s cli remove-route --domain <CHAIN>` |

If a step fails, the earlier steps stay done. Fix the cause and run `setup` again.

---

## 7. Upgrade the program later

```bash
git pull && anchor build
yarn -s cli deploy          # program exists -> upgrade (only the upgrade authority = admin can)
```

An upgrade keeps the program id and all on-chain data (Config, pools, routes, vault funds).

---

## 8. Mainnet checklist

1. In `.env` set `MAINNET_RPC_URL` and `MAINNET_ADMIN_PRIVATE_KEY` (a fresh wallet). Run every mainnet command with `--network mainnet`; mainnet never uses the shared (devnet) keys.
2. `yarn -s cli env-check --network mainnet` must show `mainnet, RPC is mainnet ✔`.
3. In `config.json` `networks.mainnet`:
   - `addresses.operator` / `rebalancer` / `fee-wallet` = the backend's addresses
   - `pools.USDC` / `pools.USDT`: set `watermark` and `maxDebit` (both ship empty on purpose)
   - `cctp.routes`: our **mainnet** vault contracts; verify every address twice
   - `relay.defaultRecipient`: our vault on BSC
4. `deploy` / `setup` ask for `yes` on mainnet. `--yes` skips the question; use it only in scripts. `create-token` and `close-program` refuse to run on mainnet.
5. Run one small end-to-end transfer per route (and Relay) before automating anything; see README "Mainnet launch steps".
6. **Hand over to a multisig** (README "Mainnet launch steps" 5 and 6):
   - Program admin: `yarn -s cli transfer-admin --to <Squads vault address> --network mainnet`, then accept in Squads.
   - Upgrade authority: `scripts/transfer-upgrade-authority.sh` needs a key **file**. Create a temporary one, then delete it:
     ```bash
     yarn -s cli keyfile --out /tmp/admin.json --network mainnet
     ./scripts/transfer-upgrade-authority.sh <Squads vault address> -k /tmp/admin.json -u <mainnet RPC URL, or mainnet-beta>
     rm /tmp/admin.json
     ```
   After the handover, `MAINNET_ADMIN_PRIVATE_KEY` no longer controls anything. `deploy` and `setup` sent with it are refused; changes go through Squads proposals instead.

---

## 9. Keeping the keys safe

- `.env` and `.env.*` are git-ignored (only `.env.example` is committed). `config.json` must never contain a private key or an API key.
- Before committing, `git status` must not list any `.env` file.
- Never paste `.env` contents into chat, tickets or screenshots. The CLI never prints private keys, only addresses.
- The admin wallet controls the whole program (roles, routes, watermark, pause, upgrades). After launch, move admin and the upgrade authority to a multisig (section 8). Then delete the key from `.env`, or empty the wallet.

---

## 10. Troubleshooting

| Message | Cause / fix |
|---|---|
| `network is devnet but the RPC (...) is mainnet` | the network and its RPC disagree; fix `--network` / `NETWORK`, or `DEVNET_RPC_URL` / `MAINNET_RPC_URL` |
| `ADMIN_PRIVATE_KEY is not set in .env` | paste the key (3.1), or `yarn -s cli keygen` for test wallets |
| `ADMIN_PRIVATE_KEY looks like a wallet ADDRESS` | you pasted the address; export the private key |
| `... is not a valid private key` | incomplete copy, extra characters, or a seed phrase (12/24 words are not accepted; export the private key) |
| `operator is not configured: set OPERATOR_PRIVATE_KEY ... or ... addresses.operator` | give the role a key in `.env` or an address in `config.json` |
| `operator: OPERATOR_PRIVATE_KEY in .env is X but ... addresses.operator is Y` | keep only one of the two, or make them match |
| `... pools.USDT.watermark is empty` | set the watermark (`"0"` = keep nothing) |
| `... is not a token mint on devnet` | a mainnet mint in the devnet section, or the other way round |
| `... cctp.routes.X: X is not in cctp.domains` / `is not a valid EVM address` | use a chain name from `cctp.domains`, with an address of `0x` + 40 hex |
| `config.json is not valid JSON` | a missing comma / quote, or a `//` comment; check with an editor |
| `target/deploy/cross_vault-keypair.json missing` / `... but the program is built for ...` | see 2.3 |
| `cannot upgrade: upgrade authority is X` / `initialize must be sent by the upgrade authority` / `the program admin is X` | the program on this network was deployed by another wallet: use that wallet's key, or deploy under your own program id (2.3 B) |
| `429 Too Many Requests` / deploy very slow | set a dedicated RPC in `DEVNET_RPC_URL` / `MAINNET_RPC_URL` |
| deploy failed halfway, SOL missing | `yarn -s cli deploy --close-buffers` |
| `cannot run solana CLI` | install the Solana CLI and make sure `solana` is on `PATH` |

---

## Command summary

| Command | Sends txs | Purpose |
|---|---|---|
| `yarn -s cli keygen` | no | create test wallets for every empty key in `.env` (+ encryption and EVM keys) |
| `yarn -s cli import-keys --dir keys/devnet` | no | move an old key directory into `.env` / `config.json` |
| `yarn -s cli env-check` | no | network, addresses, balance, deploy state, what setup would configure |
| `yarn -s cli deploy` | yes | first deploy or upgrade |
| `yarn -s cli deploy --close-buffers` | yes | reclaim SOL left by a failed deploy |
| `yarn -s cli setup [--dry-run]` | yes / no | initialize, roles, pools, CCTP routes: only the differences |
| `yarn -s cli status` / `balances` | no | on-chain status / balances of all roles |
| `yarn -s cli keyfile --out <path>` | no | write a key to a temp file for tools that need one (delete it afterwards) |
| `yarn -s cli sweep-sol` | yes | testing: send operator / rebalancer / feepayer SOL back to admin |
| `yarn -s cli close-program` | yes | testing only, irreversible: close the program and reclaim its rent (refused on mainnet, requires drained vaults) |

`yarn -s cli help` lists every command.

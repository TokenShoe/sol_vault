# cross_vault deployment guide

Deploy and configure the program with **your own wallet**. You paste the private key exported from your browser wallet (Phantom / Solflare / Backpack) into `.env`, together with the operator / rebalancer addresses and the CCTP destination vaults. No `keys/` directory is needed.

```
fill in .env  ->  yarn -s cli env-check  ->  yarn -s cli deploy  ->  yarn -s cli setup  ->  done
  (config)          (check, no tx)          (deploy program)      (init + pools + routes)
```

> Run every command from the project root `internal_bridge_sol/`.
> The full flow (env-check -> deploy -> setup -> re-run setup -> change config -> setup -> upgrade) was tested on a local validator on 2026-11-12.
> For a full feature walkthrough on devnet (deposits, payouts, CCTP to Sepolia ...), see [devnet-testing-guide.md](devnet-testing-guide.md).

---

## 1. What gets deployed, and who does what

| Role | What it does | In `.env` | Needs SOL |
|---|---|---|---|
| **admin** (you) | deploys the program (becomes the **upgrade authority**), initializes, creates pools, registers CCTP routes, pauses; may also call debit / rebalance | `ADMIN_PRIVATE_KEY` (private key) | ~7 SOL on the first deploy, about half is refunded right after |
| operator | pays users (`debit`), used by the backend | `OPERATOR_ADDRESS` (address only) | ~0.2 SOL for fees later |
| rebalancer | bridges the funds above the watermark (`rebalance_cctp` / `rebalance_relay`), used by the backend | `REBALANCER_ADDRESS` (address only) | ~0.2 SOL for fees later |

- Only the admin private key goes into `.env`. The operator and rebalancer keys stay with the backend, and you only need their **addresses**.
- `initialize` can only be sent by the upgrade authority. That is why the same wallet deploys and initializes, and the CLI enforces it.
- Use **three different wallets**. `env-check` warns if operator or rebalancer equals admin.

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
| **A. Use the project's program id** (normal case: same address as the rest of the team) | Get `cross_vault-keypair.json` from the project owner over a private channel (never chat or git), put it in `target/deploy/`, then check with `solana-keygen pubkey target/deploy/cross_vault-keypair.json`: it must print `A38GT8a6…`. Each network can have that address deployed **once**. If it is already deployed there, you upgrade it instead of deploying (see section 6). |
| **B. Your own program id** (e.g. your own test deployment) | `solana-keygen new -o target/deploy/cross_vault-keypair.json --no-bip39-passphrase --force`, then `anchor keys sync` (writes the new id into `lib.rs` and `Anchor.toml`), then `anchor build`. This **changes code**: everyone using your deployment needs this exact build. |

Upgrades do not need this file, only the admin key (the upgrade authority).

---

## 3. Fill in `.env`

```bash
cp .env.example .env
```

Then open `.env` in an editor and fill it in. Every variable is explained inside the file.

### 3.1 Export the admin private key from your wallet

Create a **new account** in the wallet for this purpose. Do not use a personal wallet that holds other funds.

| Wallet | Where |
|---|---|
| Phantom | Settings -> Manage Accounts -> pick the account -> Show Private Key -> enter password |
| Solflare | Settings -> pick the wallet -> Export Private Key |
| Backpack | Settings -> pick the wallet -> Show Private Key |

You get a long base58 string (about 88 characters). Paste it after `ADMIN_PRIVATE_KEY=`, with no quotes or spaces.

> The **address** (about 44 characters, shown on the wallet's main screen) is NOT the private key. If you paste the address, the CLI rejects it with `looks like a wallet ADDRESS`.
> A solana CLI key file content `[12,34,...]` is also accepted.

### 3.2 Example (devnet)

```bash
RPC_URL=https://devnet.helius-rpc.com/?api-key=YOUR_KEY
ADMIN_PRIVATE_KEY=4Zx...your base58 private key...9Qa

OPERATOR_ADDRESS=CmASfSYYFpkKZVJqqpKZCKTKBofri1mqyhNe11Eh74Uf
REBALANCER_ADDRESS=HWc1pFon5BHW3EFFMSZMFDn2Ye6ntuYvsUwaYc9U3AZN

USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
USDC_WATERMARK=1000
USDC_MAX_DEBIT=

USDT_MINT=
USDT_WATERMARK=
USDT_MAX_DEBIT=

CCTP_ROUTE_ETHEREUM=0xYourVaultOnSepolia0000000000000000000000
CCTP_ROUTE_BASE=
```

### 3.3 Variable reference

| Variable | Required | Meaning |
|---|---|---|
| `RPC_URL` | ✅ | Solana RPC. Use a free dedicated one (https://dashboard.helius.dev). The public node rate-limits the hundreds of transactions a deploy sends. The CLI detects mainnet / devnet from the chain itself, not from the URL. |
| `ADMIN_PRIVATE_KEY` | ✅ | the deployer / admin wallet private key |
| `OPERATOR_ADDRESS` | ✅ | operator wallet address |
| `REBALANCER_ADDRESS` | ✅ | rebalancer wallet address |
| `USDC_MINT` / `USDT_MINT` | at least one | token mint of the pool. Empty = skip that token. Mainnet USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, mainnet USDT `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`, devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| `<TOKEN>_WATERMARK` | ✅ if the mint is set | amount kept in the vault, in tokens (`1000` = 1000 USDC). Only the part above it can be rebalanced. |
| `<TOKEN>_MAX_DEBIT` | | max amount per `debit` instruction, in tokens. Empty / `0` = unlimited. On mainnet set it to the largest normal order. |
| `CCTP_ROUTE_<CHAIN>` | | our vault contract on that EVM chain (`0x` + 40 hex). `rebalance_cctp` can **only** send USDC to these addresses. Chains: `ETHEREUM`(0) `AVALANCHE`(1) `OPTIMISM`(2) `ARBITRUM`(3) `BASE`(6) `POLYGON`(7). On devnet the same names mean the testnets (Ethereum Sepolia, Base Sepolia ...). |
| `ENV_FILE` | | (shell only) use another file, e.g. `ENV_FILE=.env.mainnet yarn -s cli setup` |

Variables set in the shell take priority over `.env`, e.g. `RPC_URL=http://127.0.0.1:8899 yarn -s cli env-check`.

---

## 4. Check (sends nothing)

```bash
yarn -s cli env-check
```

Example output:

```
RPC_URL         https://devnet.helius-rpc.com/?api-key=...
network         devnet
admin           Dm5d9WG8t3tJoEFBus6nxmqRuDPv9hSsbbvXWv954yJ8  (8.2 SOL)
operator        CmASfSYYFpkKZVJqqpKZCKTKBofri1mqyhNe11Eh74Uf
rebalancer      HWc1pFon5BHW3EFFMSZMFDn2Ye6ntuYvsUwaYc9U3AZN

program id      A38GT8a6E1ySMM91Ly9rNCNbUPfFxLYgUt7X9dFmv2rK
deployed        no
  deploy needs   ~6.7 SOL (half is refunded after the deploy)
initialized     no

pools in .env
  USDC  4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU  watermark 1000  per-tx limit unlimited
CCTP routes
  ETHEREUM   domain 0  -> 0x...

next: yarn -s cli deploy
```

Check that:
- `network` is the network you mean to use
- `admin` is the address shown in your wallet
- no `⚠️` lines

**Get SOL for admin:**
- devnet: https://faucet.solana.com (choose Devnet, paste the admin address), or `solana airdrop 2 <admin address> -u devnet`
- mainnet: send SOL from an exchange or another wallet

---

## 5. Deploy

```bash
yarn -s cli deploy
```

- The CLI writes the admin key to a temporary file (mode 600) only while `solana program deploy` runs, then deletes it, even if the deploy fails.
- It checks that `target/deploy/cross_vault-keypair.json` matches the built program id before sending anything.
- On mainnet it asks you to type `yes` first.
- It ends by printing the upgrade authority, which must be your admin address.

**If the deploy fails halfway** (network problems, out of SOL), the SOL already spent on uploading sits in a "buffer" account. Get it back with:

```bash
yarn -s cli deploy --close-buffers
```

Then run `yarn -s cli deploy` again.

---

## 6. Configure: initialize + pools + CCTP routes

Preview first; this sends nothing:

```bash
yarn -s cli setup --dry-run
```

```
network devnet, 3 change(s):
  1. initialize: admin Dm5d…, operator CmAS…, rebalancer HWc1…
  2. create_pool USDC: watermark 1000, per-tx limit unlimited
  3. set_cctp_route ETHEREUM (domain 0): (none) -> 0x...
```

If the plan looks right, send it:

```bash
yarn -s cli setup
```

It sends one transaction per step and then prints the on-chain status (`yarn -s cli status` shows it any time).

**`setup` is safe to re-run.** It compares the chain with `.env` and only sends the differences:

| You change in `.env` | Re-running `setup` sends |
|---|---|
| nothing | nothing (`on-chain config already matches .env`) |
| `OPERATOR_ADDRESS` / `REBALANCER_ADDRESS` | `set_config` (role switch) |
| `<TOKEN>_WATERMARK` / `<TOKEN>_MAX_DEBIT` | `set_pool_config` |
| a new `<TOKEN>_MINT` | `create_pool` (a pool cannot be deleted later, double-check the mint) |
| a new or changed `CCTP_ROUTE_<CHAIN>` | `set_cctp_route` |
| a `CCTP_ROUTE_<CHAIN>` emptied | **nothing**. setup never removes routes. It prints a note; remove the route explicitly with `yarn -s cli remove-route --domain <n>` |

If a step fails, the earlier steps stay done. Fix the cause and run `setup` again, and it continues from where it stopped.

---

## 7. Upgrade the program later

```bash
git pull && anchor build
yarn -s cli deploy          # detects the program exists -> upgrade (only the upgrade authority = admin can)
```

An upgrade keeps the program id and all on-chain data (Config, pools, routes, vault funds). Running `setup` again is only needed if `.env` changed.

---

## 8. Mainnet checklist

1. Use a separate file: `cp .env.example .env.mainnet`, and run every command with `ENV_FILE=.env.mainnet`. This way devnet and mainnet configs never mix.
2. `RPC_URL` = a mainnet RPC; `env-check` must print `network mainnet`.
3. Mainnet mints: USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, USDT `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`.
4. `CCTP_ROUTE_*` = our **mainnet** vault contracts. Verify every address twice: funds sent to a wrong address cannot be recovered.
5. Set `<TOKEN>_MAX_DEBIT` (not unlimited).
6. `deploy` and `setup` ask for `yes` on mainnet. `--yes` skips the question; use it only in scripts.
7. Run one small end-to-end transfer per route (and Relay) before automating anything; see README "Mainnet launch steps".
8. **Hand over to a multisig** (README "Mainnet launch steps" 5 and 6):
   - Program admin: `yarn -s cli transfer-admin --to <Squads vault address>`, then accept in Squads.
   - Upgrade authority: `scripts/transfer-upgrade-authority.sh` needs a key **file**. Create a temporary one, then delete it:
     ```bash
     ENV_FILE=.env.mainnet yarn -s cli keyfile --out /tmp/admin.json
     ./scripts/transfer-upgrade-authority.sh <Squads vault address> -k /tmp/admin.json -u <your mainnet RPC_URL, or mainnet-beta>
     rm /tmp/admin.json
     ```
   After the handover, the wallet in `.env` is no longer admin or upgrade authority. Future `deploy` / `setup` calls from it are refused, and changes go through Squads proposals instead.

---

## 9. Keeping the private key safe

- `.env`, `.env.*` are in `.gitignore` (`.env.example` is the only exception). Before committing, `git status` must not list any `.env` file.
- Never paste `.env` contents into chat, tickets or screenshots. The CLI never prints the private key; it only prints addresses.
- The admin wallet controls the whole program (roles, routes, watermark, pause, upgrades). After launch, move admin and the upgrade authority to a multisig (section 8). Then delete the key from `.env`, or empty the wallet.
- When you are done deploying, you can delete the `ADMIN_PRIVATE_KEY` line. Read-only commands like `yarn -s cli status` do not need it.

---

## 10. Troubleshooting

| Message | Cause / fix |
|---|---|
| `ADMIN_PRIVATE_KEY looks like a wallet ADDRESS` | you pasted the address, export the private key (3.1) |
| `ADMIN_PRIVATE_KEY is not a valid private key` | incomplete copy, extra characters, or a seed phrase (12/24 words are not accepted; export the private key instead) |
| `OPERATOR_ADDRESS is empty` | fill in the operator / rebalancer addresses |
| `<TOKEN>_MINT is set but <TOKEN>_WATERMARK is empty` | set the watermark (e.g. `0` for none) |
| `... is not a token mint on this network` | devnet mint used on mainnet or the other way round |
| `invalid EVM address` | a CCTP route must be `0x` + 40 hex characters |
| `target/deploy/cross_vault-keypair.json missing` / `... but the program is built for ...` | see 2.3 |
| `cannot upgrade: upgrade authority is X` / `initialize must be sent by the upgrade authority` / `the program admin is X` | the program on this network was deployed by another wallet: use that wallet's key, or deploy under your own program id (2.3 B) |
| `429 Too Many Requests` / deploy very slow | use a dedicated RPC (Helius etc.) in `RPC_URL` |
| deploy failed halfway, SOL missing | `yarn -s cli deploy --close-buffers` |
| `cannot run solana CLI` | install the Solana CLI and make sure `solana` is on `PATH` |
| `ENV_FILE not found` | wrong path in `ENV_FILE` |
| `Should return a valid tpu client` | behind a proxy: the CLI already passes `--use-rpc`; if you run `solana program deploy` yourself, add it too |

---

## Command summary

| Command | Sends txs | Purpose |
|---|---|---|
| `yarn -s cli env-check` | no | show network, addresses, balance, deploy state, what setup would configure |
| `yarn -s cli deploy` | yes | first deploy or upgrade, with `ADMIN_PRIVATE_KEY` |
| `yarn -s cli deploy --close-buffers` | yes | reclaim SOL left by a failed deploy |
| `yarn -s cli setup --dry-run` | no | print the changes needed to match `.env` |
| `yarn -s cli setup` | yes | initialize / roles / pools / CCTP routes, only the differences |
| `yarn -s cli status` | no | on-chain status: roles, pools, routes |
| `yarn -s cli keyfile --out <path>` | no | write the admin key to a temp file for tools that need one (delete it afterwards) |

All other CLI commands (`pause`, `set-pool`, `remove-route`, `transfer-admin`, `payout`, `rebalance-cctp` ...) also read `ADMIN_PRIVATE_KEY` / `<ROLE>_PRIVATE_KEY` and `USDC_MINT` / `USDT_MINT` from `.env`; see `yarn -s cli help`.

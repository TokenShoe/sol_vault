# cross_vault devnet testing guide

From scratch on devnet: create accounts -> get SOL -> deploy the program -> initialize and create token pools (USDC + USDT) -> test every feature (multi-token, CCTP bridging to Ethereum Sepolia, upgrade) -> drain the vaults, close the program, reclaim SOL.

> The program is multi-token (like pump): one pool per token. Fund-related commands select the token with `--mint`: `usdc` (default), `usdt`, or a raw mint address.

> Run every command from the project root `internal_bridge_sol/`.
> The flow was run end to end on a local validator (2026-11-09); the commands are identical on devnet. The CCTP part was tested by dumping the real CCTP V2 programs and config from devnet into the local validator; the Sepolia part (`cctp-status`, `cctp-receive --dry-run`) was verified with a real devnet CCTP message.

---

## 0. Preparation

### 0.1 Tool versions

```bash
solana --version   # 4.1.2
anchor --version   # 1.2.2
node --version     # >= 22
```

### 0.2 Install dependencies and build

```bash
yarn install
anchor build       # produces target/deploy/cross_vault.so and target/idl/cross_vault.json
```

### 0.3 The CLI

All program operations use the bundled CLI `yarn -s cli <command>` (source: `scripts/cli.ts`):

```bash
yarn -s cli help   # list all commands
```

- Reads two files at the project root ([deployment-guide.md](deployment-guide.md) explains every field):
  - `.env`: **secrets** (private keys, `NETWORK`, `DEVNET_RPC_URL` / `MAINNET_RPC_URL`), git-ignored. Start with `cp .env.example .env`; the network is devnet unless a command gets `--network mainnet`
  - `config.json`: **settings** per network (pools, CCTP domains / routes, Relay, Sepolia); this guide uses `networks.devnet`
- **Use a free dedicated RPC**: the public devnet node is heavily rate limited (`429 Too Many Requests`), and deploying sends hundreds of transactions, so it often fails. Sign up for free at https://dashboard.helius.dev, copy the Devnet RPC URL, and put it in `.env`:
  ```bash
  DEVNET_RPC_URL=https://devnet.helius-rpc.com/?api-key=YOUR_KEY
  ```
  Measured: deploying via the public node failed several times; via Helius it took 14 seconds.
- Uses the system proxy automatically (`https_proxy` environment variable)
- Every successful transaction prints an explorer link
- Amounts are in token units, e.g. `--amount 1.5` means 1.5 USDC

---

## 1. Create test accounts

```bash
cp .env.example .env     # once (keygen also creates it if missing)
yarn -s cli keygen
```

This fills every **empty** key in `.env` with a new wallet (existing keys are never overwritten) and prints the addresses:

| `.env` variable | Role | Purpose | Needs SOL? |
|---|---|---|---|
| `ADMIN_PRIVATE_KEY` | admin + deployer | deploys the program (becomes upgrade authority), initializes, updates config, pauses; also the issuer of self-issued test tokens | ✅ ~7 SOL |
| `OPERATOR_PRIVATE_KEY` | operator | pays users (debit) | ✅ 0.2 SOL (sent by admin) |
| `REBALANCER_PRIVATE_KEY` | rebalancer | rebalance, add liquidity | ✅ 0.2 SOL (sent by admin) |
| `FEEPAYER_PRIVATE_KEY` | platform gas sponsor | pays gas for users' deposit transactions | ✅ 0.2 SOL (sent by admin) |
| `FEE_WALLET_PRIVATE_KEY` | platform fee wallet | receives the fee on payouts | ❌ |
| `USER_PRIVATE_KEY` | test user 1 | deposits (**0 SOL, signs only**, verifies gas sponsoring) | ❌ |
| `USER2_PRIVATE_KEY` | test user 2 | receives payouts (no USDC account, verifies automatic creation) | ❌ |
| `ENCRYPTION_SECRET_KEY` | V2 encryption key | encrypts/decrypts the destination params of V2 deposits | — |
| `EVM_PRIVATE_KEY` | Sepolia test wallet | the destination vault for CCTP rebalancing, and submits `receiveMessage` on Sepolia | a little **Sepolia ETH** |

To use your own wallet for a role (e.g. admin from Phantom), paste its base58 private key into `.env` **before** running `keygen`; only empty lines get new wallets. If you still have an old `keys/devnet` directory, run `yarn -s cli import-keys --dir keys/devnet` instead.

Fund the Sepolia address printed for `evm` with some Sepolia ETH (0.05 is enough for the `receiveMessage` gas), e.g. Google's faucet https://cloud.google.com/application/web3/faucet/ethereum/sepolia .

> `.env` is the **only** copy of these wallets: back it up, never commit it.

You can always list all addresses and balances with:

```bash
yarn -s cli balances
```

Newly generated wallets have a 0 balance on chain; fund them in the next step.

---

## 2. Get devnet SOL

Prepare about **7 SOL** for **admin** (`yarn -s cli env-check` prints the exact deploy cost):

| Purpose | Amount |
|---|---|
| program data account rent (~482KB) | ~3.4 SOL (reclaimable after testing) |
| temporary buffer account during deploy | ~3.4 SOL (refunded once the deploy succeeds) |
| sent to operator / rebalancer / feepayer | 0.6 SOL |
| tx fees and small account rents | < 0.05 SOL |

**Option 1 (recommended): web faucet**

Open https://faucet.solana.com, choose **Devnet**, enter the admin address and request SOL. Signing in with GitHub raises the limit. Repeat if needed.

**Option 2: command line**

```bash
yarn -s cli airdrop --to admin --sol 2
```

The devnet faucet is rate limited; on `rate limit` wait a while or use the web faucet.

**Check the balance:**

```bash
yarn -s cli balances       # or: yarn -s cli env-check (also shows how much SOL the deploy needs)
```

---

## 3. Deploy the program

Deploy with the admin wallet, so admin becomes the program's upgrade authority (only it can initialize):

```bash
yarn -s cli env-check      # network ✔, admin balance, "deployed no"
yarn -s cli deploy
```

`deploy` runs `solana program deploy ... --use-rpc` with `ADMIN_PRIVATE_KEY` (written to a temporary file that is deleted right after). `--use-rpc` sends every transaction through plain HTTP RPC: without it the solana CLI connects to validators over WebSocket, which fails behind a proxy with `Should return a valid tpu client: PubsubError(ConnectionError(... Connection reset by peer))`.

The deploy sends hundreds of small transactions; with a dedicated RPC it takes well under a minute. On success it prints `Program Id: A38GT8a6E1ySMM91Ly9rNCNbUPfFxLYgUt7X9dFmv2rK` and the upgrade authority (= admin).

**Check the result:**

```bash
solana program show A38GT8a6E1ySMM91Ly9rNCNbUPfFxLYgUt7X9dFmv2rK -u devnet   # or your RPC URL
```

Confirm two things:
- `Authority` is the admin address
- `Balance` is the program data rent (~2 SOL)

> `yarn -s cli deploy` uses `solana program deploy`, not `anchor deploy`: the latter also uploads the IDL on chain, costing extra rent we don't need for testing.
>
> If the deploy fails midway, it leaves a buffer account holding ~2 SOL: `yarn -s cli deploy --close-buffers` reclaims it, then run `yarn -s cli deploy` again.

---

## 4. Initialization and configuration

### 4.1 Send SOL to the roles

```bash
yarn -s cli fund --sol 0.2
```

admin sends 0.2 SOL each to operator, rebalancer and feepayer.

To send SOL from admin to any single address:

```bash
yarn -s cli send-sol --to <address> --sol 0.5
```

- `--to`: a base58 address or a role name (`operator`, `user` ...)
- `--sol`: amount in SOL (up to 9 decimals); a brand-new address must receive at least the rent-exempt minimum (the command checks first and prints the exact amount)
- `--from`: optional sender role, default `admin`

### 4.2 Prepare USDC (pick one)

> ⚠️ Pick **before** creating the USDC pool in 4.3: the pool is bound to the mint chosen here.
>
> ⚠️ **Testing CCTP bridging (5.7) requires option A.** CCTP only accepts USDC issued by Circle; self-issued test tokens cannot be bridged.

#### Option A (recommended): official Circle devnet USDC

The Circle devnet USDC mint is `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, 6 decimals.

**① Select the token and create USDC accounts for the roles**

```bash
yarn -s cli use-usdc --mint circle
```

- Checks that the mint exists on devnet and has 6 decimals, then writes it to `config.json` `networks.devnet.pools.USDC.mint` (already the Circle mint by default)
- Creates USDC accounts for user, rebalancer, operator and fee-wallet (rent paid by admin). Later payouts include a `CreateIdempotent` for the fee wallet, which does nothing because the account already exists
- Prints the user and rebalancer addresses for the faucet

**② Request USDC from the faucet**

Open https://faucet.circle.com, choose **USDC** and **Solana Devnet**, and request USDC for both **user** and **rebalancer** (about 20 USDC each time).

**③ Check the balances**

```bash
yarn -s cli balances
```

**④ (optional) Move USDC between test accounts**

```bash
yarn -s cli send-usdc --from rebalancer --to user --amount 5
```

user has no SOL; when sending from user the feepayer pays the gas automatically.

> Option A gives you little USDC, so reduce the amounts in step 5 as listed in 5.0.

#### Option B: issue your own test USDC (as much as you like)

```bash
yarn -s cli create-usdc --amount 1000
```

- Creates a 6-decimal test token used as USDC, admin is the issuer, the mint is saved to `config.json` `networks.devnet.pools.USDC.mint` (replacing the Circle mint; put it back to use option A again)
- Mints 1000 each to user and rebalancer
- Creates USDC accounts for operator and fee-wallet

The program treats both options the same: the token is passed in when the pool is created; no USDC address is hard-coded.

#### Also prepare a test USDT (multi-token tests)

There is no official USDT on devnet; issue a 6-decimal test token to simulate it:

```bash
yarn -s cli create-token --symbol usdt --amount 1000
```

The mint is saved to `config.json` `networks.devnet.pools.USDT.mint`; select it with `--mint usdt`.

### 4.3 Initialize the program + create token pools

One command, driven by `config.json` `networks.devnet` (pools: USDC watermark 5, USDT watermark 50 with per-tx limit 100; routes: none yet):

```bash
yarn -s cli setup --dry-run   # preview
yarn -s cli setup             # initialize (roles from .env) + create_pool for every token with a mint
```

- Only admin (the upgrade authority) can initialize; operator and rebalancer are the wallets in `.env` (or `addresses` in `config.json`)
- `setup` only sends what differs from `config.json`, so running it again is safe. Change a watermark in `config.json` and run it again to update the pool

The same steps one at a time (equivalent, e.g. to experiment with other values):

```bash
yarn -s cli init                                              # creates only the global Config (roles)
yarn -s cli create-pool --mint usdc --watermark 5             # USDC pool
yarn -s cli create-pool --mint usdt --watermark 50 --max-debit 100   # USDT pool, per-tx payout limit 100
```

The current status is printed afterwards. Check it any time with:

```bash
yarn -s cli status
```

### 4.4 Update the configuration (optional)

```bash
yarn -s cli set-pool --mint usdc --watermark 50     # change the USDC pool watermark
yarn -s cli set-pool --mint usdc --max-debit 5      # USDC per-tx payout limit 5 (0 = unlimited)
yarn -s cli set-config --operator <new address>     # replace the operator (role names work too, e.g. --operator user2)
```

---

## 5. Feature tests

Run in order. Every step lists the expected result.

### 5.0 Amounts for option A (Circle USDC)

The commands below assume option B (1000 USDC each). With option A user and rebalancer only have about 20 USDC each, so reduce these amounts; everything else stays the same:

| Step | Option B command | Option A |
|---|---|---|
| 5.3 | `add-liquidity --amount 200` | `add-liquidity --amount 10` |
| 5.5 | `set-pool --max-debit 5`<br>`payout ... --amount 6` (expected to fail)<br>`payout ... --amount 5` (expected to succeed) | `set-pool --max-debit 2`<br>`payout ... --amount 3`<br>`payout ... --amount 2` |
| 5.7 | (option A only) | run the 5.7 commands as written |

If you run out of USDC, request more from the faucet or move funds with `send-usdc`.

### 5.1 User deposit V1 (plaintext, gas sponsored)

```bash
yarn -s cli deposit --amount 1 --fee 0.05
```

✅ Expected: success. user still has 0 SOL (gas paid by feepayer); the vault grows by 1.

Optional args: `--recipient 0x...` (BSC receiving address), `--token 0x...` (meme contract), `--chain 56`.

### 5.2 User deposit V2 (encrypted params)

```bash
yarn -s cli deposit-v2 --amount 2 --fee 0.05
```

✅ Expected: success. In the explorer **there is no plaintext BSC address or meme contract** in the transaction.

### 5.3 Add liquidity

```bash
yarn -s cli add-liquidity --amount 200
```

✅ Expected: rebalancer's USDC drops by 200, the vault grows by 200.

### 5.4 Pay a user (with fee)

```bash
yarn -s cli payout --user user2 --amount 0.899372 --fee 0.004148
```

✅ Expected:
- One transaction does three things: creates user2's USDC account (if missing), sends 0.899372 to user2, sends 0.004148 to fee-wallet
- Same amounts as the real pump transaction

### 5.5 Per-tx limit

```bash
yarn -s cli set-pool --mint usdc --max-debit 5
yarn -s cli payout --user user2 --amount 6      # ❌ expected failure: ExceedsMaxDebit
yarn -s cli payout --user user2 --amount 5      # ✅ expected success
yarn -s cli set-pool --mint usdc --max-debit 0  # back to unlimited
```

### 5.6 Independent pause flags

```bash
yarn -s cli pause --mint usdc --deposit true --withdraw false
yarn -s cli deposit --amount 1                  # ❌ expected failure: DepositPaused
yarn -s cli payout --user user2 --amount 1      # ✅ expected success (withdrawals not paused)

yarn -s cli pause --mint usdc --deposit false --withdraw true
yarn -s cli payout --user user2 --amount 1      # ❌ expected failure: WithdrawPaused
yarn -s cli deposit --amount 1                  # ✅ expected success

yarn -s cli pause --mint usdc --deposit false --withdraw false   # resume everything
```

### 5.7 CCTP rebalance: Solana devnet -> Ethereum Sepolia (requires option A)

The rebalancer bridges the vault balance above the watermark to a destination vault via Circle CCTP V2 (standard mode). For testing, the destination vault is the Sepolia address of `EVM_PRIVATE_KEY`.

**⓪ admin registers the destination vault (once per chain)**

The recipient is not passed by the rebalancer; it is registered in the program per domain (CctpRoute). Register Sepolia (domain 0) first:

```bash
yarn -s cli set-route --domain ETHEREUM                # (= --domain 0) defaults to the EVM_PRIVATE_KEY address (testing)
yarn -s cli status                                     # the last section [CCTP routes] shows domain 0 ETHEREUM -> 0x...
```

Permanent routes (production) go in `config.json` instead, e.g. `"cctp": { "routes": { "ETHEREUM": "0xOurVault..." } }`, applied with `yarn -s cli setup`. Domain names come from `cctp.domains`.

- Update: run `set-route` again with a new address; remove: `yarn -s cli remove-route --domain 0` (the ~0.0012 SOL rent goes back to admin)
- The first registration of a route costs admin ~0.0012 SOL rent

**① Check how much can be moved**

```bash
yarn -s cli status        # see "rebalanceable"
yarn -s cli evm-balance   # current ETH / USDC of the Sepolia wallet
```

**② Test the guards first (all should fail)**

```bash
yarn -s cli rebalance-cctp --amount 100                  # ❌ InsufficientBalance or BelowWatermark
yarn -s cli rebalance-cctp --amount 1 --domain 6         # ❌ domain 6 (Base) has no route yet; the CLI asks you to run set-route
yarn -s cli rebalance-cctp --amount 1 --domain 1000      # ❌ CCTP does not support domain 1000
yarn -s cli set-route --domain 5                         # ❌ InvalidDestinationDomain (cannot register Solana itself)
```

**③ Start the bridge transfer**

```bash
yarn -s cli rebalance-cctp --all --domain 0
```

- `--domain 0` is Ethereum (Sepolia). The recipient is the one registered in step ⓪; the command prints it for checking
- ✅ Expected: success; the vault balance drops to exactly the watermark (the surplus USDC is burned by CCTP)
- The command prints the **tx signature** and the **message account**; write them down for the next steps

**④ Wait for the Circle attestation**

```bash
yarn -s cli cctp-status --tx <signature from the previous step>
```

- `pending_confirmations`: Circle is waiting for Solana finality; standard mode usually takes tens of seconds to a few minutes, check again later
- `complete`: ready to receive on Sepolia
- "not indexed yet": the transaction is very fresh, try again in a few seconds

**⑤ Receive the USDC on Sepolia**

```bash
yarn -s cli cctp-receive --tx <signature> --dry-run    # optional: simulate first, no gas spent
yarn -s cli cctp-receive --tx <signature>              # submit for real, gas paid by the EVM_PRIVATE_KEY wallet
yarn -s cli evm-balance                                # ✅ Sepolia USDC increased by the bridged amount
```

- `cctp-receive` waits until the attestation is ready (up to 600 seconds by default, adjustable with `--wait`), then calls `receiveMessage` on Sepolia's MessageTransmitterV2
- A message can only be received once; a second attempt fails with `Nonce already used`
- The command prints the Sepolia transaction link, viewable at https://sepolia.etherscan.io

**⑥ (optional) Reclaim the message account rent**

Every bridge transfer costs the rebalancer about **0.0039 SOL** rent for the CCTP message account. After the window defined by CCTP it can be reclaimed:

```bash
yarn -s cli cctp-reclaim --tx <signature> --event <message account>
```

`EventAccountWindowNotExpired` means it is too early; try again in a few days.

### 5.8 Permission checks

```bash
yarn -s cli payout --user user2 --amount 1 --operator rebalancer   # ❌ expected failure: Unauthorized
yarn -s cli rebalance-cctp --amount 1 --rebalancer operator        # ❌ expected failure: Unauthorized
```

### 5.9 Two-step admin transfer (optional)

```bash
yarn -s cli transfer-admin --to operator        # step 1: admin nominates operator
yarn -s cli status                              # pending_admin = operator address, admin unchanged
yarn -s cli accept-admin --key operator         # step 2: operator accepts
yarn -s cli status                              # admin = operator address

# transfer back (cleanup needs admin to be ADMIN_PRIVATE_KEY again)
yarn -s cli transfer-admin --to admin --admin operator
yarn -s cli accept-admin --key admin
```

### 5.9b Multi-token: the USDT pool

```bash
yarn -s cli deposit-v2 --amount 30 --fee 0.3 --mint usdt        # ✅ user deposits USDT into the USDT vault
yarn -s cli add-liquidity --amount 200 --mint usdt              # ✅ top up the USDT pool
yarn -s cli payout --user user2 --amount 20 --fee 0.5 --mint usdt   # ✅ backend pays user + fee in USDT
yarn -s cli payout --user user2 --amount 101 --mint usdt        # ❌ ExceedsMaxDebit (USDT pool per-tx limit 100)
yarn -s cli rebalance-cctp --amount 1 --mint usdt               # ❌ rejected by CCTP (local_token AccountNotInitialized; CCTP only supports USDC)
yarn -s cli pause --mint usdt --deposit true --withdraw false    # pause USDT deposits only
yarn -s cli deposit --amount 1 --mint usdt                      # ❌ DepositPaused
yarn -s cli deposit --amount 1                                  # ✅ USDC deposits unaffected
yarn -s cli pause --mint usdt --deposit false --withdraw false   # resume
yarn -s cli status                                              # balance, watermark, limit and pause flags of each pool
```

### 5.10 View all events

```bash
yarn -s cli events --limit 30
```

Lists all program events in chronological order. V2 deposits are **decrypted automatically with `ENCRYPTION_SECRET_KEY`**, showing the destination addresses. This is exactly the data the backend listener receives.

### 5.11 Test the upgrade-authority transfer script (optional)

The script takes key **files**: write temporary ones from `.env`, and delete them afterwards:

```bash
yarn -s cli keyfile --role admin    --out /tmp/admin.json
yarn -s cli keyfile --role operator --out /tmp/operator.json
# transfer to operator (keypair file, the new wallet co-signs)
./scripts/transfer-upgrade-authority.sh /tmp/operator.json -u devnet -k /tmp/admin.json
# transfer back to admin (closing the program in step 8 needs admin as upgrade authority)
./scripts/transfer-upgrade-authority.sh /tmp/admin.json -u devnet -k /tmp/operator.json
rm /tmp/admin.json /tmp/operator.json
```

The script asks for the last 4 characters of the program id (`v2rK`) to confirm.

### 5.12 Program upgrade (example: adding CCTP routes and Relay rebalancing)

Solana programs can be upgraded in place: **the program address stays the same and existing on-chain data (Config, Pool, the funds in the vaults) is kept**; only the code is replaced. Only the upgrade authority (admin here) can upgrade.

**① Before upgrading: can the new code read the old data?**

| Change | Upgrade directly? |
|---|---|
| new instructions, new account types (here: `CctpRoute`, `rebalance_relay` / `reclaim_relay_refund`) | ✅ yes, old data is unaffected |
| changed instruction args (here: `rebalance_cctp` dropped `mint_recipient`) | ✅ yes, but old SDK / backend calls will fail, so update them **at the same time** |
| changed fields of existing accounts (Config / Pool): add/remove, reorder, change type | ❌ no: old accounts keep the old layout and the new code would read garbage; a migration instruction is needed (or reserve space up front) |

**② Build the new version**

```bash
NO_DNA=1 ~/.avm/bin/anchor-1.2.2 build
solana address -k target/deploy/cross_vault-keypair.json   # must still be A38GT8a6E1ySMM91Ly9rNCNbUPfFxLYgUt7X9dFmv2rK
ls -l target/deploy/cross_vault.so                         # new version ~482KB (old one 397KB)
```

**③ Upgrade (same command as the first deploy)**

```bash
yarn -s cli deploy
```

- The program already exists, so the CLI runs the upgrade flow: it writes the new code into a temporary buffer account, then swaps it in at once.
- The buffer temporarily needs ~2.5 SOL rent, refunded to admin after the upgrade.
- If the new code is larger, the CLI extends the program automatically (`extend`); the extra space costs additional rent (~0.005 SOL per KB, ~0.43 SOL here) which stays locked while the program exists.
- If it fails midway, reclaim the buffer with `yarn -s cli deploy --close-buffers` and run it again.
- Until the upgrade is done, the new CLI cannot call the old program for changed instructions (`rebalance-cctp`, `set-route`).

**④ Verify after upgrading**

```bash
solana program show A38GT8a6E1ySMM91Ly9rNCNbUPfFxLYgUt7X9dFmv2rK -u devnet   # Last Deployed In Slot increased, Data Length is the new size
yarn -s cli status       # roles, pools and vault balances are all still there
yarn -s cli set-route --domain 0    # the new instruction works
```

> Mainnet: once the upgrade authority belongs to a Squads multisig, upgrades are proposed in Squads and approved by the members (upload the buffer with `solana program write-buffer` first, then create a "program upgrade" proposal in Squads).

### 5.13 Relay rebalance: Solana -> BSC (MAINNET only, small amounts)

Relay has **no Solana devnet deployment** (its testnet API lists no Solana chain), so this cannot be tested on devnet. The local tests (`anchor test`) already run the real Relay program dumped from mainnet; the real end-to-end check must be done on mainnet with a few USDC.

Preparation (once): a mainnet deployment of the program with a USDC pool (see [deployment-guide.md](deployment-guide.md)), and in `.env`: `MAINNET_RPC_URL`, `MAINNET_ADMIN_PRIVATE_KEY` and `MAINNET_REBALANCER_PRIVATE_KEY` (~0.01 SOL); mainnet never reads the shared keys. Set the BSC receiving address in `config.json` `networks.mainnet.relay.defaultRecipient` (or pass `--recipient`). Optional: `RELAY_API_KEY` in `.env` for higher rate limits. Add `--network mainnet` to every command below (or `export NETWORK=mainnet`).

```bash
export NETWORK=mainnet     # same as adding --network mainnet to each command

# 1. quote only (no transaction): checks the quote and prints output, fee, orderId
yarn -s cli relay-quote --amount 5                      # default: config.json relay (BSC USDT, relay.defaultRecipient)
yarn -s cli relay-quote --amount 5 --to-token 0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d   # BSC USDC instead

# 2. bridge 5 USDC above the watermark (fails with BelowWatermark otherwise; --min-out guards the output)
yarn -s cli rebalance-relay --amount 5 --min-out 4.9

# 3. status (requestId printed by step 2) -> "success"; then check the BSC address on bscscan
yarn -s cli relay-status --request 0x...

# 4. if Relay refunded, the USDC is in "relay staging" (shown by status); move it back into the vault
yarn -s cli status
yarn -s cli relay-reclaim
```

What `rebalance-relay` does: gets a quote with user = refundTo = the USDC Pool PDA -> `checkRelayQuote` (Relay instruction, accounts, amount, order id, every recipient = our address, refunds to the Pool, minimum output) -> sends `rebalance_relay(amount, orderId)` -> notifies Relay with `POST /transactions/index`.

### Feature test checklist

| # | Feature | Result |
|---|---|---|
| 5.1 | deposit V1, user with 0 SOL | ☐ |
| 5.2 | deposit V2, no plaintext on chain | ☐ |
| 5.3 | add liquidity | ☐ |
| 5.4 | payout + fee + automatic account creation | ☐ |
| 5.5 | per-tx limit | ☐ |
| 5.6 | independent deposit/withdraw pause | ☐ |
| 5.7 | CCTP: register route -> bridge -> attestation -> received on Sepolia | ☐ |
| 5.8 | permission checks | ☐ |
| 5.9 | two-step admin transfer | ☐ |
| 5.9b | multi-token: USDT deposit / payout / per-tx limit / no CCTP / per-pool pause | ☐ |
| 5.10 | events and V2 decryption | ☐ |
| 5.11 | upgrade-authority transfer script | ☐ |
| 5.12 | program upgrade | ☐ |
| 5.13 | Relay (mainnet): quote check -> deposit -> received on BSC; refund reclaim | ☐ |

---

## 6. Quick balance check

```bash
yarn -s cli balances    # SOL / token balances of all roles + vaults
yarn -s cli status      # program config, pool status, CCTP routes
```

---

## 7. Common errors

| Error | Cause / fix |
|---|---|
| `airdrop request failed ... rate limit` | devnet faucet rate limit, use the web faucet https://faucet.solana.com |
| deploy: `Should return a valid tpu client: PubsubError ... Connection reset by peer` | WebSocket cannot connect behind a proxy; add `--use-rpc` to the deploy command |
| deploy: `Max retries exceeded` / `429 Too Many Requests` | public devnet node rate limit, switch to a dedicated RPC such as Helius (section 0.3). A failed deploy leaves a buffer account holding ~2 SOL: reclaim it with `yarn -s cli deploy --close-buffers` |
| deploy: `Account allocation failed: an account with the same address already exists` | a buffer account left over from an interrupted deploy, or the RPC is out of sync. Close it as in the previous row, then deploy again |
| deploy: `insufficient funds` | admin does not have enough SOL; `yarn -s cli env-check` shows how much the deploy needs |
| `init` / `setup` fails with `Unauthorized` / `initialize must be sent by the upgrade authority` | the program was deployed by a different wallet than `ADMIN_PRIVATE_KEY` |
| `network is devnet but the RPC (...) is ...` | `DEVNET_RPC_URL` in `.env` points to another network |
| `create-pool` fails with `already in use` | that pool already exists; check with `yarn -s cli status` |
| `..._PRIVATE_KEY is not set in .env` / `... pools.USDT.mint is empty` | run `yarn -s cli keygen` first; for tokens `yarn -s cli use-usdc --mint circle` or `yarn -s cli create-token --symbol usdt` |
| fund commands fail with `AccountNotInitialized` (pool) | the token has no pool yet; run `yarn -s cli create-pool --mint <token>` |
| `rebalance-cctp` fails with `AccountNotInitialized` (route) | the domain has no registered route; run `yarn -s cli set-route --domain <CHAIN>` or add it to `config.json` `cctp.routes` + `setup` |
| `rebalance-cctp`: `CCTP does not support domain ...` | not a CCTP domain; the names and numbers are in `config.json` `cctp.domains` (0=Ethereum/Sepolia, 2=OP, 3=Arbitrum, 6=Base) |
| `use-usdc`: `is not a valid token mint` | wrong network: the Circle address only exists on devnet |
| balance shows `(no account)` | the role has no USDC account yet; with option A run `use-usdc --mint circle` again (existing accounts are skipped) |
| `transaction not confirmed in time` | devnet congestion, run it again |
| `rebalance-cctp` fails with CCTP errors like `InvalidLocalTokenState` | not Circle USDC (option B's self-issued token cannot be bridged) |
| `cctp-receive` fails with `insufficient funds` | the Sepolia wallet has no ETH, get some from the faucet |
| `cctp-receive` fails with `Nonce already used` | the message was already received |
| `rebalance-relay` / `relay-quote`: `unsafe Relay quote: ...` | the quote did not pass the safety check (e.g. `minimum output ... < ...`: lower `--min-out` or try later); nothing was sent |
| `relay-quote` fails with `Relay quote failed (400)` | the token or amount is not supported by Relay; on devnet always (Relay is mainnet only); amounts that are too small cannot cover fees |
| `rebalance-relay`: `Relay has no token account for ...` | Relay has never received this token, so a PDA cannot be the first depositor; use USDC / USDT |
| Node connection timeouts | check the proxy: `echo $https_proxy`; the CLI uses it automatically |

---

## 8. After testing: drain the vaults, close the program, reclaim SOL

**Follow the order.** Step 8.1 must come before 8.2: once the program is closed, any USDC left in the vaults is locked forever.

### 8.1 Drain the vaults

```bash
yarn -s cli drain
```

For **every pool**: admin unpauses and removes the per-tx limit, then operator moves the whole vault balance to its own account with `debit`.

✅ Expected: every pool shows `vault balance   0` at the end.

### 8.2 (optional) Remove CCTP routes

```bash
yarn -s cli remove-route --domain 0
```

Refunds the ~0.0012 SOL route rent to admin. Must be done before closing the program.

### 8.3 Close the program and reclaim its rent

```bash
yarn -s cli close-program      # asks for the last 4 characters of the program id (v2rK); refused on mainnet
```

It refuses while any vault still holds tokens (run 8.1 first). ✅ Expected: prints `Closed Program Id ..., ... SOL reclaimed`, the SOL goes back to admin.

### 8.4 Reclaim buffer accounts left by failed deploys

```bash
yarn -s cli deploy --close-buffers
```

If no deploy ever failed, this shows an empty list, which is normal.

### 8.5 Send the remaining SOL of the roles back to admin

```bash
yarn -s cli sweep-sol      # operator, rebalancer, feepayer -> admin (everything minus the tx fee)
yarn -s cli balances
```

### 8.6 Ledger

Measured on a full local run: started with 10 SOL, **9.981 SOL** left after reclaiming, about **0.019 SOL** spent in total:

| Item | Amount | Reclaimable? |
|---|---|---|
| program data account | ~2.2 SOL | ✅ reclaimed in 8.3 |
| Config + Pool + vault token accounts + Program account | ~0.006 SOL | ❌ the program has no instruction to close them |
| CctpRoute accounts | ~0.0012 SOL each | ✅ reclaimed in 8.2 |
| roles' USDC accounts + test token mints | ~0.009 SOL | only after emptying them (`spl-token burn` + `spl-token close`); too small to bother |
| transaction fees | ~0.005 SOL | ❌ |

### 8.7 After closing

- **The same program id cannot be deployed on devnet again.** Mainnet is unaffected, it is a separate network.
- For another devnet round, use a new program id:
  ```bash
  solana-keygen new -o target/deploy/cross_vault-keypair.json --force --no-bip39-passphrase
  anchor keys sync        # writes the new id into lib.rs and Anchor.toml
  anchor build
  # then start again from step 3 (the wallets in .env can be reused)
  ```
- Before the mainnet launch, also use a fresh program id and **back up** `target/deploy/cross_vault-keypair.json`.

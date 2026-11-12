# cross_vault: multi-token Solana vault for cross-chain meme trading (USDC / USDT ...)

Users on Solana buy memes on BSC (or other chains) with USDC, matched by a centralized platform. **Users never need SOL.**

```
Buy:       user signs + feepayer pays gas -> deposit_for_swap (USDC into the vault, event emitted)
           -> backend listens to the event -> BSC vault buys the meme and sends it to the user's BSC address
Sell:      user sells the meme on BSC, the USDC stays in the BSC vault
           -> backend calls debit twice in one tx -> Solana vault pays the user in USDC and the platform fee
Rebalance: vault balance > watermark -> rebalancer calls rebalance_cctp -> program CPIs into Circle CCTP V2 to burn
           -> backend fetches the Circle attestation -> receiveMessage on the destination chain
           -> USDC minted to our vault on that chain
           chains CCTP does not reach (BSC ...): backend gets a Relay quote -> rebalancer calls rebalance_relay
           -> program CPIs into the Relay Depository -> a Relay solver pays our vault on that chain within seconds
           vault balance too low -> top up with add_liquidity
```

---

## 1. Analysis of the pump vault (on-chain reverse engineering)

Program `Dsug6JqUcLJaTJCx7ufPREeHjnMakmVEAYSi5oaAEnzK` (written with Anchor). Two core instructions:

### 1.1 Buy: `DepositForSwapV2` (sample tx `4nCsVR...`)
- Signers: the pump feepayer `FHpc...` (pays gas) + the user's wallet (signs only). The feepayer is **not in the instruction accounts**, it only pays the fee
- Params: order id (16 bytes) / amount 1 USDC / fee 0.05 USDC / user's BSC address / BSC meme contract / minimum amount out
- Events emitted with `emit_cpi!` (stored in inner instructions, never truncated like logs)
- BSC tx `0xe24849...`: the BSC vault `0x836b...` buys the meme with the **same order id** and sends it to the user's BSC address

### 1.2 Sell: `AdminDebit` x2 (sample tx `5ZG7Xh...`)
| Instruction | Recipient | Amount | Meaning |
|---|---|---|---|
| AdminDebit #1 | user's USDC account `EHtR...` | 0.899372 | sale proceeds |
| AdminDebit #2 | pump fee account `3F72...` | 0.004148 | platform fee |

- Both instructions share the same order id (`...f7e7afaf`); the only signer is the pump admin `6aQt...` (also pays gas)
- BSC tx `0x485285...`: meme transferred into the BSC vault -> sold for ~0.92 USDC kept in the vault -> event with the same order id
- Accounts: `5Zs2...` is the vault state PDA (also the authority of the vault USDC account `2zQ9...`), `6cN2...` is the Config (stores the admin pubkey)

### 1.3 All pump instructions (decompiled from `solana program dump`, crate `pump-bridge`, closed source, no on-chain IDL)

Accounts: `Config` = PDA `["config"]` (admin); `Pool` = PDA `["pool", mint]` (one pool per token); vault = PDA `["vault", pool]`; `Receipt` (liquidity receipt).

| Pump instruction | Purpose (inferred from error strings / on-chain txs) | This project |
|---|---|---|
| `Initialize` | creates Config, checks the caller is the program upgrade authority | ✅ `initialize` (same upgrade-authority check) |
| `CreatePool` | creates a pool per mint, rejects unsupported Token-2022 extensions (pump only has a USDC pool on chain) | ✅ `create_pool` (one pool per token, classic SPL Token only) |
| `DepositForSwap` | user deposit, destination address/token in plaintext | ✅ `deposit_for_swap` |
| `DepositForSwapV2` | same, but destination params are **encrypted** (1-256 bytes) so bots cannot see which token is bought and front-run | ✅ `deposit_for_swap_v2` |
| `AdminDebit` | transfer from the vault to any account (not back to the vault); cannot drop below user liquidity; **no per-tx / daily limit** | ✅ `debit` (any account, called once for the payout and once for the fee); plus `rebalance_cctp` (watermark-limited, bridges directly via CCTP) |
| `AdminDeposit` | admin tops up the vault | ✅ `add_liquidity` |
| `DepositLiquidity` / `Withdraw` / `CloseReceipt` | third parties deposit liquidity for a Receipt, withdraw with it, close it when empty; limited by a hardcap | ➖ not needed (only the platform provides liquidity) |
| `SetHardcap` | sets the pool liquidity cap (currently 1,000,000 USDC) | ➖ same as above |
| `SetPauseFlags` | per pool, deposits and withdrawals paused **independently** | ✅ `set_pause_flags` (per pool) |
| `TransferAdmin` / `AcceptAdmin` | two-step admin transfer | ✅ `transfer_admin` / `accept_admin` |

Roles: pump has a single admin (a single-sig hot wallet `6aQt...` that both pays users and moves funds; only the program upgrade authority is a Squads 3/4 multisig). This project splits it into admin / operator / rebalancer.

### 1.4 Design of this project
- Account layout copied from pump: a global **Config** (roles only) + **one Pool per token** + one vault per pool. Day-to-day operations only emit events and never create accounts
- Payouts use a generic `debit` like pump: the backend decides which pool (USDC / USDT) pays, and puts two debits (user + fee) in one tx; the program does not store a fee account
- Three roles shared by all pools: **admin / operator / rebalancer**
- CCTP destinations are whitelisted per domain (`CctpRoute`), so the rebalancer can only bridge to our own vaults
- Relay (for chains without CCTP, e.g. BSC): funds can only go into the Relay Depository (fixed addresses in the program); the destination lives in Relay's off-chain order, so the backend checks every quote (`checkRelayQuote`) and a monitor checks every `RebalanceRelayEvent`
- `initialize` can only be called by the program upgrade authority, like pump, to prevent front-running

---

## 2. Project layout

```
programs/cross_vault/src/
├── lib.rs                  # program entry, 16 instructions
├── state.rs                # Config / Pool / CctpRoute accounts
├── events.rs               # events
├── errors.rs               # error codes
└── instructions/
    ├── mod.rs              # vault transfer-in / transfer-out helpers
    ├── admin.rs            # initialize / set_config / transfer_admin / accept_admin
    ├── pool.rs             # create_pool / set_pool_config / set_pause_flags (per pool)
    ├── deposit.rs          # deposit_for_swap / deposit_for_swap_v2
    ├── debit.rs            # debit
    ├── liquidity.rs        # add_liquidity
    ├── cctp_route.rs       # set_cctp_route / remove_cctp_route (register our vault contract on each destination chain)
    ├── rebalance_cctp.rs   # rebalance_cctp (CPI into CCTP V2 deposit_for_burn, recipient read from CctpRoute)
    └── rebalance_relay.rs  # rebalance_relay (CPI into Relay deposit_token) / reclaim_relay_refund
idls/                       # official CCTP V2 IDLs (read from devnet) + minimal hand-written Relay Depository IDL; declare_program! generates the CPI clients
tests/fixtures/cctp/        # CCTP programs and accounts dumped from devnet, loaded by the local validator (scripts/dump-cctp-fixtures.sh)
tests/fixtures/relay/       # Relay Depository program + config account dumped from MAINNET (scripts/dump-relay-fixtures.sh) + a real quote for SDK tests
client/vault-client.ts      # backend SDK
tests/cross_vault.ts        # integration tests
scripts/transfer-upgrade-authority.sh  # transfer the program upgrade authority after deployment (e.g. to a Squads multisig)
scripts/cli.ts              # CLI: yarn -s cli help (initialize, deposit, payout, CCTP bridging, Sepolia receive, events ...)
docs/devnet-testing-guide.md  # step-by-step devnet testing + reclaiming SOL afterwards
```

---

## 3. Accounts

| Account | Address | Description |
|---|---|---|
| Config | PDA `["config"]` | global singleton, roles only, created by `initialize` |
| Pool | PDA `["pool", mint]` | **one per token**, created by `create_pool`; also the vault authority |
| vault | PDA `["vault", pool]` | one token account per pool, holds that token |
| CctpRoute | PDA `["cctp_route", domain (u32 LE)]` | one per CCTP destination chain, created by `set_cctp_route` (~0.0012 SOL rent) |
| relay staging | ATA(mint, Pool) | one per pool, created by the first `rebalance_relay` (~0.002 SOL rent, paid by the rebalancer). Relay only accepts the sender's / refund recipient's ATA, and our vault is not an ATA, so Relay deposits pass through it and **Relay refunds land in it**; only the program can move funds out (`reclaim_relay_refund` -> vault) |

Config fields:

| Field | Description |
|---|---|
| `admin` | administrator: creates pools, updates roles and pool params, pauses, registers CCTP routes |
| `pending_admin` | pending new admin (during a two-step transfer), all zeros if none |
| `operator` | pays users and fees from the pools (admin may also call `debit`) |
| `rebalancer` | bridges the funds above the watermark to vaults on other chains via CCTP (USDC) or Relay (admin may also call `rebalance_cctp` / `rebalance_relay`) |

Pool fields (one per token):

| Field | Description |
|---|---|
| `mint` | token mint (mainnet USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, USDT `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`) |
| `vault` | vault token account |
| `watermark` | watermark |
| `max_debit_per_tx` | operator per-instruction `debit` limit, 0 = unlimited |
| `deposit_paused` | deposits paused (V1/V2 deposits of this token) |
| `withdraw_paused` | withdrawals paused (`debit` / `rebalance_cctp` / `rebalance_relay` of this token) |

CctpRoute fields (one per CCTP destination chain):

| Field | Description |
|---|---|
| `domain` | CCTP destination domain (Ethereum/Sepolia = 0, Base = 6 ...) |
| `mint_recipient` | address of **our own vault contract** on that chain, 32 bytes (EVM address left-padded with 12 zero bytes). `rebalance_cctp` can only bridge here |
| `bump` | PDA bump |

> Amounts are in base units (USDC / USDT both have 6 decimals, `1 USDC = 1_000_000`).

---

## 4. Instructions

| Instruction | Caller | Args | What it does | Event |
|---|---|---|---|---|
| `initialize` | program upgrade authority (the deploying wallet), becomes admin | `operator, rebalancer` | creates only the global Config; the accounts include this program (`this_program`) and its `program_data` to prevent front-running after deployment; operator / rebalancer cannot be the zero address (`InvalidRole`) | `InitializedEvent` |
| `create_pool` | admin | `watermark, max_debit_per_tx` | **adds a supported token**: pass the `mint`, creates its Pool and vault (mirrors pump `CreatePool`). Classic SPL Token only (USDC and USDT both qualify) | `PoolCreatedEvent` |
| `set_pool_config` | admin | `{watermark?, max_debit_per_tx?}`, `null` = unchanged | updates a pool's watermark and per-tx limit | `PoolConfigUpdatedEvent` |
| `set_pause_flags` | admin | `deposit_paused, withdraw_paused` | pauses a pool's deposits and withdrawals independently | `PauseFlagsUpdatedEvent` |
| `set_config` | admin | `{operator?, rebalancer?}`, `null` = unchanged | updates roles; new addresses cannot be all zeros (`InvalidRole`) | `ConfigUpdatedEvent` |
| `transfer_admin` | admin | `new_admin` | transfer step 1: nominate a new admin (the old admin keeps power until accepted; nominating again overrides) | `AdminTransferStartedEvent` |
| `accept_admin` | the nominated admin | — | transfer step 2: sign to accept and become admin | `AdminTransferredEvent` |
| `deposit_for_swap` | user (feepayer pays gas) | `{order_id, amount, fee, dest_chain_id, recipient, target_token, min_amount_out}` | user tokens -> the vault of that token (pass the `mint`/`pool`/`vault` of the token used), destination params in plaintext | `DepositForSwapEvent` (with `mint`) |
| `deposit_for_swap_v2` | user (feepayer pays gas) | `{order_id, amount, fee, encrypted_params}` | same, but destination params encrypted (1-256 bytes) | `DepositForSwapV2Event` (with `mint`) |
| `debit` | operator or admin | `order_id, amount` | transfers from the **pool chosen by the backend** to any token account `destination` of the same mint (not the vault itself). The backend decides whether to pay in USDC or USDT; two debits go in **one tx**: one to the user, one to the fee account; if the user has no token account, prepend a create-account instruction (operator pays ~0.002 SOL rent) | `DebitEvent` (with `mint`, `destination_owner`) |
| `add_liquidity` | anyone | `amount` | tops up a pool from the caller's token account | `AddLiquidityEvent` (with `mint`) |
| `set_cctp_route` | admin | `domain, mint_recipient` | adds or updates the address of our vault contract on a destination chain (the first call creates the CctpRoute account). `domain` cannot be 5 (Solana), the address cannot be all zeros | `CctpRouteSetEvent` (with the previous address) |
| `remove_cctp_route` | admin | `domain` | removes the route: account closed, rent refunded to admin; rebalancing to that chain is then impossible | `CctpRouteRemovedEvent` |
| `rebalance_relay` | rebalancer or admin | `amount, order_id` (32 bytes) | for chains CCTP does not reach (BSC ...), any token Relay accepts (USDC / USDT). Checks: withdrawals not paused, `amount > 0`, `order_id` not all zeros (`InvalidOrderId`), balance after transfer >= watermark. Then vault -> relay staging -> CPI into Relay `deposit_token(amount, order_id)` signed by the Pool PDA (sender = depositor = Pool). The Relay program / depository / vault addresses are constants in the program. `order_id` comes from a Relay quote with `user = refundTo = Pool PDA` | `RebalanceRelayEvent` |
| `reclaim_relay_refund` | anyone | — | moves the whole relay staging balance (Relay refunds) back into the vault; `InvalidAmount` if empty | `RelayRefundReclaimedEvent` |
| `rebalance_cctp` | rebalancer or admin | `amount, destination_domain` | **USDC pool only** (CCTP only supports Circle USDC; USDT calls are rejected by CCTP). The program CPIs into CCTP V2 `deposit_for_burn` as the USDC Pool PDA (**standard mode**: `min_finality_threshold = 2000`, `max_fee = 0`, `destination_caller` all zeros), burning vault USDC and creating a cross-chain message. Balance after transfer must be >= watermark; **the recipient is not passed by the caller**, it is read from the CctpRoute of `destination_domain` (unregistered domains fail with `AccountNotInitialized`). The accounts also include a freshly generated `message_sent_event_data` keypair (signer); its ~0.0039 SOL rent is paid by the rebalancer | `RebalanceCctpEvent` |

**Full CCTP flow** (wrapped in `client/vault-client.ts`):
0. (one-time) admin registers each destination vault with `setCctpRoute(program, adminKp, domain, "0xDestinationVault")`;
1. `rebalanceCctp(program, rebalancerKp, USDC, amount, domain)` starts the transfer and returns the tx signature and message account;
2. `fetchCctpAttestation(signature)` polls Circle Iris (testnet `iris-api-sandbox.circle.com`, mainnet `iris-api.circle.com`) until `status = complete`;
3. call MessageTransmitterV2 `receiveMessage(message, attestation)` on the destination chain. `destination_caller` is zero, so anyone can submit; the backend pays gas with its own EVM hot wallet;
4. reclaim rent: every CCTP transfer creates a message account (required by CCTP; Circle's attestation service reads the message from it) whose ~0.0039 SOL rent is paid by the rebalancer. After the window expires, `reclaimCctpEventAccount(connection, rebalancerKp, signature, messageAccount)` refunds it. Safe to call repeatedly; returns `reclaimed` / `already_closed` / `attestation_pending` / `window_not_expired`, suitable for a daily backend cron job.

**Full Relay flow** (Solana mainnet only: Relay has no Solana devnet; wrapped in `client/vault-client.ts`, CLI `rebalance-relay`):
1. `getRelayQuote({ mint, amount, destinationChainId: 56, destinationCurrency: BSC_USDT, recipient: BSC_VAULT })` calls `POST /quote/v2` with `user = refundTo = Pool PDA` and `includeProtocolData`;
2. `checkRelayQuote(quote, request)` **refuses to continue unless**: there is exactly one Relay `deposit_token` instruction with our Pool / mint and Relay's fixed accounts; the amount and order id match; every destination payment goes to our vault in the requested token; there are no destination calls; the Solana refund goes to the Pool PDA; optional minimum output. It returns `orderId` / `requestId`;
3. `rebalanceRelay(program, rebalancerKp, mint, amount, orderId)`: send soon after quoting, with exactly the quoted amount (otherwise Relay re-quotes or refunds);
4. `indexRelayTx(signature, requestId)` calls `POST /transactions/index`, because the deposit happens inside our program (CPI);
5. `getRelayStatus(requestId)` until success; the funds arrive on the destination chain within seconds;
6. on failure Relay refunds automatically (minus gas) to `refundTo` = Pool, i.e. into the relay staging account; `reclaimRelayRefund` (or CLI `relay-reclaim`) moves it back into the vault. `getPoolStatus` returns `relayStagingBalance`.

Relay addresses (Solana mainnet): program `99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2`, depository `Dodg2HifwU8rmaVVyMyUZDGTRbqAJTyVYxXPwcbNpBKc`, vault `7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ` (its USDC account `4nvJ5zWdVspxJiNZzB127U6amPH98SFFkBx2JZrAduia` exists). Relay chain id of Solana: `792703809`; BSC: `56`. Fee measured on 2026-11-10: ~0.26 USDC per 100 USDC, ~22 USDC per 10,000 USDC (CCTP standard mode is free).

> The program itself creates accounts only in three places: `initialize` creates the global Config (1); `create_pool` creates a Pool + vault per token (2); `set_cctp_route` creates one CctpRoute per destination chain (plus the relay staging ATA on a pool's first `rebalance_relay`). Day-to-day operations only emit events, which the backend persists.
> Like pump, every instruction only emits events with `emit_cpi!` and writes no `msg!` logs: events are never truncated, and we save the compute of base58-encoding addresses on chain; on errors Anchor logs the error code automatically.

| Network | CCTP addresses |
|---|---|
| Solana (same on mainnet / devnet) | TokenMessengerMinterV2 `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe`, MessageTransmitterV2 `CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC`, domain 5 |
| Ethereum Sepolia | MessageTransmitterV2 `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`, USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`, domain 0 |
| devnet USDC | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (CCTP only supports Circle USDC) |

`deposit_for_swap` args:
- `order_id`: 16-byte order id (UUID), the BSC side reconciles with the same id
- `amount`: total deposit (fee included); `fee`: must be `< amount`; amount actually used to buy = `amount - fee`
- `dest_chain_id`: BSC = 56; `recipient` / `target_token`: destination-chain addresses, 1-64 characters
- `min_amount_out`: minimum meme amount to receive (0 = no limit)

V2 encryption format (`encryptSwapParams` / `decryptSwapParams` in `client/vault-client.ts`):
- Algorithm: x25519 + XSalsa20-Poly1305 (tweetnacl `box`), a one-time ephemeral key per deposit
- Layout: `[ephemeral pubkey 32 bytes][nonce 24 bytes][ciphertext]`; the plaintext is JSON `{"c":chainId,"r":recipient,"t":memeContract,"m":minOut}`
- Platform key pair: generated with `generateEncryptionKeyPair()`; **the secretKey stays on the backend**, the publicKey goes to the frontend

Error codes: `Unauthorized` (wrong role / initializer is not the upgrade authority), `DepositPaused`, `WithdrawPaused`, `InvalidAmount`, `InvalidAddress`, `InsufficientBalance`, `BelowWatermark`, `InvalidEncryptedParams`, `ExceedsMaxDebit`, `InvalidDestinationDomain`, `InvalidMintRecipient`, `DestinationIsVault`, `InvalidProgramData`, `UnsupportedMint`, `NotPendingAdmin`, `InvalidRole` (zero address for operator / rebalancer), `InvalidOrderId` (all-zero Relay order id).

---

## 5. Backend SDK (`client/vault-client.ts`)

```ts
import { getProgram, buildDepositTx, assertSafeForFeePayer, orderId, MINTS, createPool, setPoolConfig,
         payoutToUser, debitIx, addLiquidity, rebalanceCctp, setCctpRoute, fetchCctpAttestation, CCTP, getPoolStatus,
         reclaimCctpEventAccount, getRelayQuote, checkRelayQuote, rebalanceRelay, indexRelayTx, getRelayStatus,
         reclaimRelayRefund, listenEvents, backfillEvents } from "./client/vault-client";

const program = getProgram(connection);
const USDC = MINTS.USDC_MAINNET, USDT = MINTS.USDT_MAINNET;

// 0) admin: add tokens (once per token) and register CCTP destination vaults (once per chain)
await createPool(program, adminKp, USDC, 1_000_000_000 /* watermark 1000 */, 0 /* per-tx limit: unlimited */);
await createPool(program, adminKp, USDT, 500_000_000, 0);
await setCctpRoute(program, adminKp, CCTP.DOMAIN.ETHEREUM, ETH_VAULT_ADDRESS);

// 1) user deposit (gasless)
const tx = await buildDepositTx(program, {
  user, feePayer: feePayer.publicKey, mint: USDC /* pass USDT if the user pays with USDT */,
  orderId: orderId.fromUuid(order.uuid), amount: 1_000_000, fee: 50_000,
  destChainId: 56, recipient: "0x3b7d...", targetToken: "0xe552...",
});
assertSafeForFeePayer(tx, feePayer.publicKey); // ⚠️ must be checked before the feepayer signs
tx.partialSign(feePayer);
// -> hand over to the third-party login wallet for the user to sign and send

// 1b) V2: the frontend encrypts destination params with the platform public key; only ciphertext goes on chain
const enc = encryptSwapParams({ destChainId: 56, recipient: "0x3b7d...", targetToken: "0xe552..." }, PLATFORM_PUBKEY);
const txV2 = await buildDepositV2Tx(program, { user, feePayer: feePayer.publicKey, mint: USDC,
  orderId: orderId.fromUuid(order.uuid), amount: 1_000_000, fee: 50_000, encryptedParams: enc });

// 2) listen to events -> buy on BSC (idempotent by order_id)
listenEvents(program, async (e) => {
  if (e.name === "depositForSwapEvent") { /* plaintext params, call the BSC vault to buy */ }
  if (e.name === "depositForSwapV2Event") {
    const p = decryptSwapParams(e.data.encryptedParams, PLATFORM_SECRET_KEY); // decrypt with the backend key
    /* buy on the BSC vault with p.recipient / p.targetToken */
  }
});
const missed = await backfillEvents(program, lastSignature); // periodic backfill

// 3) payout after the user sells on BSC (operator): the backend chooses USDC or USDT (pass that mint)
// one tx: [create user token account (skipped if it exists)] + debit(user 0.899372) + debit(fee 0.004148)
await payoutToUser(program, operatorKp, USDC, userPubkey, orderId.fromUuid(sell.uuid), 899_372, 4_148, FEE_WALLET);
// or build instructions yourself with debitIx (e.g. pay several users in one tx)

// 4) admin: independent pause flags / two-step transfer
await setPauseFlags(program, adminKp, USDT, true, false);   // pause USDT deposits only
await transferAdmin(program, adminKp, newAdmin.publicKey); // step 1: nominate
await acceptAdmin(program, newAdminKp);                    // step 2: the new admin accepts

// 5) rebalancing (rebalancer): check each pool's balance
const s = await getPoolStatus(program, USDC); // { pool, balance, relayStagingBalance, watermark, excess, deficit }
if (s.excess > 0n) {
  // bridge to the Ethereum vault (domain 0) via CCTP; the recipient is the one admin registered with setCctpRoute
  const { signature, messageSentEventData } = await rebalanceCctp(program, rebalancerKp, USDC, s.excess, CCTP.DOMAIN.ETHEREUM);
  // poll the Circle attestation; once complete call MessageTransmitterV2.receiveMessage(message, attestation) on Ethereum
  const att = await fetchCctpAttestation(signature, { testnet: false });
  // cron job: reclaim the message account rent after the window expires
  await reclaimCctpEventAccount(connection, rebalancerKp, signature, messageSentEventData, { testnet: false });
}
if (s.deficit > 0n) await addLiquidity(program, rebalancerKp, USDC, s.deficit);

// 6) rebalancing via Relay (chains without CCTP, e.g. BSC; also works for USDT)
const s2 = await getPoolStatus(program, USDT);
const req = { mint: USDT, amount: s2.excess, destinationChainId: 56,
              destinationCurrency: "0x55d398326f99059ff775485246999027b3197955" /* BSC USDT */, recipient: BSC_VAULT };
const checked = checkRelayQuote(await getRelayQuote(req), { ...req, minAmountOut: MIN_OUT }); // throws if unsafe
const sig = await rebalanceRelay(program, rebalancerKp, USDT, req.amount, checked.orderId);
await indexRelayTx(sig, checked.requestId);
await getRelayStatus(checked.requestId); // poll until success
// if Relay refunded (getPoolStatus(...).relayStagingBalance > 0): move it back into the vault
await reclaimRelayRefund(program, anyKp, USDT);
```

---

## 6. Build, test, deploy

| Tool | Version |
|---|---|
| Anchor CLI / anchor-lang / anchor-spl | 1.2.2 |
| Solana (Agave) CLI | 4.1.2 (platform-tools v1.58) |
| Rust | >= 1.89 |
| TS client | `@anchor-lang/core` 1.2.2 |

```bash
yarn install
anchor build
anchor test --validator legacy     # plain `anchor test` works if Surfpool is installed
solana program deploy target/deploy/cross_vault.so --program-id target/deploy/cross_vault-keypair.json -u devnet --use-rpc
```
Program id: `A38GT8a6E1ySMM91Ly9rNCNbUPfFxLYgUt7X9dFmv2rK`, its keypair is `target/deploy/cross_vault-keypair.json`; back it up (it is deleted together with `target/`).

### devnet testing

See [docs/devnet-testing-guide.md](docs/devnet-testing-guide.md): create accounts -> get SOL -> deploy -> initialize -> feature tests -> upgrade -> drain vaults / close the program / reclaim SOL.

### Mainnet launch steps (in order)
1. **Deploy**: `solana program deploy ...` (the deploying wallet = upgrade authority)
2. **Initialize**: call `initialize` with the deploying wallet (only the upgrade authority can)
3. **Create pools**: admin calls `create_pool(watermark, per-tx limit)` for every supported token (USDC, USDT ...)
4. **Register CCTP routes**: admin calls `set_cctp_route(domain, our vault contract)` for every destination chain
4.1 **Relay**: check Relay's token account exists for every token you will send (`ATA(mint, 7uTT8Xi5…)`; USDC exists), then run one small end-to-end `rebalance-relay` (e.g. 5 USDC) and confirm arrival and the refund path before automating it
5. **Transfer the upgrade authority to a multisig**:
   ```bash
   # pass the Squads multisig "vault address" (Vault address in the Squads UI, not the Multisig account address)
   ./scripts/transfer-upgrade-authority.sh <SquadsVaultAddress> -u mainnet-beta
   ```
   The script checks in order: the signer is the upgrade authority -> new address format -> the program is initialized (refuses otherwise) -> asks for the last 4 chars of the program id -> executes -> verifies on chain.
   - New authority as a **pubkey**: for multisigs (a multisig cannot sign directly, so the script adds `--skip-new-upgrade-authority-signer-check`)
   - New authority as a **keypair file**: the new wallet co-signs, which protects against typos; recommended for regular wallets
   - Other options: `-k` current authority keypair, `-p` program id, `-y` skip confirmation (CI only)
6. **Transfer the program admin to the multisig**: call `transfer_admin(multisig vault address)`, then create an `accept_admin` transaction in Squads and execute it once enough members sign
7. Future upgrades: `anchor build`, upload the new version with `solana program write-buffer`, then create an upgrade proposal in Squads

---

## 7. Notes & possible improvements

1. **Status (2026-11-12)**: `anchor build` succeeds on Anchor 1.2.2 and `anchor test --validator legacy` passes 31/31 (admin may also call `debit` / `rebalance_cctp` / `rebalance_relay`, covered by tests; Relay: the local validator loads the real Relay Depository dumped from mainnet; the CPI deposit, Relay's own `DepositEvent`, refund reclaim and the quote checks against a saved real quote are tested; a real mainnet Relay transfer has NOT been done yet; including USDC + USDT multi-token: pool isolation, per-pool pause, USDT cannot use CCTP; CCTP routes; the local validator loads the real CCTP V2 programs dumped from devnet and the CCTP test checks every field of the generated message). `transfer-upgrade-authority.sh` was tested on a local validator (refuses when uninitialized, cancels on a wrong confirmation code, transfer to a keypair, transfer to a pubkey, refuses without authority).
2. **feepayer safety**: always call `assertSafeForFeePayer` before signing, otherwise anyone could make the platform pay gas for arbitrary transactions.
3. **Duplicate payouts are prevented by the backend**: the program keeps no on-chain order records (kept simple, like pump); the backend must be idempotent by `order_id` and check whether an order was already paid before paying.
4. **initialize is restricted to the upgrade authority** to prevent front-running. If the upgrade authority is later moved to a multisig, initialize first or send initialize through the multisig; `[test] upgradeable = true` in `Anchor.toml` makes the local validator's upgrade authority the test wallet.
5. **V2 key safety**: leaking the platform encryption secretKey only exposes order contents (not funds), but rotate it regularly; during rotation the backend must keep both old and new keys for decryption.
6. **admin is powerful**: it could make itself rebalancer, register its own address as a route and set the watermark to 0 to drain funds. Use a multisig (Squads) for admin on mainnet.
6.1 **rebalance_cctp can only bridge to destination vaults registered by admin** (CctpRoute, one address per domain): if the rebalancer key leaks, an attacker can at most move the funds above the watermark to our own vaults on other chains. Changing a route requires the admin signature (a multisig on mainnet). The program does not check that the first 12 bytes of an EVM address are zero (Sui / Aptos use 32-byte addresses); the SDK's `setCctpRoute` pads 0x addresses automatically; verify routes with `yarn -s cli status` after registering.
7. **Per-pool debit limit**: `max_debit_per_tx` defaults to 0 (unlimited, like pump). On mainnet set it to the largest normal single order; raise it temporarily via admin or split large orders. It only limits each instruction: a leaked operator key can still drain via many debits, so keep the operator key in a secure signing service (KMS/HSM), monitor `DebitEvent` in the backend, and pause withdrawals of that pool with `set_pause_flags` on anomalies.
6.2 **rebalance_relay cannot verify the destination on chain**: Relay's `order_id` is only a hash of its off-chain order, so a leaked rebalancer key could request a quote paying an attacker and deposit up to the funds above the watermark. Mitigations: `checkRelayQuote` before every deposit; a monitor that looks up each `RebalanceRelayEvent.order_id` in the Relay API and calls `set_pause_flags` on mismatch; keep the watermark-excess small; keep the rebalancer key in a signing service. Rare edge case: if Relay can neither fill nor refund, the funds stay credited to the depositor (the Pool PDA) and need a signed Relay withdrawal, which a PDA cannot produce; that would need Relay support.
6.3 **Relay token accounts**: Relay creates its token account on first deposit of a token, paid by the sender; the Pool PDA cannot pay, so deposits of a token Relay has never received fail (check `ATA(mint, Relay vault)` first; the CLI does).
7.1 **USDT**: USDT cannot use CCTP; rebalance it with `rebalance_relay` (or swap to USDC on Solana first); Tether can freeze USDT, so keep the USDT watermark low; the backend decides which token users buy with and get paid in, and must account per `mint`.
8. **TS**: the Anchor 1.x TS client does not infer `tokenProgram`; pass `TOKEN_PROGRAM_ID` explicitly. Use `confirmed` for the provider.
9. **Reserved space before mainnet**: consider adding a `_reserved: [u8; N]` field at the end of Config and Pool so future fields can be added through upgrades without data migration.
10. **Optional enhancements**: on-chain order de-duplication (one PDA per order or a bitmap), multiple operators, a separate per-tx cap for `rebalance_relay` (in a new account, so the Pool layout does not change).

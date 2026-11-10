//! Events: all emitted via emit_cpi! (stored in inner instructions, never truncated like logs); the backend listens and persists them.
//! Every fund-related event carries `mint` so the backend can account per token.
use anchor_lang::prelude::*;

/// User deposit to buy a meme on another chain (V1: destination params in plaintext)
#[event]
pub struct DepositForSwapEvent {
    pub order_id: [u8; 16],
    pub user: Pubkey,
    /// Deposit token (USDC / USDT ...)
    pub mint: Pubkey,
    /// Total deposit amount (fee included)
    pub amount: u64,
    /// Fee (included in amount); amount actually used to buy on the destination chain = amount - fee
    pub fee: u64,
    pub dest_chain_id: u64,
    /// User's receiving address on the destination chain
    pub recipient: String,
    /// Meme token contract on the destination chain
    pub target_token: String,
    /// Minimum meme amount to receive (slippage protection, 0 = no limit)
    pub min_amount_out: u128,
    pub vault_balance: u64,
    pub timestamp: i64,
}

/// User deposit V2: destination params (recipient, meme contract, slippage ...) are encrypted with the platform public key,
/// so only ciphertext is visible on chain and bots cannot front-run; the backend decrypts it with the private key
#[event]
pub struct DepositForSwapV2Event {
    pub order_id: [u8; 16],
    pub user: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub fee: u64,
    /// Encrypted destination params (1-256 bytes)
    pub encrypted_params: Vec<u8>,
    pub vault_balance: u64,
    pub timestamp: i64,
}

/// operator transferred out of a pool (used for both user payouts and fees; the backend reconciles by order_id)
#[event]
pub struct DebitEvent {
    pub order_id: [u8; 16],
    pub operator: Pubkey,
    /// Token transferred
    pub mint: Pubkey,
    /// Destination token account
    pub destination: Pubkey,
    /// Owner of the destination account (user wallet / fee wallet)
    pub destination_owner: Pubkey,
    pub amount: u64,
    pub vault_balance: u64,
    pub timestamp: i64,
}

/// Someone added funds to a pool
#[event]
pub struct AddLiquidityEvent {
    pub from: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub vault_balance: u64,
    pub timestamp: i64,
}

/// The rebalancer bridged the pool's USDC above the watermark to a vault on another chain via Circle CCTP V2.
/// The backend queries Circle Iris with the tx signature for the attestation, then calls receiveMessage on the destination chain
#[event]
pub struct RebalanceCctpEvent {
    pub rebalancer: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    /// CCTP destination domain (Ethereum = 0, Base = 6 ...)
    pub destination_domain: u32,
    /// Destination recipient (EVM address left-padded with 12 zero bytes to 32 bytes)
    pub mint_recipient: Pubkey,
    /// CCTP account holding the cross-chain message; its rent can be reclaimed after the window expires
    pub message_sent_event_data: Pubkey,
    /// Minimum finality threshold: 2000 = standard mode
    pub min_finality_threshold: u32,
    pub watermark: u64,
    pub vault_balance: u64,
    pub timestamp: i64,
}

/// The rebalancer deposited the pool's funds above the watermark into the Relay Depository (for chains CCTP does not reach, e.g. BSC).
/// The destination recipient lives in Relay's off-chain order; the monitor checks order_id against the Relay API
#[event]
pub struct RebalanceRelayEvent {
    pub rebalancer: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    /// Relay orderId (from the quote)
    pub order_id: [u8; 32],
    pub watermark: u64,
    pub vault_balance: u64,
    pub timestamp: i64,
}

/// A Relay refund was moved from the relay staging account back into the vault
#[event]
pub struct RelayRefundReclaimedEvent {
    pub caller: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub vault_balance: u64,
    pub timestamp: i64,
}

/// admin created a new pool (added a supported token)
#[event]
pub struct PoolCreatedEvent {
    pub admin: Pubkey,
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub vault: Pubkey,
    pub watermark: u64,
    pub max_debit_per_tx: u64,
}

/// admin updated pool params
#[event]
pub struct PoolConfigUpdatedEvent {
    pub admin: Pubkey,
    pub mint: Pubkey,
    pub watermark: u64,
    pub max_debit_per_tx: u64,
}

/// Pool pause flags changed
#[event]
pub struct PauseFlagsUpdatedEvent {
    pub admin: Pubkey,
    pub mint: Pubkey,
    pub deposit_paused: bool,
    pub withdraw_paused: bool,
}

/// Program initialized (emitted only once), records the initial roles
#[event]
pub struct InitializedEvent {
    pub admin: Pubkey,
    pub operator: Pubkey,
    pub rebalancer: Pubkey,
}

/// admin updated roles
#[event]
pub struct ConfigUpdatedEvent {
    pub admin: Pubkey,
    pub operator: Pubkey,
    pub rebalancer: Pubkey,
}

/// admin nominated a new admin (step 1)
#[event]
pub struct AdminTransferStartedEvent {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
}

/// New admin accepted (step 2)
#[event]
pub struct AdminTransferredEvent {
    pub old_admin: Pubkey,
    pub new_admin: Pubkey,
}

/// admin added / updated the CCTP route of a chain
#[event]
pub struct CctpRouteSetEvent {
    pub admin: Pubkey,
    pub domain: u32,
    /// Previous address (all zeros when newly added)
    pub old_mint_recipient: Pubkey,
    pub mint_recipient: Pubkey,
}

/// admin removed the CCTP route of a chain (rebalancing to that chain is no longer possible)
#[event]
pub struct CctpRouteRemovedEvent {
    pub admin: Pubkey,
    pub domain: u32,
    pub mint_recipient: Pubkey,
}

//! On-chain state accounts (mirrors pump: one global Config + one Pool per token)
//!
//! - Config    PDA ["config"]                          global singleton, stores roles only
//! - Pool      PDA ["pool", mint]                      one per token (USDC, USDT ...): watermark, per-tx debit limit, pause flags
//! - vault     PDA ["vault", pool]                     one token account per pool, authority = Pool
//! - CctpRoute PDA ["cctp_route", domain (u32 LE)]     one per destination chain: address of our vault contract on that chain
//!
//! Day-to-day operations (deposit, payout, add liquidity, bridging) only emit events and never create accounts; accounts are created only by initialize, create_pool and set_cctp_route.
use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"config";
pub const POOL_SEED: &[u8] = b"pool";
pub const VAULT_SEED: &[u8] = b"vault";
pub const CCTP_ROUTE_SEED: &[u8] = b"cctp_route";

/// Global configuration: roles
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Administrator: creates pools, updates roles and pool params, pauses
    pub admin: Pubkey,
    /// Pending new admin (two-step transfer: transfer_admin nominates -> accept_admin accepts); Pubkey::default() means none
    pub pending_admin: Pubkey,
    /// operator: after a user sells a meme on another chain, calls debit to pay the user and the fee from a pool (the backend chooses the pool)
    pub operator: Pubkey,
    /// rebalancer: bridges the amount above the watermark to vaults on other chains via CCTP (only the USDC pool supports CCTP)
    pub rebalancer: Pubkey,
    pub bump: u8,
}

/// Token pool: one per token
#[account]
#[derive(InitSpace)]
pub struct Pool {
    /// Token mint (USDC / USDT ...)
    pub mint: Pubkey,
    /// Vault token account (PDA ["vault", pool])
    pub vault: Pubkey,
    /// Watermark: only the vault balance above this value can be rebalanced away
    pub watermark: u64,
    /// operator per-tx debit limit (0 = unlimited)
    pub max_debit_per_tx: u64,
    /// Deposit pause: deposit_for_swap / deposit_for_swap_v2 are disabled for this pool
    pub deposit_paused: bool,
    /// Withdraw pause: debit / rebalance_cctp are disabled for this pool
    pub withdraw_paused: bool,
    pub bump: u8,
}

/// CCTP route: the address of our own vault contract on a destination chain (domain).
/// rebalance_cctp can only send funds to the address registered here; the backend passes only the domain, never the recipient.
#[account]
#[derive(InitSpace)]
pub struct CctpRoute {
    /// CCTP destination domain (Ethereum/Sepolia = 0, Base = 6 ...)
    pub domain: u32,
    /// Destination vault address, 32 bytes (EVM address left-padded with 12 zero bytes)
    pub mint_recipient: Pubkey,
    pub bump: u8,
}

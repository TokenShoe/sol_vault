//! # cross_vault — multi-token Solana vault for centralized cross-chain meme trading (USDC / USDT ..., one pool per token)
//!
//! Roles:
//! - admin: create pools (add tokens), update roles and pool params, pause deposits/withdrawals per pool, two-step admin transfer, register CCTP destination vaults
//! - operator: after a user sells a meme on another chain, pays the user (+ fee) from the pool chosen by the backend
//! - rebalancer: bridges the funds above the pool watermark to vaults on other chains
//!   - via CCTP (recipient addresses are registered per domain by admin via set_cctp_route; the rebalancer can only pick a domain)
//!   - via Relay for chains CCTP does not reach, e.g. BSC (funds can only go into the Relay Depository)
//!
//! Flow: user deposit_for_swap -> event -> backend buys the meme on BSC;
//!       user sells on BSC -> backend calls debit twice in one transaction: once to the user, once to the fee account.
use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("A38GT8a6E1ySMM91Ly9rNCNbUPfFxLYgUt7X9dFmv2rK");

#[program]
pub mod cross_vault {
    use super::*;

    // ------------------------- admin: global -------------------------

    /// Initialize: only the program upgrade authority may call; the caller becomes admin. Creates only the global Config
    pub fn initialize(ctx: Context<Initialize>, operator: Pubkey, rebalancer: Pubkey) -> Result<()> {
        instructions::admin::initialize(ctx, operator, rebalancer)
    }

    /// admin updates operator / rebalancer
    pub fn set_config(ctx: Context<AdminOnly>, args: SetConfigArgs) -> Result<()> {
        instructions::admin::set_config(ctx, args)
    }

    /// Admin transfer step 1: the current admin nominates a new admin
    pub fn transfer_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        instructions::admin::transfer_admin(ctx, new_admin)
    }

    /// Admin transfer step 2: the nominated admin signs to accept
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::admin::accept_admin(ctx)
    }

    // ------------------------- admin: pools (one per token) -------------------------

    /// Add a supported token: create its Pool and vault (mirrors pump CreatePool)
    pub fn create_pool(ctx: Context<CreatePool>, watermark: u64, max_debit_per_tx: u64) -> Result<()> {
        instructions::pool::create_pool(ctx, watermark, max_debit_per_tx)
    }

    /// Update a pool's watermark / per-tx debit limit (0 = unlimited)
    pub fn set_pool_config(ctx: Context<PoolAdmin>, args: SetPoolConfigArgs) -> Result<()> {
        instructions::pool::set_pool_config(ctx, args)
    }

    /// Set a pool's deposit pause and withdraw pause independently
    pub fn set_pause_flags(ctx: Context<PoolAdmin>, deposit_paused: bool, withdraw_paused: bool) -> Result<()> {
        instructions::pool::set_pause_flags(ctx, deposit_paused, withdraw_paused)
    }

    // ------------------------- users -------------------------

    /// User deposits to buy a meme on another chain (gas paid by the platform feepayer)
    pub fn deposit_for_swap(ctx: Context<DepositForSwap>, args: DepositForSwapArgs) -> Result<()> {
        instructions::deposit::deposit_for_swap(ctx, args)
    }

    /// User deposit V2: destination-chain params are encrypted (anti front-running)
    pub fn deposit_for_swap_v2(ctx: Context<DepositForSwap>, args: DepositForSwapV2Args) -> Result<()> {
        instructions::deposit::deposit_for_swap_v2(ctx, args)
    }

    // ------------------------- operator / rebalancer -------------------------

    /// operator transfers from a pool to any token account of the same mint (mirrors pump AdminDebit); the backend calls it once for the payout and once for the fee in the same transaction
    pub fn debit(ctx: Context<Debit>, order_id: [u8; 16], amount: u64) -> Result<()> {
        instructions::debit::debit(ctx, order_id, amount)
    }

    /// Add funds to a pool
    pub fn add_liquidity(ctx: Context<AddLiquidity>, amount: u64) -> Result<()> {
        instructions::liquidity::add_liquidity(ctx, amount)
    }

    /// The rebalancer bridges the USDC above the pool watermark to a vault on another chain via Circle CCTP V2 (standard mode).
    /// Only the destination domain is passed; the recipient comes from the CctpRoute registered by admin
    pub fn rebalance_cctp(ctx: Context<RebalanceCctp>, amount: u64, destination_domain: u32) -> Result<()> {
        instructions::rebalance_cctp::rebalance_cctp(ctx, amount, destination_domain)
    }

    /// The rebalancer deposits the amount above the pool watermark into the Relay Depository (chains CCTP does not reach, e.g. BSC).
    /// order_id comes from a Relay quote whose user / refundTo is the Pool PDA and whose recipient is our vault on the destination chain
    pub fn rebalance_relay(ctx: Context<RebalanceRelay>, amount: u64, order_id: [u8; 32]) -> Result<()> {
        instructions::rebalance_relay::rebalance_relay(ctx, amount, order_id)
    }

    /// Move Relay refunds (they land in the Pool's ATA, the relay staging account) back into the vault; anyone may call
    pub fn reclaim_relay_refund(ctx: Context<ReclaimRelayRefund>) -> Result<()> {
        instructions::rebalance_relay::reclaim_relay_refund(ctx)
    }

    // ------------------------- admin: CCTP routes (one per destination chain) -------------------------

    /// Add / update the address of our vault contract on a destination chain
    pub fn set_cctp_route(ctx: Context<SetCctpRoute>, domain: u32, mint_recipient: Pubkey) -> Result<()> {
        instructions::cctp_route::set_cctp_route(ctx, domain, mint_recipient)
    }

    /// Remove the route for a destination chain (rent refunded to admin); rebalancing to that chain is no longer possible
    pub fn remove_cctp_route(ctx: Context<RemoveCctpRoute>, domain: u32) -> Result<()> {
        instructions::cctp_route::remove_cctp_route(ctx, domain)
    }
}

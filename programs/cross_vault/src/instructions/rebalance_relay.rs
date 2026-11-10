//! Vault rebalancing via Relay (for chains CCTP does not reach, e.g. BSC): deposit the amount above the watermark
//! into the Relay Depository; a Relay solver then pays our vault on the destination chain with its own funds.
//!
//! Flow:
//!   1. the backend requests a quote (POST /quote/v2) with user = refundTo = Pool PDA and recipient = our vault on the
//!      destination chain, checks it, and takes the 32-byte orderId (protocol.v2.orderId, also the last 32 bytes of the
//!      returned deposit_token instruction data)
//!   2. rebalancer calls rebalance_relay(amount, order_id):
//!      vault --(amount)--> relay staging account --(Relay deposit_token CPI, signed by the Pool PDA)--> Relay vault
//!   3. the backend calls POST /transactions/index so Relay picks up the deposit made inside our program,
//!      then polls the Relay status API until the fill is done
//!   4. if Relay refunds, the refund lands in the relay staging account; anyone calls reclaim_relay_refund to move it back
//!
//! Why the relay staging account: Relay requires the sender's token account and the refund recipient's token account to
//! be the associated token account (ATA) of the sender / refundTo. Our vault is PDA ["vault", pool], not an ATA, so the
//! Pool's own ATA, ATA(mint, Pool PDA), is used for both directions. Only this program (the Pool PDA) can move funds out of it.
//!
//! Constraints: only the rebalancer; pool withdrawals not paused; vault balance after transfer >= pool watermark.
//! The Relay program and its depository / vault accounts are fixed constants, so funds can only go into the Relay Depository.
//! Limitation: the destination recipient is bound inside Relay's off-chain order (order_id is only its hash), so it cannot be
//! verified on chain; the backend must check the quote, and a monitor should check each event against the Relay API.
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use super::{pool_signer_seeds, transfer_from_vault};
use crate::{
    errors::VaultError,
    events::{RebalanceRelayEvent, RelayRefundReclaimedEvent},
    state::{Config, Pool, CONFIG_SEED, POOL_SEED},
};

// Generates the relay_depository module from idls/relay_depository.json (minimal hand-written IDL: deposit_token only)
declare_program!(relay_depository);
use relay_depository::cpi::accounts::DepositToken;

/// Relay Depository program (Solana mainnet)
pub const RELAY_DEPOSITORY_PROGRAM: Pubkey = relay_depository::ID;
/// Relay Depository config account, PDA ["relay_depository"] of the program above
pub const RELAY_DEPOSITORY: Pubkey = pubkey!("Dodg2HifwU8rmaVVyMyUZDGTRbqAJTyVYxXPwcbNpBKc");
/// Relay vault, PDA ["vault"] of the program above (owner of the Relay token accounts)
pub const RELAY_VAULT: Pubkey = pubkey!("7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ");

#[event_cpi]
#[derive(Accounts)]
pub struct RebalanceRelay<'info> {
    /// rebalancer; pays the rent of the relay staging account the first time it is created
    #[account(mut)]
    pub rebalancer: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = rebalancer @ VaultError::Unauthorized)]
    pub config: Account<'info, Config>,

    pub mint: InterfaceAccount<'info, Mint>,

    /// Pool PDA: signs as the Relay sender (Relay marks the sender writable)
    #[account(mut, seeds = [POOL_SEED, mint.key().as_ref()], bump = pool.bump, has_one = mint, has_one = vault)]
    pub pool: Account<'info, Pool>,

    /// Vault token account (owner = Pool PDA)
    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// Relay staging account = ATA(mint, Pool PDA): source of the Relay deposit and destination of Relay refunds
    #[account(
        init_if_needed,
        payer = rebalancer,
        associated_token::mint = mint,
        associated_token::authority = pool,
        associated_token::token_program = token_program
    )]
    pub relay_staging: InterfaceAccount<'info, TokenAccount>,

    // ---------------- Relay accounts: fixed addresses; the token account is validated by Relay ----------------
    /// CHECK: fixed address
    #[account(address = RELAY_DEPOSITORY_PROGRAM)]
    pub relay_program: UncheckedAccount<'info>,
    /// CHECK: fixed address
    #[account(address = RELAY_DEPOSITORY)]
    pub relay_depository: UncheckedAccount<'info>,
    /// CHECK: fixed address
    #[account(address = RELAY_VAULT)]
    pub relay_vault: UncheckedAccount<'info>,
    /// CHECK: ATA(mint, RELAY_VAULT); Relay checks it is exactly this ATA (it must already exist, see README)
    #[account(mut)]
    pub relay_vault_token_account: UncheckedAccount<'info>,

    #[account(constraint = token_program.key() == anchor_spl::token::ID @ VaultError::UnsupportedMint)]
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn rebalance_relay(ctx: Context<RebalanceRelay>, amount: u64, order_id: [u8; 32]) -> Result<()> {
    let a = &ctx.accounts;
    require!(!a.pool.withdraw_paused, VaultError::WithdrawPaused);
    require!(amount > 0, VaultError::InvalidAmount);
    require!(order_id != [0u8; 32], VaultError::InvalidOrderId);
    let remaining = a.vault.amount.checked_sub(amount).ok_or(VaultError::InsufficientBalance)?;
    require!(remaining >= a.pool.watermark, VaultError::BelowWatermark);

    // 1. vault -> relay staging (Relay only accepts the sender's ATA as the source)
    transfer_from_vault(&a.token_program, &a.vault, &a.mint, a.relay_staging.to_account_info(), &a.pool, amount)?;

    // 2. CPI into Relay deposit_token, signed by the Pool PDA (sender = depositor = Pool)
    let bump = [a.pool.bump];
    let seeds = pool_signer_seeds(&a.pool.mint, &bump);
    let accounts = DepositToken {
        relay_depository: a.relay_depository.to_account_info(),
        sender: a.pool.to_account_info(),
        depositor: a.pool.to_account_info(),
        vault: a.relay_vault.to_account_info(),
        mint: a.mint.to_account_info(),
        sender_token_account: a.relay_staging.to_account_info(),
        vault_token_account: a.relay_vault_token_account.to_account_info(),
        token_program: a.token_program.to_account_info(),
        associated_token_program: a.associated_token_program.to_account_info(),
        system_program: a.system_program.to_account_info(),
    };
    relay_depository::cpi::deposit_token(
        CpiContext::new_with_signer(RELAY_DEPOSITORY_PROGRAM, accounts, &[&seeds]),
        amount,
        order_id,
    )?;

    ctx.accounts.vault.reload()?;
    emit_cpi!(RebalanceRelayEvent {
        rebalancer: ctx.accounts.rebalancer.key(),
        mint: ctx.accounts.mint.key(),
        amount,
        order_id,
        watermark: ctx.accounts.pool.watermark,
        vault_balance: ctx.accounts.vault.amount,
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct ReclaimRelayRefund<'info> {
    /// Anyone may call: funds can only move back into the vault
    pub caller: Signer<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(seeds = [POOL_SEED, mint.key().as_ref()], bump = pool.bump, has_one = mint, has_one = vault)]
    pub pool: Account<'info, Pool>,

    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// Relay staging account = ATA(mint, Pool PDA), where Relay refunds land
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = pool,
        associated_token::token_program = token_program
    )]
    pub relay_staging: InterfaceAccount<'info, TokenAccount>,

    #[account(constraint = token_program.key() == anchor_spl::token::ID @ VaultError::UnsupportedMint)]
    pub token_program: Interface<'info, TokenInterface>,
}

/// Move the whole relay staging balance (Relay refunds) back into the vault
pub fn reclaim_relay_refund(ctx: Context<ReclaimRelayRefund>) -> Result<()> {
    let a = &ctx.accounts;
    let amount = a.relay_staging.amount;
    require!(amount > 0, VaultError::InvalidAmount);

    let bump = [a.pool.bump];
    let seeds = pool_signer_seeds(&a.pool.mint, &bump);
    anchor_spl::token_interface::transfer_checked(
        CpiContext::new_with_signer(
            a.token_program.key(),
            anchor_spl::token_interface::TransferChecked {
                from: a.relay_staging.to_account_info(),
                mint: a.mint.to_account_info(),
                to: a.vault.to_account_info(),
                authority: a.pool.to_account_info(),
            },
            &[&seeds],
        ),
        amount,
        a.mint.decimals,
    )?;

    ctx.accounts.vault.reload()?;
    emit_cpi!(RelayRefundReclaimedEvent {
        caller: ctx.accounts.caller.key(),
        mint: ctx.accounts.mint.key(),
        amount,
        vault_balance: ctx.accounts.vault.amount,
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

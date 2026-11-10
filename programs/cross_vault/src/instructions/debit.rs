//! operator transfers out of a pool (mirrors pump AdminDebit: the pool is selected by mint / pool / vault)
//!
//! Generic transfer to any token account of the same mint (except the vault itself). After a user sells a meme, the backend decides which token to pay with
//! and puts several debits in the **same transaction**:
//!   debit(order_id, user proceeds) -> user's token account
//!   debit(order_id, fee)           -> platform fee account
//! If the user has no token account for that mint, the backend prepends createAssociatedTokenAccountIdempotent.
//!
//! Checks: sufficient balance, destination is not the vault, pool withdrawals not paused, within the pool's per-tx limit (0 = unlimited).
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use super::transfer_from_vault;
use crate::{
    errors::VaultError,
    events::DebitEvent,
    state::{Config, Pool, CONFIG_SEED, POOL_SEED},
};

#[event_cpi]
#[derive(Accounts)]
pub struct Debit<'info> {
    pub operator: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = operator @ VaultError::Unauthorized)]
    pub config: Account<'info, Config>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(seeds = [POOL_SEED, mint.key().as_ref()], bump = pool.bump, has_one = mint, has_one = vault)]
    pub pool: Account<'info, Pool>,

    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// Destination token account (user's or fee account), cannot be the vault itself
    /// (Anchor 1.x rejects duplicate mutable accounts first; this constraint is a second safeguard)
    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program,
        constraint = destination.key() != vault.key() @ VaultError::DestinationIsVault
    )]
    pub destination: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn debit(ctx: Context<Debit>, order_id: [u8; 16], amount: u64) -> Result<()> {
    let a: &&mut Debit<'_> = &ctx.accounts;
    require!(!a.pool.withdraw_paused, VaultError::WithdrawPaused);
    require!(amount > 0, VaultError::InvalidAmount);
    require!(
        a.pool.max_debit_per_tx == 0 || amount <= a.pool.max_debit_per_tx,
        VaultError::ExceedsMaxDebit
    );
    require!(a.vault.amount >= amount, VaultError::InsufficientBalance);

    transfer_from_vault(
        &a.token_program,
        &a.vault,
        &a.mint,
        a.destination.to_account_info(),
        &a.pool,
        amount,
    )?;
    ctx.accounts.vault.reload()?;

    emit_cpi!(DebitEvent {
        order_id,
        operator: ctx.accounts.operator.key(),
        mint: ctx.accounts.mint.key(),
        destination: ctx.accounts.destination.key(),
        destination_owner: ctx.accounts.destination.owner,
        amount,
        vault_balance: ctx.accounts.vault.amount,
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

//! add_liquidity: anyone (usually the rebalancer / operator) adds funds to a pool (mirrors pump AdminDeposit)
//! (bridging surplus USDC away: see rebalance_cctp.rs)
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use super::transfer_to_vault;
use crate::{
    errors::VaultError,
    events::AddLiquidityEvent,
    state::{Pool, POOL_SEED},
};

#[event_cpi]
#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    pub from: Signer<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(seeds = [POOL_SEED, mint.key().as_ref()], bump = pool.bump, has_one = mint, has_one = vault)]
    pub pool: Account<'info, Pool>,

    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, token::mint = mint, token::authority = from, token::token_program = token_program)]
    pub from_token: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn add_liquidity(ctx: Context<AddLiquidity>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::InvalidAmount);
    let a = &ctx.accounts;
    transfer_to_vault(&a.token_program, &a.from_token, &a.mint, &a.vault, a.from.to_account_info(), amount)?;
    ctx.accounts.vault.reload()?;

    emit_cpi!(AddLiquidityEvent {
        from: ctx.accounts.from.key(),
        mint: ctx.accounts.mint.key(),
        amount,
        vault_balance: ctx.accounts.vault.amount,
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

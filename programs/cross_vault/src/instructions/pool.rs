//! Token pool management (mirrors pump CreatePool / SetHardcap / SetPauseFlags)
//! - create_pool: add a supported token, creating its Pool and vault (once per token)
//! - set_pool_config: update a pool's watermark / per-tx debit limit
//! - set_pause_flags: pause a pool's deposits / withdrawals independently
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    errors::VaultError,
    events::{PauseFlagsUpdatedEvent, PoolConfigUpdatedEvent, PoolCreatedEvent},
    state::{Config, Pool, CONFIG_SEED, POOL_SEED, VAULT_SEED},
};

// ------------------------------ create_pool ------------------------------

#[event_cpi]
#[derive(Accounts)]
pub struct CreatePool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ VaultError::Unauthorized)]
    pub config: Account<'info, Config>,

    /// Mint of the new token (only the classic SPL Token program is supported: USDC and USDT both qualify)
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(init, payer = admin, space = 8 + Pool::INIT_SPACE, seeds = [POOL_SEED, mint.key().as_ref()], bump)]
    pub pool: Account<'info, Pool>,

    /// Vault token account, authority = Pool PDA
    #[account(
        init,
        payer = admin,
        seeds = [VAULT_SEED, pool.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = pool,
        token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(constraint = token_program.key() == anchor_spl::token::ID @ VaultError::UnsupportedMint)]
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn create_pool(ctx: Context<CreatePool>, watermark: u64, max_debit_per_tx: u64) -> Result<()> {
    let mint = ctx.accounts.mint.key();
    let vault = ctx.accounts.vault.key();
    ctx.accounts.pool.set_inner(Pool {
        mint,
        vault,
        watermark,
        max_debit_per_tx,
        deposit_paused: false,
        withdraw_paused: false,
        bump: ctx.bumps.pool,
    });
    emit_cpi!(PoolCreatedEvent {
        admin: ctx.accounts.admin.key(),
        mint,
        pool: ctx.accounts.pool.key(),
        vault,
        watermark,
        max_debit_per_tx,
    });
    Ok(())
}

// ------------------------------ update pool params / pause ------------------------------

/// admin updates a pool: shared accounts struct
#[event_cpi]
#[derive(Accounts)]
pub struct PoolAdmin<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ VaultError::Unauthorized)]
    pub config: Account<'info, Config>,
    /// No mint account needed: Anchor already checks the pool is owned by this program and is a Pool,
    /// and the PDA address is verified with the mint stored in the pool itself
    #[account(mut, seeds = [POOL_SEED, pool.mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
}

/// Fields passed as None are left unchanged
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct SetPoolConfigArgs {
    pub watermark: Option<u64>,
    /// 0 = unlimited
    pub max_debit_per_tx: Option<u64>,
}

pub fn set_pool_config(ctx: Context<PoolAdmin>, args: SetPoolConfigArgs) -> Result<()> {
    let p = &mut ctx.accounts.pool;
    if let Some(v) = args.watermark {
        p.watermark = v;
    }
    if let Some(v) = args.max_debit_per_tx {
        p.max_debit_per_tx = v;
    }
    emit_cpi!(PoolConfigUpdatedEvent {
        admin: ctx.accounts.admin.key(),
        mint: p.mint,
        watermark: p.watermark,
        max_debit_per_tx: p.max_debit_per_tx,
    });
    Ok(())
}

/// Pause deposits and withdrawals independently (mirrors pump SetPauseFlags, per pool)
pub fn set_pause_flags(ctx: Context<PoolAdmin>, deposit_paused: bool, withdraw_paused: bool) -> Result<()> {
    let p = &mut ctx.accounts.pool;
    p.deposit_paused = deposit_paused;
    p.withdraw_paused = withdraw_paused;
    emit_cpi!(PauseFlagsUpdatedEvent { admin: ctx.accounts.admin.key(), mint: p.mint, deposit_paused, withdraw_paused });
    Ok(())
}

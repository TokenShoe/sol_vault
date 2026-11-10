//! Initialization & global role management (pool admin instructions live in pool.rs)
use anchor_lang::prelude::*;

use crate::{
    errors::VaultError,
    events::{AdminTransferStartedEvent, AdminTransferredEvent, ConfigUpdatedEvent, InitializedEvent},
    program::CrossVault,
    state::{Config, CONFIG_SEED},
};

// ------------------------------ initialize ------------------------------

/// Only the program's upgrade authority (the deploying wallet) can initialize, preventing front-running after deployment (mirrors pump)
/// Creates only the global Config; token pools are created by create_pool
#[event_cpi]
#[derive(Accounts)]
pub struct Initialize<'info> {
    /// Deployer (must be the program upgrade authority), becomes admin
    #[account(mut)]
    pub admin: Signer<'info>,

    /// This program itself, used to locate its ProgramData account
    #[account(constraint = this_program.programdata_address()? == Some(program_data.key()) @ VaultError::InvalidProgramData)]
    pub this_program: Program<'info, CrossVault>,

    /// This program's ProgramData account, which records the upgrade authority
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ VaultError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,

    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,

    pub system_program: Program<'info, System>,
}

/// Role addresses cannot be all zeros: nobody could sign for them, effectively disabling the feature (guards against typos)
fn require_role(key: &Pubkey) -> Result<()> {
    require!(*key != Pubkey::default(), VaultError::InvalidRole);
    Ok(())
}

pub fn initialize(ctx: Context<Initialize>, operator: Pubkey, rebalancer: Pubkey) -> Result<()> {
    require_role(&operator)?;
    require_role(&rebalancer)?;
    ctx.accounts.config.set_inner(Config {
        admin: ctx.accounts.admin.key(),
        pending_admin: Pubkey::default(),
        operator,
        rebalancer,
        bump: ctx.bumps.config,
    });
    emit_cpi!(InitializedEvent { admin: ctx.accounts.admin.key(), operator, rebalancer });
    Ok(())
}

// ------------------------------ set_config ------------------------------

/// Update roles; fields passed as None are left unchanged
/// (admin transfer goes through transfer_admin + accept_admin; pool params through set_pool_config / set_pause_flags)
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct SetConfigArgs {
    pub operator: Option<Pubkey>,
    pub rebalancer: Option<Pubkey>,
}

/// Shared accounts struct for instructions that only need admin + Config
#[event_cpi]
#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ VaultError::Unauthorized)]
    pub config: Account<'info, Config>,
}

pub fn set_config(ctx: Context<AdminOnly>, args: SetConfigArgs) -> Result<()> {
    let c = &mut ctx.accounts.config;
    if let Some(v) = args.operator {
        require_role(&v)?;
        c.operator = v;
    }
    if let Some(v) = args.rebalancer {
        require_role(&v)?;
        c.rebalancer = v;
    }
    emit_cpi!(ConfigUpdatedEvent { admin: c.admin, operator: c.operator, rebalancer: c.rebalancer });
    Ok(())
}

// ------------------------------ two-step admin transfer ------------------------------

/// Step 1: the current admin nominates a new admin (the old admin keeps full power until accepted; calling again overrides the nomination)
pub fn transfer_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
    let c = &mut ctx.accounts.config;
    c.pending_admin = new_admin;
    emit_cpi!(AdminTransferStartedEvent { admin: c.admin, pending_admin: new_admin });
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    /// The nominated new admin
    pub new_admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

/// Step 2: the new admin signs to accept
pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let c = &mut ctx.accounts.config;
    let signer = ctx.accounts.new_admin.key();
    require!(c.pending_admin != Pubkey::default() && c.pending_admin == signer, VaultError::NotPendingAdmin);
    let old_admin = c.admin;
    c.admin = signer;
    c.pending_admin = Pubkey::default();
    emit_cpi!(AdminTransferredEvent { old_admin, new_admin: signer });
    Ok(())
}

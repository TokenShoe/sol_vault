//! CCTP route management (admin): register our own vault contract address for each destination chain
//!
//! - set_cctp_route(domain, mint_recipient): add or update. The first call creates the CctpRoute account (admin pays ~0.0012 SOL rent)
//! - remove_cctp_route(domain): remove; the account is closed and rent refunded to admin; rebalancing to that chain is no longer possible
//!
//! rebalance_cctp reads the recipient from here, so the rebalancer / backend cannot send funds anywhere else.
use anchor_lang::prelude::*;

use super::rebalance_cctp::SOLANA_CCTP_DOMAIN;
use crate::{
    errors::VaultError,
    events::{CctpRouteRemovedEvent, CctpRouteSetEvent},
    state::{CctpRoute, Config, CCTP_ROUTE_SEED, CONFIG_SEED},
};

#[event_cpi]
#[derive(Accounts)]
#[instruction(domain: u32)]
pub struct SetCctpRoute<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ VaultError::Unauthorized)]
    pub config: Account<'info, Config>,

    /// Created if missing, updated if it exists
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + CctpRoute::INIT_SPACE,
        seeds = [CCTP_ROUTE_SEED, &domain.to_le_bytes()],
        bump
    )]
    pub route: Account<'info, CctpRoute>,

    pub system_program: Program<'info, System>,
}

pub fn set_cctp_route(ctx: Context<SetCctpRoute>, domain: u32, mint_recipient: Pubkey) -> Result<()> {
    require!(domain != SOLANA_CCTP_DOMAIN, VaultError::InvalidDestinationDomain);
    require!(mint_recipient != Pubkey::default(), VaultError::InvalidMintRecipient);

    let r = &mut ctx.accounts.route;
    let old_mint_recipient = r.mint_recipient; // all zeros for a newly created account
    r.domain = domain;
    r.mint_recipient = mint_recipient;
    r.bump = ctx.bumps.route;

    emit_cpi!(CctpRouteSetEvent { admin: ctx.accounts.admin.key(), domain, old_mint_recipient, mint_recipient });
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(domain: u32)]
pub struct RemoveCctpRoute<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ VaultError::Unauthorized)]
    pub config: Account<'info, Config>,

    /// Closed, rent refunded to admin
    #[account(mut, close = admin, seeds = [CCTP_ROUTE_SEED, &domain.to_le_bytes()], bump = route.bump)]
    pub route: Account<'info, CctpRoute>,
}

pub fn remove_cctp_route(ctx: Context<RemoveCctpRoute>, domain: u32) -> Result<()> {
    emit_cpi!(CctpRouteRemovedEvent {
        admin: ctx.accounts.admin.key(),
        domain,
        mint_recipient: ctx.accounts.route.mint_recipient,
    });
    Ok(())
}

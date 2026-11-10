//! User deposits to buy a meme on another chain (mirrors pump DepositForSwap / DepositForSwapV2)
//! The user only signs; the platform feepayer is the transaction fee payer and does not appear in the instruction accounts.
//! Pass the mint / pool / vault of the token being deposited (USDC / USDT ...); the event carries the mint.
//!
//! - V1: destination recipient and meme contract are written in plaintext in the event
//! - V2: destination params are encrypted by the frontend with the platform public key; only ciphertext goes on chain, so bots cannot front-run
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use super::transfer_to_vault;
use crate::{
    errors::VaultError,
    events::{DepositForSwapEvent, DepositForSwapV2Event},
    state::{Pool, POOL_SEED},
};

/// Max encrypted params length (same as pump: 1-256 bytes)
pub const MAX_ENCRYPTED_PARAMS_LEN: usize = 256;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct DepositForSwapArgs {
    pub order_id: [u8; 16],
    pub amount: u64,
    pub fee: u64,
    pub dest_chain_id: u64,
    pub recipient: String,
    pub target_token: String,
    pub min_amount_out: u128,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct DepositForSwapV2Args {
    pub order_id: [u8; 16],
    pub amount: u64,
    pub fee: u64,
    /// Encrypted destination params (off-chain format, e.g. encrypted JSON {chainId, recipient, token, minOut})
    pub encrypted_params: Vec<u8>,
}

/// Accounts shared by V1 / V2 (no Config needed, same as pump)
#[event_cpi]
#[derive(Accounts)]
pub struct DepositForSwap<'info> {
    pub user: Signer<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(seeds = [POOL_SEED, mint.key().as_ref()], bump = pool.bump, has_one = mint, has_one = vault)]
    pub pool: Account<'info, Pool>,

    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, token::mint = mint, token::authority = user, token::token_program = token_program)]
    pub user_token: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Common checks + transfer the user's tokens into the vault; returns the vault balance after the deposit
fn pull_from_user(ctx: &mut Context<DepositForSwap>, amount: u64, fee: u64) -> Result<u64> {
    require!(!ctx.accounts.pool.deposit_paused, VaultError::DepositPaused);
    require!(amount > 0 && fee < amount, VaultError::InvalidAmount);
    let a = &ctx.accounts;
    transfer_to_vault(&a.token_program, &a.user_token, &a.mint, &a.vault, a.user.to_account_info(), amount)?;
    ctx.accounts.vault.reload()?;
    Ok(ctx.accounts.vault.amount)
}

pub fn deposit_for_swap(mut ctx: Context<DepositForSwap>, args: DepositForSwapArgs) -> Result<()> {
    for s in [&args.recipient, &args.target_token] {
        require!(!s.is_empty() && s.len() <= 64, VaultError::InvalidAddress);
    }
    let vault_balance = pull_from_user(&mut ctx, args.amount, args.fee)?;

    emit_cpi!(DepositForSwapEvent {
        order_id: args.order_id,
        user: ctx.accounts.user.key(),
        mint: ctx.accounts.mint.key(),
        amount: args.amount,
        fee: args.fee,
        dest_chain_id: args.dest_chain_id,
        recipient: args.recipient,
        target_token: args.target_token,
        min_amount_out: args.min_amount_out,
        vault_balance,
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

pub fn deposit_for_swap_v2(mut ctx: Context<DepositForSwap>, args: DepositForSwapV2Args) -> Result<()> {
    require!(
        !args.encrypted_params.is_empty() && args.encrypted_params.len() <= MAX_ENCRYPTED_PARAMS_LEN,
        VaultError::InvalidEncryptedParams
    );
    let vault_balance = pull_from_user(&mut ctx, args.amount, args.fee)?;

    emit_cpi!(DepositForSwapV2Event {
        order_id: args.order_id,
        user: ctx.accounts.user.key(),
        mint: ctx.accounts.mint.key(),
        amount: args.amount,
        fee: args.fee,
        encrypted_params: args.encrypted_params,
        vault_balance,
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

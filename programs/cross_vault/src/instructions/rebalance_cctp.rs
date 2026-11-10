//! Vault rebalancing: bridge the USDC above the watermark to a vault on another chain via Circle CCTP V2 (standard mode)
//!
//! Flow:
//!   1. rebalancer calls this instruction -> the program CPIs into CCTP TokenMessengerMinterV2.deposit_for_burn as the Pool PDA
//!      -> the vault's USDC is burned and CCTP creates a cross-chain message (stored in the message_sent_event_data account)
//!   2. the backend queries the Circle Iris API with the tx signature for the attestation (standard mode waits for source-chain finality, usually tens of seconds on devnet)
//!   3. the backend calls MessageTransmitterV2.receiveMessage(message, attestation) on the destination chain; USDC is minted to the destination vault
//!
//! Params (passed by the backend):
//!   - amount: amount to bridge
//!   - destination_domain: CCTP destination domain (Ethereum/Sepolia = 0, Base = 6 ...)
//! The recipient is NOT passed by the backend: it is read from the CctpRoute registered by admin via set_cctp_route (our own vault contract on the destination chain).
//!
//! Constraints: only the rebalancer; the destination domain must have a registered route; vault balance after transfer >= pool watermark; pool withdrawals not paused.
//! CCTP only supports Circle USDC: calls on USDT or other pools are rejected by CCTP (no matching local_token).
//! CCTP validates all of its own accounts (PDAs, supported domain, supported mint); wrong accounts are rejected by CCTP.
//!
//! Invocation: `declare_program!` reads idls/token_messenger_minter_v2.json (the official CCTP IDL, the equivalent of a Solidity ABI)
//! and generates the `cpi::deposit_for_burn(...)` client, so no hand-written discriminator, argument encoding or account ordering.
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use super::pool_signer_seeds;
use crate::{
    errors::VaultError,
    events::RebalanceCctpEvent,
    state::{CctpRoute, Config, Pool, CCTP_ROUTE_SEED, CONFIG_SEED, POOL_SEED},
};

// Generates the token_messenger_minter_v2 module from the CCTP IDL (cpi functions, account structs, param types)
declare_program!(token_messenger_minter_v2);
use token_messenger_minter_v2::{cpi::accounts::DepositForBurn, types::DepositForBurnParams};

/// CCTP V2 program address (same on mainnet and devnet)
pub const TOKEN_MESSENGER_MINTER_V2: Pubkey = token_messenger_minter_v2::ID;
pub const MESSAGE_TRANSMITTER_V2: Pubkey = pubkey!("CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC");
/// Solana's CCTP domain
pub const SOLANA_CCTP_DOMAIN: u32 = 5;
/// Standard mode: attestation is issued after source-chain finality, zero fee (fast mode is 1000)
pub const STANDARD_FINALITY_THRESHOLD: u32 = 2000;

#[event_cpi]
#[derive(Accounts)]
#[instruction(amount: u64, destination_domain: u32)]
pub struct RebalanceCctp<'info> {
    /// rebalancer, also pays the rent of the CCTP message account (event_rent_payer)
    #[account(mut)]
    pub rebalancer: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = rebalancer @ VaultError::Unauthorized)]
    pub config: Account<'info, Config>,

    /// USDC mint (must be writable for CCTP to burn)
    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(seeds = [POOL_SEED, mint.key().as_ref()], bump = pool.bump, has_one = mint, has_one = vault)]
    pub pool: Account<'info, Pool>,

    /// Vault USDC account (the account burned from, owner = Pool PDA)
    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// Destination route: the recipient is read from here. For an unregistered domain this account does not exist and the transaction fails
    #[account(seeds = [CCTP_ROUTE_SEED, &destination_domain.to_le_bytes()], bump = route.bump)]
    pub route: Account<'info, CctpRoute>,

    // ---------------- accounts required by CCTP, validated by CCTP itself ----------------
    /// CHECK: TokenMessengerMinterV2 PDA ["sender_authority"]
    pub sender_authority_pda: UncheckedAccount<'info>,
    /// CHECK: TokenMessengerMinterV2 PDA ["denylist_account", pool]
    pub denylist_account: UncheckedAccount<'info>,
    /// CHECK: MessageTransmitterV2 PDA ["message_transmitter"]
    #[account(mut)]
    pub message_transmitter: UncheckedAccount<'info>,
    /// CHECK: TokenMessengerMinterV2 PDA ["token_messenger"]
    pub token_messenger: UncheckedAccount<'info>,
    /// CHECK: TokenMessengerMinterV2 PDA ["remote_token_messenger", destination domain as a decimal string]
    pub remote_token_messenger: UncheckedAccount<'info>,
    /// CHECK: TokenMessengerMinterV2 PDA ["token_minter"]
    pub token_minter: UncheckedAccount<'info>,
    /// CHECK: TokenMessengerMinterV2 PDA ["local_token", mint]
    #[account(mut)]
    pub local_token: UncheckedAccount<'info>,
    /// Freshly generated keypair; CCTP creates an account here to store the cross-chain message (must sign)
    #[account(mut)]
    pub message_sent_event_data: Signer<'info>,
    /// CHECK: fixed address
    #[account(address = MESSAGE_TRANSMITTER_V2)]
    pub message_transmitter_program: UncheckedAccount<'info>,
    /// CHECK: fixed address
    #[account(address = TOKEN_MESSENGER_MINTER_V2)]
    pub token_messenger_minter_program: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    /// CHECK: TokenMessengerMinterV2 PDA ["__event_authority"]
    pub cctp_event_authority: UncheckedAccount<'info>,
}

pub fn rebalance_cctp(
    ctx: Context<RebalanceCctp>,
    amount: u64,
    destination_domain: u32,
) -> Result<()> {
    let a = &ctx.accounts;
    require!(!a.pool.withdraw_paused, VaultError::WithdrawPaused);
    require!(amount > 0, VaultError::InvalidAmount);
    // domain != Solana and non-empty recipient were already checked when the route was registered via set_cctp_route
    let mint_recipient = a.route.mint_recipient;
    let remaining = a.vault.amount.checked_sub(amount).ok_or(VaultError::InsufficientBalance)?;
    require!(remaining >= a.pool.watermark, VaultError::BelowWatermark);

    // ---------- CPI into CCTP deposit_for_burn, signed by the Pool PDA as owner ----------
    let bump = [a.pool.bump];
    let seeds = pool_signer_seeds(&a.pool.mint, &bump);
    let accounts = DepositForBurn {
        owner: a.pool.to_account_info(),                 // vault owner = Pool PDA (signed with the seeds below)
        event_rent_payer: a.rebalancer.to_account_info(), // pays rent for the CCTP message account
        sender_authority_pda: a.sender_authority_pda.to_account_info(),
        burn_token_account: a.vault.to_account_info(),   // the vault being burned from
        denylist_account: a.denylist_account.to_account_info(),
        message_transmitter: a.message_transmitter.to_account_info(),
        token_messenger: a.token_messenger.to_account_info(),
        remote_token_messenger: a.remote_token_messenger.to_account_info(),
        token_minter: a.token_minter.to_account_info(),
        local_token: a.local_token.to_account_info(),
        burn_token_mint: a.mint.to_account_info(),
        message_sent_event_data: a.message_sent_event_data.to_account_info(),
        message_transmitter_program: a.message_transmitter_program.to_account_info(),
        token_messenger_minter_program: a.token_messenger_minter_program.to_account_info(),
        token_program: a.token_program.to_account_info(),
        system_program: a.system_program.to_account_info(),
        event_authority: a.cctp_event_authority.to_account_info(),
        program: a.token_messenger_minter_program.to_account_info(),
    };
    token_messenger_minter_v2::cpi::deposit_for_burn(
        CpiContext::new_with_signer(TOKEN_MESSENGER_MINTER_V2, accounts, &[&seeds]),
        DepositForBurnParams {
            amount,
            destination_domain,
            mint_recipient,
            destination_caller: Pubkey::default(), // all zeros: anyone can submit the message on the destination chain
            max_fee: 0,                            // standard mode is free
            min_finality_threshold: STANDARD_FINALITY_THRESHOLD,
        },
    )?;

    ctx.accounts.vault.reload()?;
    emit_cpi!(RebalanceCctpEvent {
        rebalancer: ctx.accounts.rebalancer.key(),
        mint: ctx.accounts.mint.key(),
        amount,
        destination_domain,
        mint_recipient,
        message_sent_event_data: ctx.accounts.message_sent_event_data.key(),
        min_finality_threshold: STANDARD_FINALITY_THRESHOLD,
        watermark: ctx.accounts.pool.watermark,
        vault_balance: ctx.accounts.vault.amount,
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

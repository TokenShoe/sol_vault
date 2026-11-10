pub mod admin;
pub mod cctp_route;
pub mod debit;
pub mod deposit;
pub mod liquidity;
pub mod pool;
pub mod rebalance_cctp;

pub use admin::*;
pub use cctp_route::*;
pub use debit::*;
pub use deposit::*;
pub use liquidity::*;
pub use pool::*;
pub use rebalance_cctp::*;

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::state::{Pool, POOL_SEED};

/// Pool PDA signer seeds: ["pool", mint, bump]
pub fn pool_signer_seeds<'a>(mint: &'a Pubkey, bump: &'a [u8; 1]) -> [&'a [u8]; 3] {
    [POOL_SEED, mint.as_ref(), bump]
}

/// Transfer out of a pool vault (signed by the Pool PDA)
pub fn transfer_from_vault<'info>(
    token_program: &Interface<'info, TokenInterface>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    to: AccountInfo<'info>,
    pool: &Account<'info, Pool>,
    amount: u64,
) -> Result<()> {
    let bump = [pool.bump];
    let seeds = pool_signer_seeds(&pool.mint, &bump);
    transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: vault.to_account_info(),
                mint: mint.to_account_info(),
                to,
                authority: pool.to_account_info(),
            },
            &[&seeds],
        ),
        amount,
        mint.decimals,
    )
}

/// Transfer from the signer's own account into a pool vault
pub fn transfer_to_vault<'info>(
    token_program: &Interface<'info, TokenInterface>,
    from: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    authority: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    transfer_checked(
        CpiContext::new(
            token_program.key(),
            TransferChecked {
                from: from.to_account_info(),
                mint: mint.to_account_info(),
                to: vault.to_account_info(),
                authority,
            },
        ),
        amount,
        mint.decimals,
    )
}

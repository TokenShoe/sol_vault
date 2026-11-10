use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Deposits are paused")]
    DepositPaused,
    #[msg("Withdrawals are paused")]
    WithdrawPaused,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Address string is empty or longer than 64 characters")]
    InvalidAddress,
    #[msg("Insufficient vault balance")]
    InsufficientBalance,
    #[msg("Vault balance would fall below the watermark")]
    BelowWatermark,
    #[msg("Encrypted params must be 1-256 bytes")]
    InvalidEncryptedParams,
    #[msg("Amount exceeds the per-transaction debit limit")]
    ExceedsMaxDebit,
    #[msg("Invalid CCTP destination domain (cannot be Solana's own domain 5)")]
    InvalidDestinationDomain,
    #[msg("Destination mint recipient cannot be empty")]
    InvalidMintRecipient,
    #[msg("Destination cannot be the vault itself")]
    DestinationIsVault,
    #[msg("ProgramData account does not match this program")]
    InvalidProgramData,
    #[msg("Only tokens issued by the classic SPL Token program are supported")]
    UnsupportedMint,
    #[msg("No pending admin, or the signer is not the pending admin")]
    NotPendingAdmin,
    #[msg("operator / rebalancer cannot be the zero address")]
    InvalidRole,
    #[msg("Relay order id cannot be all zeros")]
    InvalidOrderId,
}

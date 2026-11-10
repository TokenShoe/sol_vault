/**
 * cross_vault integration tests (multi-token: USDC pool + USDT pool)
 * Covers: initialization, pool creation, gasless deposit + events, payout + fee (pump-style two transfers in one tx),
 *      add liquidity, CCTP V2 rebalance (the local validator loads the real CCTP programs dumped from devnet),
 *      multi-token isolation (USDT deposit/payout, pools do not affect each other), permissions, per-pool pause, config updates, two-step admin transfer
 */
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction, Transaction } from "@solana/web3.js";
import * as fs from "fs";
import {
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";
import type { CrossVault } from "../target/types/cross_vault";
import {
  CHAIN,
  CCTP,
  acceptAdmin,
  addLiquidity,
  assertSafeForFeePayer,
  buildDepositTx,
  buildDepositV2Tx,
  createPool,
  debitIx,
  decryptSwapParams,
  encryptSwapParams,
  evmAddressToBytes32,
  generateEncryptionKeyPair,
  getConfig,
  getPoolStatus,
  orderId,
  parseEventsFromTx,
  payoutToUser,
  poolPda,
  rebalanceCctp,
  removeCctpRoute,
  setCctpRoute,
  getCctpRoutes,
  cctpRoutePda,
  bytes32ToEvmAddress,
  setPauseFlags,
  setPoolConfig,
  setRoles,
  transferAdmin,
  vaultAddress,
} from "../client/vault-client";

const U = (n: number) => BigInt(Math.round(n * 1_000_000)); // USDC / USDT both have 6 decimals
/** Circle devnet USDC; on the local validator its mint authority is replaced by the test key below (see scripts/dump-cctp-fixtures.sh) */
const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const usdcMintAuthority = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("tests/fixtures/usdc-mint-authority.json", "utf8")))
);
/** Simulated destination-chain (Ethereum Sepolia) vault address */
const SEPOLIA_VAULT = "0x3b7dca567179daecec9b8f308984a22542cccd96";
const BSC_USER = "0x3b7dca567179daecec9b8f308984a22542cccd96";
const BSC_MEME = "0xe55296ff1ccf6f6136cf00e552e46ef69e30a3e2";

async function expectFail(p: Promise<unknown>, msg: string) {
  try {
    await p;
  } catch (e: any) {
    const text = String(e?.message ?? e) + JSON.stringify(e?.logs ?? []);
    if (!text.includes(msg)) console.log("actual error:", text.slice(0, 1500));
    expect(text).to.contain(msg);
    return;
  }
  throw new Error(`expected failure containing "${msg}"`);
}

describe("cross_vault", () => {
  // use confirmed everywhere so the next tx sees the state of the previous one
  const env = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(env.connection, env.wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);
  const program = new Program<CrossVault>(anchor.workspace.crossVault.idl, provider);
  const conn = provider.connection;
  const admin = (provider.wallet as anchor.Wallet).payer;

  const operator = Keypair.generate();
  const rebalancer = Keypair.generate();
  const feePayer = Keypair.generate();
  const feeWallet = Keypair.generate();
  const user = Keypair.generate(); // user with 0 SOL
  const seller = Keypair.generate(); // user without a token account
  const usdc = USDC_MINT;
  let usdt: PublicKey; // test USDT (a 6-decimal token created locally)
  let feeAta: PublicKey; // fee wallet's USDC account
  const WATERMARK = U(100);

  /** Common params for building deposit transactions */
  const depositBase = (mint: PublicKey) => ({
    user: user.publicKey,
    feePayer: feePayer.publicKey,
    mint,
    orderId: orderId.random(),
    destChainId: CHAIN.BSC,
    recipient: BSC_USER,
    targetToken: BSC_MEME,
  });

  before(async () => {
    for (const kp of [operator, rebalancer, feePayer]) {
      await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 10 * LAMPORTS_PER_SOL), "confirmed");
    }
    // USDC: Circle devnet USDC (local fixture), so the real CCTP flow works
    // USDT: simulated by a 6-decimal token created locally
    usdt = await createMint(conn, admin, admin.publicKey, null, 6);
    for (const [mint, auth] of [
      [usdc, usdcMintAuthority],
      [usdt, admin],
    ] as [PublicKey, Keypair][]) {
      for (const owner of [user, rebalancer]) {
        const ata = (await getOrCreateAssociatedTokenAccount(conn, admin, mint, owner.publicKey)).address;
        await mintTo(conn, admin, mint, ata, auth, U(1000));
      }
      await getOrCreateAssociatedTokenAccount(conn, admin, mint, feeWallet.publicKey);
      await getOrCreateAssociatedTokenAccount(conn, admin, mint, operator.publicKey);
    }
    feeAta = getAssociatedTokenAddressSync(usdc, feeWallet.publicKey);
  });

  // ------------------------------ initialize & create pools ------------------------------
  const BPF_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  const programData = () => PublicKey.findProgramAddressSync([program.programId.toBuffer()], BPF_UPGRADEABLE)[0];
  const initialize = (signer: Keypair, op = operator.publicKey, rb = rebalancer.publicKey) =>
    program.methods
      .initialize(op, rb)
      .accountsPartial({ admin: signer.publicKey, thisProgram: program.programId, programData: programData() })
      .signers([signer])
      .rpc();

  it("non-upgrade-authority cannot front-run initialize", async () => {
    await expectFail(initialize(operator), "Unauthorized");
  });

  it("initialize: operator / rebalancer cannot be the zero address", async () => {
    await expectFail(initialize(admin, PublicKey.default), "InvalidRole");
    await expectFail(initialize(admin, operator.publicKey, PublicKey.default), "InvalidRole");
  });

  it("initialize (by upgrade authority) creates only the global Config and emits InitializedEvent", async () => {
    const sig = await initialize(admin);
    const [ev] = await parseEventsFromTx(program, sig);
    expect(ev.name).to.eq("initializedEvent");
    expect(ev.data.operator.toBase58()).to.eq(operator.publicKey.toBase58());
    expect(ev.data.rebalancer.toBase58()).to.eq(rebalancer.publicKey.toBase58());
    const c = await getConfig(program);
    expect(c.admin.toBase58()).to.eq(admin.publicKey.toBase58());
    expect(c.operator.toBase58()).to.eq(operator.publicKey.toBase58());
    expect(c.rebalancer.toBase58()).to.eq(rebalancer.publicKey.toBase58());
  });

  it("cannot initialize twice", async () => {
    await expectFail(initialize(admin), "already in use");
  });

  it("create_pool: admin creates USDC and USDT pools; non-admin cannot; the same token cannot be added twice", async () => {
    await expectFail(createPool(program, operator, usdc, WATERMARK), "Unauthorized");
    await createPool(program, admin, usdc, WATERMARK);
    await createPool(program, admin, usdt, U(50), U(500));
    await expectFail(createPool(program, admin, usdc, WATERMARK), "already in use");

    const p = await getPoolStatus(program, usdt);
    expect(p.pool.mint.toBase58()).to.eq(usdt.toBase58());
    expect(p.pool.vault.toBase58()).to.eq(vaultAddress(usdt).toBase58());
    expect(p.watermark).to.eq(U(50));
    expect(p.pool.maxDebitPerTx.toString()).to.eq(U(500).toString());
    // the vault is owned by the pool PDA
    const vaultAcc = await getAccount(conn, vaultAddress(usdt));
    expect(vaultAcc.owner.toBase58()).to.eq(poolPda(usdt).toBase58());
  });

  // ------------------------------ USDC: deposit / add liquidity / payout ------------------------------
  it("user with 0 SOL deposits USDC with gas paid by feepayer; event carries mint", async () => {
    const base = depositBase(usdc);
    const tx = await buildDepositTx(program, { ...base, amount: U(1), fee: U(0.05) });
    assertSafeForFeePayer(tx, feePayer.publicKey);
    const sig = await sendAndConfirmTransaction(conn, tx, [feePayer, user], { commitment: "confirmed" });

    const [ev] = await parseEventsFromTx(program, sig);
    expect(ev.name.toLowerCase()).to.eq("depositforswapevent");
    expect(orderId.toHex(ev.data.orderId)).to.eq(orderId.toHex(base.orderId));
    expect(ev.data.mint.toBase58()).to.eq(usdc.toBase58());
    expect(ev.data.recipient).to.eq(BSC_USER);
    expect(ev.data.vaultBalance.toString()).to.eq(U(1).toString());
    expect(await conn.getBalance(user.publicKey)).to.eq(0);
  });

  it("deposit validation: fee >= amount fails", async () => {
    const tx = await buildDepositTx(program, { ...depositBase(usdc), amount: U(1), fee: U(1) });
    await expectFail(sendAndConfirmTransaction(conn, tx, [feePayer, user]), "InvalidAmount");
  });

  it("add liquidity", async () => {
    await addLiquidity(program, rebalancer, usdc, U(200));
    expect((await getPoolStatus(program, usdc)).balance).to.eq(U(201));
  });

  it("operator payout (two debits in one tx, like pump): user and fee wallet receive funds; user account created if missing", async () => {
    const id = orderId.random();
    const sig = await payoutToUser(program, operator, usdc, seller.publicKey, id, U(0.899372), U(0.004148), feeWallet.publicKey);
    expect((await getAccount(conn, getAssociatedTokenAddressSync(usdc, seller.publicKey))).amount).to.eq(U(0.899372));
    expect((await getAccount(conn, feeAta)).amount).to.eq(U(0.004148));

    // two DebitEvents with the same order id; recipients are the user and the fee wallet
    const evs = await parseEventsFromTx(program, sig);
    expect(evs.map((e) => e.name.toLowerCase())).to.deep.eq(["debitevent", "debitevent"]);
    expect(evs.every((e) => orderId.toHex(e.data.orderId) === orderId.toHex(id))).to.eq(true);
    expect(evs.every((e) => e.data.mint.toBase58() === usdc.toBase58())).to.eq(true);
    expect(evs[0].data.destinationOwner.toBase58()).to.eq(seller.publicKey.toBase58());
    expect(evs[1].data.destinationOwner.toBase58()).to.eq(feeWallet.publicKey.toBase58());
  });

  it("debit: cannot send to the vault itself or exceed the balance", async () => {
    const send = async (dest: PublicKey, amt: bigint) => {
      const ix = await debitIx(program, operator.publicKey, usdc, dest, orderId.random(), amt);
      return sendAndConfirmTransaction(conn, new Transaction().add(ix), [operator], { commitment: "confirmed" });
    };
    // Anchor 1.x rejects the same writable account appearing twice, before the program's DestinationIsVault check
    await expectFail(send(vaultAddress(usdc), U(1)), "ConstraintDuplicateMutableAccount");
    const { balance } = await getPoolStatus(program, usdc);
    await expectFail(send(feeAta, balance + 1n), "InsufficientBalance");
  });

  it("per-pool per-tx limit: 0 = unlimited by default; above the limit fails, equal succeeds; back to 0 removes the limit", async () => {
    expect((await getPoolStatus(program, usdc)).pool.maxDebitPerTx.toNumber()).to.eq(0);
    await setPoolConfig(program, admin, usdc, { maxDebitPerTx: U(5) });
    await expectFail(payoutToUser(program, operator, usdc, seller.publicKey, orderId.random(), U(5.000001)), "ExceedsMaxDebit");
    await payoutToUser(program, operator, usdc, seller.publicKey, orderId.random(), U(5));
    // payout and fee are two separate debits, each subject to the limit
    await payoutToUser(program, operator, usdc, seller.publicKey, orderId.random(), U(4), U(1), feeWallet.publicKey);
    await setPoolConfig(program, admin, usdc, { maxDebitPerTx: 0 });
    await payoutToUser(program, operator, usdc, seller.publicKey, orderId.random(), U(6));
  });

  it("non-operator cannot pay out", async () => {
    await expectFail(payoutToUser(program, rebalancer, usdc, rebalancer.publicKey, orderId.random(), U(1)), "Unauthorized");
  });

  // ------------------------------ USDT pool: multi-token ------------------------------
  it("USDT: user deposits USDT (V1 / V2) into the USDT vault, event mint = USDT", async () => {
    const usdcBefore = (await getPoolStatus(program, usdc)).balance;
    const tx = await buildDepositTx(program, { ...depositBase(usdt), amount: U(10), fee: U(0.1) });
    const sig = await sendAndConfirmTransaction(conn, tx, [feePayer, user], { commitment: "confirmed" });
    const [ev] = await parseEventsFromTx(program, sig);
    expect(ev.data.mint.toBase58()).to.eq(usdt.toBase58());

    const tx2 = await buildDepositV2Tx(program, { ...depositBase(usdt), amount: U(5), fee: 0, encryptedParams: Buffer.from([1, 2, 3]) });
    await sendAndConfirmTransaction(conn, tx2, [feePayer, user], { commitment: "confirmed" });

    expect((await getPoolStatus(program, usdt)).balance).to.eq(U(15));
    expect((await getPoolStatus(program, usdc)).balance).to.eq(usdcBefore); // USDC pool unaffected
  });

  it("USDT: backend pays user + fee from the USDT pool; subject to the USDT pool's own per-tx limit", async () => {
    const sig = await payoutToUser(program, operator, usdt, seller.publicKey, orderId.random(), U(8), U(0.2), feeWallet.publicKey);
    expect((await getAccount(conn, getAssociatedTokenAddressSync(usdt, seller.publicKey))).amount).to.eq(U(8));
    expect((await getAccount(conn, getAssociatedTokenAddressSync(usdt, feeWallet.publicKey))).amount).to.eq(U(0.2));
    const evs = await parseEventsFromTx(program, sig);
    expect(evs.every((e) => e.data.mint.toBase58() === usdt.toBase58())).to.eq(true);
    // the USDT pool was created with a per-tx limit of 500
    await addLiquidity(program, rebalancer, usdt, U(600));
    await expectFail(payoutToUser(program, operator, usdt, seller.publicKey, orderId.random(), U(501)), "ExceedsMaxDebit");
  });

  it("pool isolation: the USDT vault cannot be passed as the USDC pool's vault", async () => {
    const ix = await program.methods
      .debit(orderId.random(), new anchor.BN(1))
      .accountsPartial({
        operator: operator.publicKey,
        mint: usdc,
        pool: poolPda(usdc),
        vault: vaultAddress(usdt), // wrong: the USDT vault
        destination: getAssociatedTokenAddressSync(usdc, operator.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    await expectFail(sendAndConfirmTransaction(conn, new Transaction().add(ix), [operator]), "ConstraintHasOne");
  });

  // ------------------------------ CCTP routes (admin registers destination vaults) ------------------------------
  it("CCTP routes: only admin can register; Solana / zero address rejected; can update and remove (rent refunded)", async () => {
    await expectFail(setCctpRoute(program, operator, CCTP.DOMAIN.ETHEREUM, SEPOLIA_VAULT), "Unauthorized");
    await expectFail(setCctpRoute(program, admin, CCTP.SOLANA_DOMAIN, SEPOLIA_VAULT), "InvalidDestinationDomain");
    await expectFail(setCctpRoute(program, admin, CCTP.DOMAIN.ETHEREUM, PublicKey.default), "InvalidMintRecipient");

    // register a wrong address first, then fix it: the event carries the previous address
    const wrong = "0x000000000000000000000000000000000000dead";
    await setCctpRoute(program, admin, CCTP.DOMAIN.ETHEREUM, wrong);
    const sig = await setCctpRoute(program, admin, CCTP.DOMAIN.ETHEREUM, SEPOLIA_VAULT);
    const [ev] = await parseEventsFromTx(program, sig);
    expect(ev.name.toLowerCase()).to.eq("cctproutesetevent");
    expect(bytes32ToEvmAddress(ev.data.oldMintRecipient)).to.eq(wrong);
    expect(bytes32ToEvmAddress(ev.data.mintRecipient)).to.eq(SEPOLIA_VAULT);

    // register Base then remove it: account closed, rent refunded to admin
    await setCctpRoute(program, admin, CCTP.DOMAIN.BASE, SEPOLIA_VAULT);
    const before = await conn.getBalance(admin.publicKey);
    await expectFail(removeCctpRoute(program, operator, CCTP.DOMAIN.BASE), "Unauthorized");
    await removeCctpRoute(program, admin, CCTP.DOMAIN.BASE);
    expect(await conn.getAccountInfo(cctpRoutePda(CCTP.DOMAIN.BASE))).to.eq(null);
    expect(await conn.getBalance(admin.publicKey)).to.be.gt(before); // rent > tx fee

    const routes = await getCctpRoutes(program);
    expect(routes.map((r) => [r.domain, r.evmAddress])).to.deep.eq([[0, SEPOLIA_VAULT]]);
  });

  it("the USDT pool cannot use CCTP (CCTP only supports Circle USDC)", async () => {
    const { excess } = await getPoolStatus(program, usdt);
    expect(excess > 0n).to.eq(true);
    // CCTP has no local_token account for USDT and rejects it
    await expectFail(rebalanceCctp(program, rebalancer, usdt, 1n, CCTP.DOMAIN.ETHEREUM), "Error");
    expect((await getPoolStatus(program, usdt)).excess).to.eq(excess); // funds untouched
  });

  // ------------------------------ USDC: CCTP rebalance ------------------------------
  it("CCTP rebalance: only the amount above the watermark, only the rebalancer, only domains with a registered route", async () => {
    const { excess } = await getPoolStatus(program, usdc);
    await expectFail(rebalanceCctp(program, rebalancer, usdc, excess + 1n, CCTP.DOMAIN.ETHEREUM), "BelowWatermark");
    await expectFail(rebalanceCctp(program, operator, usdc, 1n, CCTP.DOMAIN.ETHEREUM), "Unauthorized");
    // domains without a route (including Solana itself): the route account does not exist, so it fails
    await expectFail(rebalanceCctp(program, rebalancer, usdc, 1n, CCTP.SOLANA_DOMAIN), "AccountNotInitialized");
    await expectFail(rebalanceCctp(program, rebalancer, usdc, 1n, CCTP.DOMAIN.BASE), "AccountNotInitialized");
  });

  it("CCTP rebalance: real CCTP V2 deposit_for_burn call burns the USDC vault and creates a message to Sepolia", async () => {
    const { excess, watermark } = await getPoolStatus(program, usdc);
    const supplyBefore = (await conn.getTokenSupply(usdc)).value.amount;
    const { signature, messageSentEventData } = await rebalanceCctp(program, rebalancer, usdc, excess, CCTP.DOMAIN.ETHEREUM);

    // the vault keeps exactly the watermark; USDC supply decreases (burned by CCTP)
    expect((await getPoolStatus(program, usdc)).balance).to.eq(watermark);
    const supplyAfter = (await conn.getTokenSupply(usdc)).value.amount;
    expect(BigInt(supplyBefore) - BigInt(supplyAfter)).to.eq(excess);

    // our event
    const evs = await parseEventsFromTx(program, signature);
    const ev = evs.find((e) => e.name.toLowerCase() === "rebalancecctpevent")!;
    expect(ev.data.mint.toBase58()).to.eq(usdc.toBase58());
    expect(ev.data.amount.toString()).to.eq(excess.toString());
    expect(ev.data.destinationDomain).to.eq(0);
    expect(ev.data.mintRecipient.toBase58()).to.eq(evmAddressToBytes32(SEPOLIA_VAULT).toBase58());
    expect(ev.data.minFinalityThreshold).to.eq(2000);

    // the cross-chain message created by CCTP (MessageSent account, owned by MessageTransmitterV2); decode and check key fields
    const acc = await conn.getAccountInfo(messageSentEventData);
    expect(acc!.owner.toBase58()).to.eq(CCTP.MESSAGE_TRANSMITTER_V2.toBase58());
    // MessageSent layout: 8 discriminator + 32 rent_payer + 8 created_at + 4 message length + message
    const msg = acc!.data.subarray(8 + 32 + 8 + 4);
    // MessageV2：version(4) sourceDomain(4) destinationDomain(4) nonce(32) sender(32) recipient(32) destinationCaller(32) minFinality(4) finalityExecuted(4) | body
    expect(msg.readUInt32BE(4)).to.eq(5); // source domain = Solana
    expect(msg.readUInt32BE(8)).to.eq(0); // destination domain = Ethereum
    expect(msg.readUInt32BE(140)).to.eq(2000); // standard mode
    const body = msg.subarray(148);
    // BurnMessageV2：version(4) burnToken(32) mintRecipient(32) amount(32) messageSender(32) maxFee(32) ...
    expect("0x" + body.subarray(36 + 12, 68).toString("hex")).to.eq(SEPOLIA_VAULT); // recipient
    expect(BigInt("0x" + body.subarray(68, 100).toString("hex"))).to.eq(excess); // amount
    expect(new PublicKey(body.subarray(100, 132)).toBase58()).to.eq(poolPda(usdc).toBase58()); // sender = USDC pool PDA
    expect(BigInt("0x" + body.subarray(132, 164).toString("hex"))).to.eq(0n); // max_fee = 0
  });

  // ------------------------------ V2 encrypted deposit ------------------------------
  it("V2: encrypted destination params; only ciphertext on chain, backend can decrypt", async () => {
    const platformKey = generateEncryptionKeyPair(); // secretKey stays on the backend
    const enc = encryptSwapParams(
      { destChainId: CHAIN.BSC, recipient: BSC_USER, targetToken: BSC_MEME, minAmountOut: "1000" },
      platformKey.publicKey
    );
    expect(enc.length).to.be.lte(256);
    const base = depositBase(usdc);
    const tx = await buildDepositV2Tx(program, { ...base, amount: U(2), fee: U(0.05), encryptedParams: enc });
    assertSafeForFeePayer(tx, feePayer.publicKey);
    const sig = await sendAndConfirmTransaction(conn, tx, [feePayer, user], { commitment: "confirmed" });

    const [ev] = await parseEventsFromTx(program, sig);
    expect(ev.name.toLowerCase()).to.eq("depositforswapv2event");
    expect(orderId.toHex(ev.data.orderId)).to.eq(orderId.toHex(base.orderId));
    // no plaintext address visible in the on-chain transaction data
    const raw = JSON.stringify(await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }));
    expect(raw.toLowerCase()).to.not.contain(BSC_MEME.slice(2));
    const p = decryptSwapParams(ev.data.encryptedParams, platformKey.secretKey);
    expect(p).to.deep.eq({ destChainId: CHAIN.BSC, recipient: BSC_USER, targetToken: BSC_MEME, minAmountOut: "1000" });
  });

  it("V2: empty or >256-byte encrypted params fail", async () => {
    for (const bad of [Buffer.alloc(0), Buffer.alloc(257, 1)]) {
      const tx = await buildDepositV2Tx(program, { ...depositBase(usdc), amount: U(1), fee: 0, encryptedParams: bad });
      await expectFail(sendAndConfirmTransaction(conn, tx, [feePayer, user]), "InvalidEncryptedParams");
    }
  });

  // ------------------------------ pause / config / admin ------------------------------
  it("per-pool pause: pausing USDC deposits does not affect USDT; pausing USDC withdrawals blocks payouts and CCTP", async () => {
    const depositTx = (mint: PublicKey) =>
      buildDepositV2Tx(program, { ...depositBase(mint), amount: U(1), fee: 0, encryptedParams: Buffer.from([1, 2, 3]) });

    // pause only USDC deposits: USDC deposit fails, USDC withdrawals work, USDT deposits work
    await setPauseFlags(program, admin, usdc, true, false);
    await expectFail(sendAndConfirmTransaction(conn, await depositTx(usdc), [feePayer, user]), "DepositPaused");
    await payoutToUser(program, operator, usdc, seller.publicKey, orderId.random(), U(1));
    await sendAndConfirmTransaction(conn, await depositTx(usdt), [feePayer, user], { commitment: "confirmed" });

    // pause only USDC withdrawals: USDC payout and CCTP fail, USDC deposits work, USDT payouts work
    await setPauseFlags(program, admin, usdc, false, true);
    await expectFail(payoutToUser(program, operator, usdc, seller.publicKey, orderId.random(), U(1)), "WithdrawPaused");
    await expectFail(rebalanceCctp(program, rebalancer, usdc, 1n, CCTP.DOMAIN.ETHEREUM), "WithdrawPaused");
    await sendAndConfirmTransaction(conn, await depositTx(usdc), [feePayer, user], { commitment: "confirmed" });
    await payoutToUser(program, operator, usdt, seller.publicKey, orderId.random(), U(1));

    // non-admin cannot set
    await expectFail(setPauseFlags(program, operator, usdc, false, false), "Unauthorized");
    await setPauseFlags(program, admin, usdc, false, false);
    const { pool } = await getPoolStatus(program, usdc);
    expect(pool.depositPaused).to.eq(false);
    expect(pool.withdrawPaused).to.eq(false);
  });

  it("admin updates pool watermark / replaces operator; non-admin cannot", async () => {
    await setPoolConfig(program, admin, usdc, { watermark: U(50) });
    expect((await getPoolStatus(program, usdc)).watermark).to.eq(U(50));
    expect((await getPoolStatus(program, usdt)).watermark).to.eq(U(50)); // the USDT pool keeps its own value

    await expectFail(setPoolConfig(program, operator, usdc, { watermark: 0 }), "Unauthorized");
    await expectFail(setRoles(program, operator, { operator: operator.publicKey }), "Unauthorized");
    await expectFail(setRoles(program, admin, { operator: PublicKey.default }), "InvalidRole");
    await expectFail(setRoles(program, admin, { rebalancer: PublicKey.default }), "InvalidRole");

    const newOp = Keypair.generate();
    await setRoles(program, admin, { operator: newOp.publicKey });
    expect((await getConfig(program)).operator.toBase58()).to.eq(newOp.publicKey.toBase58());
    await expectFail(payoutToUser(program, operator, usdc, seller.publicKey, orderId.random(), U(1)), "Unauthorized");
  });

  it("two-step admin transfer: nominate -> accept; old admin stays effective until accepted, others cannot accept", async () => {
    const newAdmin = Keypair.generate();
    await conn.confirmTransaction(await conn.requestAirdrop(newAdmin.publicKey, LAMPORTS_PER_SOL), "confirmed");

    // cannot accept without a nomination
    await expectFail(acceptAdmin(program, newAdmin), "NotPendingAdmin");
    // non-admin cannot nominate
    await expectFail(transferAdmin(program, operator, newAdmin.publicKey), "Unauthorized");

    await transferAdmin(program, admin, newAdmin.publicKey);
    let c = await getConfig(program);
    expect(c.pendingAdmin.toBase58()).to.eq(newAdmin.publicKey.toBase58());
    expect(c.admin.toBase58()).to.eq(admin.publicKey.toBase58()); // not accepted yet, power stays with the old admin
    await setPauseFlags(program, admin, usdc, false, false);

    // only the nominee can accept
    await expectFail(acceptAdmin(program, operator), "NotPendingAdmin");

    await acceptAdmin(program, newAdmin);
    c = await getConfig(program);
    expect(c.admin.toBase58()).to.eq(newAdmin.publicKey.toBase58());
    expect(c.pendingAdmin.toBase58()).to.eq(PublicKey.default.toBase58());
    // old admin is revoked, new admin is effective (including creating new pools)
    await expectFail(setPauseFlags(program, admin, usdc, true, true), "Unauthorized");
    await setPauseFlags(program, newAdmin, usdc, false, false);
  });
});

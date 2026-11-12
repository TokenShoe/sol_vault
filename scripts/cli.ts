/**
 * cross_vault command-line tool (deploy, configure, devnet / local validator testing)
 *
 * Usage: yarn -s cli <command> [--arg value ...]
 *   yarn -s cli help              list all commands
 *
 * Two config files at the project root (guide: docs/deployment-guide.md):
 *   .env         SECRETS, git-ignored (template .env.example; ENV_FILE=path picks another file; shell variables win)
 *                  NETWORK                     default network: devnet (default) / mainnet / localnet; --network on any command overrides it
 *                  DEVNET_RPC_URL / MAINNET_RPC_URL / LOCALNET_RPC_URL  RPC per network (overrides config.json rpc; RPC_URL = shared fallback)
 *                  any secret below can be per network (DEVNET_ADMIN_PRIVATE_KEY wins over ADMIN_PRIVATE_KEY);
 *                  on MAINNET private keys are read ONLY from MAINNET_<NAME>, never from the shared name
 *                  <ROLE>_PRIVATE_KEY          base58 private key exported from Phantom / Solflare / Backpack (or a [..] JSON array):
 *                                              ADMIN / OPERATOR / REBALANCER / FEEPAYER / FEE_WALLET / USER / USER2
 *                  ENCRYPTION_SECRET_KEY       x25519 secret (base64) for V2 encrypted deposits
 *                  EVM_PRIVATE_KEY             EVM test wallet (Sepolia): CCTP test recipient, pays receiveMessage gas
 *                  RELAY_API_KEY / EVM_RPC_URL optional
 *   config.json  NON-SECRET settings per network, committed (CONFIG_FILE=path picks another file)
 *                  rpc, addresses (role addresses when no private key is given), pools (mint / watermark / maxDebit),
 *                  cctp (attestation API, domain map, routes = our vault per chain, EVM testnet), relay (API, chains, defaults)
 *   yarn -s cli keygen       creates any missing test wallets in .env
 *   yarn -s cli import-keys  moves an old keys/<network> directory into .env / config.json
 *
 * Multi-token: one pool per token. Fund-related commands select the token with --mint: usdc (default) / usdt / circle / any mint address
 *
 * Relay commands (relay-quote / rebalance-relay / relay-status / relay-reclaim) only work on Solana MAINNET with mainnet USDC / USDT:
 * Relay has no Solana devnet. Use them with NETWORK=mainnet (e.g. ENV_FILE=.env.mainnet) and small amounts.
 *
 * Amounts are in token units (USDC / USDT both have 6 decimals, e.g. --amount 1.5 means 1.5 tokens)
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline/promises";
import { spawnSync } from "child_process";
import bs58 from "bs58";
import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptMint,
  getMint,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import nacl from "tweetnacl";
import { EnvHttpProxyAgent, fetch as undiciFetch, setGlobalDispatcher } from "undici";
import { Contract, FetchRequest, formatEther, formatUnits, JsonRpcProvider, parseUnits, Wallet } from "ethers";
import type { CrossVault } from "../target/types/cross_vault";
import idl from "../target/idl/cross_vault.json";
import {
  CCTP,
  CHAIN,
  configPda,
  poolPda,
  fetchCctpAttestation,
  rebalanceCctpIx,
  cctpAccounts,
  cctpRoutePda,
  bytes32ToEvmAddress,
  evmAddressToBytes32,
  reclaimCctpEventAccountIx,
  decryptSwapParams,
  encryptSwapParams,
  orderId,
  parseEventsFromTx,
  PROGRAM_ID,
  vaultAddress,
  RELAY,
  getRelayQuote,
  checkRelayQuote,
  rebalanceRelayIx,
  indexRelayTx,
  getRelayStatus,
  relayStagingAddress,
  relayVaultTokenAddress,
} from "../client/vault-client";

// ------------------------------ .env ------------------------------
/** Load the deploy config from .env before anything reads process.env (variables already set in the shell are not overridden) */
const ENV_FILE = path.resolve(process.env.ENV_FILE || ".env");
// a missing file is fine (e.g. before keygen creates it): commands that need a key say which variable is missing
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
/** Read an env variable, trimmed; empty string = not set */
const env = (k: string): string | undefined => process.env[k]?.trim() || undefined;
/** Fatal error while loading the config (before main runs): print and exit without a stack trace */
function die(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

// ------------------------------ config.json (non-secret, one section per network) ------------------------------
const CONFIG_FILE = path.resolve(process.env.CONFIG_FILE || "config.json");
const NETWORKS = ["localnet", "devnet", "mainnet"] as const;
type Network = (typeof NETWORKS)[number];
interface PoolCfg {
  mint: string;
  /** token units, e.g. "1000" */
  watermark: string;
  /** token units, "" / "0" = unlimited */
  maxDebit: string;
}
interface EvmTestnetCfg {
  name: string;
  chainId: number;
  rpc: string;
  messageTransmitter: string;
  usdc: string;
  explorer: string;
}
interface NetworkCfg {
  /** default RPC; RPC_URL in .env overrides it */
  rpc: string;
  /** role -> address, used when that role's private key is not in .env */
  addresses: Record<string, string>;
  /** token symbol -> pool settings (setup creates / updates them) */
  pools: Record<string, PoolCfg>;
  cctp: {
    /** Circle Iris attestation API */
    attestationApi: string;
    /** chain name -> CCTP domain number */
    domains: Record<string, number>;
    /** chain name -> our vault (0x..) on that chain; setup registers them on chain */
    routes: Record<string, string>;
    /** EVM test chain used by cctp-receive / evm-balance (devnet only) */
    evmTestnet: EvmTestnetCfg | null;
  };
  relay: {
    api: string;
    /** chain name -> Relay chain id */
    chains: Record<string, number>;
    defaultChain: string;
    /** our vault on the destination chain; empty = the EVM_PRIVATE_KEY address (testing) */
    defaultRecipient: string;
    /** chain name -> default destination token */
    defaultTokens: Record<string, string>;
  };
}
function readConfigFile(): { networks: Record<string, NetworkCfg>; [k: string]: unknown } {
  if (!fs.existsSync(CONFIG_FILE)) die(`config file not found: ${CONFIG_FILE}`);
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (e: any) {
    die(`${path.basename(CONFIG_FILE)} is not valid JSON: ${e.message}`);
  }
}
/** Fill in missing sections so the rest of the code never sees undefined */
function normalizeNetworkCfg(c: Partial<NetworkCfg>): NetworkCfg {
  return {
    rpc: c.rpc ?? "",
    addresses: c.addresses ?? {},
    pools: c.pools ?? {},
    cctp: { attestationApi: "", domains: {}, routes: {}, evmTestnet: null, ...(c.cctp ?? {}) },
    relay: { api: "", chains: {}, defaultChain: "", defaultRecipient: "", defaultTokens: {}, ...(c.relay ?? {}) },
  };
}
/**
 * Network: --network devnet|mainnet|localnet (anywhere on the command line, removed before the command parses its args)
 * > NETWORK in .env / shell > devnet
 */
function takeNetworkFlag(): string | undefined {
  const i = process.argv.indexOf("--network");
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) die("--network needs a value: devnet / mainnet / localnet");
  process.argv.splice(i, 2);
  return v;
}
const NETWORK = (takeNetworkFlag() ?? env("NETWORK") ?? "devnet") as Network;
if (!NETWORKS.includes(NETWORK)) die(`network ${NETWORK} is not one of ${NETWORKS.join(" / ")}`);
/** Per-network secret: <NETWORK>_<NAME> (e.g. MAINNET_ADMIN_PRIVATE_KEY, DEVNET_RPC_URL) wins over the shared <NAME> */
const netName = (name: string) => `${NETWORK.toUpperCase()}_${name}`;
/** Private keys: on mainnet ONLY the MAINNET_ name counts, so devnet / test wallets can never sign mainnet transactions */
const isPrivate = (name: string) => name.endsWith("_PRIVATE_KEY") || name === "ENCRYPTION_SECRET_KEY";
const sharedAllowed = (name: string) => !(NETWORK === "mainnet" && isPrivate(name));
/** Variable name to tell the user to set */
const keyVar = (name: string) => (sharedAllowed(name) ? `${name} (or ${netName(name)})` : netName(name));
const secret = (name: string): string | undefined => env(netName(name)) ?? (sharedAllowed(name) ? env(name) : undefined);
/** Which variable a secret came from, for messages */
const secretSource = (name: string) => (env(netName(name)) ? netName(name) : sharedAllowed(name) && env(name) ? name : undefined);
const CFG: NetworkCfg = normalizeNetworkCfg(readConfigFile().networks?.[NETWORK] ?? die(`${path.basename(CONFIG_FILE)} has no networks.${NETWORK} section`));
/** Where a setting lives, for error messages: config.json networks.devnet.pools.USDC */
const cfgPath = (p: string) => `${path.basename(CONFIG_FILE)} networks.${NETWORK}.${p}`;

// ------------------------------ infrastructure ------------------------------
const RPC_URL = secret("RPC_URL") ?? (CFG.rpc || die(`no RPC: set ${netName("RPC_URL")} in .env or ${cfgPath("rpc")}`));
const IS_LOCAL = /127\.0\.0\.1|localhost/.test(RPC_URL); // local RPC: connect directly, without the proxy
const BPF_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const USDC_DECIMALS = 6;
/** Official Circle devnet USDC (faucet https://faucet.circle.com), alias --mint circle */
const CIRCLE_DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

/** Route Node through the system proxy (https_proxy etc.); local validator connects directly */
process.env.NO_PROXY ||= "localhost,127.0.0.1";
const proxyAgent = new EnvHttpProxyAgent();
setGlobalDispatcher(proxyAgent); // all fetches (Circle Iris etc.) go through the system proxy (except local addresses)

/** ethers uses Node's http module and ignores the proxy by default: register a proxied request function */
FetchRequest.registerGetUrl(async (req) => {
  const res = await undiciFetch(req.url, {
    method: req.method,
    headers: Object.fromEntries(Object.entries(req.headers)),
    body: req.body ? Buffer.from(req.body) : undefined,
    dispatcher: proxyAgent,
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  return { statusCode: res.status, statusMessage: res.statusText, headers, body: new Uint8Array(await res.arrayBuffer()) };
});
/** EVM test chain (Sepolia) settings; only configured for devnet */
function evmTestnet(): EvmTestnetCfg {
  const t = CFG.cctp.evmTestnet;
  if (!t) throw new Error(`no ${cfgPath("cctp.evmTestnet")}: the EVM test commands (cctp-receive, evm-balance) only work on devnet`);
  return t;
}
const sepoliaProvider = () => new JsonRpcProvider(secret("EVM_RPC_URL") ?? evmTestnet().rpc, evmTestnet().chainId, { staticNetwork: true });
const SEPOLIA_ABI = {
  usdc: ["function balanceOf(address) view returns (uint256)"],
  messageTransmitter: ["function receiveMessage(bytes message, bytes attestation) returns (bool)"],
};
const proxiedFetch: any = (url: any, init: any) =>
  undiciFetch(url, IS_LOCAL ? init : { ...init, dispatcher: proxyAgent });

const connection = new Connection(RPC_URL, { commitment: "confirmed", fetch: proxiedFetch, disableRetryOnRateLimit: false });
const dummyWallet = new anchor.Wallet(Keypair.generate());
const provider = new anchor.AnchorProvider(connection, dummyWallet, { commitment: "confirmed" });
const program = new Program<CrossVault>(idl as CrossVault, provider);

const log = (...a: any[]) => console.log(...a);
const explorer = (sig: string) =>
  NETWORK === "localnet"
    ? `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(RPC_URL)}`
    : NETWORK === "mainnet"
      ? `https://explorer.solana.com/tx/${sig}`
      : `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

/** Token amount <-> base units */
const toUnits = (v: string | number): bigint => {
  const [i, f = ""] = String(v).split(".");
  if (f.length > USDC_DECIMALS) throw new Error(`amount has more than ${USDC_DECIMALS} decimals: ${v}`);
  return BigInt(i || "0") * 10n ** BigInt(USDC_DECIMALS) + BigInt((f + "000000").slice(0, USDC_DECIMALS));
};
const fmt = (units: bigint | number | BN) => {
  const u = BigInt(units.toString());
  const s = u.toString().padStart(USDC_DECIMALS + 1, "0");
  return `${s.slice(0, -USDC_DECIMALS)}.${s.slice(-USDC_DECIMALS)}`.replace(/\.?0+$/, "") || "0";
};
const bn = (v: bigint) => new BN(v.toString());

/** SOL amount string -> lamports, exact (no floating point), at most 9 decimals */
const solToLamports = (v: string): bigint => {
  if (!/^\d*\.?\d+$/.test(v)) throw new Error(`invalid SOL amount: ${v}`);
  const [i, f = ""] = v.split(".");
  if (f.length > 9) throw new Error(`SOL amount has more than 9 decimals: ${v}`);
  return BigInt(i || "0") * 1_000_000_000n + BigInt((f + "000000000").slice(0, 9));
};
/** lamports -> SOL string, trailing zeros trimmed */
const lamportsToSol = (l: bigint): string => {
  const s = l.toString().padStart(10, "0");
  return `${s.slice(0, -9)}.${s.slice(-9)}`.replace(/\.?0+$/, "") || "0";
};

// ------------------------------ keys (.env) ------------------------------
const ROLES = ["admin", "operator", "rebalancer", "feepayer", "fee-wallet", "user", "user2"] as const;
type Role = (typeof ROLES)[number];
const isRole = (v: string): v is Role => (ROLES as readonly string[]).includes(v);
/** Env variable holding a role's private key: "fee-wallet" -> FEE_WALLET_PRIVATE_KEY */
const roleEnv = (role: string) => `${role.toUpperCase().replace(/-/g, "_")}_PRIVATE_KEY`;
const envFileName = () => path.basename(ENV_FILE);

/**
 * Wallet private key string -> Keypair
 * Accepts: the base58 string exported by Phantom / Solflare / Backpack (64 bytes), or a solana CLI keypair file content [12,34,...]
 * @param name variable name, only used in error messages (the key itself is never printed)
 */
function parsePrivateKey(name: string, raw: string): Keypair {
  const v = raw.trim().replace(/^["']|["']$/g, "");
  let bytes: Uint8Array;
  try {
    bytes = v.startsWith("[") ? Uint8Array.from(JSON.parse(v)) : bs58.decode(v);
  } catch {
    throw new Error(`${name} is not a valid private key: expected the base58 string exported by the wallet, or a [..] JSON array`);
  }
  // a wallet address is also base58 (32 bytes): reject it instead of silently treating it as a seed, which would yield a different wallet
  if (bytes.length === 32) throw new Error(`${name} looks like a wallet ADDRESS (32 bytes), not a private key: export the private key from the wallet`);
  if (bytes.length !== 64) throw new Error(`${name} decodes to ${bytes.length} bytes, expected the 64-byte private key exported by the wallet`);
  try {
    return Keypair.fromSecretKey(bytes); // also checks that the public half matches the secret half
  } catch {
    throw new Error(`${name} is not a valid Solana private key (the public key part does not match)`);
  }
}

/** Does .env hold this role's private key? */
const hasKey = (role: Role) => !!secret(roleEnv(role));
/**
 * Role name -> Keypair from <ROLE>_PRIVATE_KEY in .env.
 * A path to a solana CLI key file also works (e.g. target/deploy/cross_vault-keypair.json, or accept-admin --key <file>).
 */
function loadKp(roleOrPath: string): Keypair {
  if (isRole(roleOrPath)) {
    const name = roleEnv(roleOrPath);
    const raw = secret(name);
    if (!raw)
      throw new Error(`${keyVar(name)} is not set in ${envFileName()}: paste the ${roleOrPath} wallet's base58 private key, or run yarn -s cli keygen to create test wallets`);
    return parsePrivateKey(secretSource(name)!, raw);
  }
  if (!fs.existsSync(roleOrPath)) throw new Error(`unknown role or key file: ${roleOrPath} (roles: ${ROLES.join(", ")})`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(roleOrPath, "utf8"))));
}
/**
 * Address of a role: from its private key in .env, otherwise addresses.<role> in config.json
 * (address only: e.g. operator / rebalancer when the deployer does not hold their keys). Both set but different = error.
 */
function rolePubkey(role: Role): PublicKey {
  const fromKey = hasKey(role) ? loadKp(role).publicKey : null;
  const addr = CFG.addresses[role]?.trim();
  let fromCfg: PublicKey | null = null;
  if (addr) {
    try {
      fromCfg = new PublicKey(addr);
    } catch {
      throw new Error(`${cfgPath(`addresses.${role}`)} is not a valid Solana address: ${addr}`);
    }
  }
  if (fromKey && fromCfg && !fromKey.equals(fromCfg))
    throw new Error(`${role}: ${roleEnv(role)} in ${envFileName()} is ${fromKey.toBase58()} but ${cfgPath(`addresses.${role}`)} is ${fromCfg.toBase58()}; keep only one`);
  const pk = fromKey ?? fromCfg;
  if (!pk) throw new Error(`${role} is not configured: set ${keyVar(roleEnv(role))} in ${envFileName()}, or ${cfgPath(`addresses.${role}`)}`);
  return pk;
}
const roleConfigured = (role: Role) => hasKey(role) || !!CFG.addresses[role]?.trim();
/** Role name / keypair file / pubkey string -> pubkey */
function resolvePubkey(v: string): PublicKey {
  if (isRole(v)) return rolePubkey(v);
  if (fs.existsSync(v)) return loadKp(v).publicKey;
  return new PublicKey(v);
}

// ------------------------------ tokens (config.json pools) ------------------------------
/** Token alias -> mint: usdc / usdt (config.json pools.<SYMBOL>.mint), circle (Circle devnet USDC), or a raw mint address */
function resolveMint(v?: string): PublicKey {
  const name = (v ?? "usdc").toUpperCase();
  if (name === "CIRCLE") return new PublicKey(CIRCLE_DEVNET_USDC);
  const m = CFG.pools[name]?.mint?.trim();
  if (m) return new PublicKey(m);
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v ?? "")) return new PublicKey(v!);
  throw new Error(`${cfgPath(`pools.${name}.mint`)} is empty: set it, or run yarn -s cli use-usdc --mint circle / yarn -s cli create-token --symbol ${name.toLowerCase()}`);
}
const loadMint = () => resolveMint("usdc");
/** Tokens with a mint in config.json */
function knownMints(): { symbol: string; mint: PublicKey }[] {
  return Object.entries(CFG.pools)
    .filter(([, p]) => p?.mint?.trim())
    .map(([symbol, p]) => ({ symbol, mint: new PublicKey(p.mint.trim()) }));
}
/** mint -> display name (USDC / USDT / shortened address) */
const symbolOf = (mint: PublicKey) =>
  knownMints().find((m) => m.mint.equals(mint))?.symbol ?? (mint.equals(new PublicKey(CIRCLE_DEVNET_USDC)) ? "USDC" : mint.toBase58().slice(0, 6) + "…");

// ------------------------------ other secrets (.env) ------------------------------
/** V2 encryption key pair (x25519) from ENCRYPTION_SECRET_KEY (base64 of the 32-byte secret; the public key is derived) */
function loadEncryptionKey(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const raw = secret("ENCRYPTION_SECRET_KEY");
  if (!raw) throw new Error(`${keyVar("ENCRYPTION_SECRET_KEY")} is not set in ${envFileName()}: run yarn -s cli keygen`);
  const sk = Buffer.from(raw, "base64");
  if (sk.length !== 32) throw new Error(`ENCRYPTION_SECRET_KEY must be base64 of 32 bytes (got ${sk.length})`);
  return nacl.box.keyPair.fromSecretKey(sk);
}
/** EVM test wallet from EVM_PRIVATE_KEY (0x + 64 hex) */
function loadEvm(): { privateKey: string; address: string } {
  const raw = secret("EVM_PRIVATE_KEY");
  if (!raw) throw new Error(`${keyVar("EVM_PRIVATE_KEY")} is not set in ${envFileName()}: run yarn -s cli evm-keygen`);
  try {
    const w = new Wallet(raw.startsWith("0x") ? raw : `0x${raw}`);
    return { privateKey: w.privateKey, address: w.address };
  } catch {
    throw new Error("EVM_PRIVATE_KEY is not a valid EVM private key (0x + 64 hex characters)");
  }
}
async function usdcBalanceOf(addr: string): Promise<bigint> {
  return new Contract(evmTestnet().usdc, SEPOLIA_ABI.usdc, sepoliaProvider()).balanceOf(addr);
}

// ------------------------------ writing .env / config.json (keygen, import-keys, create-token, use-usdc) ------------------------------
/**
 * Set NAME=value in the .env file, only if it is missing or empty: an existing value is NEVER overwritten.
 * Creates .env from .env.example (mode 600) if it does not exist yet.
 */
function setEnvIfEmpty(baseName: string, value: string): "written" | "kept" {
  const name = sharedAllowed(baseName) ? baseName : netName(baseName); // mainnet private keys go to MAINNET_<NAME>
  if (!fs.existsSync(ENV_FILE)) {
    const tpl = path.resolve(".env.example");
    fs.writeFileSync(ENV_FILE, fs.existsSync(tpl) ? fs.readFileSync(tpl, "utf8") : "", { mode: 0o600 });
  }
  let text = fs.readFileSync(ENV_FILE, "utf8");
  const re = new RegExp(`^${name}=(.*)$`, "m");
  const m = text.match(re);
  if (m && m[1].trim()) return "kept";
  const line = `${name}=${value}`;
  text = m ? text.replace(re, () => line) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
  fs.writeFileSync(ENV_FILE, text, { mode: 0o600 });
  fs.chmodSync(ENV_FILE, 0o600);
  process.env[name] = value; // visible to the rest of this run
  return "written";
}
/** Change this network's section of config.json (file and in-memory copy) */
function updateNetworkConfig(fn: (c: NetworkCfg) => void) {
  const file = readConfigFile();
  file.networks[NETWORK] = normalizeNetworkCfg(file.networks[NETWORK] ?? {});
  fn(file.networks[NETWORK]);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(file, null, 2) + "\n");
  fn(CFG);
}

/** Set a pool's mint, keeping its watermark / maxDebit (new entry: watermark 0, unlimited) */
function setPoolMint(c: NetworkCfg, symbol: string, mint: string) {
  c.pools[symbol] = { mint, watermark: c.pools[symbol]?.watermark ?? "0", maxDebit: c.pools[symbol]?.maxDebit ?? "0" };
}

// ------------------------------ deploy config (config.json) ------------------------------
const SO_FILE = "target/deploy/cross_vault.so";
const PROGRAM_KEYPAIR_FILE = "target/deploy/cross_vault-keypair.json";

/**
 * Pools from config.json (entries with an empty mint are skipped).
 * strict: throw on an incomplete entry (setup); otherwise collect it in problems (env-check)
 */
function configPools(strict: boolean) {
  const pools: { symbol: string; mint: PublicKey; watermark: bigint; maxDebit: bigint }[] = [];
  const problems: string[] = [];
  for (const [symbol, p] of Object.entries(CFG.pools)) {
    const mint = p?.mint?.trim();
    if (!mint) continue;
    try {
      const wm = String(p.watermark ?? "").trim();
      if (!wm) throw new Error(`${cfgPath(`pools.${symbol}.watermark`)} is empty (token units, e.g. "1000"; "0" keeps nothing)`);
      let mintPk: PublicKey;
      try {
        mintPk = new PublicKey(mint);
      } catch {
        throw new Error(`${cfgPath(`pools.${symbol}.mint`)} is not a valid address: ${mint}`);
      }
      pools.push({ symbol, mint: mintPk, watermark: toUnits(wm), maxDebit: toUnits(String(p.maxDebit ?? "").trim() || "0") });
    } catch (e: any) {
      if (strict) throw e;
      problems.push(e.message);
    }
  }
  return { pools, problems };
}
/** CCTP routes from config.json: chain name -> our vault, domain looked up in cctp.domains */
function configRoutes() {
  return Object.entries(CFG.cctp.routes).flatMap(([chain, addr]) => {
    if (!addr?.trim()) return [];
    const domain = CFG.cctp.domains[chain];
    if (domain === undefined) throw new Error(`${cfgPath(`cctp.routes.${chain}`)}: ${chain} is not in cctp.domains (${Object.keys(CFG.cctp.domains).join(", ")})`);
    let recipient: string;
    try {
      recipient = bytes32ToEvmAddress(evmAddressToBytes32(addr.trim())); // validates + normalizes to lowercase
    } catch {
      throw new Error(`${cfgPath(`cctp.routes.${chain}`)} is not a valid EVM address: ${addr}`);
    }
    return [{ chain, domain, recipient }];
  });
}
/** --domain value: a number, or a chain name from cctp.domains (ETHEREUM, BASE ...) */
function resolveDomain(v: string): number {
  if (/^\d+$/.test(v)) return Number(v);
  const d = CFG.cctp.domains[v.toUpperCase()];
  if (d === undefined) throw new Error(`unknown CCTP chain ${v}: use a domain number or one of ${Object.keys(CFG.cctp.domains).join(", ")} (${cfgPath("cctp.domains")})`);
  return d;
}
/** CCTP domain -> chain name from config.json, for display */
const domainName = (d: number) => Object.entries(CFG.cctp.domains).find(([, x]) => x === d)?.[0] ?? "?";

/** Name of the cluster behind RPC_URL, from its genesis hash (never trust the URL text for safety checks) */
async function clusterName(): Promise<"mainnet" | "devnet" | "testnet" | "localnet"> {
  const g = await connection.getGenesisHash();
  if (g === "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d") return "mainnet";
  if (g === "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") return "devnet";
  if (g === "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY") return "testnet";
  return "localnet";
}
const EXPECTED: Record<Network, (actual: string) => boolean> = {
  mainnet: (a) => a === "mainnet",
  devnet: (a) => a === "devnet",
  localnet: (a) => a === "localnet",
};
let networkChecked: Promise<void> | undefined;
/** Make sure RPC_URL really is NETWORK (e.g. never apply the devnet config to mainnet). Checked once per run, before any transaction */
function assertNetwork(): Promise<void> {
  networkChecked ??= clusterName().then((actual) => {
    if (!EXPECTED[NETWORK](actual)) throw new Error(`network is ${NETWORK} but the RPC (${RPC_URL}) is ${actual}: fix --network / NETWORK, or ${secretSource("RPC_URL") ?? cfgPath("rpc")}`);
  });
  return networkChecked;
}
/** On mainnet, ask the user to type "yes" before sending anything (skip with --yes) */
async function confirmMainnet(a: Record<string, string>, what: string) {
  if ((await clusterName()) !== "mainnet" || a.yes === "true") return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await rl.question(`\n⚠️  MAINNET: ${what}\n   type yes to continue: `);
  rl.close();
  if (ans.trim() !== "yes") throw new Error("cancelled");
}
/** Upgrade authority of the deployed program; undefined = not deployed, null = immutable */
async function upgradeAuthority(): Promise<PublicKey | null | undefined> {
  const programData = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], BPF_UPGRADEABLE)[0];
  const acc = await connection.getAccountInfo(programData);
  if (!acc) return undefined;
  // ProgramData layout: enum tag (4) + slot (8) + Option<Pubkey> (1 + 32)
  return acc.data[12] === 1 ? new PublicKey(acc.data.subarray(13, 45)) : null;
}
/**
 * Run fn with the keypair written to a temporary file (for the solana CLI, which only reads key files).
 * The file is mode 600 in a fresh temp dir and is always deleted afterwards, even on errors.
 */
function withTempKeyfile<T>(kp: Keypair, fn: (file: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-vault-"));
  const file = path.join(dir, "key.json");
  try {
    fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
/** Run the solana CLI with inherited stdio; throws if it fails (call assertNetwork() first) */
function solanaCli(args: string[]) {
  log(`  $ solana ${args.map((x) => (x.includes("cross-vault-") ? "<temp key file>" : x)).join(" ")}`);
  const r = spawnSync("solana", args, { stdio: "inherit" });
  if (r.error) throw new Error(`cannot run solana CLI: ${r.error.message} (is it installed and on PATH?)`);
  if (r.status !== 0) throw new Error(`solana ${args[0]} ${args[1] ?? ""} failed (exit ${r.status})`);
}

// ------------------------------ send transactions (confirm by polling, no websocket) ------------------------------
async function send(ixs: TransactionInstruction[], signers: Keypair[], feePayer: Keypair = signers[0]): Promise<string> {
  await assertNetwork();
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: feePayer.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  const uniq = [feePayer, ...signers.filter((s) => !s.publicKey.equals(feePayer.publicKey))];
  tx.sign(...uniq);
  let sig: string;
  try {
    sig = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
  } catch (e: any) {
    const logs: string[] = e?.logs ?? (await e?.getLogs?.(connection).catch(() => [])) ?? [];
    const anchorErr = logs.find((l) => l.includes("AnchorError") || l.includes("Error Code"));
    throw new Error(`transaction failed: ${anchorErr ?? e.message}\n${logs.slice(-6).join("\n")}`);
  }
  for (let i = 0; i < 60; i++) {
    const st = (await connection.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(`transaction execution failed ${sig}: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") {
      log(`  ✅ transaction succeeded ${sig}\n     ${explorer(sig)}`);
      return sig;
    }
    if ((await connection.getBlockHeight("confirmed")) > lastValidBlockHeight) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`transaction not confirmed in time ${sig}`);
}

// ------------------------------ argument parsing ------------------------------
function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    out[k] = v;
  }
  return out;
}
const need = (a: Record<string, string>, k: string) => {
  if (a[k] === undefined) throw new Error(`missing argument --${k}`);
  return a[k];
};
const bool = (v: string) => {
  if (!["true", "false"].includes(v)) throw new Error(`expected true / false: ${v}`);
  return v === "true";
};

// ------------------------------ commands ------------------------------
const commands: Record<string, { desc: string; run: (a: Record<string, string>) => Promise<void> }> = {
  keygen: {
    desc: "create test wallets for every role that has no key yet and write them into .env (existing keys are never overwritten); also ENCRYPTION_SECRET_KEY and EVM_PRIVATE_KEY",
    run: async () => {
      for (const r of ROLES) {
        const st = setEnvIfEmpty(roleEnv(r), bs58.encode(Keypair.generate().secretKey));
        log(`${r.padEnd(11)} ${loadKp(r).publicKey.toBase58()}${st === "written" ? "  (new)" : ""}`);
      }
      const est = setEnvIfEmpty("ENCRYPTION_SECRET_KEY", Buffer.from(nacl.box.keyPair().secretKey).toString("base64"));
      log(`encryption  ${Buffer.from(loadEncryptionKey().publicKey).toString("base64")} (V2 encryption public key)${est === "written" ? "  (new)" : ""}`);
      await commands["evm-keygen"].run({});
      log(`\nkeys are in ${ENV_FILE} (git-ignored, mode 600). Back it up: losing it loses the wallets.`);
    },
  },

  "import-keys": {
    desc: "move an old key directory (keys/devnet style: <role>.json, encryption.json, evm.json, <token>-mint.txt) into .env / config.json: --dir keys/devnet. Never overwrites; reports conflicts",
    run: async (a) => {
      const dir = path.resolve(need(a, "dir"));
      if (!fs.existsSync(dir)) throw new Error(`${dir} not found`);
      const conflicts: string[] = [];
      /** write one value; if .env already has a DIFFERENT value, record a conflict instead of overwriting */
      const put = (name: string, value: string, same: () => boolean, label: string) => {
        const st = setEnvIfEmpty(name, value);
        if (st === "kept" && !same()) conflicts.push(`${name} in ${envFileName()} differs from ${label}: kept the .env value`);
        log(`  ${name.padEnd(24)} ${st === "written" ? "imported" : same() ? "already in .env (same)" : "CONFLICT, kept .env value"}`);
      };
      for (const r of ROLES) {
        const f = path.join(dir, `${r}.json`);
        if (!fs.existsSync(f)) continue;
        const kp = loadKp(f);
        put(roleEnv(r), bs58.encode(kp.secretKey), () => loadKp(r).publicKey.equals(kp.publicKey), f);
      }
      const ef = path.join(dir, "encryption.json");
      if (fs.existsSync(ef)) {
        const j = JSON.parse(fs.readFileSync(ef, "utf8"));
        put("ENCRYPTION_SECRET_KEY", j.secretKey, () => Buffer.from(loadEncryptionKey().publicKey).toString("base64") === j.publicKey, ef);
      }
      const vf = path.join(dir, "evm.json");
      if (fs.existsSync(vf)) {
        const j = JSON.parse(fs.readFileSync(vf, "utf8"));
        put("EVM_PRIVATE_KEY", j.privateKey, () => loadEvm().address.toLowerCase() === String(j.address).toLowerCase(), vf);
      }
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith("-mint.txt"))) {
        const symbol = f.replace("-mint.txt", "").toUpperCase();
        const mint = fs.readFileSync(path.join(dir, f), "utf8").trim();
        const cur = CFG.pools[symbol]?.mint?.trim();
        if (cur && cur !== mint) {
          conflicts.push(`${cfgPath(`pools.${symbol}.mint`)} is ${cur}, ${f} says ${mint}: kept config.json`);
          log(`  ${`pools.${symbol}.mint`.padEnd(24)} CONFLICT, kept config.json value`);
          continue;
        }
        if (!cur) updateNetworkConfig((c) => setPoolMint(c, symbol, mint));
        log(`  ${`pools.${symbol}.mint`.padEnd(24)} ${cur ? "already in config.json (same)" : `imported into ${cfgPath(`pools.${symbol}`)}`}`);
      }
      if (conflicts.length) {
        log(`\n⚠️  ${conflicts.length} conflict(s), nothing was overwritten:`);
        conflicts.forEach((c) => log(`  - ${c}`));
        log(`Do NOT delete ${dir} until these are resolved.`);
      } else log(`\n✅ everything in ${dir} is now in ${envFileName()} / ${path.basename(CONFIG_FILE)}. Check with yarn -s cli balances, then you can delete ${dir}.`);
    },
  },

  balances: {
    desc: "show SOL / token balances of all roles and pool vaults",
    run: async () => {
      const mints = knownMints();
      log(`network ${NETWORK}, RPC: ${RPC_URL}`);
      log("role".padEnd(12) + "address".padEnd(46) + "SOL".padEnd(12) + mints.map((m) => m.symbol.padEnd(14)).join(""));
      const tokenBal = async (mint: PublicKey, owner: PublicKey) => {
        const b = await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(mint, owner, true)).catch(() => null);
        return b ? fmt(BigInt(b.value.amount)) : "(no account)";
      };
      for (const r of ROLES) {
        if (!roleConfigured(r)) {
          log(r.padEnd(12) + `(not set: ${keyVar(roleEnv(r))})`);
          continue;
        }
        const pk = rolePubkey(r);
        const sol = ((await connection.getBalance(pk)) / LAMPORTS_PER_SOL).toFixed(4);
        const cols: string[] = [];
        for (const m of mints) cols.push((await tokenBal(m.mint, pk)).padEnd(14));
        log(r.padEnd(12) + pk.toBase58().padEnd(46) + sol.padEnd(12) + cols.join(""));
      }
      for (const m of mints) {
        const b = await connection.getTokenAccountBalance(vaultAddress(m.mint)).catch(() => null);
        log(`${m.symbol} vault`.padEnd(12) + vaultAddress(m.mint).toBase58().padEnd(46) + "-".padEnd(12) + (b ? fmt(BigInt(b.value.amount)) : "(no pool)"));
      }
    },
  },

  airdrop: {
    desc: "request test SOL: --to admin --sol 2 (the devnet faucet is rate limited; use the web faucet if it fails)",
    run: async (a) => {
      const to = resolvePubkey(a.to ?? "admin");
      const sol = Number(a.sol ?? "2");
      const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
      for (let i = 0; i < 60; i++) {
        const st = (await connection.getSignatureStatuses([sig])).value[0];
        if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") break;
        await new Promise((r) => setTimeout(r, 500));
      }
      log(`  ✅ received ${sol} SOL -> ${to.toBase58()}, balance ${(await connection.getBalance(to)) / LAMPORTS_PER_SOL} SOL`);
    },
  },

  fund: {
    desc: "admin sends SOL to operator / rebalancer / feepayer each: --sol 0.2",
    run: async (a) => {
      const admin = loadKp("admin");
      const lamports = Math.round(Number(a.sol ?? "0.2") * LAMPORTS_PER_SOL);
      const ixs = (["operator", "rebalancer", "feepayer"] as Role[]).map((r) =>
        SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: rolePubkey(r), lamports })
      );
      await send(ixs, [admin]);
    },
  },

  "send-sol": {
    desc: "admin sends SOL to any address: --to <address | role | keypair file> --sol 0.5 [--from admin]",
    run: async (a) => {
      const from = loadKp(a.from ?? "admin");
      const to = resolvePubkey(need(a, "to"));
      const lamports = solToLamports(need(a, "sol"));
      if (lamports <= 0n) throw new Error("--sol must be greater than 0");
      if (to.equals(from.publicKey)) throw new Error("--to is the same as the sender");

      // Pre-checks so the user gets a readable error instead of a raw simulation failure
      const FEE_RESERVE = 10_000n; // enough for one transaction fee (5000 lamports per signature)
      const fromBal = BigInt(await connection.getBalance(from.publicKey));
      if (fromBal < lamports + FEE_RESERVE) {
        throw new Error(`insufficient SOL: sender has ${lamportsToSol(fromBal)} SOL, needs ${lamportsToSol(lamports + FEE_RESERVE)} (amount + fee)`);
      }
      // A brand-new (0 SOL) account must receive at least the rent-exempt minimum, otherwise the transfer fails
      const toBal = BigInt(await connection.getBalance(to));
      const rentMin = BigInt(await connection.getMinimumBalanceForRentExemption(0));
      if (toBal === 0n && lamports < rentMin) {
        throw new Error(`recipient is a new account: send at least ${lamportsToSol(rentMin)} SOL (rent-exempt minimum)`);
      }

      log(`RPC: ${RPC_URL}`);
      log(`  ${from.publicKey.toBase58()} -> ${to.toBase58()}  ${lamportsToSol(lamports)} SOL`);
      await send([SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports })], [from]);
      log(`  sender balance ${lamportsToSol(BigInt(await connection.getBalance(from.publicKey)))} SOL`);
      log(`  recipient balance ${lamportsToSol(BigInt(await connection.getBalance(to)))} SOL`);
    },
  },

  "create-usdc": {
    desc: "same as create-token --symbol usdc",
    run: async (a) => commands["create-token"].run({ ...a, symbol: "usdc" }),
  },

  "create-token": {
    desc: "issue your own test token (6 decimals, admin is mint authority) and mint --amount 1000 to user / rebalancer each: --symbol usdt",
    run: async (a) => {
      const admin = loadKp("admin");
      const symbol = (a.symbol ?? "usdt").toLowerCase();
      const SYM = symbol.toUpperCase();
      if (NETWORK === "mainnet") throw new Error("create-token issues TEST tokens: not on mainnet");
      let mint: PublicKey;
      if (CFG.pools[SYM]?.mint?.trim()) {
        mint = resolveMint(symbol);
        log(`${SYM} already set in ${cfgPath(`pools.${SYM}.mint`)}: ${mint.toBase58()}`);
      } else {
        const mintKp = Keypair.generate();
        mint = mintKp.publicKey;
        await send(
          [
            SystemProgram.createAccount({
              fromPubkey: admin.publicKey,
              newAccountPubkey: mint,
              space: MINT_SIZE,
              lamports: await getMinimumBalanceForRentExemptMint(connection),
              programId: TOKEN_PROGRAM_ID,
            }),
            createInitializeMint2Instruction(mint, USDC_DECIMALS, admin.publicKey, null),
          ],
          [admin, mintKp]
        );
        updateNetworkConfig((c) => setPoolMint(c, SYM, mint.toBase58()));
        log(`test ${SYM} mint: ${mint.toBase58()} (saved to ${cfgPath(`pools.${SYM}.mint`)})`);
      }
      const amount = toUnits(a.amount ?? "1000");
      const ixs: TransactionInstruction[] = [];
      for (const r of ["user", "rebalancer", "operator", "fee-wallet"] as Role[]) {
        const owner = rolePubkey(r);
        const ata = getAssociatedTokenAddressSync(mint, owner);
        ixs.push(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata, owner, mint));
        if (r === "user" || r === "rebalancer") ixs.push(createMintToInstruction(mint, ata, admin.publicKey, amount));
      }
      await send(ixs, [admin]);
      log(`minted ${fmt(amount)} ${symbol.toUpperCase()} to user and rebalancer each; token accounts created for operator and fee-wallet`);
    },
  },

  "use-usdc": {
    desc: "use an existing USDC (no self-issued token): --mint circle (Circle devnet USDC) or --mint <mint address>; also creates USDC accounts for all roles",
    run: async (a) => {
      const admin = loadKp("admin");
      const m = need(a, "mint");
      const mint = new PublicKey(m === "circle" ? CIRCLE_DEVNET_USDC : m);
      // Validate the mint: must exist, be an SPL Token mint, and have 6 decimals
      const info = await connection.getParsedAccountInfo(mint);
      const parsed: any = (info.value?.data as any)?.parsed;
      if (!info.value || parsed?.type !== "mint") throw new Error(`${mint.toBase58()} is not a valid token mint (wrong cluster?)`);
      if (parsed.info.decimals !== USDC_DECIMALS) throw new Error(`decimals is ${parsed.info.decimals}, not USDC's 6`);
      if (!info.value.owner.equals(TOKEN_PROGRAM_ID)) throw new Error("only USDC issued by the classic SPL Token program is supported");

      if (CFG.pools.USDC?.mint?.trim() && !loadMint().equals(mint)) {
        log(`⚠️ replacing the previous ${loadMint().toBase58()} (its pool, if created, remains on chain)`);
      }
      updateNetworkConfig((c) => setPoolMint(c, "USDC", mint.toBase58()));
      log(`USDC mint: ${mint.toBase58()} (saved to ${cfgPath("pools.USDC.mint")})`);

      // Create token accounts for roles that send/receive USDC (admin pays rent; skipped if they exist)
      const roles: Role[] = ["user", "rebalancer", "operator", "fee-wallet"];
      await send(
        roles.map((r) => {
          const owner = rolePubkey(r);
          return createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, getAssociatedTokenAddressSync(mint, owner), owner, mint);
        }),
        [admin]
      );
      log(`USDC accounts created for ${roles.join(", ")}.\n\nNext: go to the faucet https://faucet.circle.com (choose Solana Devnet) and request USDC for these addresses:`);
      for (const r of ["user", "rebalancer"] as Role[]) log(`  ${r.padEnd(11)} ${rolePubkey(r).toBase58()}`);
      log(`then check with yarn -s cli balances`);
    },
  },

  "send-usdc": {
    desc: "transfer tokens between test accounts: --from rebalancer --to user --amount 5 [--mint usdt]",
    run: async (a) => {
      const from = loadKp(need(a, "from"));
      const to = resolvePubkey(need(a, "to"));
      const mint = resolveMint(a.mint);
      const amount = toUnits(need(a, "amount"));
      const fromAta = getAssociatedTokenAddressSync(mint, from.publicKey, true);
      const toAta = getAssociatedTokenAddressSync(mint, to, true);
      // The sender pays gas; for users without SOL (e.g. user) the feepayer sponsors it
      const payer = (await connection.getBalance(from.publicKey)) > 0 ? from : loadKp("feepayer");
      await send(
        [
          createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, toAta, to, mint),
          createTransferCheckedInstruction(fromAta, mint, toAta, from.publicKey, amount, USDC_DECIMALS),
        ],
        [from],
        payer
      );
      log(`transferred ${fmt(amount)} ${symbolOf(mint)}: ${from.publicKey.toBase58()} -> ${to.toBase58()}`);
    },
  },

  // ------------------------------ deployment (.env driven, see docs/deployment-guide.md) ------------------------------
  "env-check": {
    desc: "check the deploy config (.env + config.json), sends nothing: network, admin balance, roles, program, pools and CCTP routes to configure",
    run: async () => {
      log(`env file        ${fs.existsSync(ENV_FILE) ? ENV_FILE : "(none, only shell variables)"}`);
      log(`config file     ${CONFIG_FILE}  [networks.${NETWORK}]`);
      log(`RPC_URL         ${RPC_URL}  (${secretSource("RPC_URL") ?? "config.json rpc"})`);
      const actual = await clusterName();
      log(`network         ${NETWORK}, RPC is ${actual}${EXPECTED[NETWORK](actual) ? " ✔" : "  ⚠️  MISMATCH: every transaction will be refused"}`);
      const admin = loadKp("admin");
      const sol = BigInt(await connection.getBalance(admin.publicKey));
      log(`admin           ${admin.publicKey.toBase58()}  (${lamportsToSol(sol)} SOL, ${secretSource("ADMIN_PRIVATE_KEY")})`);
      const src = (r: Role) => (hasKey(r) ? `private key ${secretSource(roleEnv(r))}` : "address in config.json");
      const operator = rolePubkey("operator");
      const rebalancer = rolePubkey("rebalancer");
      log(`operator        ${operator.toBase58()}  (${src("operator")})`);
      log(`rebalancer      ${rebalancer.toBase58()}  (${src("rebalancer")})`);
      if (operator.equals(admin.publicKey) || rebalancer.equals(admin.publicKey)) log(`  ⚠️  operator / rebalancer equals admin: use separate wallets in production`);

      log(`\nprogram id      ${PROGRAM_ID.toBase58()}`);
      const auth = await upgradeAuthority();
      if (auth === undefined) {
        const size = fs.existsSync(SO_FILE) ? fs.statSync(SO_FILE).size : 0;
        log(`deployed        no`);
        if (!size) log(`  ⚠️  ${SO_FILE} missing: run anchor build`);
        if (!fs.existsSync(PROGRAM_KEYPAIR_FILE)) log(`  ⚠️  ${PROGRAM_KEYPAIR_FILE} missing: the first deploy needs it (see the guide)`);
        if (size) {
          // program data account (size + 45 bytes header) + a temporary buffer of the same size during deploy
          const rent = BigInt(await connection.getMinimumBalanceForRentExemption(size + 45));
          log(`  deploy needs   ~${lamportsToSol(rent * 2n)} SOL (half is refunded after the deploy)`);
          if (sol < rent * 2n) log(`  ⚠️  admin balance is not enough`);
        }
      } else {
        log(`deployed        yes, upgrade authority ${auth ? auth.toBase58() : "(none, immutable)"}`);
        if (auth && !auth.equals(admin.publicKey)) log(`  ⚠️  admin in .env is not the upgrade authority: deploy (upgrade) and init will fail`);
      }
      const cfg = await program.account.config.fetchNullable(configPda());
      log(`initialized     ${cfg ? `yes, on-chain admin ${cfg.admin.toBase58()}` : "no"}`);

      const { pools, problems } = configPools(false);
      log(`\npools           ${pools.length || problems.length ? "" : `(none: set ${cfgPath("pools.<TOKEN>.mint")})`}`);
      for (const p of pools) log(`  ${p.symbol.padEnd(5)} ${p.mint.toBase58()}  watermark ${fmt(p.watermark)}  per-tx limit ${p.maxDebit ? fmt(p.maxDebit) : "unlimited"}`);
      for (const p of problems) log(`  ⚠️  ${p}`);
      const routes = configRoutes();
      log(`CCTP routes     ${routes.length ? "" : `(none: set ${cfgPath("cctp.routes.<CHAIN>")})`}`);
      for (const r of routes) log(`  ${r.chain.padEnd(10)} domain ${String(r.domain).padEnd(2)} -> ${r.recipient}`);
      log(`\nnext: ${auth === undefined ? "yarn -s cli deploy" : cfg ? "yarn -s cli setup --dry-run" : "yarn -s cli setup"}`);
    },
  },

  deploy: {
    desc: "deploy or upgrade the program with the admin key (ADMIN_PRIVATE_KEY); the deployer becomes the upgrade authority. [--close-buffers] only reclaims SOL from failed deploys",
    run: async (a) => {
      const admin = loadKp("admin");
      await assertNetwork();
      if (a["close-buffers"] === "true") {
        // a failed deploy leaves a buffer account holding the SOL; this closes all buffers of admin and refunds it
        withTempKeyfile(admin, (k) => solanaCli(["program", "close", "--buffers", "-k", k, "-u", RPC_URL]));
        return;
      }
      if (!fs.existsSync(SO_FILE)) throw new Error(`${SO_FILE} missing: run anchor build first`);
      const auth = await upgradeAuthority();
      let programArg: string;
      if (auth === undefined) {
        // first deploy: needs the program keypair, and it must match declare_id! in lib.rs (= the IDL address)
        if (!fs.existsSync(PROGRAM_KEYPAIR_FILE)) throw new Error(`${PROGRAM_KEYPAIR_FILE} missing: see "program id" in docs/deployment-guide.md`);
        const pid = loadKp(PROGRAM_KEYPAIR_FILE).publicKey;
        if (!pid.equals(PROGRAM_ID)) throw new Error(`${PROGRAM_KEYPAIR_FILE} is ${pid.toBase58()} but the program is built for ${PROGRAM_ID.toBase58()}: run anchor keys sync && anchor build`);
        programArg = PROGRAM_KEYPAIR_FILE;
        log(`first deploy of ${PROGRAM_ID.toBase58()}, upgrade authority will be admin ${admin.publicKey.toBase58()}`);
      } else {
        if (!auth || !auth.equals(admin.publicKey)) throw new Error(`cannot upgrade: upgrade authority is ${auth?.toBase58() ?? "(none)"}, admin in .env is ${admin.publicKey.toBase58()}`);
        programArg = PROGRAM_ID.toBase58(); // upgrade: the address is enough
        log(`upgrading ${PROGRAM_ID.toBase58()} (upgrade authority = admin)`);
      }
      await confirmMainnet(a, `${auth === undefined ? "deploy" : "UPGRADE"} program ${PROGRAM_ID.toBase58()}`);
      withTempKeyfile(admin, (k) => solanaCli(["program", "deploy", SO_FILE, "--program-id", programArg, "-k", k, "-u", RPC_URL, "--use-rpc"]));
      log(`\n✅ upgrade authority: ${(await upgradeAuthority())?.toBase58()}`);
      log(`next: yarn -s cli setup${auth === undefined ? "" : " --dry-run (only if the config changed)"}`);
    },
  },

  setup: {
    desc: "make the on-chain config match config.json (+ role keys in .env): init -> roles -> pools (create / update) -> CCTP routes. Idempotent, safe to re-run. [--dry-run] only print the plan",
    run: async (a) => {
      await assertNetwork();
      const admin = loadKp("admin");
      const operator = rolePubkey("operator");
      const rebalancer = rolePubkey("rebalancer");
      const { pools } = configPools(true);
      const routes = configRoutes();
      const plan: { desc: string; ix: () => Promise<TransactionInstruction> }[] = [];

      // 1. initialize, or update the roles if they differ from the config
      const cfg = await program.account.config.fetchNullable(configPda());
      if (!cfg) {
        const auth = await upgradeAuthority();
        if (auth === undefined) throw new Error("program not deployed yet: run yarn -s cli deploy first");
        if (!auth || !auth.equals(admin.publicKey)) throw new Error(`initialize must be sent by the upgrade authority ${auth?.toBase58()}, admin in .env is ${admin.publicKey.toBase58()}`);
        const programData = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], BPF_UPGRADEABLE)[0];
        plan.push({
          desc: `initialize: admin ${admin.publicKey.toBase58()}, operator ${operator.toBase58()}, rebalancer ${rebalancer.toBase58()}`,
          ix: () => program.methods.initialize(operator, rebalancer).accountsPartial({ admin: admin.publicKey, thisProgram: PROGRAM_ID, programData }).instruction(),
        });
      } else {
        if (!cfg.admin.equals(admin.publicKey)) throw new Error(`the program admin is ${cfg.admin.toBase58()}, not the admin in .env ${admin.publicKey.toBase58()}`);
        const op = cfg.operator.equals(operator) ? null : operator;
        const rb = cfg.rebalancer.equals(rebalancer) ? null : rebalancer;
        if (op || rb)
          plan.push({
            desc: `set_config:${op ? ` operator ${cfg.operator.toBase58()} -> ${op.toBase58()}` : ""}${rb ? ` rebalancer ${cfg.rebalancer.toBase58()} -> ${rb.toBase58()}` : ""}`,
            ix: () => program.methods.setConfig({ operator: op, rebalancer: rb }).accountsPartial({ admin: admin.publicKey }).instruction(),
          });
      }

      // 2. pools: create missing ones, update watermark / per-tx limit if they differ
      for (const p of pools) {
        const info = await getMint(connection, p.mint).catch(() => null);
        if (!info) throw new Error(`${cfgPath(`pools.${p.symbol}.mint`)} ${p.mint.toBase58()} is not a token mint on ${NETWORK}`);
        if (info.decimals !== USDC_DECIMALS) throw new Error(`${cfgPath(`pools.${p.symbol}.mint`)} has ${info.decimals} decimals, this CLI only handles ${USDC_DECIMALS}`);
        const pool = await program.account.pool.fetchNullable(poolPda(p.mint));
        const wm = bn(p.watermark), md = bn(p.maxDebit);
        if (!pool) {
          plan.push({
            desc: `create_pool ${p.symbol}: watermark ${fmt(p.watermark)}, per-tx limit ${p.maxDebit ? fmt(p.maxDebit) : "unlimited"}`,
            ix: () => program.methods.createPool(wm, md).accountsPartial({ admin: admin.publicKey, mint: p.mint, pool: poolPda(p.mint), vault: vaultAddress(p.mint), tokenProgram: TOKEN_PROGRAM_ID }).instruction(),
          });
        } else if (!pool.watermark.eq(wm) || !pool.maxDebitPerTx.eq(md)) {
          plan.push({
            desc: `set_pool_config ${p.symbol}: watermark ${fmt(pool.watermark)} -> ${fmt(p.watermark)}, per-tx limit ${fmt(pool.maxDebitPerTx)} -> ${fmt(p.maxDebit)}`,
            ix: () => program.methods.setPoolConfig({ watermark: wm, maxDebitPerTx: md }).accountsPartial({ admin: admin.publicKey, pool: poolPda(p.mint) }).instruction(),
          });
        }
      }

      // 3. CCTP routes: register missing ones, update changed ones; routes only on chain are reported, never removed automatically
      for (const r of routes) {
        const cur = await program.account.cctpRoute.fetchNullable(cctpRoutePda(r.domain));
        const curAddr = cur ? bytes32ToEvmAddress(cur.mintRecipient) : null;
        if (curAddr === r.recipient) continue;
        plan.push({
          desc: `set_cctp_route ${r.chain} (domain ${r.domain}): ${curAddr ?? "(none)"} -> ${r.recipient}`,
          ix: () => program.methods.setCctpRoute(r.domain, evmAddressToBytes32(r.recipient)).accountsPartial({ admin: admin.publicKey, route: cctpRoutePda(r.domain) }).instruction(),
        });
      }
      for (const { account: r } of await program.account.cctpRoute.all()) {
        if (!routes.some((x) => x.domain === r.domain))
          log(`  ℹ️  on-chain route domain ${r.domain} -> ${bytes32ToEvmAddress(r.mintRecipient)} is not in config.json (kept; remove with yarn -s cli remove-route --domain ${r.domain})`);
      }

      log(`network ${await clusterName()}, ${plan.length ? `${plan.length} change(s):` : "on-chain config already matches config.json, nothing to do"}`);
      plan.forEach((p, i) => log(`  ${i + 1}. ${p.desc}`));
      if (!plan.length || a["dry-run"] === "true") return;

      await confirmMainnet(a, `send the ${plan.length} change(s) above`);
      // one transaction per step: if one fails, the earlier ones stay done and re-running setup continues from there
      for (const p of plan) {
        log(`\n▶ ${p.desc}`);
        await send([await p.ix()], [admin]);
      }
      log("");
      await commands.status.run({});
    },
  },

  keyfile: {
    desc: "write a role's private key (from .env) to a solana CLI key file, for tools that need a file (e.g. transfer-upgrade-authority.sh): --out path [--role admin]. Delete the file afterwards!",
    run: async (a) => {
      const role = a.role ?? "admin";
      if (!isRole(role)) throw new Error(`unknown role ${role}`);
      const out = path.resolve(need(a, "out"));
      if (fs.existsSync(out)) throw new Error(`${out} already exists, refusing to overwrite`);
      const kp = loadKp(role);
      fs.writeFileSync(out, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
      log(`wrote ${role} ${kp.publicKey.toBase58()} -> ${out} (mode 600)\n⚠️  this file is a private key: delete it when done: rm ${out}`);
    },
  },

  init: {
    desc: "initialize the program (admin must be the upgrade authority); creates only the global Config, then add tokens with create-pool",
    run: async () => {
      const admin = loadKp("admin");
      // Config can only be created once: if already initialized, just show the current status without sending a tx
      if (await connection.getAccountInfo(configPda())) {
        log("Program already initialized (Config exists), no need to run init again. Current status:");
        await commands.status.run({});
        return;
      }
      const programData = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], BPF_UPGRADEABLE)[0];
      const ix = await program.methods
        .initialize(rolePubkey("operator"), rolePubkey("rebalancer"))
        .accountsPartial({ admin: admin.publicKey, thisProgram: PROGRAM_ID, programData })
        .instruction();
      await send([ix], [admin]);
      await commands.status.run({});
    },
  },

  "create-pool": {
    desc: "admin adds a supported token (creates pool + vault): --mint usdc|usdt|address --watermark 5 [--max-debit 0 (0 = unlimited)]",
    run: async (a) => {
      const admin = loadKp("admin");
      const mint = resolveMint(a.mint);
      const ix = await program.methods
        .createPool(bn(toUnits(a.watermark ?? "0")), bn(toUnits(a["max-debit"] ?? "0")))
        .accountsPartial({ admin: admin.publicKey, mint, pool: poolPda(mint), vault: vaultAddress(mint), tokenProgram: TOKEN_PROGRAM_ID })
        .instruction();
      await send([ix], [admin]);
      await commands.status.run({});
    },
  },

  status: {
    desc: "show program roles and the status of all pools (tokens)",
    run: async () => {
      const c = await program.account.config.fetchNullable(configPda());
      if (!c) return log(`program ${PROGRAM_ID.toBase58()} is not initialized on ${NETWORK} (run yarn -s cli env-check)`);
      log(`program id      ${PROGRAM_ID.toBase58()}`);
      log(`Config          ${configPda().toBase58()}`);
      log(`admin           ${c.admin.toBase58()}`);
      log(`pending_admin   ${c.pendingAdmin.equals(PublicKey.default) ? "(none)" : c.pendingAdmin.toBase58()}`);
      log(`operator        ${c.operator.toBase58()}`);
      log(`rebalancer      ${c.rebalancer.toBase58()}`);
      const pools = await program.account.pool.all();
      if (!pools.length) return log(`\nno pools yet, create one with yarn -s cli create-pool --mint usdc --watermark 5`);
      for (const { publicKey, account: p } of pools) {
        const sym = symbolOf(p.mint);
        const bal = BigInt((await connection.getTokenAccountBalance(p.vault)).value.amount);
        const wm = BigInt(p.watermark.toString());
        log(`\n[${sym} pool] ${publicKey.toBase58()}`);
        log(`  mint          ${p.mint.toBase58()}`);
        log(`  vault           ${p.vault.toBase58()}`);
        log(`  vault balance   ${fmt(bal)} ${sym}`);
        log(`  watermark       ${fmt(wm)} ${sym} (rebalanceable: ${fmt(bal > wm ? bal - wm : 0n)})`);
        log(`  per-tx limit    ${p.maxDebitPerTx.isZero() ? "unlimited" : fmt(p.maxDebitPerTx) + " " + sym}`);
        log(`  deposit paused  ${p.depositPaused}`);
        log(`  withdraw paused ${p.withdrawPaused}`);
        const staging = await connection.getTokenAccountBalance(relayStagingAddress(p.mint)).catch(() => null);
        log(`  relay staging   ${staging ? fmt(BigInt(staging.value.amount)) + " " + sym + (staging.value.amount !== "0" ? " (Relay refund, run relay-reclaim)" : "") : "(not created)"}`);
      }
      const routes = (await program.account.cctpRoute.all()).sort((x, y) => x.account.domain - y.account.domain);
      log(`\n[CCTP routes] rebalance can only go to the destination vaults registered here${routes.length ? "" : " (none yet, register with set-route)"}`);
      for (const { account: r } of routes) log(`  domain ${String(r.domain).padEnd(4)} ${domainName(r.domain).padEnd(10)} → ${bytes32ToEvmAddress(r.mintRecipient)}`);
    },
  },

  "set-route": {
    desc: "admin registers / updates our vault contract on a destination chain: --domain 0|ETHEREUM --recipient 0x.. (default: the EVM_PRIVATE_KEY address, for testing). For permanent routes prefer config.json cctp.routes + setup",
    run: async (a) => {
      const admin = loadKp("admin");
      const domain = resolveDomain(need(a, "domain"));
      const recipient: string = a.recipient ?? loadEvm().address;
      const ix = await program.methods
        .setCctpRoute(domain, evmAddressToBytes32(recipient))
        .accountsPartial({ admin: admin.publicKey, route: cctpRoutePda(domain) })
        .instruction();
      log(`registering CCTP route: domain ${domain} -> ${recipient}`);
      await send([ix], [admin]);
      await commands.status.run({});
    },
  },

  "remove-route": {
    desc: "admin removes the route of a destination chain (rent refunded to admin); rebalancing to that chain is then impossible: --domain 0|ETHEREUM",
    run: async (a) => {
      const admin = loadKp("admin");
      const domain = resolveDomain(need(a, "domain"));
      const ix = await program.methods
        .removeCctpRoute(domain)
        .accountsPartial({ admin: admin.publicKey, route: cctpRoutePda(domain) })
        .instruction();
      await send([ix], [admin]);
      await commands.status.run({});
    },
  },

  "set-config": {
    desc: "admin updates roles: [--operator role/address] [--rebalancer role/address]",
    run: async (a) => {
      const admin = loadKp("admin");
      const ix = await program.methods
        .setConfig({
          operator: a.operator ? resolvePubkey(a.operator) : null,
          rebalancer: a.rebalancer ? resolvePubkey(a.rebalancer) : null,
        })
        .accountsPartial({ admin: admin.publicKey })
        .instruction();
      await send([ix], [admin]);
      await commands.status.run({});
    },
  },

  "set-pool": {
    desc: "admin updates pool params: --mint usdc [--watermark 100] [--max-debit 50 (0 = unlimited)]",
    run: async (a) => {
      const admin = loadKp("admin");
      const mint = resolveMint(a.mint);
      const ix = await program.methods
        .setPoolConfig({
          watermark: a.watermark !== undefined ? bn(toUnits(a.watermark)) : null,
          maxDebitPerTx: a["max-debit"] !== undefined ? bn(toUnits(a["max-debit"])) : null,
        })
        .accountsPartial({ admin: admin.publicKey, pool: poolPda(mint) })
        .instruction();
      await send([ix], [admin]);
      await commands.status.run({});
    },
  },

  pause: {
    desc: "admin sets a pool's pause flags: --mint usdc --deposit true|false --withdraw true|false",
    run: async (a) => {
      const admin = loadKp("admin");
      const mint = resolveMint(a.mint);
      const ix = await program.methods
        .setPauseFlags(bool(need(a, "deposit")), bool(need(a, "withdraw")))
        .accountsPartial({ admin: admin.publicKey, pool: poolPda(mint) })
        .instruction();
      await send([ix], [admin]);
    },
  },

  deposit: {
    desc: "user deposit V1 (plaintext, user signs, feepayer pays gas): --amount 1 --fee 0.05 [--mint usdt] [--recipient 0x..] [--token 0x..]",
    run: async (a) => {
      const user = loadKp(a.user ?? "user");
      const feePayer = loadKp("feepayer");
      const mint = resolveMint(a.mint);
      const id = orderId.random();
      const ix = await program.methods
        .depositForSwap({
          orderId: id,
          amount: bn(toUnits(need(a, "amount"))),
          fee: bn(toUnits(a.fee ?? "0")),
          destChainId: new BN(Number(a.chain ?? CHAIN.BSC)),
          recipient: a.recipient ?? "0x3b7dca567179daecec9b8f308984a22542cccd96",
          targetToken: a.token ?? "0xe55296ff1ccf6f6136cf00e552e46ef69e30a3e2",
          minAmountOut: new BN(a["min-out"] ?? "0"),
        })
        .accountsPartial({
          user: user.publicKey,
          mint,
          pool: poolPda(mint),
          vault: vaultAddress(mint),
          userToken: getAssociatedTokenAddressSync(mint, user.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();
      log(`order id ${orderId.toHex(id)}`);
      await send([ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }), ix], [user], feePayer);
    },
  },

  "deposit-v2": {
    desc: "user deposit V2 (encrypted destination params): --amount 1 --fee 0.05 [--mint usdt] [--recipient 0x..] [--token 0x..]",
    run: async (a) => {
      const user = loadKp(a.user ?? "user");
      const feePayer = loadKp("feepayer");
      const mint = resolveMint(a.mint);
      const id = orderId.random();
      const enc = encryptSwapParams(
        {
          destChainId: Number(a.chain ?? CHAIN.BSC),
          recipient: a.recipient ?? "0x3b7dca567179daecec9b8f308984a22542cccd96",
          targetToken: a.token ?? "0xe55296ff1ccf6f6136cf00e552e46ef69e30a3e2",
          minAmountOut: a["min-out"] ?? "0",
        },
        loadEncryptionKey().publicKey
      );
      const ix = await program.methods
        .depositForSwapV2({ orderId: id, amount: bn(toUnits(need(a, "amount"))), fee: bn(toUnits(a.fee ?? "0")), encryptedParams: enc })
        .accountsPartial({
          user: user.publicKey,
          mint,
          pool: poolPda(mint),
          vault: vaultAddress(mint),
          userToken: getAssociatedTokenAddressSync(mint, user.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();
      log(`order id ${orderId.toHex(id)}, ciphertext ${enc.length} bytes`);
      await send([ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }), ix], [user], feePayer);
    },
  },

  payout: {
    desc: "operator pays a user from a pool (one tx: create account + debit user + debit fee): --user user2 --amount 0.9 [--fee 0.01] [--mint usdt]",
    run: async (a) => {
      const operator = loadKp(a.operator ?? "operator");
      const mint = resolveMint(a.mint);
      const user = resolvePubkey(a.user ?? "user2");
      const id = orderId.random();
      const userAta = getAssociatedTokenAddressSync(mint, user, true);
      const debit = (dest: PublicKey, amt: bigint) =>
        program.methods
          .debit(id, bn(amt))
          .accountsPartial({ operator: operator.publicKey, mint, pool: poolPda(mint), vault: vaultAddress(mint), destination: dest, tokenProgram: TOKEN_PROGRAM_ID })
          .instruction();
      const ixs = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 120_000 }),
        createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, userAta, user, mint),
        await debit(userAta, toUnits(need(a, "amount"))),
      ];
      const fee = toUnits(a.fee ?? "0");
      if (fee > 0n) {
        const feeOwner = rolePubkey("fee-wallet");
        const feeAta = getAssociatedTokenAddressSync(mint, feeOwner);
        ixs.push(createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, feeAta, feeOwner, mint));
        ixs.push(await debit(feeAta, fee));
      }
      log(`order id ${orderId.toHex(id)}`);
      await send(ixs, [operator]);
    },
  },

  "add-liquidity": {
    desc: "add funds to a pool (rebalancer pays by default): --amount 200 [--mint usdt] [--from role]",
    run: async (a) => {
      const from = loadKp(a.from ?? "rebalancer");
      const mint = resolveMint(a.mint);
      const ix = await program.methods
        .addLiquidity(bn(toUnits(need(a, "amount"))))
        .accountsPartial({
          from: from.publicKey,
          mint,
          pool: poolPda(mint),
          vault: vaultAddress(mint),
          fromToken: getAssociatedTokenAddressSync(mint, from.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();
      await send([ix], [from]);
    },
  },

  "rebalance-cctp": {
    desc: "rebalancer bridges the USDC above the pool watermark via CCTP V2 (standard mode): --amount 5 or --all, --domain 0|ETHEREUM (default ETHEREUM; Sepolia on devnet). The recipient is the registered route",
    run: async (a) => {
      const rb = loadKp(a.rebalancer ?? "rebalancer");
      const mint = resolveMint(a.mint);
      const domain = resolveDomain(a.domain ?? "ETHEREUM");
      // CCTP has a remote_token_messenger account for every supported destination chain; missing = domain not supported by CCTP, warn early
      if (!(await connection.getAccountInfo(cctpAccounts(mint, domain).remoteTokenMessenger))) {
        throw new Error(`CCTP does not support domain ${domain} (no remote_token_messenger account on chain). Known: ${Object.entries(CFG.cctp.domains).map(([k, v]) => `${v}=${k}`).join(", ")}`);
      }
      // The program reads the recipient from the route; look it up here to display it, and warn early if not registered
      const route = await program.account.cctpRoute.fetchNullable(cctpRoutePda(domain));
      if (!route) throw new Error(`no destination vault registered for domain ${domain}; ask admin to run: yarn -s cli set-route --domain ${domain} --recipient 0x...`);
      const recipient = bytes32ToEvmAddress(route.mintRecipient);
      let amount: bigint;
      if (a.all) {
        const p = await program.account.pool.fetch(poolPda(mint));
        const bal = BigInt((await connection.getTokenAccountBalance(p.vault)).value.amount);
        amount = bal - BigInt(p.watermark.toString());
        if (amount <= 0n) return log("vault balance is not above the watermark, nothing to rebalance");
      } else amount = toUnits(need(a, "amount"));
      const eventKp = Keypair.generate();
      log(`CCTP bridging ${fmt(amount)} USDC -> domain ${domain}, recipient ${recipient}`);
      log(`message account ${eventKp.publicKey.toBase58()}`);
      const ix = await rebalanceCctpIx(program, rb.publicKey, mint, amount, domain, eventKp.publicKey);
      const sig = await send([ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }), ix], [rb, eventKp]);
      log(`\nNext: wait for the Circle attestation (standard mode waits for Solana finality, usually tens of seconds), then:`);
      log(`  yarn -s cli cctp-status  --tx ${sig}`);
      log(`  yarn -s cli cctp-receive --tx ${sig}`);
    },
  },

  "cctp-status": {
    desc: "check the attestation status of a CCTP message (Circle Iris, config.json cctp.attestationApi): --tx <Solana tx signature>",
    run: async (a) => {
      const st = await fetchCctpAttestation(need(a, "tx"), { api: CFG.cctp.attestationApi });
      if (!st) return log("Circle has not indexed this transaction yet, try again in a few seconds");
      log(`status      ${st.status}${st.status === "complete" ? " (ready to receive on the destination chain)" : " (pending)"}`);
      log(`eventNonce  ${st.eventNonce}`);
      const dm = st.raw.decodedMessage;
      if (dm) {
        log(`src domain  ${dm.sourceDomain} -> dst domain ${dm.destinationDomain}`);
        const b = dm.decodedMessageBody ?? {};
        if (b.mintRecipient) log(`recipient   ${b.mintRecipient}`);
        if (b.amount) log(`amount      ${fmt(BigInt(b.amount))} USDC`);
      }
      if (st.message) log(`message     ${st.message.slice(0, 66)}... (${(st.message.length - 2) / 2} bytes)`);
      if (st.attestation) log(`attestation ${st.attestation.slice(0, 66)}...`);
    },
  },

  "cctp-receive": {
    desc: "(devnet) submit receiveMessage on the EVM testnet (Sepolia) to receive USDC, gas paid by EVM_PRIVATE_KEY: --tx <Solana tx signature> [--wait 600 max seconds] [--dry-run simulate only]",
    run: async (a) => {
      const sig = need(a, "tx");
      const evm = loadEvm();
      const tn = evmTestnet();
      const waitSec = Number(a.wait ?? "600");
      const t0 = Date.now();
      let st = await fetchCctpAttestation(sig, { api: CFG.cctp.attestationApi });
      while (!st || st.status !== "complete" || !st.message || !st.attestation) {
        if ((Date.now() - t0) / 1000 > waitSec) throw new Error(`no attestation after ${waitSec}s, current status ${st?.status ?? "not indexed"}`);
        process.stdout.write(`\rwaiting for Circle attestation... status=${st?.status ?? "not indexed"} waited ${Math.round((Date.now() - t0) / 1000)}s   `);
        await new Promise((r) => setTimeout(r, 5000));
        st = await fetchCctpAttestation(sig, { api: CFG.cctp.attestationApi });
      }
      log(`\nattestation ready, submitting to ${tn.name} MessageTransmitterV2 ${tn.messageTransmitter}`);
      const provider = sepoliaProvider();
      const wallet = new Wallet(evm.privateKey, provider);
      const recipient: string | undefined = st.raw.decodedMessage?.decodedMessageBody?.mintRecipient;
      const before = recipient ? await usdcBalanceOf(recipient) : null;
      const mt = new Contract(tn.messageTransmitter, SEPOLIA_ABI.messageTransmitter, wallet);
      if (a["dry-run"]) {
        try {
          await mt.receiveMessage.staticCall(st.message, st.attestation);
          log("  ✅ simulation succeeded (--dry-run, nothing sent)");
        } catch (e: any) {
          log(`  ❌ simulation failed: ${e.reason ?? e.shortMessage ?? e.message}`);
        }
        return;
      }
      const tx = await mt.receiveMessage(st.message, st.attestation);
      log(`  ${tn.name} tx sent ${tx.hash}\n     ${tn.explorer}/tx/${tx.hash}`);
      const receipt = await tx.wait();
      if (receipt?.status !== 1) throw new Error(`${tn.name} tx failed ${tx.hash}`);
      log(`  ✅ USDC minted on ${tn.name}`);
      if (recipient && before !== null) {
        const after = await usdcBalanceOf(recipient);
        log(`  recipient ${recipient} USDC: ${fmt(before)} -> ${fmt(after)}`);
      }
    },
  },

  "cctp-reclaim": {
    desc: "reclaim CCTP message account rent (~0.0039 SOL each, refunded to rebalancer; only after the CCTP window expires): --tx <signature> --event <message account>",
    run: async (a) => {
      const rb = loadKp(a.rebalancer ?? "rebalancer");
      const eventAcc = new PublicKey(need(a, "event"));
      const st = await fetchCctpAttestation(need(a, "tx"), { api: CFG.cctp.attestationApi });
      if (!st?.message || !st.attestation) throw new Error(`attestation not ready (status ${st?.status ?? "not indexed"})`);
      const ix = reclaimCctpEventAccountIx(rb.publicKey, eventAcc, st.attestation, st.message);
      const before = await connection.getBalance(rb.publicKey);
      await send([ix], [rb]);
      log(`  reclaimed ${((await connection.getBalance(rb.publicKey)) - before) / LAMPORTS_PER_SOL} SOL (net of tx fee)`);
    },
  },

  "relay-quote": {
    desc: "(mainnet) ask Relay for a rebalance quote and check it, without sending: --amount 5 [--mint usdc] [--chain BSC|56] [--to-token 0x..] [--recipient 0x..] (defaults: config.json relay)",
    run: async (a) => {
      const { req, checked, quote } = await relayQuote(a, toUnits(need(a, "amount")));
      printRelayQuote(req, checked, quote);
    },
  },

  "rebalance-relay": {
    desc: "(mainnet) rebalancer bridges the amount above the watermark via Relay (e.g. to BSC): --amount 5 or --all [--mint usdc] [--chain BSC|56] [--to-token 0x..] [--recipient 0x..] [--min-out 4.9]",
    run: async (a) => {
      const rb = loadKp(a.rebalancer ?? "rebalancer");
      const mint = resolveMint(a.mint);
      let amount: bigint;
      if (a.all) {
        const p = await program.account.pool.fetch(poolPda(mint));
        const bal = BigInt((await connection.getTokenAccountBalance(p.vault)).value.amount);
        amount = bal - BigInt(p.watermark.toString());
        if (amount <= 0n) return log("vault balance is not above the watermark, nothing to rebalance");
      } else amount = toUnits(need(a, "amount"));
      if (!(await connection.getAccountInfo(relayVaultTokenAddress(mint))))
        throw new Error(`Relay has no token account for ${mint.toBase58()} (ATA of its vault); this token cannot be deposited from a PDA`);
      const { req, checked, quote } = await relayQuote(a, amount);
      printRelayQuote(req, checked, quote);
      const ix = await rebalanceRelayIx(program, rb.publicKey, mint, amount, checked.orderId);
      const sig = await send([ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ix], [rb]);
      // the deposit happens inside our program (CPI): tell Relay so it is picked up promptly
      try {
        log(`Relay transactions/index: ${await indexRelayTx(sig, checked.requestId, secret("RELAY_API_KEY"), CFG.relay.api)}`);
      } catch (e: any) {
        log(`⚠️  Relay transactions/index failed (${e.message}); Relay may still detect it, check the status`);
      }
      log(`\nNext: yarn -s cli relay-status --request ${checked.requestId}`);
    },
  },

  "relay-status": {
    desc: "(mainnet) Relay request status: --request 0x<requestId>",
    run: async (a) => {
      const st = await getRelayStatus(need(a, "request"), CFG.relay.api);
      log(JSON.stringify(st, null, 2));
    },
  },

  "relay-reclaim": {
    desc: "move Relay refunds from the relay staging account back into the vault (anyone may call): [--mint usdc] [--caller rebalancer]",
    run: async (a) => {
      const caller = loadKp(a.caller ?? "rebalancer");
      const mint = resolveMint(a.mint);
      const staging = relayStagingAddress(mint);
      const bal = await connection.getTokenAccountBalance(staging).catch(() => null);
      if (!bal || bal.value.amount === "0") return log(`relay staging ${staging.toBase58()} is empty, nothing to reclaim`);
      log(`moving ${fmt(BigInt(bal.value.amount))} ${symbolOf(mint)} from relay staging back into the vault`);
      const ix = await program.methods
        .reclaimRelayRefund()
        .accountsPartial({ caller: caller.publicKey, mint, pool: poolPda(mint), vault: vaultAddress(mint), relayStaging: staging, tokenProgram: TOKEN_PROGRAM_ID })
        .instruction();
      await send([ix], [caller]);
    },
  },

  "evm-keygen": {
    desc: "create the EVM test wallet (EVM_PRIVATE_KEY in .env, kept if it exists): CCTP test recipient on Sepolia, pays receiveMessage gas",
    run: async () => {
      const st = setEnvIfEmpty("EVM_PRIVATE_KEY", Wallet.createRandom().privateKey);
      log(`evm         ${loadEvm().address}${st === "written" ? "  (new)" : ""}`);
      if (st === "written") log(`            fund it with some Sepolia ETH (receiveMessage gas), e.g. https://cloud.google.com/application/web3/faucet/ethereum/sepolia`);
    },
  },

  "evm-balance": {
    desc: "(devnet) show ETH / USDC balance on the EVM testnet (Sepolia): [--address 0x..] (default: the EVM_PRIVATE_KEY address)",
    run: async (a) => {
      const addr = a.address ?? loadEvm().address;
      log(`${evmTestnet().name} ${addr}`);
      log(`  ETH   ${formatEther(await sepoliaProvider().getBalance(addr))}`);
      log(`  USDC  ${fmt(await usdcBalanceOf(addr))}`);
    },
  },

  "transfer-admin": {
    desc: "admin nominates a new admin (step 1): --to role/address",
    run: async (a) => {
      const admin = loadKp(a.admin ?? "admin");
      const ix = await program.methods.transferAdmin(resolvePubkey(need(a, "to"))).accountsPartial({ admin: admin.publicKey }).instruction();
      await send([ix], [admin]);
    },
  },

  "accept-admin": {
    desc: "new admin accepts (step 2): --key <role name whose private key is in .env> or a keypair file",
    run: async (a) => {
      const kp = loadKp(need(a, "key"));
      const ix = await program.methods.acceptAdmin().accountsPartial({ newAdmin: kp.publicKey }).instruction();
      await send([ix], [kp]);
    },
  },

  events: {
    desc: "show recent program events (V2 decrypted automatically): --limit 10",
    run: async (a) => {
      const sigs = await connection.getSignaturesForAddress(PROGRAM_ID, { limit: Number(a.limit ?? 10) }, "confirmed");
      let ek: { secretKey: Uint8Array } | null = null;
      try {
        ek = loadEncryptionKey();
      } catch {}
      for (const s of sigs.reverse()) {
        if (s.err) continue;
        for (const e of await parseEventsFromTx(program, s.signature)) {
          const d = e.data;
          const t = new Date((d.timestamp?.toNumber?.() || s.blockTime || 0) * 1000).toISOString().replace("T", " ").slice(0, 19);
          let line = `${t}  ${e.name}`;
          if (d.orderId) line += `  order=${orderId.toHex(d.orderId)}`;
          if (d.amount) line += `  amount=${fmt(d.amount)}${d.mint ? " " + symbolOf(d.mint) : ""}`;
          if (d.fee) line += `  fee=${fmt(d.fee)}`;
          if (d.recipient) line += `  → ${d.recipient}  token=${d.targetToken}`;
          if (d.destinationOwner) line += `  → ${d.destinationOwner.toBase58()}`;
          if (d.destinationDomain !== undefined && d.mintRecipient)
            line += `  CCTP -> domain ${d.destinationDomain} 0x${Buffer.from(d.mintRecipient.toBytes()).subarray(12).toString("hex")}  message account=${d.messageSentEventData.toBase58()}`;
          if (d.encryptedParams && ek) {
            const p = decryptSwapParams(d.encryptedParams, ek.secretKey);
            line += `  [decrypted] chain=${p.destChainId} -> ${p.recipient} token=${p.targetToken}`;
          }
          if (d.vaultBalance) line += `  vault=${fmt(d.vaultBalance)}`;
          log(line);
        }
      }
    },
  },

  "sweep-sol": {
    desc: "after testing: send all SOL of operator / rebalancer / feepayer (those with a private key in .env) back to admin: [--roles operator,rebalancer,feepayer]",
    run: async (a) => {
      const admin = rolePubkey("admin");
      const roles = (a.roles ?? "operator,rebalancer,feepayer").split(",").map((r) => r.trim());
      const FEE = 5000n; // one signature
      for (const r of roles) {
        if (!isRole(r) || r === "admin") throw new Error(`invalid role ${r}`);
        if (!hasKey(r)) {
          log(`${r.padEnd(11)} skipped (no ${keyVar(roleEnv(r))})`);
          continue;
        }
        const kp = loadKp(r);
        const bal = BigInt(await connection.getBalance(kp.publicKey));
        if (bal <= FEE) {
          log(`${r.padEnd(11)} skipped (${lamportsToSol(bal)} SOL)`);
          continue;
        }
        log(`${r.padEnd(11)} ${lamportsToSol(bal - FEE)} SOL -> admin`);
        // the whole balance minus the fee: the account is emptied (and closed by the runtime)
        await send([SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: admin, lamports: bal - FEE })], [kp]);
      }
      log(`admin balance ${lamportsToSol(BigInt(await connection.getBalance(admin)))} SOL`);
    },
  },

  "close-program": {
    desc: "IRREVERSIBLE (testing only): close the program and refund its rent to admin; the program id can never be deployed again on this network. Run drain first",
    run: async (a) => {
      const admin = loadKp("admin");
      await assertNetwork();
      if (NETWORK === "mainnet") throw new Error("close-program is refused on mainnet");
      const auth = await upgradeAuthority();
      if (auth === undefined) return log("program is not deployed (or already closed)");
      if (!auth || !auth.equals(admin.publicKey)) throw new Error(`only the upgrade authority ${auth?.toBase58()} can close it`);
      for (const { account: p } of await program.account.pool.all()) {
        const bal = BigInt((await connection.getTokenAccountBalance(p.vault)).value.amount);
        if (bal > 0n && a.force !== "true") throw new Error(`${symbolOf(p.mint)} vault still holds ${fmt(bal)}: run yarn -s cli drain first (funds would be locked forever)`);
      }
      const pid = PROGRAM_ID.toBase58();
      if (a.yes !== "true") {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const ans = await rl.question(`\n⚠️  close ${pid} on ${NETWORK}? This cannot be undone. Type the last 4 characters of the program id: `);
        rl.close();
        if (ans.trim() !== pid.slice(-4)) throw new Error("cancelled");
      }
      withTempKeyfile(admin, (k) => solanaCli(["program", "close", pid, "--bypass-warning", "-k", k, "-u", RPC_URL]));
    },
  },

  drain: {
    desc: "empty all pools after testing: admin unpauses and removes per-tx limits, operator moves each vault's full balance to the operator's own account",
    run: async () => {
      const admin = loadKp("admin");
      const operator = loadKp("operator");
      for (const { account: p } of await program.account.pool.all()) {
        const mint = p.mint;
        const sym = symbolOf(mint);
        await send(
          [
            await program.methods
              .setPoolConfig({ watermark: null, maxDebitPerTx: new BN(0) })
              .accountsPartial({ admin: admin.publicKey, pool: poolPda(mint) })
              .instruction(),
            await program.methods.setPauseFlags(false, false).accountsPartial({ admin: admin.publicKey, pool: poolPda(mint) }).instruction(),
          ],
          [admin]
        );
        const bal = BigInt((await connection.getTokenAccountBalance(p.vault)).value.amount);
        if (bal === 0n) continue;
        const opAta = getAssociatedTokenAddressSync(mint, operator.publicKey);
        log(`moving ${sym} vault ${fmt(bal)} to operator ${operator.publicKey.toBase58()}`);
        await send(
          [
            createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, opAta, operator.publicKey, mint),
            await program.methods
              .debit(Array.from(Buffer.alloc(16)), bn(bal))
              .accountsPartial({ operator: operator.publicKey, mint, pool: poolPda(mint), vault: p.vault, destination: opAta, tokenProgram: TOKEN_PROGRAM_ID })
              .instruction(),
          ],
          [operator]
        );
      }
      await commands.status.run({});
    },
  },
};

// ------------------------------ Relay helpers ------------------------------
/** Relay destination chain from --chain (name from config.json relay.chains, or a chain id), default relay.defaultChain */
function resolveRelayChain(v?: string): { id: number; name?: string } {
  const key = v ?? CFG.relay.defaultChain;
  if (!key) throw new Error(`pass --chain, or set ${cfgPath("relay.defaultChain")}`);
  if (/^\d+$/.test(key)) return { id: Number(key), name: Object.entries(CFG.relay.chains).find(([, id]) => id === Number(key))?.[0] };
  const id = CFG.relay.chains[key.toUpperCase()];
  if (id === undefined) throw new Error(`unknown Relay chain ${key}: use a chain id or one of ${Object.keys(CFG.relay.chains).join(", ")} (${cfgPath("relay.chains")})`);
  return { id, name: key.toUpperCase() };
}

/** Build the quote request from CLI args + config.json relay, fetch the quote and check it (throws if unsafe) */
async function relayQuote(a: Record<string, string>, amount: bigint) {
  const mint = resolveMint(a.mint);
  const chain = resolveRelayChain(a.chain);
  const destinationChainId = chain.id;
  const destinationCurrency = a["to-token"] ?? (chain.name ? CFG.relay.defaultTokens[chain.name] : undefined);
  if (!destinationCurrency) throw new Error(`no default token for chain ${chain.name ?? chain.id} in ${cfgPath("relay.defaultTokens")}, pass --to-token 0x..`);
  const recipient = a.recipient ?? (CFG.relay.defaultRecipient.trim() || loadEvm().address);
  const req = { mint, amount, destinationChainId, destinationCurrency, recipient, apiKey: secret("RELAY_API_KEY"), api: CFG.relay.api || undefined };
  const quote = await getRelayQuote(req);
  // --min-out is in destination token units; read its decimals from the quote
  const decimals = Number(quote?.details?.currencyOut?.currency?.decimals ?? 18);
  const minAmountOut = a["min-out"] ? parseUnits(a["min-out"], decimals) : undefined;
  const checked = checkRelayQuote(quote, { ...req, minAmountOut });
  return { req, checked, quote };
}

function printRelayQuote(req: { mint: PublicKey; amount: bigint; destinationChainId: number; recipient: string }, checked: any, quote: any) {
  const out = quote.details.currencyOut;
  log(`Relay quote (checked ✔)`);
  log(`  in          ${fmt(req.amount)} ${symbolOf(req.mint)} from Pool ${poolPda(req.mint).toBase58()}`);
  log(`  out         ${out.amountFormatted} ${out.currency.symbol} on chain ${req.destinationChainId} (minimum ${formatUnits(out.minimumAmount, out.currency.decimals)})`);
  log(`  recipient   ${req.recipient}`);
  log(`  relay fee   ${quote.fees?.relayer?.amountFormatted ?? "?"} ${quote.fees?.relayer?.currency?.symbol ?? ""}`);
  log(`  orderId     0x${Buffer.from(checked.orderId).toString("hex")}`);
  log(`  requestId   ${checked.requestId}`);
  log(`  eta         ~${quote.details.timeEstimate ?? "?"}s`);
}

// ------------------------------ entry point ------------------------------
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || !commands[cmd]) {
    log("Usage: yarn -s cli <command> [--arg value] [--network devnet|mainnet|localnet]\n");
    for (const [k, v] of Object.entries(commands)) log(`  ${k.padEnd(15)} ${v.desc}`);
    log(`\ncurrent network=${NETWORK}  RPC=${RPC_URL}\n        env ${ENV_FILE}${fs.existsSync(ENV_FILE) ? "" : " (missing)"}  config ${CONFIG_FILE}`);
    if (cmd && cmd !== "help") process.exit(1);
    return;
  }
  await commands[cmd].run(parseArgs(rest));
}

main().catch((e) => {
  console.error(`\n❌ ${e.message ?? e}`);
  process.exit(1);
});

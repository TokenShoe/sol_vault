# cross_vault 部署指南（中文版）

只列步骤和命令。每个字段的详细解释见英文版 [deployment-guide.md](deployment-guide.md)。

- 所有命令都在项目根目录 `internal_bridge_sol/` 下运行
- 每个命令都可以加 `--network devnet` 或 `--network mainnet` 来选择网络，不加时用 `.env` 里的 `NETWORK`（默认 devnet）
- 金额单位都是代币个数，比如 `--amount 1.5` 就是 1.5 USDC

---

## 0. 准备（每台电脑做一次）

```bash
solana --version          # 4.1.2
anchor --version          # 1.2.2
node --version            # >= 22

yarn install
anchor build              # 生成 target/deploy/cross_vault.so
```

第一次部署时，还需要程序 ID 的密钥文件 `target/deploy/cross_vault-keypair.json`。二选一：

```bash
# 方式 A：用项目现有的程序 ID：向项目负责人私下要这个文件，放进 target/deploy/，然后检查
solana-keygen pubkey target/deploy/cross_vault-keypair.json      # 应输出 A38GT8a6...

# 方式 B：用自己的新程序 ID（会改代码，需要提交）
solana-keygen new -o target/deploy/cross_vault-keypair.json --no-bip39-passphrase --force
anchor keys sync
anchor build
```

---

## 1. 填写 `.env`（私钥和 RPC，不提交 git）

```bash
cp .env.example .env
```

用编辑器打开 `.env`，填这几项：

```bash
NETWORK=devnet                                   # 不加 --network 时默认用的网络

DEVNET_RPC_URL=https://devnet.helius-rpc.com/?api-key=你的KEY      # 不填就用公共节点（容易被限流）
MAINNET_RPC_URL=https://mainnet.helius-rpc.com/?api-key=你的KEY

# devnet 用的私钥：从 Phantom 导出的 base58 字符串（约 88 个字符，不是地址）
ADMIN_PRIVATE_KEY=
OPERATOR_PRIVATE_KEY=
REBALANCER_PRIVATE_KEY=
FEEPAYER_PRIVATE_KEY=
FEE_WALLET_PRIVATE_KEY=
USER_PRIVATE_KEY=
USER2_PRIVATE_KEY=

# 主网只读 MAINNET_ 开头的私钥，不会用上面那些
MAINNET_ADMIN_PRIVATE_KEY=
```

devnet 测试想快点，可以一键生成测试钱包（只填空着的项，已有的不会覆盖）：

```bash
yarn -s cli keygen
```

如果手上还有旧的 `keys/devnet` 目录，一键导入：

```bash
yarn -s cli import-keys --dir keys/devnet
```

> Phantom 导出私钥：设置 → 管理账户 → 选账户 → 显示私钥 → 输入密码。
> `.env` 是这些钱包私钥唯一的一份，一定要备份。

---

## 2. 填写 `config.json`（不是秘密，提交 git）

找到对应网络的那一段（`networks.devnet` 或 `networks.mainnet`），按需修改：

```json
"devnet": {
  "addresses": {
    "operator": "",
    "rebalancer": "",
    "fee-wallet": ""
  },
  "pools": {
    "USDC": { "mint": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", "watermark": "1", "maxDebit": "0" },
    "USDT": { "mint": "", "watermark": "50", "maxDebit": "100" }
  },
  "cctp": {
    "routes": {
      "ETHEREUM": "0x72281a602539d2E31a1129DeE7d26C4960c8F787"
    }
  }
}
```

| 字段 | 怎么填 |
|---|---|
| `addresses.operator` / `rebalancer` / `fee-wallet` | `.env` 里没有这个角色的私钥时，在这里填它的**地址**。主网一般这样填 |
| `pools.<代币>.mint` | 代币地址。留空表示不建这个池子 |
| `pools.<代币>.watermark` | 金库最少保留多少（代币个数，字符串）。主网**必须自己填** |
| `pools.<代币>.maxDebit` | 单笔付款上限，`"0"` 表示不限 |
| `cctp.routes.<链名>` | 我们在这条链上的金库合约地址。链名从 `cctp.domains` 里选：`ETHEREUM` `AVALANCHE` `OPTIMISM` `ARBITRUM` `BASE` `POLYGON` |

**CCTP 路由样例**（以太坊金库）：

```json
"routes": {
  "ETHEREUM": "0x72281a602539d2E31a1129DeE7d26C4960c8F787"
}
```

要配多条链就继续加，比如 `"BASE": "0x..."`。

> 现在这个样例只写在了 **devnet** 一段，对应 Sepolia 测试链。主网的 `networks.mainnet.cctp.routes` 要另外填主网金库地址，转错地址的钱找不回来，务必核对两遍。

---

## 3. 检查配置（不发交易）

```bash
yarn -s cli env-check                      # devnet
yarn -s cli env-check --network mainnet    # 主网
```

确认三点：`network` 一行有 ✔，`admin` 是你的钱包地址，并且没有 ⚠️。

给 admin 准备 SOL（首次部署约 7 SOL，部署后大约退回一半）：

```bash
yarn -s cli airdrop --to admin --sol 2     # 只有 devnet 能用，也可以去网页水龙头 https://faucet.solana.com
yarn -s cli balances                       # 查看所有角色的余额
```

---

## 4. 部署合约

```bash
yarn -s cli deploy                         # 部署到 devnet
yarn -s cli deploy --network mainnet       # 部署到主网（会让你输入 yes 确认）
```

- 第一次运行是部署，以后再运行就是升级，地址和链上数据都保留
- 部署中途失败的话，先用下面的命令回收 SOL，再重新部署：

```bash
yarn -s cli deploy --close-buffers
```

---

## 5. 部署后的配置

### 方式一：一次性配置（推荐）

按 `config.json` 自动完成：初始化 → 设置角色 → 创建资金池 → 登记 CCTP 路由。

```bash
yarn -s cli setup --dry-run                # 先看要做哪些改动（不发交易）
yarn -s cli setup                          # 执行

yarn -s cli setup --network mainnet --dry-run
yarn -s cli setup --network mainnet
```

以后改了 `config.json`（水位线、路由、角色），再运行一次 `setup` 就行，它只发有变化的部分。

### 方式二：单独配置

```bash
# 初始化（只能运行一次，operator / rebalancer 取自 .env 或 config.json）
yarn -s cli init

# 创建资金池
yarn -s cli create-pool --mint usdc --watermark 1
yarn -s cli create-pool --mint usdt --watermark 50 --max-debit 100

# 修改资金池参数
yarn -s cli set-pool --mint usdc --watermark 100
yarn -s cli set-pool --mint usdc --max-debit 50          # 0 = 不限

# 更换角色
yarn -s cli set-config --operator <新地址>
yarn -s cli set-config --rebalancer <新地址>

# 登记 / 修改 / 删除 CCTP 路由
yarn -s cli set-route --domain ETHEREUM --recipient 0x72281a602539d2E31a1129DeE7d26C4960c8F787
yarn -s cli remove-route --domain ETHEREUM

# 暂停 / 恢复某个池子的充值、提款
yarn -s cli pause --mint usdc --deposit true --withdraw false
yarn -s cli pause --mint usdc --deposit false --withdraw false

# 转移 admin（两步）
yarn -s cli transfer-admin --to <新 admin 地址>
yarn -s cli accept-admin --key <新 admin 的角色名>       # 新 admin 的私钥要在 .env 里

# 查看当前链上状态
yarn -s cli status
```

以上命令都可以加 `--network mainnet`。

---

## 6. 测试命令（devnet）

### 6.1 准备测试资金

```bash
yarn -s cli fund --sol 0.2                 # admin 给 operator / rebalancer / feepayer 各转 0.2 SOL

# 准备 USDC，二选一
yarn -s cli use-usdc --mint circle         # A：用 Circle 官方 devnet USDC，然后去 https://faucet.circle.com 领币
yarn -s cli create-usdc --amount 1000      # B：自己发一个测试 USDC（不能走 CCTP 跨链）

yarn -s cli create-token --symbol usdt --amount 1000    # 测试用 USDT
yarn -s cli balances
```

### 6.2 用户充值：deposit_for_swap / deposit_for_swap_v2

```bash
# V1 明文充值（对应 deposit_for_swap）：user 签名，feepayer 付 gas
yarn -s cli deposit --amount 1 --fee 0.05
yarn -s cli deposit --amount 1 --fee 0.05 --mint usdt --chain 56 \
  --recipient 0x3b7dca567179daecec9b8f308984a22542cccd96 \
  --token 0xe55296ff1ccf6f6136cf00e552e46ef69e30a3e2 --min-out 0

# V2 加密充值（对应 deposit_for_swap_v2）：链上看不到目标地址
yarn -s cli deposit-v2 --amount 2 --fee 0.05
```

参数：`--amount` 充值金额，`--fee` 手续费，`--mint` 代币（默认 usdc），`--chain` 目标链 ID（默认 56），`--recipient` 目标链收款地址，`--token` 目标代币合约，`--min-out` 最少到账，`--user` 用哪个角色付款（默认 user）。

### 6.3 加流动性：add_liquidity

```bash
yarn -s cli add-liquidity --amount 200                  # 默认由 rebalancer 出钱
yarn -s cli add-liquidity --amount 200 --mint usdt
```

### 6.4 给用户付款：debit

```bash
# 一笔交易：给 user2 付 0.899372，给 fee-wallet 付 0.004148
yarn -s cli payout --user user2 --amount 0.899372 --fee 0.004148
yarn -s cli payout --user user2 --amount 1 --mint usdt
yarn -s cli payout --user user2 --amount 1 --operator admin       # admin 也能调用 debit
yarn -s cli payout --user <任意地址> --amount 1
```

### 6.5 CCTP 跨链调仓：rebalance_cctp（只支持 USDC）

```bash
yarn -s cli status                                      # 查看还能调出多少（rebalanceable）
yarn -s cli rebalance-cctp --amount 1 --domain ETHEREUM
yarn -s cli rebalance-cctp --all --domain ETHEREUM      # 把水位线以上的全部调走

yarn -s cli cctp-status  --tx <上一步的交易签名>          # 查 Circle 签名进度
yarn -s cli cctp-receive --tx <交易签名> --dry-run       # 在 Sepolia 上模拟领取
yarn -s cli cctp-receive --tx <交易签名>                 # 在 Sepolia 上领取（EVM_PRIVATE_KEY 付 gas）
yarn -s cli evm-balance                                 # 查 Sepolia 余额
yarn -s cli cctp-reclaim --tx <交易签名> --event <消息账户>   # 几天后回收约 0.0039 SOL 租金
```

### 6.6 Relay 跨链调仓：rebalance_relay（只能在主网用小额测试）

```bash
yarn -s cli relay-quote     --amount 5 --network mainnet                    # 只报价，不发交易
yarn -s cli rebalance-relay --amount 5 --min-out 4.9 --network mainnet
yarn -s cli relay-status    --request <requestId> --network mainnet
yarn -s cli relay-reclaim   --network mainnet                               # Relay 退款时把钱移回金库
```

### 6.7 查看

```bash
yarn -s cli status                         # 角色、资金池、路由
yarn -s cli balances                       # 所有角色和金库的余额
yarn -s cli events --limit 20              # 最近的链上事件（V2 充值会自动解密）
yarn -s cli help                           # 全部命令
```

---

## 7. 测试结束后清理（devnet）

按顺序执行：

```bash
yarn -s cli drain                          # 1. 清空所有金库（不先清空，关闭合约后钱就永远锁住了）
yarn -s cli remove-route --domain ETHEREUM # 2. 删除路由，回收租金
yarn -s cli close-program                  # 3. 关闭合约，回收租金（不可恢复，主网禁止运行）
yarn -s cli deploy --close-buffers         # 4. 回收部署失败留下的 SOL
yarn -s cli sweep-sol                      # 5. 把 operator / rebalancer / feepayer 的 SOL 收回 admin
yarn -s cli balances
```

> 合约关闭后，同一个程序 ID 在这个网络上不能再部署。要重新测试，需要按第 0 步方式 B 换一个新的程序 ID。

# OpenCS 部署清单（交付给客户的运维文档）

> 导入名单 → 自动节奏触达 → 客户一回复即停。
> Agent 的**每个动作**都过风险分级，自由回复默认进审批队列——**批准的就是发出的**，全程审计可回放。
> Agent 从低分对话里自提改进，但改行为准则永远要人点头。
> 业务数据全在你自己的机器上，模型可全私有部署——**放开自动化是你的决策，而不是我们的默认值**。

## 安全模型

| 面 | 鉴权方式 | 说明 |
|---|---|---|
| `/admin/*`、`/console` 数据接口 | `Authorization: Bearer <OPENCS_ADMIN_TOKEN>` | 管理面能批外呼、改生命周期——等同后台权限。生产必填 ≥16 字节，恒定时间比较 |
| `/channels/webchat` | 无（业务侧自行嵌入鉴权）+ 每会话频控 | 客户触点。默认 20 条/分钟/会话，超限 429 |
| `/channels/wecom/callback` | 企微签名（SHA1）+ AES-256-CBC + receiveid 校验 | 伪造回调 403 |
| `/health/*` | 无 | 探针专用，不触碰业务数据 |

**风险分级默认值**：`OPENCS_AUTO_APPROVE_TIERS=0,1,2,3` —— agent 的自由文本回复
（ORANGE_C）进入**审批队列**，运营在 `/console` 批准后客户才收到。
确认知识库质量后，可显式改为 `0,1,2,3,4` 开启自动回复。这是运营决策，不是默认值。

**演进提案同样走人工门禁**：提案在审批前会经过「影子运行验证」——用坏例原文同输入
重跑，给审批者看「这条技能改动是否真的修复了坏例」。改行为准则的提案永远需要人工批准。

## 首次部署

```bash
# 1. 准备两个仓库（dsh 以 link: 引用锁定 commit，见 README「依赖 dsh 的方式」）
git clone https://github.com/phasorhand/open-customer-service-dsh.git
bash open-customer-service-dsh/scripts/setup-dsh.sh   # clone + checkout + 构建 ../deepseek-harness

# 2. 生成凭证
export OPENCS_ADMIN_TOKEN=$(openssl rand -hex 24)
export OPENCS_ACTION_TOKEN_SECRET=$(openssl rand -hex 32)

# 3. 起服务（compose 构建上下文是父目录）
DEEPSEEK_API_KEY=sk-xxx docker compose -f open-customer-service-dsh/docker-compose.yml up -d --build

# 4. 验证
curl localhost:8080/health/ready
open http://localhost:8080/console   # 右上角填 OPENCS_ADMIN_TOKEN
```

## 企微客服接入

1. 企业微信后台 → 客服 → API：拿到 `Secret`（WECOM_CORP_SECRET）
2. 配置回调 URL `https://<你的域名>/channels/wecom/callback`，
   生成 `Token`（WECOM_TOKEN）与 `EncodingAESKey`（WECOM_ENCODING_AES_KEY）
3. 四件套 + `WECOM_CORP_ID` 配进环境变量后重启，企微后台点「保存」触发 URL 验证
4. 注意：企微客服有 **48 小时会话窗口**——窗口外不可主动发消息，
   节奏外呼的首触不要选企微渠道

## 数据与备份

全部业务数据是 `OPENCS_DATA_DIR`（容器内 `/data` 卷）下的 SQLite 文件：

| 文件 | 内容 | 丢失影响 |
|---|---|---|
| `crm.db` | 联系人、渠道身份、时间线 | **核心资产**，必须备份 |
| `nurture.db` | 节奏、运行、发件箱 | 在途外呼状态 |
| `audit.db` | 审计 + 审批队列 | 合规记录 |
| `evolution.db` | 评测 + 演进提案 | 学习积累 |
| `knowledge.db` | 知识库索引 | 可由 knowledge/ 目录重建 |
| `sessions/` | 会话事件日志（JSONL） | 会话回放能力 |

备份即拷文件（SQLite WAL 模式下先 `sqlite3 x.db ".backup backup.db"` 或停写拷贝）。
`knowledge/` 与 `skills/` 是运营维护的 Markdown 源，建议纳入客户自己的 git。

### 自动备份

`scripts/backup.sh` 对全部 `.db` 做 `.backup` 一致性快照并连同 `sessions/`
打包 tar.gz，按份数轮转（默认 14 份）。在**宿主机**对数据卷执行，cron 示例：

```cron
# 每天 03:00 备份，保留 30 份
0 3 * * * OPENCS_DATA_DIR=/srv/opencs/data OPENCS_BACKUP_DIR=/srv/opencs/backups \
  OPENCS_BACKUP_KEEP=30 bash /srv/opencs/open-customer-service-dsh/scripts/backup.sh
```

恢复：停服务 → 解包 tar.gz 覆盖 `OPENCS_DATA_DIR` → 起服务。

## 已知边界

- 单进程部署；多实例水平扩展需把发件箱换成 BullMQ（接口已预留，见 nurture/RESEARCH.md）
- 服务重启后进行中的**对话上下文**重置（联系人/节奏/审批不受影响）
- 企微适配器的 sync_msg 游标在内存中；重启后重拉一次增量（幂等，不会重复触发回复）

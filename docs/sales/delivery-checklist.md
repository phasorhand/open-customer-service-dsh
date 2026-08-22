# OpenCS 交付检查单（交付工程师用）

按顺序执行，每项打勾。任何一项不通过，不进入下一阶段。

## 阶段 0：交付前（在我方环境）

- [ ] `pnpm test` 全绿（当前基线 472 项）
- [ ] `pnpm smoke` 离线冒烟通过
- [ ] **真实 LLM 冒烟**（唯一无法离线验证的环节，交付前必须做）：
  ```bash
  DEEPSEEK_API_KEY=sk-xxx pnpm dev
  ```
  - [ ] webchat 问答：答案引用知识库来源，无编造政策
  - [ ] **身份边界**：多轮对话中 Agent 不自称客户公司员工（Python 版生产 bug #1，
        mock 模型无法验证此项，必须真模型过一遍）
  - [ ] 节奏 `llm` 模式步骤：生成内容符合 persona，不泄露内部指令
  - [ ] 审批队列 → 批准 → 客户侧收到的是批准原文
- [ ] `git tag` 交付版本号，记录 dsh commit（当前 `47f943859b`）

## 阶段 1：客户环境部署（0.5 天）

- [ ] 服务器就位（≥2C4G，Docker 或 Node 22 + pnpm）
- [ ] `bash scripts/setup-dsh.sh` 拉取并构建框架依赖
- [ ] 生成生产凭证：
  ```bash
  export OPENCS_ADMIN_TOKEN=$(openssl rand -hex 24)
  export OPENCS_ACTION_TOKEN_SECRET=$(openssl rand -hex 32)
  ```
- [ ] `OPENCS_ENV=production` 启动成功（fail-fast 校验通过即配置齐全）
- [ ] `/health/ready` 返回 `ready:true` 且 `degraded:false`（degraded=true 说明还在 mock 模型）
- [ ] 反向代理终结 HTTPS，控制台仅内网 / VPN 可达
- [ ] `scripts/backup.sh` 手动执行成功 + cron 定时任务配置（见 DEPLOYMENT.md）
- [ ] （企微客户）回调 URL 验证通过、收发消息各测一条

## 阶段 2：业务配置（与客户运营一起）

- [ ] 客户知识库 Markdown 迁入 `knowledge/`，抽 10 个真实客服问题验证检索命中
- [ ] 技能话术（`skills/`）按客户业务定制 persona 与边界
- [ ] 首批联系人 CSV 导入，核对：无重复建档、无渠道身份者正确标注「不可触达」
- [ ] 节奏配置评审：首触必须 `template` 模式；静默时段与客户时区一致；周频控确认
- [ ] `OPENCS_AUTO_APPROVE_TIERS` 保持默认 `0,1,2,3`（自由回复走审批）——
      **向客户书面确认**这是试运行策略

## 阶段 3：试运行验收（两周）

- [ ] 运营完成审批操作培训（批准 / 驳回 / 看审计）
- [ ] 每日审批通过率记录（目标参考：>90% 且无越权承诺类驳回）
- [ ] 评测指标周报：低分对话数量趋势、演进提案产生与处理情况
- [ ] 备份文件实际恢复演练一次（新目录解包 → 起服务 → 数据完整）
- [ ] 重启演练：确认联系人 / 节奏 / 审批 / 审计无丢失
- [ ] 验收会：客户签字确认是否放开自动回复（改 `OPENCS_AUTO_APPROVE_TIERS` 加 `4`）

## 阶段 4：移交

- [ ] 交付物清单：服务器访问方式、凭证保管、备份位置、DEPLOYMENT.md、
      本检查单已勾版本、演示脚本
- [ ] 客户侧至少 1 名运维接手人完成：重启、备份、恢复、看健康探针四项操作
- [ ] 维保联系通道建立（工单 / 微信群），响应时效书面化

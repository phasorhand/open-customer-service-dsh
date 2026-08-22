# OpenCS 演示脚本（15 分钟）

> 目标：让客户在 15 分钟里看到「AI 能干活」「人管得住 AI」「数据在自己手里」三件事。
> 全程可离线跑（mock 模型），有 DeepSeek key 则效果更真实。演示前跑一遍本脚本。

## 演示前准备（5 分钟，客户到场前）

```bash
pnpm dev                        # 起服务；有 key 则 DEEPSEEK_API_KEY=sk-xxx pnpm dev
open http://localhost:8080/console
```

预置演示数据（干净环境执行；已有数据可跳过）：

```bash
B=localhost:8080
curl -s -X POST $B/admin/tenants/default/contacts/import -H 'content-type: application/json' -d '{
  "csv":"email,name,company,external_id,tags\nli.wei@acme-demo.cn,李维,演示科技,u-liwei,重点\nwang.fang@acme-demo.cn,王芳,演示科技,u-wangfang,决策人\nchen.jie@bolt-demo.cn,陈杰,示例电商,u-chenjie,复购\nzhao.min@bolt-demo.cn,赵敏,示例电商,,\nliu.yang@cloud-demo.cn,刘洋,云上样例,u-liuyang,高意向\n",
  "channel_id":"webchat"}'
```

---

## 第 1 幕：客服问答（3 分钟）——「AI 能干活」

控制台 →「对话测试」标签，输入：**「买的东西想退款，还来得及吗」**

**看点与话术：**
- 回复带来源标注 `[售后政策 / 退款政策]` ——「答案不是模型编的，是从你们自己维护的知识库里检索的」
- 打开 `knowledge/` 目录给客户看：**知识库就是 Markdown 文件**，运营改完保存即生效，无需重启无需培训
- （可选）现场改一条政策，再问一遍，展示热生效

## 第 2 幕：审批闭环（4 分钟）——「人管得住 AI」⭐ 核心差异点

刚才的回复**客户其实还没收到**。切到「审批」标签：

**看点与话术：**
- 「Agent 的自由文本回复默认不直接发出，而是进这个队列。你看到的就是将要发给客户的原文」
- 点「批准发送」——「**批准的就是发出的**：批准后由系统原样投递，不再经过模型，AI 没有机会再改一个字」
- 切到「审计」标签：「刚才每个动作——查知识库是 allow、生成回复是 ask——都有裁决记录，持久化，重启不丢」
- 抛出关键句：「**放开自动回复是一行配置，但那是你们的运营决策，不是我们的默认值**。确认知识库质量后再放开，风险你们自己控制」

## 第 3 幕：外呼节奏（4 分钟）——「增长引擎」

「节奏」标签新建（或用命令行）：

```bash
curl -s -X POST $B/admin/tenants/default/cadences -H 'content-type: application/json' -d '{
  "name":"新签线索首触","channel_id":"webchat","sender_persona":"OpenCS 的小林",
  "auto_enroll":true,
  "entry_filter":{"rules":[{"field":"addressable","operator":"eq","value":true}]},
  "steps":[{"step_order":0,"delay_seconds":0,"template":"{{name}}你好，我是小林。"},
           {"step_order":1,"delay_seconds":86400,"goal":"个性化跟进，突出数据主权"}]}'
curl -s -X POST $B/admin/tenants/default/cadences/<id>/activate
curl -s -X POST $B/admin/tenants/default/cadences/tick
```

**看点与话术：**
- 「5 个联系人，4 个自动入组触达——那个没触达的是因为没有渠道身份，系统**显式标注不可触达**，不会假装发了」
- 「首触是模板，毫秒级、零模型成本；后续跟进才用 LLM 写个性化内容——5000 人的名单不会烧 55 小时模型时间」
- 「静默时段、每周频控、**客户一回复立刻退出节奏**——不做骚扰式营销，这些规则是引擎级的，不靠运营自觉」

## 第 4 幕：闭环学习（2 分钟）——「它会变好，但由你把关」

「演进提案」标签（有历史数据时展示）：

**话术：**
- 「每轮回复都有零成本的自动评测：有没有越权承诺、语气、推进度。低分对话沉淀成证据，Agent 会**自己提改进提案**」
- 「但改它自己行为准则的提案，**永远需要人批**。让模型自己决定要不要遵守『不乱承诺』，等于没有红线」

## 收尾（2 分钟）

- 总览页给一句总结：「你们看到的数据——联系人、会话、审计——全部在这台机器的几个 SQLite 文件里，备份就是拷文件」
- 模型选择：「今天演示用的是内置确定性模型（离线可跑）；生产接 DeepSeek API，或接你们自建的 vLLM 实现**全量数据不出机房**」
- 下一步：留 [one-pager.md](one-pager.md) 与 [security-whitepaper.md](security-whitepaper.md)，约 POC（见 [delivery-checklist.md](delivery-checklist.md)）

## 常见现场提问速查

| 问题 | 回答 |
|---|---|
| 「能全自动回复吗」 | 能，改一个环境变量。但我们建议先人工审批跑两周，看通过率再放 |
| 「并发能扛多少」 | 单实例设计，适合 50 坐席以下团队；水平扩展在路线图（队列切换点已预留） |
| 「微信生态呢」 | 企业微信客服已支持（签名 + 加解密全套）；注意企微 48 小时会话窗口限制 |
| 「模型幻觉怎么办」 | 三层：知识库标注来源 + 回复默认人工审批 + 自动评测抓越权承诺 |
| 「你们能看到我们数据吗」 | 不能。自托管，我们没有任何回传通道；模型走你们自己的 API 账号或自建端点 |

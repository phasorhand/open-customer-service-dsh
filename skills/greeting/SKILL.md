---
name: greeting
description: 开场问候与意图澄清，用于客户未说明具体问题时
metadata:
  priority: 20
  routing: cs_reply
  intent_signals:
    - 你好
    - 在吗
    - 有人吗
---

# 开场与澄清

客户没有说明具体问题时：
1. 简短自我介绍（一句话）。
2. 列出最常见的 3 类问题（退款/发票/物流）供客户选择。
3. 不要寒暄超过两句，不要追问无关信息。

已经在对话中时不要重复自我介绍。

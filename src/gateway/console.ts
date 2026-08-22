/**
 * 管理控制台：自包含单页，`GET /console`。
 *
 * 为什么不用 Next.js（P7 原计划）：Python 版的 web-ui 面向旧 API 集
 * （replay 向导、CRM 配置向导等），迁移成本高且一半页面对不上。
 * 售卖场景需要的是**开箱即用的运营界面**——单文件、零构建、随服务分发，
 * 客户 docker 起来就能用。复杂界面需求出现时再上前端工程。
 *
 * 鉴权：token 存 localStorage，全部请求带 Bearer。页面本身不含敏感数据。
 */

export function consoleHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenCS 控制台</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --line:#e5e7eb; --text:#111827; --muted:#6b7280;
          --primary:#2563eb; --ok:#059669; --warn:#d97706; --bad:#dc2626; }
  * { box-sizing:border-box; margin:0; }
  body { font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
         background:var(--bg); color:var(--text); font-size:14px; }
  header { background:var(--card); border-bottom:1px solid var(--line); padding:10px 20px;
           display:flex; align-items:center; gap:16px; position:sticky; top:0; z-index:10; }
  header h1 { font-size:16px; }
  header input { margin-left:auto; padding:6px 10px; border:1px solid var(--line);
                 border-radius:6px; width:260px; }
  nav { display:flex; gap:4px; padding:10px 20px 0; }
  nav button { padding:8px 14px; border:none; background:none; cursor:pointer; font-size:14px;
               border-radius:8px 8px 0 0; color:var(--muted); }
  nav button.active { background:var(--card); color:var(--text); font-weight:600;
                      border:1px solid var(--line); border-bottom-color:var(--card); }
  main { padding:16px 20px 60px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px;
          padding:16px; margin-bottom:14px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:12px; }
  .stat { text-align:center; padding:14px 8px; }
  .stat b { display:block; font-size:26px; }
  .stat span { color:var(--muted); font-size:12px; }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line);
           vertical-align:top; word-break:break-all; }
  th { color:var(--muted); font-weight:500; font-size:12px; }
  button.act { padding:6px 14px; border:1px solid var(--line); border-radius:6px;
               background:var(--card); cursor:pointer; }
  button.primary { background:var(--primary); color:#fff; border-color:var(--primary); }
  button.danger { color:var(--bad); border-color:var(--bad); }
  textarea, input[type=text] { width:100%; padding:8px; border:1px solid var(--line);
                               border-radius:6px; font:inherit; }
  .row { display:flex; gap:10px; margin-bottom:10px; align-items:center; }
  .tag { display:inline-block; padding:2px 8px; border-radius:99px; font-size:12px;
         background:var(--bg); }
  .tag.ok { color:var(--ok); } .tag.warn { color:var(--warn); } .tag.bad { color:var(--bad); }
  .chat { max-height:400px; overflow-y:auto; display:flex; flex-direction:column; gap:8px;
          padding:10px; background:var(--bg); border-radius:8px; margin-bottom:10px; }
  .msg { max-width:75%; padding:8px 12px; border-radius:12px; white-space:pre-wrap; }
  .msg.me { align-self:flex-end; background:var(--primary); color:#fff; }
  .msg.bot { align-self:flex-start; background:var(--card); border:1px solid var(--line); }
  .msg.sys { align-self:center; color:var(--muted); font-size:12px; background:none; }
  #toast { position:fixed; bottom:20px; left:50%; transform:translateX(-50%);
           background:var(--text); color:#fff; padding:10px 18px; border-radius:8px;
           opacity:0; transition:opacity .3s; pointer-events:none; }
  #toast.show { opacity:1; }
  .muted { color:var(--muted); }
</style>
</head>
<body>
<header>
  <h1>OpenCS 控制台</h1>
  <span class="muted" id="llm-info"></span>
  <input id="token" type="password" placeholder="管理凭证（OPENCS_ADMIN_TOKEN）">
</header>
<nav id="tabs"></nav>
<main id="view"></main>
<div id="toast"></div>
<script>
const $ = (id) => document.getElementById(id)
const TENANT = 'default'
const tokenInput = $('token')
tokenInput.value = localStorage.getItem('opencs_token') || ''
tokenInput.addEventListener('change', () => { localStorage.setItem('opencs_token', tokenInput.value); refresh() })

function toast(text) {
  const el = $('toast'); el.textContent = text; el.classList.add('show')
  setTimeout(() => el.classList.remove('show'), 2500)
}

async function api(path, options = {}) {
  const headers = { 'content-type': 'application/json' }
  if (tokenInput.value) headers['authorization'] = 'Bearer ' + tokenInput.value
  const response = await fetch(path, { ...options, headers })
  const body = await response.json().catch(() => ({}))
  if (response.status === 401) { toast('管理凭证无效，请在右上角填写'); throw new Error('unauthorized') }
  if (!response.ok) { toast(body.message || ('请求失败 ' + response.status)); throw new Error(body.message || response.status) }
  return body
}
const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))

const TABS = [
  ['overview', '总览'], ['contacts', '联系人'], ['cadences', '节奏'],
  ['approvals', '审批'], ['proposals', '演进提案'], ['audit', '审计'], ['chat', '对话测试'],
]
let active = location.hash.slice(1) || 'overview'
$('tabs').innerHTML = TABS.map(([id, label]) =>
  '<button id="tab-' + id + '" onclick="switchTab(\\'' + id + '\\')">' + label + '</button>').join('')

function switchTab(id) { active = id; location.hash = id; refresh() }

async function refresh() {
  for (const [id] of TABS) $('tab-' + id).classList.toggle('active', id === active)
  try { await RENDER[active]() } catch (e) { /* toast 已提示 */ }
}

const RENDER = {
  async overview() {
    const stats = await api('/admin/stats')
    $('llm-info').textContent = stats.llm.provider + ' / ' + stats.llm.model
    const funnel = Object.entries(stats.contacts.funnel).map(([stage, count]) =>
      '<div class="stat card"><b>' + count + '</b><span>' + esc(stage) + '</span></div>').join('')
    $('view').innerHTML =
      '<div class="grid">' +
      '<div class="stat card"><b>' + stats.contacts.total + '</b><span>联系人</span></div>' +
      '<div class="stat card"><b>' + (stats.approvals.pending || 0) + '</b><span>待审批</span></div>' +
      '<div class="stat card"><b>' + (stats.sends.sent || 0) + '</b><span>已触达</span></div>' +
      '<div class="stat card"><b>' + (stats.cadences.byState.active || 0) + '</b><span>节奏运行中</span></div>' +
      '<div class="stat card"><b>' + stats.knowledge.chunkCount + '</b><span>知识块</span></div>' +
      '</div><h3 style="margin:14px 0 8px">漏斗</h3><div class="grid">' + (funnel || '<span class="muted">暂无数据</span>') + '</div>' +
      '<p class="muted" style="margin-top:18px;font-size:12px">每个动作过风险分级 · 自由回复默认进审批 · 批准的就是发出的 · 全程审计可回放 · 放开自动化是运营决策</p>'
  },

  async contacts() {
    const data = await api('/admin/tenants/' + TENANT + '/contacts?limit=50')
    const rows = data.items.map((c) =>
      '<tr><td>' + esc(c.name || c.dedup_key) + '</td><td>' + esc(c.lifecycle_stage) + '</td>' +
      '<td>' + c.score + '</td><td>' + (c.addressable ? '<span class="tag ok">可触达</span>' : '<span class="tag bad">无渠道</span>') + '</td>' +
      '<td class="muted">' + esc((c.tags || []).join('、')) + '</td></tr>').join('')
    $('view').innerHTML =
      '<div class="card"><h3>导入 CSV</h3><p class="muted" style="margin:6px 0">表头支持中英文别名（姓名/手机/邮箱/公司/标签/external_id）。带 external_id 的行会自动关联 webchat 渠道身份。</p>' +
      '<textarea id="csv" rows="4" placeholder="email,name,external_id&#10;a@x.com,张三,u-a"></textarea>' +
      '<div class="row" style="margin-top:8px"><button class="act primary" onclick="importCsv()">导入</button><span id="import-result" class="muted"></span></div></div>' +
      '<div class="card"><h3>联系人（' + data.total + '）</h3><table><tr><th>姓名</th><th>阶段</th><th>意向分</th><th>触达</th><th>标签</th></tr>' + rows + '</table></div>'
  },

  async cadences() {
    const [list, stats] = await Promise.all([
      api('/admin/tenants/' + TENANT + '/cadences'),
      api('/admin/tenants/' + TENANT + '/cadences/stats'),
    ])
    const rows = list.items.map((c) =>
      '<tr><td>' + esc(c.name) + '</td><td><span class="tag ' + (c.status === 'active' ? 'ok' : '') + '">' + c.status + '</span></td>' +
      '<td>' + c.steps.length + ' 步（' + c.steps.map((s) => s.mode).join('→') + '）</td>' +
      '<td>' + esc(c.sender_persona || '—') + '</td>' +
      '<td><button class="act" onclick="cadenceAction(\\'' + c.id + '\\', \\'' + (c.status === 'active' ? 'pause' : 'activate') + '\\')">' +
      (c.status === 'active' ? '暂停' : '激活') + '</button></td></tr>').join('')
    $('view').innerHTML =
      '<div class="card"><div class="row"><h3>节奏</h3>' +
      '<button class="act" style="margin-left:auto" onclick="tick()">立即执行一轮</button></div>' +
      '<p class="muted">运行：' + JSON.stringify(stats.runs.byState) + ' · 结束原因：' + JSON.stringify(stats.runs.byFinishReason) + ' · 发件：' + JSON.stringify(stats.sends) + '</p></div>' +
      '<div class="card"><table><tr><th>名称</th><th>状态</th><th>步骤</th><th>发件人身份</th><th></th></tr>' + rows +
      '</table><p class="muted" style="margin-top:8px">创建节奏请用 API（POST /admin/tenants/' + TENANT + '/cadences），字段说明见 README。</p></div>'
  },

  async approvals() {
    const data = await api('/admin/approvals')
    const rows = data.items.map((a) =>
      '<tr><td class="muted">' + esc(a.conversation_id) + '</td><td>' + esc(a.preview) + '</td>' +
      '<td class="muted">' + new Date(a.requested_at).toLocaleString() + '</td>' +
      '<td style="white-space:nowrap"><button class="act primary" onclick="decide(\\'' + a.id + '\\', \\'approve\\')">批准发送</button> ' +
      '<button class="act danger" onclick="decide(\\'' + a.id + '\\', \\'reject\\')">驳回</button></td></tr>').join('')
    $('view').innerHTML =
      '<div class="card"><h3>待审批（' + data.items.length + '）</h3>' +
      '<p class="muted" style="margin:6px 0">批准 = 将「内容」原样发送给客户，不再经过模型。各状态：' + JSON.stringify(data.counts) + '</p>' +
      '<table><tr><th>会话</th><th>内容</th><th>请求时间</th><th></th></tr>' +
      (rows || '<tr><td colspan="4" class="muted">队列为空</td></tr>') + '</table></div>'
  },

  async proposals() {
    const data = await api('/admin/proposals')
    const rows = data.items.map((p) =>
      '<tr><td><span class="tag">' + esc(p.dimension) + '</span></td><td><b>' + esc(p.title) + '</b><br><span class="muted">' + esc(p.rationale) + '</span></td>' +
      '<td><span class="tag ' + (p.status === 'gated' ? 'warn' : '') + '">' + esc(p.status) + '</span><br><span class="muted">' + esc(p.gateReason || '') + '</span></td>' +
      '<td style="white-space:nowrap">' + (p.status === 'gated' || p.status === 'pending'
        ? '<button class="act primary" onclick="reviewProposal(\\'' + p.id + '\\', \\'approve\\')">批准</button> <button class="act danger" onclick="reviewProposal(\\'' + p.id + '\\', \\'reject\\')">驳回</button>'
        : '') + '</td></tr>').join('')
    $('view').innerHTML =
      '<div class="card"><h3>演进提案</h3><p class="muted" style="margin:6px 0">agent 自己提出的改进（知识缺口、话术调整）。改变行为准则的提案永远需要人工确认。各状态：' + JSON.stringify(data.counts) + '</p>' +
      '<table><tr><th>维度</th><th>提案</th><th>状态 / 门禁判定</th><th></th></tr>' +
      (rows || '<tr><td colspan="4" class="muted">暂无提案</td></tr>') + '</table></div>'
  },

  async audit() {
    const data = await api('/admin/audit-log?limit=100')
    const rows = data.items.map((e) =>
      '<tr><td class="muted">' + new Date(e.at).toLocaleString() + '</td><td>' + esc(e.tool) + '</td>' +
      '<td><span class="tag ' + (e.decision === 'allow' ? 'ok' : e.decision === 'deny' ? 'bad' : 'warn') + '">' + e.decision + '</span></td>' +
      '<td class="muted">' + esc(e.reason || '') + '</td></tr>').join('')
    $('view').innerHTML =
      '<div class="card"><h3>审计日志（共 ' + data.total + ' 条，持久化，重启不丢）</h3>' +
      '<table><tr><th>时间</th><th>工具</th><th>裁决</th><th>原因</th></tr>' + rows + '</table></div>'
  },

  async chat() {
    if (!window.__chatId) window.__chatId = 'console-' + Math.random().toString(36).slice(2, 8)
    $('view').innerHTML =
      '<div class="card"><h3>对话测试 <span class="muted" style="font-weight:400">会话 ' + window.__chatId + '</span></h3>' +
      '<div class="chat" id="chatlog"><div class="msg sys">以客户身份发消息，验证知识库与审批链路</div></div>' +
      '<div class="row"><input type="text" id="chat-input" placeholder="例如：买的东西想退款，还来得及吗" onkeydown="if(event.key===\\'Enter\\')sendChat()">' +
      '<button class="act primary" onclick="sendChat()">发送</button>' +
      '<button class="act" onclick="window.__chatId=null;refresh()">新会话</button></div></div>'
  },
}

async function importCsv() {
  const csv = $('csv').value.trim()
  if (!csv) return toast('请粘贴 CSV 内容')
  const report = await api('/admin/tenants/' + TENANT + '/contacts/import',
    { method: 'POST', body: JSON.stringify({ csv, channel_id: 'webchat' }) })
  $('import-result').textContent = '新建 ' + report.imported + '、更新 ' + report.updated + '、跳过 ' + report.skipped +
    (report.errors.length ? '；首个错误（第' + report.errors[0].line + '行）：' + report.errors[0].error : '')
  toast('导入完成')
}

async function cadenceAction(id, action) {
  await api('/admin/tenants/' + TENANT + '/cadences/' + id + '/' + action, { method: 'POST', body: '{}' })
  toast(action === 'activate' ? '已激活' : '已暂停'); refresh()
}

async function tick() {
  const { report } = await api('/admin/tenants/' + TENANT + '/cadences/tick', { method: 'POST', body: '{}' })
  toast('入组 ' + report.enrolled + '、发送 ' + report.sent + '、推迟 ' + report.deferred + '、失败 ' + report.failed)
  refresh()
}

async function decide(id, action) {
  const reviewer = localStorage.getItem('opencs_reviewer') || prompt('审核人姓名：') || ''
  if (!reviewer) return
  localStorage.setItem('opencs_reviewer', reviewer)
  await api('/admin/approvals/' + id + '/' + action, { method: 'POST', body: JSON.stringify({ reviewer }) })
  toast(action === 'approve' ? '已批准并发送' : '已驳回'); refresh()
}

async function reviewProposal(id, action) {
  const reviewer = localStorage.getItem('opencs_reviewer') || prompt('审核人姓名：') || ''
  if (!reviewer) return
  localStorage.setItem('opencs_reviewer', reviewer)
  await api('/admin/proposals/' + id + '/' + action, { method: 'POST', body: JSON.stringify({ reviewer }) })
  toast('已处理'); refresh()
}

async function sendChat() {
  const input = $('chat-input'); const text = input.value.trim()
  if (!text) return
  input.value = ''
  const log = $('chatlog')
  log.insertAdjacentHTML('beforeend', '<div class="msg me">' + esc(text) + '</div>')
  log.scrollTop = log.scrollHeight
  const body = await api('/channels/webchat', {
    method: 'POST',
    body: JSON.stringify({ conversation_id: window.__chatId, customer_id: 'console-user', text }),
  })
  if (body.delivered && body.reply) {
    log.insertAdjacentHTML('beforeend', '<div class="msg bot">' + esc(body.reply) + '</div>')
  } else {
    log.insertAdjacentHTML('beforeend',
      '<div class="msg sys">回复已进入审批队列（当前风险档需人工确认）。到「审批」页签批准后客户才会收到。</div>')
  }
  log.scrollTop = log.scrollHeight
}

refresh()
setInterval(() => { if (active === 'overview' || active === 'approvals') refresh() }, 10000)
</script>
</body>
</html>`
}

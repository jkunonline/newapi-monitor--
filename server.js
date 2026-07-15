#!/usr/bin/env node
// NewAPI 模型连通性监控 —— 零依赖，Node >= 18
// 支持多个 API（多站点/多密钥），定时对每个 API 下所有模型发真实小请求。
// 支持 Telegram 异常/恢复通知。

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const HISTORY_PATH = path.join(ROOT, 'data', 'history.json');
const MAX_HISTORY = 288; // 每模型保留的探测记录数
const SEP = '::'; // api 名与模型名的分隔符

// ---------- 配置 ----------

const DEFAULTS = {
  title: 'NewAPI 模型监控',
  interval_minutes: 10,
  timeout_ms: 30000,
  concurrency: 3,
  max_tokens: 1,
  fallback_max_tokens: 4096, // 思考类模型 max_tokens=1 会报错，回退用这个值重试
  exclude_patterns: [],
  port: 8788,
  host: '127.0.0.1',
};

function normalizeBaseUrl(u) {
  return String(u || '')
    .trim()
    .replace(/^(https?:\/\/)+(https?:\/\/)/, '$2') // 容错重复协议头
    .replace(/\/+$/, '')
    .replace(/\/v1$/, '');
}

function loadConfig() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error(`[config] 无法读取 ${CONFIG_PATH}: ${e.message}`);
    process.exit(1);
  }
  const cfg = { ...DEFAULTS, ...raw };

  // 多 API：apis 数组；兼容旧的顶层 base_url/api_key（视为一个 API）
  let apis = Array.isArray(raw.apis) ? raw.apis : [];
  if (!apis.length && raw.base_url && raw.api_key) {
    apis = [{ name: '', base_url: raw.base_url, api_key: raw.api_key }];
  }
  cfg.apis = apis
    .map((a, i) => ({
      name: a.name || (() => { try { return new URL(normalizeBaseUrl(a.base_url)).hostname; } catch { return `api${i + 1}`; } })(),
      base_url: normalizeBaseUrl(a.base_url),
      api_key: a.api_key,
      exclude_patterns: Array.isArray(a.exclude_patterns) ? a.exclude_patterns : cfg.exclude_patterns,
    }))
    .filter(a => {
      const bad = !a.base_url || a.base_url.includes('example.com') || !a.api_key || a.api_key === 'sk-xxx';
      if (bad) console.error(`[config] 跳过未配置完整的 API: ${a.name || a.base_url || '(空)'}`);
      return !bad;
    });

  // 名称去重
  const seen = new Set();
  for (const a of cfg.apis) {
    let n = a.name, k = 2;
    while (seen.has(n)) n = `${a.name}-${k++}`;
    a.name = n;
    seen.add(n);
  }

  if (!cfg.apis.length) {
    console.error('[config] 请在 config.json 中配置至少一个可用的 API（apis 数组或顶层 base_url/api_key）');
    process.exit(1);
  }

  // Telegram 通知：chat_id 可省略，会通过 getUpdates 自动发现（需先给 bot 发过一条消息）
  const tg = raw.telegram || {};
  cfg.telegram = {
    enabled: !!tg.enabled && !!tg.bot_token,
    bot_token: tg.bot_token || '',
    chat_id: tg.chat_id || '',
    notify_recovery: tg.notify_recovery !== false,      // 默认恢复也通知
    notify_after_failures: Math.max(1, tg.notify_after_failures || 1), // 连续失败 N 次才报警
  };
  if (tg.enabled && !cfg.telegram.enabled) {
    console.error('[config] telegram.enabled 为 true 但缺少 bot_token，通知已禁用');
  }
  // 环境变量覆盖（Docker 部署时容器内需监听 0.0.0.0）
  if (process.env.HOST) cfg.host = process.env.HOST;
  if (process.env.PORT) cfg.port = parseInt(process.env.PORT, 10) || cfg.port;
  return cfg;
}

const config = loadConfig();

// 通配符匹配（* 匹配任意字符，大小写不敏感）
function matchPattern(name, pattern) {
  const re = new RegExp('^' + pattern.toLowerCase().split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(name.toLowerCase());
}

// ---------- 状态与历史 ----------

// state.models: { ["api::model"]: { api, model, excluded, present, alerted, history: [...] } }
const state = {
  models: {},
  lastProbeStart: null,
  lastProbeEnd: null,
  nextProbeAt: null,
  probing: false,
};

function loadHistory() {
  try {
    const saved = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    if (saved && typeof saved.models === 'object') {
      // 迁移旧格式（key 不含 "::" 时归入第一个 API）
      for (const [key, m] of Object.entries(saved.models)) {
        if (key.includes(SEP)) {
          state.models[key] = m;
        } else {
          const api = config.apis[0].name;
          state.models[`${api}${SEP}${key}`] = { ...m, api, model: key };
        }
      }
      state.lastProbeEnd = saved.lastProbeEnd || null;
      const n = Object.keys(state.models).length;
      if (n) console.log(`[history] 已从 ${HISTORY_PATH} 恢复 ${n} 条模型历史`);
    }
  } catch {
    // 首次运行没有历史文件，忽略
  }
}

function saveHistory() {
  try {
    fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
    const tmp = HISTORY_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ models: state.models, lastProbeEnd: state.lastProbeEnd }));
    fs.renameSync(tmp, HISTORY_PATH);
  } catch (e) {
    console.error(`[history] 保存失败: ${e.message}`);
  }
}

// ---------- Telegram 通知 ----------

const CHATID_CACHE = path.join(ROOT, 'data', 'telegram_chat_id');

// chat_id 未配置时自动发现：读缓存 → getUpdates 取最近一条私聊消息的 chat.id
async function resolveChatId() {
  if (config.telegram.chat_id) return config.telegram.chat_id;
  try {
    const cached = fs.readFileSync(CHATID_CACHE, 'utf8').trim();
    if (cached) { config.telegram.chat_id = cached; return cached; }
  } catch { /* 无缓存 */ }
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.telegram.bot_token}/getUpdates?limit=100`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const updates = body.result || [];
    // 从最新往回找一条带 chat 的消息（私聊/群组都行）
    for (let i = updates.length - 1; i >= 0; i--) {
      const msg = updates[i].message || updates[i].edited_message || updates[i].channel_post;
      const id = msg?.chat?.id;
      if (id) {
        const chatId = String(id);
        config.telegram.chat_id = chatId;
        try { fs.mkdirSync(ROOT + '/data', { recursive: true }); fs.writeFileSync(CHATID_CACHE, chatId); } catch {}
        console.log(`[telegram] 自动发现 chat_id: ${chatId} (${msg.chat.type}${msg.chat.username ? ' @' + msg.chat.username : ''})，已缓存`);
        return chatId;
      }
    }
    console.error('[telegram] 未配置 chat_id 且 getUpdates 里没有消息 —— 请先在 Telegram 里给你的 bot 发一条消息（如 /start），下一轮探测会自动识别');
  } catch (e) {
    console.error(`[telegram] 自动发现 chat_id 失败: ${e.message}`);
  }
  return null;
}

async function sendTelegram(text) {
  if (!config.telegram.enabled) return;
  const chatId = await resolveChatId();
  if (!chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.telegram.bot_token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) console.error(`[telegram] 发送失败 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    else console.log('[telegram] 通知已发送');
  } catch (e) {
    console.error(`[telegram] 发送异常: ${e.message}`);
  }
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 探测轮结束后根据状态变化生成并发送通知
async function notifyChanges(changes) {
  if (!config.telegram.enabled) return;
  const downs = changes.filter(c => c.type === 'down');
  const ups = config.telegram.notify_recovery ? changes.filter(c => c.type === 'up') : [];
  if (!downs.length && !ups.length) return;

  const lines = [`<b>${esc(config.title)}</b>`];
  if (downs.length) {
    lines.push('', `🔴 <b>异常 (${downs.length})</b>`);
    for (const c of downs.slice(0, 20)) {
      lines.push(`• [${esc(c.api)}] <code>${esc(c.model)}</code>${c.http_status ? ` HTTP ${c.http_status}` : ''}${c.error ? `\n  ${esc(c.error.slice(0, 120))}` : ''}`);
    }
    if (downs.length > 20) lines.push(`… 以及另外 ${downs.length - 20} 个`);
  }
  if (ups.length) {
    lines.push('', `🟢 <b>已恢复 (${ups.length})</b>`);
    for (const c of ups.slice(0, 20)) {
      lines.push(`• [${esc(c.api)}] <code>${esc(c.model)}</code>${c.latency_ms ? ` ${c.latency_ms}ms` : ''}`);
    }
    if (ups.length > 20) lines.push(`… 以及另外 ${ups.length - 20} 个`);
  }
  await sendTelegram(lines.join('\n'));
}

// ---------- 探测 ----------

async function fetchModels(api) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.timeout_ms);
  try {
    const res = await fetch(`${api.base_url}/v1/models`, {
      headers: { Authorization: `Bearer ${api.api_key}` },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    const ids = (body.data || []).map(m => m.id).filter(Boolean);
    return [...new Set(ids)].sort();
  } finally {
    clearTimeout(timer);
  }
}

function summarizeError(text) {
  if (!text) return '';
  try {
    const j = JSON.parse(text);
    const msg = j?.error?.message || j?.message || text;
    return String(msg).slice(0, 300);
  } catch {
    return String(text).slice(0, 300);
  }
}

async function probeModel(api, model) {
  const start = Date.now();
  const doRequest = async (tokenField, tokenValue) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.timeout_ms);
    try {
      const res = await fetch(`${api.base_url}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${api.api_key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'hi' }],
          [tokenField]: tokenValue,
          stream: false,
        }),
        signal: ctrl.signal,
      });
      const text = await res.text();
      return { res, text };
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let { res, text } = await doRequest('max_tokens', config.max_tokens);
    // 部分推理模型不支持 max_tokens，需要 max_completion_tokens
    if (!res.ok && /max_tokens/.test(text) && /max_completion_tokens|unsupported|not supported/i.test(text)) {
      ({ res, text } = await doRequest('max_completion_tokens', config.max_tokens));
    }
    // 思考类模型要求 max_tokens 大于思考预算/最小值，用更大的值重试
    if (!res.ok && /max_tokens|max_completion_tokens/i.test(text) &&
        /at least|greater than|minimum|too small|budget|thinking|>=|不能小于|至少/i.test(text)) {
      ({ res, text } = await doRequest('max_tokens', config.fallback_max_tokens));
      if (!res.ok && /max_completion_tokens|unsupported|not supported/i.test(text)) {
        ({ res, text } = await doRequest('max_completion_tokens', config.fallback_max_tokens));
      }
    }
    const latency = Date.now() - start;
    if (res.ok) {
      return { t: Date.now(), status: 'ok', latency_ms: latency, http_status: res.status, error: '' };
    }
    return { t: Date.now(), status: 'error', latency_ms: latency, http_status: res.status, error: summarizeError(text) };
  } catch (e) {
    const latency = Date.now() - start;
    const isTimeout = e.name === 'AbortError' || /abort/i.test(String(e.message));
    return {
      t: Date.now(),
      status: isTimeout ? 'timeout' : 'error',
      latency_ms: latency,
      http_status: 0,
      error: isTimeout ? `超时 (${config.timeout_ms}ms)` : String(e.message).slice(0, 300),
    };
  }
}

// 追加记录并返回状态变化事件（down / up / null）
function pushRecord(key, record) {
  const entry = state.models[key];
  entry.history.push(record);
  if (entry.history.length > MAX_HISTORY) entry.history = entry.history.slice(-MAX_HISTORY);

  const k = config.telegram.notify_after_failures;
  if (record.status !== 'ok') {
    // 统计尾部连续失败次数
    let streak = 0;
    for (let i = entry.history.length - 1; i >= 0 && entry.history[i].status !== 'ok'; i--) streak++;
    if (streak >= k && !entry.alerted) {
      entry.alerted = true;
      return { type: 'down', api: entry.api, model: entry.model, http_status: record.http_status, error: record.error };
    }
  } else if (entry.alerted) {
    entry.alerted = false;
    return { type: 'up', api: entry.api, model: entry.model, latency_ms: record.latency_ms };
  }
  return null;
}

async function runProbe() {
  if (state.probing) {
    console.log('[probe] 上一轮探测仍在进行，跳过');
    return;
  }
  state.probing = true;
  state.lastProbeStart = Date.now();
  console.log(`[probe] 开始探测 @ ${new Date().toLocaleString()}`);
  const changes = [];

  // 逐 API 拉取模型列表
  const foundKeys = new Set();
  const tasks = []; // {api, model, key}
  let skipped = 0;
  for (const api of config.apis) {
    try {
      const models = await fetchModels(api);
      console.log(`[probe] [${api.name}] 发现 ${models.length} 个模型`);
      for (const m of models) {
        const key = `${api.name}${SEP}${m}`;
        foundKeys.add(key);
        if (!state.models[key]) state.models[key] = { api: api.name, model: m, excluded: false, history: [] };
        const entry = state.models[key];
        entry.api = api.name;
        entry.model = m;
        entry.present = true;
        entry.excluded = api.exclude_patterns.some(p => matchPattern(m, p));
        if (entry.excluded) skipped++;
        else tasks.push({ api, model: m, key });
      }
    } catch (e) {
      console.error(`[probe] [${api.name}] 拉取模型列表失败: ${e.message}`);
      // 该 API 下已知模型全部记一次失败，让页面能反映站点级故障
      for (const [key, entry] of Object.entries(state.models)) {
        if (entry.api === api.name && !entry.excluded) {
          foundKeys.add(key);
          const c = pushRecord(key, { t: Date.now(), status: 'error', latency_ms: 0, http_status: 0, error: `模型列表拉取失败: ${String(e.message).slice(0, 200)}` });
          if (c) changes.push(c);
        }
      }
    }
  }
  // 已消失的模型保留历史但标记下线
  for (const [key, entry] of Object.entries(state.models)) {
    if (!foundKeys.has(key)) entry.present = false;
  }

  // 并发受限的 worker 池（跨所有 API 共享）
  let index = 0;
  let okCount = 0, failCount = 0;
  const worker = async () => {
    while (index < tasks.length) {
      const { api, model, key } = tasks[index++];
      const rec = await probeModel(api, model);
      const c = pushRecord(key, rec);
      if (c) changes.push(c);
      if (rec.status === 'ok') {
        okCount++;
        console.log(`[probe] ✓ [${api.name}] ${model} ${rec.latency_ms}ms`);
      } else {
        failCount++;
        console.log(`[probe] ✗ [${api.name}] ${model} [${rec.status}${rec.http_status ? ' ' + rec.http_status : ''}] ${rec.error}`);
      }
      // 小抖动，避免请求过于整齐触发限流
      await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
    }
  };
  await Promise.all(Array.from({ length: Math.min(config.concurrency, tasks.length) }, worker));

  state.lastProbeEnd = Date.now();
  state.nextProbeAt = Date.now() + config.interval_minutes * 60 * 1000;
  state.probing = false;
  saveHistory();
  console.log(`[probe] 完成: ${okCount} 正常 / ${failCount} 异常 / ${skipped} 跳过`);
  await notifyChanges(changes);
}

// ---------- HTTP 服务 ----------

function buildStatus() {
  const models = Object.values(state.models).map(m => {
    const hist = m.history || [];
    const last = hist[hist.length - 1] || null;
    const dayAgo = Date.now() - 24 * 3600 * 1000;
    const recent = hist.filter(h => h.t >= dayAgo);
    const okRate = recent.length ? recent.filter(h => h.status === 'ok').length / recent.length : null;
    return {
      api: m.api,
      name: m.model,
      excluded: !!m.excluded,
      present: m.present !== false,
      last,
      ok_rate_24h: okRate,
      history: hist.slice(-60), // 页面只需要最近 60 条画方块
    };
  });
  models.sort((a, b) => a.api.localeCompare(b.api) || a.name.localeCompare(b.name));
  return {
    title: config.title,
    generated_at: Date.now(),
    probing: state.probing,
    last_probe_start: state.lastProbeStart,
    last_probe_end: state.lastProbeEnd,
    next_probe_at: state.nextProbeAt,
    interval_minutes: config.interval_minutes,
    apis: config.apis.map(a => a.name),
    models,
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    fs.readFile(path.join(ROOT, 'public', 'index.html'), (err, buf) => {
      if (err) { res.writeHead(500); res.end('index.html missing'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buf);
    });
  } else if (req.method === 'GET' && url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(buildStatus()));
  } else if (req.method === 'POST' && url.pathname === '/api/probe') {
    const already = state.probing;
    if (!already) runProbe().catch(e => console.error(`[probe] 异常: ${e.message}`));
    res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ started: !already, probing: true }));
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});

// ---------- 启动 ----------

loadHistory();
server.listen(config.port, config.host, () => {
  console.log(`[server] 状态页: http://${config.host}:${config.port}`);
  console.log(`[server] 监控 ${config.apis.length} 个 API: ${config.apis.map(a => a.name).join(', ')}`);
  console.log(`[server] 探测周期: ${config.interval_minutes} 分钟, 并发: ${config.concurrency}, 超时: ${config.timeout_ms}ms`);
  console.log(`[server] Telegram 通知: ${config.telegram.enabled ? '已启用' : '未启用'}`);
  if (config.telegram.enabled) {
    resolveChatId().then(id => {
      if (id) sendTelegram(`✅ <b>${esc(config.title)}</b> 已启动，通知链路正常`);
    });
  }
  runProbe().catch(e => console.error(`[probe] 异常: ${e.message}`));
  setInterval(() => runProbe().catch(e => console.error(`[probe] 异常: ${e.message}`)), config.interval_minutes * 60 * 1000);
  state.nextProbeAt = Date.now() + config.interval_minutes * 60 * 1000;
});

#!/usr/bin/env node
// NewAPI 模型连通性监控 —— 零依赖，Node >= 18
// 多 API 监控 + Telegram 通知 + Web 管理面板（登录后可在线增删改 API，即时生效并持久化到 config.json）

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
  confirm_retries: 2,        // 探测失败后再复测 N 次（共 1+N 次），全失败才记异常
  confirm_retry_delay_ms: 30000, // 复测间隔：30 秒，给号池轮换的时间，避免连续打到同一个坏号
  exclude_patterns: [],
  port: 8788,
  host: '127.0.0.1',
};

function normalizeBaseUrl(u) {
  let s = String(u || '')
    .trim()
    .replace(/^(https?:\/\/)+(https?:\/\/)/, '$2') // 容错重复协议头
    .replace(/\/+$/, '')
    .replace(/\/v1$/, '');
  // 没写协议时自动补 https://
  if (s && !/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s;
}

function deriveApis(rawApis, globalExclude) {
  const apis = (Array.isArray(rawApis) ? rawApis : [])
    .map((a, i) => ({
      rawIndex: i, // 在 rawConfig.apis 中的真实下标——管理接口必须用它定位，派生数组会过滤无效条目导致索引错位
      name: a.name || (() => { try { return new URL(normalizeBaseUrl(a.base_url)).hostname; } catch { return `api${i + 1}`; } })(),
      base_url: normalizeBaseUrl(a.base_url),
      api_key: a.api_key,
      exclude_patterns: Array.isArray(a.exclude_patterns) ? a.exclude_patterns : globalExclude,
    }))
    .filter(a => {
      const bad = !a.base_url || a.base_url.includes('example.com') || !a.api_key || a.api_key === 'sk-xxx';
      if (bad) console.error(`[config] 跳过未配置完整的 API: ${a.name || a.base_url || '(空)'}`);
      return !bad;
    });
  const seen = new Set();
  for (const a of apis) {
    let n = a.name, k = 2;
    while (seen.has(n)) n = `${a.name}-${k++}`;
    a.name = n;
    seen.add(n);
  }
  return apis;
}

let rawConfig = {};
let config = {};

function loadConfig() {
  try {
    rawConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error(`[config] 无法读取 ${CONFIG_PATH}: ${e.message}`);
    process.exit(1);
  }
  const cfg = { ...DEFAULTS, ...rawConfig };

  // 兼容旧的顶层 base_url/api_key（视为一个 API）
  let rawApis = Array.isArray(rawConfig.apis) ? rawConfig.apis : [];
  if (!rawApis.length && rawConfig.base_url && rawConfig.api_key) {
    rawApis = [{ name: '', base_url: rawConfig.base_url, api_key: rawConfig.api_key }];
  }
  cfg.apis = deriveApis(rawApis, cfg.exclude_patterns);

  // Telegram 通知：chat_id 可省略，会通过 getUpdates 自动发现（需先给 bot 发过一条消息）
  const tg = rawConfig.telegram || {};
  cfg.telegram = {
    enabled: !!tg.enabled && !!tg.bot_token,
    bot_token: tg.bot_token || '',
    chat_id: tg.chat_id || '',
    notify_recovery: tg.notify_recovery !== false,
    notify_after_failures: Math.max(1, tg.notify_after_failures || 1),
  };
  if (tg.enabled && !cfg.telegram.enabled) {
    console.error('[config] telegram.enabled 为 true 但缺少 bot_token，通知已禁用');
  }

  // 管理员账户：password 非空才启用 Web 管理
  const adm = rawConfig.admin || {};
  cfg.admin = {
    enabled: !!adm.password,
    username: adm.username || 'admin',
    password: adm.password || '',
  };

  // 环境变量覆盖（Docker 部署时容器内需监听 0.0.0.0）
  if (process.env.HOST) cfg.host = process.env.HOST;
  if (process.env.PORT) cfg.port = parseInt(process.env.PORT, 10) || cfg.port;
  config = cfg;
}

function saveConfig() {
  const content = JSON.stringify(rawConfig, null, 2) + '\n';
  try {
    const tmp = CONFIG_PATH + '.tmp';
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, CONFIG_PATH);
  } catch (e) {
    // Docker 单文件挂载时 rename 会报 EBUSY/EXDEV，退化为直接写
    try { fs.unlinkSync(CONFIG_PATH + '.tmp'); } catch {}
    fs.writeFileSync(CONFIG_PATH, content);
  }
}

loadConfig();
if (!config.apis.length && !config.admin.enabled) {
  console.error('[config] 没有可用的 API，且未设置 admin.password（无法从 Web 添加）。请在 config.json 配置其一。');
  process.exit(1);
}

// 通配符匹配（* 匹配任意字符，大小写不敏感）
function matchPattern(name, pattern) {
  const re = new RegExp('^' + pattern.toLowerCase().split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(name.toLowerCase());
}

// ---------- 状态与历史 ----------

const state = {
  models: {}, // { ["api::model"]: { api, model, excluded, present, alerted, history: [...] } }
  lastProbeStart: null,
  lastProbeEnd: null,
  nextProbeAt: null,
  probing: false,
};

function loadHistory() {
  try {
    const saved = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    if (saved && typeof saved.models === 'object') {
      for (const [key, m] of Object.entries(saved.models)) {
        if (key.includes(SEP)) {
          state.models[key] = m;
        } else if (config.apis[0]) {
          const api = config.apis[0].name;
          state.models[`${api}${SEP}${key}`] = { ...m, api, model: key };
        }
      }
      state.lastProbeEnd = saved.lastProbeEnd || null;
      const n = Object.keys(state.models).length;
      if (n) console.log(`[history] 已从 ${HISTORY_PATH} 恢复 ${n} 条模型历史`);
    }
  } catch { /* 首次运行没有历史文件 */ }
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

// ---------- 管理员会话 ----------

const sessions = new Map(); // token -> expiry(ms)
const SESSION_TTL = 7 * 24 * 3600 * 1000;
const loginFails = new Map(); // ip -> { count, resetAt }

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function isAuthed(req) {
  if (!config.admin.enabled) return false;
  const token = parseCookies(req).session;
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp || exp < Date.now()) { sessions.delete(token); return false; }
  return true;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

// ---------- Telegram 通知 ----------

const CHATID_CACHE = path.join(ROOT, 'data', 'telegram_chat_id');

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
    console.error('[telegram] 未配置 chat_id 且 getUpdates 里没有消息 —— 请先在 Telegram 里给你的 bot 发一条消息（如 /start）');
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
      lines.push(`• [${esc(c.api)}] <code>${esc(c.model)}</code>${c.latency_ms ? ` ${(c.latency_ms / 1000).toFixed(2)}s` : ''}`);
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

// 探测失败的复核逻辑见 runProbe：首测失败的模型集中等待 confirm_retry_delay_ms 后
// 批量复测（给号池轮换的时间），连续 1+confirm_retries 次都失败才记异常。

// 追加记录并返回状态变化事件（down / up / null）
function pushRecord(key, record) {
  const entry = state.models[key];
  entry.history.push(record);
  if (entry.history.length > MAX_HISTORY) entry.history = entry.history.slice(-MAX_HISTORY);

  const k = config.telegram.notify_after_failures;
  if (record.status !== 'ok') {
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

// scope: null=全部；{apiName}=只探测该分组；{apiName, modelName}=单个模型；{apiName, models:[...]}=指定模型集合
async function runProbe(scope = null) {
  if (state.probing) {
    state.probeQueue = state.probeQueue || [];
    state.probeQueue.push(scope);
    console.log('[probe] 上一轮探测仍在进行，已排队');
    return;
  }
  state.probing = true;
  state.lastProbeStart = Date.now();
  const isFull = !scope || (!scope.apiName && !scope.modelName);
  const scopeDesc = !scope ? '全部'
    : scope.modelName ? `[${scope.apiName}] ${scope.modelName}`
    : scope.models ? `[${scope.apiName}] ${scope.models.length} 个新模型`
    : `[${scope.apiName}]`;
  console.log(`[probe] 开始探测 (${scopeDesc}) @ ${new Date().toLocaleString()}`);
  const changes = [];
  const apisSnapshot = config.apis.filter(a => !scope?.apiName || a.name === scope.apiName); // 探测中管理员改配置不影响本轮

  const foundKeys = new Set();
  const tasks = [];
  let skipped = 0;
  for (const api of apisSnapshot) {
    try {
      const models = await fetchModels(api);
      if (isFull) console.log(`[probe] [${api.name}] 发现 ${models.length} 个模型`);
      for (const m of models) {
        if (scope?.modelName && m !== scope.modelName) continue;
        if (scope?.models && !scope.models.includes(m)) continue;
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
      if (scope?.modelName && !tasks.length && !skipped) {
        console.log(`[probe] [${api.name}] 模型 ${scope.modelName} 不在列表中`);
      }
    } catch (e) {
      console.error(`[probe] [${api.name}] 拉取模型列表失败: ${e.message}`);
      for (const [key, entry] of Object.entries(state.models)) {
        if (entry.api === api.name && !entry.excluded && (!scope?.modelName || entry.model === scope.modelName)) {
          foundKeys.add(key);
          const c = pushRecord(key, { t: Date.now(), status: 'error', latency_ms: 0, http_status: 0, error: `模型列表拉取失败: ${String(e.message).slice(0, 200)}` });
          if (c) changes.push(c);
        }
      }
    }
  }
  // 下线清理只在全量探测时做（局部探测的 foundKeys 不完整）。
  // 注意：某 API 列表拉取失败时其已知模型都在 foundKeys 里，不会被误删。
  if (isFull) {
    const validApis = new Set(config.apis.map(a => a.name));
    for (const [key, entry] of Object.entries(state.models)) {
      if (!validApis.has(entry.api)) { delete state.models[key]; continue; } // API 已被管理员删除
      if (!foundKeys.has(key)) {
        console.log(`[probe] − [${entry.api}] ${entry.model} 已从列表移除，删除记录`);
        delete state.models[key];
      }
    }
  }

  // 通用并发池：探测 list 里的任务，成功立即记录，失败的返回待复测列表
  const probePass = async (list, label) => {
    let i = 0;
    const failed = [];
    const worker = async () => {
      while (i < list.length) {
        const t = list[i++];
        if (!state.models[t.key]) continue; // 探测中该 API 被删除
        const rec = await probeModel(t.api, t.model);
        if (!state.models[t.key]) continue;
        if (rec.status === 'ok') {
          okCount++;
          const c = pushRecord(t.key, rec);
          if (c) changes.push(c);
          console.log(`[probe] ✓ [${t.api.name}] ${t.model} ${rec.latency_ms}ms${label ? `（${label}通过）` : ''}`);
        } else {
          failed.push({ ...t, rec });
          console.log(`[probe] ? [${t.api.name}] ${t.model} ${label || '首测'}失败 [${rec.status}${rec.http_status ? ' ' + rec.http_status : ''}]，待复测确认`);
        }
        await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
      }
    };
    await Promise.all(Array.from({ length: Math.min(config.concurrency, list.length) }, worker));
    return failed;
  };

  let okCount = 0, failCount = 0;
  // 第一遍：全部模型
  let pending = await probePass(tasks, '');
  // 复测确认：失败的集中等待后批量重测（间隔期给号池轮换的时间），任一次成功即算正常
  const totalTests = 1 + Math.max(0, config.confirm_retries);
  for (let attempt = 2; attempt <= totalTests && pending.length; attempt++) {
    console.log(`[probe] ${pending.length} 个模型待复测，${Math.round(config.confirm_retry_delay_ms / 1000)}s 后进行第 ${attempt}/${totalTests} 次测试`);
    await new Promise(r => setTimeout(r, config.confirm_retry_delay_ms));
    pending = await probePass(pending, `第 ${attempt} 次复测`);
  }
  // 复测后仍失败的才记异常
  for (const t of pending) {
    if (!state.models[t.key]) continue;
    failCount++;
    if (totalTests > 1) t.rec.error = `连续 ${totalTests} 次失败 · ${t.rec.error || t.rec.status}`;
    const c = pushRecord(t.key, t.rec);
    if (c) changes.push(c);
    console.log(`[probe] ✗ [${t.api.name}] ${t.model} [${t.rec.status}${t.rec.http_status ? ' ' + t.rec.http_status : ''}] ${t.rec.error}`);
  }

  state.lastProbeEnd = Date.now();
  if (isFull) state.nextProbeAt = Date.now() + config.interval_minutes * 60 * 1000;
  state.probing = false;
  saveHistory();
  console.log(`[probe] 完成 (${scopeDesc}): ${okCount} 正常 / ${failCount} 异常 / ${skipped} 跳过`);
  await notifyChanges(changes);
  const queue = state.probeQueue;
  if (queue && queue.length) {
    // 队列里含全量请求则跑全量，否则跑最早的局部请求
    const next = queue.some(s => !s || (!s.apiName && !s.modelName)) ? null : queue[0];
    state.probeQueue = [];
    console.log('[probe] 执行排队的探测请求');
    runProbe(next).catch(e => console.error(`[probe] 异常: ${e.message}`));
  }
}

// ---------- HTTP 服务 ----------

function buildStatus(req) {
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
      history: hist.slice(-60),
    };
  });
  const apiOrder = new Map(config.apis.map((a, i) => [a.name, i]));
  models.sort((a, b) => (apiOrder.get(a.api) ?? 999) - (apiOrder.get(b.api) ?? 999) || a.name.localeCompare(b.name));
  return {
    title: config.title,
    generated_at: Date.now(),
    probing: state.probing,
    last_probe_start: state.lastProbeStart,
    last_probe_end: state.lastProbeEnd,
    next_probe_at: state.nextProbeAt,
    interval_minutes: config.interval_minutes,
    apis: config.apis.map(a => a.name),
    admin_enabled: config.admin.enabled,
    authed: isAuthed(req),
    models,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => {
      buf += c;
      if (buf.length > 65536) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function maskKey(k) {
  const s = String(k || '');
  return s.length <= 10 ? '***' : s.slice(0, 6) + '…' + s.slice(-4);
}

// rawConfig.apis 保证为数组（管理接口写入前调用）
function ensureRawApis() {
  if (!Array.isArray(rawConfig.apis)) {
    rawConfig.apis = [];
    if (rawConfig.base_url && rawConfig.api_key) {
      rawConfig.apis.push({ name: '', base_url: rawConfig.base_url, api_key: rawConfig.api_key });
      delete rawConfig.base_url;
      delete rawConfig.api_key;
    }
  }
}

function applyApisChange() {
  saveConfig();
  config.apis = deriveApis(rawConfig.apis, config.exclude_patterns);
  if (!state.probing) runProbe().catch(e => console.error(`[probe] 异常: ${e.message}`));
}

async function handleAdmin(req, res, url) {
  // 登录（不需要已有会话）
  if (req.method === 'POST' && url.pathname === '/api/login') {
    if (!config.admin.enabled) return json(res, 400, { error: '未启用管理员（config.json 中设置 admin.password）' });
    const ip = clientIp(req);
    const fail = loginFails.get(ip);
    if (fail && fail.count >= 10 && Date.now() < fail.resetAt) {
      return json(res, 429, { error: '失败次数过多，请 15 分钟后再试' });
    }
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    if (safeEqual(body.username || '', config.admin.username) && safeEqual(body.password || '', config.admin.password)) {
      loginFails.delete(ip);
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, Date.now() + SESSION_TTL);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}`,
      });
      return res.end(JSON.stringify({ ok: true }));
    }
    const f = loginFails.get(ip) || { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
    if (Date.now() > f.resetAt) { f.count = 0; f.resetAt = Date.now() + 15 * 60 * 1000; }
    f.count++;
    loginFails.set(ip, f);
    return json(res, 401, { error: '用户名或密码错误' });
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    const token = parseCookies(req).session;
    if (token) sessions.delete(token);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  // 以下都需要登录
  if (!isAuthed(req)) return json(res, 401, { error: '未登录' });

  if (req.method === 'GET' && url.pathname === '/api/admin/apis') {
    ensureRawApis();
    const derived = deriveApis(rawConfig.apis, config.exclude_patterns);
    return json(res, 200, {
      apis: rawConfig.apis.map((a, i) => {
        const d = derived.find(x => x.rawIndex === i);
        return {
          name: d ? d.name : (a.name || '(无效条目)'),
          base_url: a.base_url || '',
          api_key_masked: maskKey(a.api_key),
          exclude_patterns: Array.isArray(a.exclude_patterns) ? a.exclude_patterns : null,
          invalid: !d,
        };
      }),
    });
  }

  // 重新拉取模型列表（?api=分组名，省略则全部分组），新增模型自动探测
  if (req.method === 'POST' && url.pathname === '/api/admin/refresh-models') {
    const apiName = url.searchParams.get('api') || '';
    const targets = config.apis.filter(a => !apiName || a.name === apiName);
    if (!targets.length) return json(res, 404, { error: apiName ? `找不到分组 "${apiName}"` : '没有已配置的 API' });
    let total = 0, added = 0, removed = 0;
    const errors = [];
    for (const api of targets) {
      try {
        const models = await fetchModels(api);
        total += models.length;
        const newModels = [];
        const found = new Set();
        for (const m of models) {
          const key = `${api.name}${SEP}${m}`;
          found.add(key);
          if (!state.models[key]) {
            state.models[key] = { api: api.name, model: m, excluded: false, history: [] };
            newModels.push(m);
          }
          const entry = state.models[key];
          entry.present = true;
          entry.excluded = api.exclude_patterns.some(p => matchPattern(m, p));
        }
        for (const [key, entry] of Object.entries(state.models)) {
          if (entry.api === api.name && !found.has(key)) {
            console.log(`[admin] [${api.name}] ${entry.model} 已从列表移除，删除记录`);
            delete state.models[key];
            removed++;
          }
        }
        const probeList = [...new Set(newModels)];
        added += probeList.length;
        console.log(`[admin] [${api.name}] 刷新模型列表: ${models.length} 个，新增 ${probeList.length}`);
        const toProbe = probeList.filter(m => !state.models[`${api.name}${SEP}${m}`].excluded);
        if (toProbe.length) runProbe({ apiName: api.name, models: toProbe }).catch(e => console.error(`[probe] 异常: ${e.message}`));
      } catch (e) {
        errors.push(`[${api.name}] ${String(e.message).slice(0, 150)}`);
      }
    }
    saveHistory();
    if (errors.length && !total) return json(res, 502, { error: errors.join('; ') });
    return json(res, 200, { ok: true, total, added, removed, errors });
  }

  // 分组排序：body.order 为派生名称的新顺序
  if (req.method === 'POST' && url.pathname === '/api/admin/apis/reorder') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    if (!Array.isArray(body.order)) return json(res, 400, { error: 'order 必须是数组' });
    ensureRawApis();
    const derived = deriveApis(rawConfig.apis, config.exclude_patterns);
    if (derived.length !== rawConfig.apis.length) {
      return json(res, 400, { error: '存在无效的 API 条目，请先在 config.json 中清理后再排序' });
    }
    if (body.order.length !== derived.length || new Set(body.order).size !== derived.length ||
        !body.order.every(n => derived.some(a => a.name === n))) {
      return json(res, 400, { error: 'order 与现有分组不匹配，请刷新后重试' });
    }
    rawConfig.apis = body.order.map(n => rawConfig.apis[derived.find(a => a.name === n).rawIndex]);
    try {
      saveConfig();
      config.apis = deriveApis(rawConfig.apis, config.exclude_patterns);
    } catch (e) {
      return json(res, 500, { error: `配置保存失败：${String(e.message).slice(0, 200)}` });
    }
    console.log(`[admin] 分组排序: ${body.order.join(' → ')}`);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/apis') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    const base_url = normalizeBaseUrl(body.base_url);
    const api_key = String(body.api_key || '').trim();
    const name = String(body.name || '').trim();
    if (!base_url || !/^https?:\/\//.test(base_url)) return json(res, 400, { error: 'base_url 无效，示例: https://api.example.com' });
    if (!api_key) return json(res, 400, { error: 'api_key 不能为空' });
    ensureRawApis();
    if (name && deriveApis(rawConfig.apis, config.exclude_patterns).some(a => a.name === name)) {
      return json(res, 400, { error: `名称 "${name}" 已存在` });
    }
    // 保存前先验证连通性，问题立刻反馈
    let modelCount = 0;
    try {
      const models = await fetchModels({ base_url, api_key });
      modelCount = models.length;
      if (!modelCount) return json(res, 400, { error: '验证失败：/v1/models 返回了空列表，请检查密钥的模型权限' });
    } catch (e) {
      return json(res, 400, { error: `验证失败：${String(e.message).slice(0, 200)}` });
    }
    const entry = { name, base_url, api_key };
    if (Array.isArray(body.exclude_patterns) && body.exclude_patterns.length) entry.exclude_patterns = body.exclude_patterns;
    rawConfig.apis.push(entry);
    try {
      applyApisChange();
    } catch (e) {
      rawConfig.apis.pop();
      return json(res, 500, { error: `配置保存失败：${String(e.message).slice(0, 200)}` });
    }
    console.log(`[admin] 添加 API: ${name || base_url} (${modelCount} 个模型)`);
    return json(res, 200, { ok: true, model_count: modelCount });
  }

  // 复制分组：新名字自动加 _copy（重名则 _copy2…），密钥等配置原样带过去
  const dupMatch = url.pathname.match(/^\/api\/admin\/apis\/(.+)\/duplicate$/);
  if (dupMatch && req.method === 'POST') {
    const target = decodeURIComponent(dupMatch[1]);
    ensureRawApis();
    const derived = deriveApis(rawConfig.apis, config.exclude_patterns);
    const hit = derived.find(a => a.name === target);
    if (!hit) return json(res, 404, { error: `找不到 API "${target}"` });
    const src = rawConfig.apis[hit.rawIndex];
    let newName = `${target}_copy`, k = 2;
    while (derived.some(a => a.name === newName)) newName = `${target}_copy${k++}`;
    rawConfig.apis.push({ ...src, name: newName });
    try {
      applyApisChange();
    } catch (e) {
      rawConfig.apis.pop();
      return json(res, 500, { error: `配置保存失败：${String(e.message).slice(0, 200)}` });
    }
    console.log(`[admin] 复制 API: ${target} → ${newName}`);
    return json(res, 200, { ok: true, name: newName, base_url: src.base_url });
  }

  const apiPathMatch = url.pathname.match(/^\/api\/admin\/apis\/(.+)$/);
  if (apiPathMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
    const target = decodeURIComponent(apiPathMatch[1]);
    ensureRawApis();
    // 用派生名称定位，再通过 rawIndex 回到原始条目——派生数组会过滤无效条目，
    // 直接用派生下标索引 rawConfig.apis 会错位（曾导致编辑改到别的分组）
    const derived = deriveApis(rawConfig.apis, config.exclude_patterns);
    const hit = derived.find(a => a.name === target);
    if (!hit) return json(res, 404, { error: `找不到 API "${target}"` });
    const idx = hit.rawIndex;

    if (req.method === 'DELETE') {
      rawConfig.apis.splice(idx, 1);
      for (const [key, entry] of Object.entries(state.models)) {
        if (entry.api === target) delete state.models[key];
      }
      saveHistory();
      applyApisChange();
      console.log(`[admin] 删除 API: ${target}`);
      return json(res, 200, { ok: true });
    }

    // PUT 更新
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    const item = rawConfig.apis[idx];
    if (body.base_url !== undefined) {
      const bu = normalizeBaseUrl(body.base_url);
      if (!/^https?:\/\//.test(bu)) return json(res, 400, { error: 'base_url 无效' });
      item.base_url = bu;
    }
    if (body.api_key !== undefined && String(body.api_key).trim()) item.api_key = String(body.api_key).trim();
    if (body.exclude_patterns !== undefined) {
      if (Array.isArray(body.exclude_patterns) && body.exclude_patterns.length) item.exclude_patterns = body.exclude_patterns;
      else delete item.exclude_patterns;
    }
    if (body.name !== undefined && String(body.name).trim() && String(body.name).trim() !== target) {
      const newName = String(body.name).trim();
      if (derived.some(a => a.rawIndex !== idx && a.name === newName)) return json(res, 400, { error: `名称 "${newName}" 已存在` });
      item.name = newName;
      // 迁移历史记录 key
      for (const [key, entry] of Object.entries(state.models)) {
        if (entry.api === target) {
          entry.api = newName;
          state.models[`${newName}${SEP}${entry.model}`] = entry;
          delete state.models[key];
        }
      }
      saveHistory();
    }
    try {
      applyApisChange();
    } catch (e) {
      return json(res, 500, { error: `配置保存失败：${String(e.message).slice(0, 200)}` });
    }
    console.log(`[admin] 更新 API: ${target}`);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'not found' });
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
    json(res, 200, buildStatus(req));
  } else if (req.method === 'POST' && url.pathname === '/api/probe') {
    if (!isAuthed(req)) { json(res, 401, { error: '仅管理员可手动探测' }); return; }
    const apiName = url.searchParams.get('api') || '';
    const modelName = url.searchParams.get('model') || '';
    if (apiName && !config.apis.some(a => a.name === apiName)) { json(res, 404, { error: `找不到分组 "${apiName}"` }); return; }
    const scope = apiName ? { apiName, modelName: modelName || undefined } : null;
    runProbe(scope).catch(e => console.error(`[probe] 异常: ${e.message}`));
    json(res, 202, { probing: true });
  } else if (url.pathname.startsWith('/api/')) {
    handleAdmin(req, res, url).catch(e => {
      console.error(`[admin] 处理异常: ${e.message}`);
      try { json(res, 500, { error: '内部错误' }); } catch {}
    });
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});

// 定期清理过期会话
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
}, 3600 * 1000);

// ---------- 启动 ----------

loadHistory();
server.listen(config.port, config.host, () => {
  console.log(`[server] 状态页: http://${config.host}:${config.port}`);
  console.log(`[server] 监控 ${config.apis.length} 个 API: ${config.apis.map(a => a.name).join(', ') || '(暂无，可从 Web 管理面板添加)'}`);
  console.log(`[server] 探测周期: ${config.interval_minutes} 分钟, 并发: ${config.concurrency}, 超时: ${config.timeout_ms}ms`);
  console.log(`[server] Telegram 通知: ${config.telegram.enabled ? '已启用' : '未启用'}`);
  console.log(`[server] Web 管理: ${config.admin.enabled ? `已启用 (用户: ${config.admin.username})` : '未启用（config.json 设置 admin.password 后开启）'}`);
  if (config.telegram.enabled) {
    resolveChatId().then(id => {
      if (id) sendTelegram(`✅ <b>${esc(config.title)}</b> 已启动，通知链路正常`);
    });
  }
  if (config.apis.length) runProbe().catch(e => console.error(`[probe] 异常: ${e.message}`));
  setInterval(() => { if (config.apis.length) runProbe().catch(e => console.error(`[probe] 异常: ${e.message}`)); }, config.interval_minutes * 60 * 1000);
  state.nextProbeAt = Date.now() + config.interval_minutes * 60 * 1000;
});

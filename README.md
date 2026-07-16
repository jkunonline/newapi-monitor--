# NewAPI 模型连通性监控

类 sub2api 的模型状态页：定时对多个 newapi / OneAPI 站点密钥下的**所有模型**发送真实小请求（`max_tokens: 1`），网页展示每个模型的可用性、延迟、24h 成功率和历史记录，异常时推送 Telegram 通知。

**零依赖**，只需 Node.js >= 18（或 Docker）。

## 功能特性

- 🔍 **自动发现模型**：每轮从 `/v1/models` 拉取密钥可用的全部模型（Claude / GPT / Gemini / GLM / DeepSeek / Qwen 等全部支持），新增模型自动纳入监控
- 🔑 **多 API 支持**：可同时监控多个站点/多个密钥，页面顶部标签页点击切换分组
- 🛠 **Web 管理面板**：管理员登录后可在网页上直接添加/编辑/删除 API，立即生效并写回配置，无需重启
- ✅ **真实探测**：发真实 chat 请求（`max_tokens: 1`，消耗极小），能真正验证模型是否可用；思考类模型自动回退更大的 max_tokens、`max_completion_tokens`
- 📊 **状态页**：状态点、当前延迟、24h 成功率、历史小方块（悬停看错误详情）、搜索过滤、30 秒自动刷新、手动「立即探测」
- 📱 **Telegram 通知**：模型异常/恢复时推送，只在状态变化时通知一次，不轰炸；支持连续失败 N 次才报警（过滤抖动）
- 💾 **历史持久化**：每模型保留最近 288 次记录（约 48 小时），重启自动恢复，无需数据库
- 🚫 **智能跳过**：画图/语音/embedding 等非对话模型自动跳过（通配符可配置）

## 快速开始（本机运行）

```bash
git clone https://github.com/jkunonline/newapi-monitor--.git
cd newapi-monitor--
cp config.example.json config.json
# 编辑 config.json，填入你的 base_url 和 api_key
node server.js
```

打开 <http://127.0.0.1:8788> 即可看到状态页。

## 配置说明

```jsonc
{
  "title": "我的模型监控",              // 页面标题，自定义
  "apis": [                             // 一个或多个 API
    {
      "name": "站点A",                  // 显示名，省略则用域名
      "base_url": "https://a.com",      // 网关地址，不带 /v1
      "api_key": "sk-xxx"
      // 可单独加 "exclude_patterns" 覆盖全局
    }
  ],
  "admin": {                            // Web 管理面板（可选）
    "username": "admin",
    "password": "强密码"                 // 非空即启用；留空/删掉则纯只读状态页
  },
  "telegram": {
    "enabled": true,
    "bot_token": "123456:ABC-...",      // @BotFather 创建 bot 获得
    "chat_id": "123456789",             // 你的用户 id；省略则自动发现（见下）
    "notify_recovery": true,            // 恢复时也通知
    "notify_after_failures": 1          // 连续失败 N 次才报警，设 2 可过滤抖动
  },
  "interval_minutes": 10,               // 探测周期
  "timeout_ms": 30000,                  // 单请求超时
  "concurrency": 3,                     // 并发数，太大易触发限流
  "max_tokens": 1,                      // 探测消耗，保持 1 即可
  "fallback_max_tokens": 4096,          // 思考类模型的重试值
  "exclude_patterns": ["*tts*", "..."], // 跳过的模型（通配符 * ）
  "port": 8788,
  "host": "127.0.0.1"                   // 环境变量 HOST/PORT 可覆盖
}
```

兼容简化格式：顶层直接写 `base_url` + `api_key`（单 API）。

### Web 管理面板

配置了 `admin.password` 后，页面右上角出现「管理登录」按钮：

- 登录后可**添加 / 编辑 / 删除 API**，保存即触发一轮探测，无需重启服务
- 修改会写回 `config.json`（Docker 部署时注意 config.json 挂载不能是只读 `:ro`）
- 登录失败 10 次同一 IP 锁 15 分钟；会话有效期 7 天（重启服务后需重新登录）
- 编辑时 API Key 留空表示不修改；密钥在页面上只显示掩码
- 不设置 `admin.password` 时页面是纯只读状态页，无任何管理入口

### Telegram 通知配置

1. Telegram 里找 [@BotFather](https://t.me/BotFather) → `/newbot` 创建，拿到 `bot_token`
2. **私聊你的 bot 点 /start**（必须，否则 bot 无法主动给你发消息）
3. `chat_id` 填你的用户 id 即固定绑定，只发给你；不填则自动识别最近私聊 bot 的人并缓存到 `data/telegram_chat_id`
4. 启动时会发一条「✅ 已启动」测试消息验证链路

> 查自己的 id：给 [@userinfobot](https://t.me/userinfobot) 发条消息即可。

## 部署到服务器

### 方式一：Docker（推荐）

服务器需已安装 Docker 和 docker compose 插件。

```bash
# 1. 拉取源码
git clone https://github.com/jkunonline/newapi-monitor--.git /opt/newapi-monitor
cd /opt/newapi-monitor

# 2. 准备配置
cp config.example.json config.json
vim config.json        # 填入密钥、Telegram 等

# 3. 启动
docker compose up -d --build

# 4. 查看探测日志
docker logs -f newapi-monitor
```

默认只绑定服务器 `127.0.0.1:8788`（状态页无鉴权，不要裸奔公网）。访问方式：

**A. SSH 隧道（最简单安全）** —— 本机执行：

```bash
ssh -N -L 8788:127.0.0.1:8788 root@你的服务器IP
```

然后本机浏览器打开 http://127.0.0.1:8788

**B. nginx 反代 + Basic Auth（公网访问）**：

```bash
# 生成密码文件
htpasswd -c /etc/nginx/.htpasswd admin
```

```nginx
server {
    listen 443 ssl;
    server_name monitor.example.com;
    # ssl_certificate ...;

    location / {
        auth_basic "monitor";
        auth_basic_user_file /etc/nginx/.htpasswd;
        proxy_pass http://127.0.0.1:8788;
    }
}
```

**更新版本**：

```bash
cd /opt/newapi-monitor
git pull
docker compose up -d --build
```

### 方式二：systemd（不用 Docker）

服务器需已安装 Node.js >= 18。

```bash
git clone https://github.com/jkunonline/newapi-monitor--.git /opt/newapi-monitor
cd /opt/newapi-monitor
cp config.example.json config.json && vim config.json
```

创建 `/etc/systemd/system/newapi-monitor.service`：

```ini
[Unit]
Description=NewAPI model monitor
After=network-online.target

[Service]
WorkingDirectory=/opt/newapi-monitor
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now newapi-monitor
journalctl -u newapi-monitor -f     # 查看日志
```

### 方式三：macOS 本机常驻（launchd）

```bash
cat > ~/Library/LaunchAgents/com.newapi.monitor.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.newapi.monitor</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/node</string>
    <string>SERVER_JS_PATH</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
EOF
# 把 SERVER_JS_PATH 替换为 server.js 的绝对路径、node 路径按 `which node` 调整
launchctl load ~/Library/LaunchAgents/com.newapi.monitor.plist
```

## 页面说明

- **顶部统计**：API 数 / 模型总数 / 正常 / 异常 / 未探测
- **API 标签页**：多 API 时显示，点击切换；标签上的圆点绿=全部正常、红=有异常，并显示 `正常/总数`
- **模型行**：状态点（绿/红/黄=超时/灰=未探测）、延迟、24h 成功率、历史方块（悬停看时间和错误）
- 异常模型自动排在最前；某 API 整站故障（模型列表都拉不到）时该 API 下全部模型标红

## 常见问题

**Q: 有些模型没出现在页面上？**
监控范围 = 密钥在 `/v1/models` 返回的列表。去 newapi 后台检查该密钥的分组/模型权限。

**Q: 思考模型（o3 / deepseek-r1 / claude thinking）报 max_tokens 错误？**
已内置三层回退（`max_tokens: 1` → `max_completion_tokens` → `fallback_max_tokens: 4096`）。仍报错请提 issue 附错误信息。

**Q: Telegram 收不到通知？**
1. 确认私聊 bot 点过 /start；2. 浏览器访问 `https://api.telegram.org/bot<token>/getMe` 验证 token；3. 服务器能直连 api.telegram.org（国内机器可能需要代理）。

**Q: 探测会消耗多少额度？**
每模型每轮一条 `max_tokens: 1` 的请求，普通模型几乎可忽略；思考类模型会多一些（可用 `exclude_patterns` 排除）。

## License

MIT

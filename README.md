# WawAPI model monitor

独立监测 `https://wawapii.com/v1/models`，比较相邻的有效模型列表，并通过现有通知渠道提醒模型上新、下架、空列表和 API 异常。

## 配置

优先使用环境变量：

```bash
export WAWAPI_API_KEY='your-new-wawapi-key'
```

也可以复制本地模板并填写 Key：

```bash
cp wawapi_model_monitor.local.js.example wawapi_model_monitor.local.js
```

通知渠道使用 `push_config.local.js` 或对应环境变量。真实 Key 不要提交到 Git。

## 运行

单次执行适合青龙或 cron：

```bash
npm run start:once
```

常驻执行适合 systemd、pm2 或 Docker：

```bash
npm start
```

主动报告当前模型列表：

```bash
npm run report
```

轮询间隔可以通过 `WAWAPI_MODEL_INTERVAL_MS` 调整。状态文件只保留一份最新的非空模型快照；连续相同 API 异常只提醒一次，恢复后发送恢复通知。

## 测试

```bash
npm test
```

测试使用本地 mock，不需要真实 WawAPI Key，也不会发送真实通知。

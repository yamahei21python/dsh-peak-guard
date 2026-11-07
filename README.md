# dsh-peak-guard

DeepSeek Harness (DSH) 用のピーク料金ガード。**使用中モデルの料金カタログを読み、ピーク倍率が適用される時間だけリクエストを停止**する。手動で解除しない限りブロックされる。

ピーク時間をハードコードせず、`opencode-go` のモデルカタログが返す `cost.multipliers` を現在UTCで評価する。モデル追加・料金改定に自動追従する。

```
[PEAK GUARD] deepseek-v4.1-flash はピーク時間のため停止（単価倍増）
  ピーク: 平日 10:00-13:00 / 15:00-19:00 JST (UTC 01-04, 06-10)
  このピーク残り: 約42分
  1時間だけ解除: npx dsh-peak off
```

## Install

npm (recommended):

```bash
dsh plugin --profile web add dsh-peak-guard
```

GitHub (no registry):

```bash
dsh plugin --profile web add github:yamahei21python/dsh-peak-guard
```

A bundle install adds the guard row to the profile; no manual `cordis.patch.yml` insert is needed. Restart `dsh`.

### Provider configuration

The bundle only installs the guard. The model provider row stays yours (API key, endpoint, models). For OpenCode Go:

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: llm-pi-ai
  config:
    providers:
      opencode-go:
        displayName: OpenCode Go
        apiKeyEnv: OPENCODE_GO_KEY
        api: openai-completions
        baseURL: https://opencode.ai/inference/go/openai/v1
        headers:
          x-opencode-session: dsh-<random-stable-id>
        compat:
          supportsDeveloperRole: false
          maxTokensField: max_tokens
          supportsReasoningEffort: true
        models:
          - id: deepseek-v4.1-flash
            name: DeepSeek V4.1 Flash
            contextWindow: 1000000
            maxTokens: 384000
            input: [text, image]
            reasoningEfforts:
              off:
              low: low
              high: high
              max: max
          - id: deepseek-v4-pro
            name: DeepSeek V4 Pro
            contextWindow: 1000000
            maxTokens: 384000
            input: [text]
            reasoningEfforts:
              off:
              high: high
              max: max

- id: agent-default-model
  config:
    provider: opencode-go
    model: deepseek-v4.1-flash
```

Store the key with the credentials service (Models page) or export `OPENCODE_GO_KEY`.

## Bypass

```bash
npx dsh-peak off          # 60 minutes
npx dsh-peak off 30       # 30 minutes
npx dsh-peak on           # block again now
npx dsh-peak status
```

State file (shared with the OpenCode guard by default):

```json
{"until":1794017000000,"minutes":60,"set_at":"2026-11-07T02:00:00.000Z"}
```

Override the path with `DSH_PEAK_BYPASS`. The guard fails closed: a missing or corrupt file means "block during peak".

Test flags for development:

```bash
PEAK_GUARD_FORCE=peak dsh web   # always block
PEAK_GUARD_FORCE=off  dsh web   # never block
```

## How it works

- Hooks the `llm/stream` waterfall.
- Fetches `https://opencode.ai/inference/go/v1/models` (10-minute cache; last good catalog kept on failure; 60-second negative cache).
- Evaluates each model's `cost.multipliers[].when` (`utc_days`, `utc_hours` with `gte`/`lt`, `any`/`all`) against the current UTC time.
- On a match with no active bypass, yields a terminal `finish` chunk with `code: PEAK_GUARD` and HTTP-429 semantics; the turn fails cleanly instead of crashing the process.
- If the catalog is unreachable, falls back to the documented weekday windows `01:00-04:00` and `06:00-10:00` UTC.

## Configuration

Optional plugin config (`cordis.patch.yml` row can override):

```yaml
- id: peak-guard
  config:
    providers: [opencode-go]
    modelsUrl: https://opencode.ai/inference/go/v1/models
```

## Scope and limitations

- Only blocks calls routed through the configured provider ids (default `opencode-go`).
- Other clients (Claude Code, Codex, etc.) are not covered; use a gateway-level guard.
- DSH is a developer preview; `engines.dsh` is `>=0.2.0-rc.1 <0.3.0`.
- Prices and peak windows come from the provider catalog; this package ships none.

## License

MIT

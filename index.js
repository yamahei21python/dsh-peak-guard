// DeepSeek Harness plugin: block peak-priced model calls unless manually bypassed.
//
// The peak windows are NOT hardcoded: the plugin reads the provider's model
// catalog (opencode/go /v1/models) and evaluates each model's
// `cost.multipliers` conditions against the current UTC time. Any matching
// multiplier means the request would be billed at the multiplied rate.
//
// Bypass is shared with the OpenCode guard:
//   ~/.config/opencode/bin/deepseek-peak off [minutes]
//   ~/.config/opencode/bin/deepseek-peak on
//   ~/.config/opencode/bin/deepseek-peak status

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const name = "deepseek-peak-guard";

const DEFAULT_PROVIDERS = ["opencode-go"];
const DEFAULT_MODELS_URL = "https://opencode.ai/inference/go/v1/models";
const BYPASS_PATH = path.join(os.homedir(), ".opencode", "deepseek_peak_bypass.json");
const AUDIT_PATH = path.join(os.homedir(), ".opencode", "deepseek_peak_guard.log");
const CACHE_TTL_MS = 10 * 60 * 1000;
const FALLBACK_WINDOWS = [
  { start: 1 * 60, end: 4 * 60 },
  { start: 6 * 60, end: 10 * 60 },
];

let cache = { at: 0, url: "", models: new Map(), failedAt: 0 };
const FAILURE_TTL_MS = 60 * 1000;

function audit(event, detail) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
    fs.appendFileSync(
      AUDIT_PATH,
      JSON.stringify({ ts: new Date().toISOString(), event, source: "dsh-plugin", ...detail }) + "\n"
    );
  } catch {
    // logging must never break a request
  }
}

function toMinutes(hhmm) {
  if (typeof hhmm !== "string") return null;
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function dayName(date) {
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][date.getUTCDay()];
}

/** Evaluate one catalog `when` condition tree against a Date. */
export function matchesWhen(when, date) {
  if (!when || typeof when !== "object") return false;
  if (Array.isArray(when.all) && !when.all.every((c) => matchesWhen(c, date))) return false;
  if (Array.isArray(when.any) && !when.any.some((c) => matchesWhen(c, date))) return false;
  if (when.utc_days && Array.isArray(when.utc_days.in)) {
    if (!when.utc_days.in.includes(dayName(date))) return false;
  }
  if (when.utc_hours && typeof when.utc_hours === "object") {
    const now = date.getUTCHours() * 60 + date.getUTCMinutes();
    const gte = toMinutes(when.utc_hours.gte);
    const lt = toMinutes(when.utc_hours.lt);
    // A malformed bound must not turn into "always matches" (all-day block).
    if (when.utc_hours.gte !== undefined && gte === null) return false;
    if (when.utc_hours.lt !== undefined && lt === null) return false;
    if (gte !== null && now < gte) return false;
    if (lt !== null && now >= lt) return false;
  }
  return true;
}

/** End of the matched window in minutes-of-day (smallest lt after now). */
export function windowEndMinutes(when, nowMinute) {
  if (!when || typeof when !== "object") return null;
  const ends = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.utc_hours && node.utc_hours.lt) {
      const lt = toMinutes(node.utc_hours.lt);
      if (lt !== null) ends.push(lt);
    }
    if (Array.isArray(node.all)) node.all.forEach(walk);
    if (Array.isArray(node.any)) node.any.forEach(walk);
  };
  walk(when);
  const later = ends.filter((n) => nowMinute === undefined || n > nowMinute).sort((a, b) => a - b);
  return later.length > 0 ? later[0] : (ends.sort((a, b) => a - b)[0] ?? null);
}

async function loadCatalog(url) {
  const now = Date.now();
  if (cache.url === url) {
    if (cache.models.size > 0 && now - cache.at < CACHE_TTL_MS) return cache.models;
    // Negative cache: avoid an 8s fetch on every request while the catalog is down.
    if (cache.failedAt > 0 && now - cache.failedAt < FAILURE_TTL_MS) {
      return cache.models.size > 0 ? cache.models : null;
    }
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const models = new Map();
    for (const m of json.data ?? []) {
      if (!m || typeof m.id !== "string") continue;
      const multipliers = m.cost?.multipliers;
      models.set(m.id.toLowerCase(), { id: m.id, multipliers: Array.isArray(multipliers) ? multipliers : [] });
    }
    if (models.size === 0) {
      cache = { at: now, url, models: new Map(), failedAt: now };
      audit("catalog_empty", { url });
      return null;
    }
    cache = { at: now, url, models, failedAt: 0 };
    audit("catalog_loaded", { url, models: models.size });
    return models;
  } catch (error) {
    // Keep the last good catalog (stale) and back off briefly on failure.
    cache = { at: cache.at, url, models: cache.models, failedAt: now };
    audit("catalog_failed", { url, error: String(error) });
    return cache.models.size > 0 ? cache.models : null;
  }
}

function bypassUntil() {
  try {
    const raw = JSON.parse(fs.readFileSync(BYPASS_PATH, "utf8"));
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (raw && typeof raw === "object" && Number.isFinite(raw.until)) return Number(raw.until);
  } catch {
    // missing / corrupt -> block during peak
  }
  return 0;
}

function isTargetModel(model) {
  const m = String(model).toLowerCase();
  return m.includes("deepseek-v4") && (m.includes("flash") || m.includes("pro"));
}

function bareModelId(model) {
  const s = String(model);
  return (s.split("/").pop() ?? s).toLowerCase();
}

/**
 * Decide whether this call is peak-priced.
 * @returns {{peak: boolean, endMinute: number|null, source: string}}
 */
async function peakState(provider, model, config) {
  const force = String(process.env.PEAK_GUARD_FORCE ?? "").toLowerCase();
  const now = new Date();
  if (force === "peak") return { peak: true, endMinute: null, source: "forced" };
  if (force === "off") return { peak: false, endMinute: null, source: "forced" };

  const providers = config?.providers ?? DEFAULT_PROVIDERS;
  if (!providers.includes(provider)) return { peak: false, endMinute: null, source: "provider" };

  const models = await loadCatalog(config?.modelsUrl ?? DEFAULT_MODELS_URL);
  if (models) {
    const entry = models.get(bareModelId(model));
    if (entry) {
      const nowMinute = now.getUTCHours() * 60 + now.getUTCMinutes();
      for (const mult of entry.multipliers) {
        if (matchesWhen(mult.when, now)) {
          return { peak: true, endMinute: windowEndMinutes(mult.when, nowMinute), source: "catalog" };
        }
      }
      return { peak: false, endMinute: null, source: "catalog" };
    }
  }

  // Catalog unavailable or model unknown: conservative fallback for Go DeepSeek.
  if (isTargetModel(model)) {
    const dow = now.getUTCDay();
    const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
    if (dow !== 0 && dow !== 6) {
      for (const w of FALLBACK_WINDOWS) {
        if (minute >= w.start && minute < w.end) {
          return { peak: true, endMinute: w.end, source: "fallback" };
        }
      }
    }
  }
  return { peak: false, endMinute: null, source: "fallback" };
}

function blockMessage(provider, model, endMinute) {
  const now = new Date();
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const remain = endMinute === null ? null : Math.max(1, endMinute - nowMin);
  return [
    `[PEAK GUARD] ${model} はピーク時間のため停止（単価倍増）`,
    `  provider: ${provider}`,
    `  ピーク: 平日 10:00-13:00 / 15:00-19:00 JST (UTC 01-04, 06-10)`,
    ...(remain === null ? [] : [`  このピーク残り: 約${remain}分`]),
    `  1時間だけ解除: ~/.config/opencode/bin/deepseek-peak off`,
    `  再ブロック: ~/.config/opencode/bin/deepseek-peak on`,
  ].join("\n");
}

/** Graceful block: emit a terminal error finish instead of throwing (throwing kills the dsh process). */
function blockedStream(message) {
  return (async function* () {
    yield {
      type: "finish",
      reason: { kind: "error", failure: { message, code: "PEAK_GUARD", status: 429 } },
    };
  })();
}

export function apply(ctx, config = {}) {
  // Must return an AsyncIterable synchronously: an async listener would yield a
  // Promise and the runtime rejects it as "stream is not async iterable".
  ctx.on("llm/stream", (options, next) => {
    const provider = String(options?.provider ?? "");
    const model = String(options?.model ?? "");

    return (async function* () {
      if (!provider || !model) {
        yield* next();
        return;
      }

      const state = await peakState(provider, model, config);
      if (!state.peak) {
        yield* next();
        return;
      }

      const until = bypassUntil();
      if (until > Date.now()) {
        audit("bypass", {
          provider,
          model,
          remain_min: Math.ceil((until - Date.now()) / 60000),
          source: state.source,
        });
        yield* next();
        return;
      }

      audit("blocked", { provider, model, source: state.source });
      yield* blockedStream(blockMessage(provider, model, state.endMinute));
    })();
  });

  audit("plugin_loaded", { providers: config?.providers ?? DEFAULT_PROVIDERS });
}

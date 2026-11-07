#!/usr/bin/env node
// dsh-peak — manual bypass for dsh-deepseek-peak-guard.
//
//   dsh-peak off [minutes]   default 60, range 1-240
//   dsh-peak on
//   dsh-peak status
//
// The bypass file is shared with the OpenCode guard by default:
//   ~/.opencode/deepseek_peak_bypass.json   { "until": <epoch ms>, ... }
// Override with DSH_PEAK_BYPASS=/path/to/file.json.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const statePath =
  process.env.DSH_PEAK_BYPASS ||
  path.join(os.homedir(), ".opencode", "deepseek_peak_bypass.json");

const cmd = process.argv[2] ?? "status";
const rawMinutes = process.argv[3] ?? "60";

function peakNow(date = new Date()) {
  const d = date.getUTCDay();
  if (d === 0 || d === 6) return false;
  const h = date.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

function peakEnd(date = new Date()) {
  if (!peakNow(date)) return null;
  const end = new Date(date.getTime());
  end.setUTCMinutes(0, 0, 0);
  end.setUTCHours(date.getUTCHours() < 4 ? 4 : 10);
  return end;
}

function until() {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (raw && typeof raw === "object" && Number.isFinite(raw.until)) return Number(raw.until);
  } catch {
    // missing or corrupt -> no bypass
  }
  return 0;
}

function fmt(date) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

if (cmd === "off") {
  if (!/^\d+$/.test(rawMinutes)) {
    console.error("ERROR: minutes must be 1-240");
    process.exit(1);
  }
  const minutes = Number(rawMinutes);
  if (minutes < 1 || minutes > 240) {
    console.error("ERROR: minutes must be 1-240");
    process.exit(1);
  }
  const untilMs = Date.now() + minutes * 60 * 1000;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      until: untilMs,
      minutes,
      set_at: new Date().toISOString(),
      source: "dsh-peak",
    }) + "\n",
    { mode: 0o600 }
  );
  console.log(`BYPASS ON: ${minutes}min (until ${fmt(new Date(untilMs))} JST)`);
} else if (cmd === "on") {
  fs.rmSync(statePath, { force: true });
  console.log("BYPASS OFF: peak block restored");
} else if (cmd === "status") {
  const u = until();
  if (u > Date.now()) {
    console.log(`BYPASS: ON (remain ${Math.ceil((u - Date.now()) / 60000)}min, until ${fmt(new Date(u))} JST)`);
  } else {
    console.log("BYPASS: OFF");
  }
  const end = peakEnd();
  if (end) {
    console.log(`PEAK: YES (remain ${Math.max(1, Math.ceil((end.getTime() - Date.now()) / 60000))}min)`);
  } else {
    console.log("PEAK: no (off-peak / weekend)");
  }
  console.log(`state: ${statePath}`);
} else {
  console.error("usage: dsh-peak {off [1-240]|on|status}");
  process.exit(1);
}

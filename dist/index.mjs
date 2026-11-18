#!/usr/bin/env node
// Lake GitHub Action 0.3.0 (lake/plan-approval). Built from lake-gate 0.3.0. Copyright (c) 2026 Lake. All rights reserved. See LICENSE.

// src/action.js
import fs from "node:fs";

// src/config-core.js
var DEFAULT_CONFIG = {
  requiredApprovals: 1,
  allowedAssociations: ["OWNER", "MEMBER", "COLLABORATOR"],
  ignoreLogins: [],
  requirePlan: "warn",
  // PR check when code changes without a plan: "off" | "warn" | "fail"
  gateWithoutPlan: false,
  // true: block agent edits until there is a plan at all (strict teams)
  try: false,
  // trial mode (`init --try`): `lake-gate approve` self-approves locally; never counts on the PR
  localGate: "block",
  // Claude Code hook: "block" | "ask" | "off"
  gatedTools: ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"],
  readOnlyBash: [
    "^\\s*(ls|pwd|cat|head|tail|wc|rg|grep|find|tree|file|stat|which|echo|env|date|du|df)(\\s|$)",
    "^\\s*git\\s+(status|log|diff|show|branch|remote|rev-parse|ls-files|blame|fetch)(\\s|$)",
    "^\\s*(npx\\s+(-y\\s+)?)?lake-gate(@\\S+)?\\s+(status|estimate|check|sync|plan|help)(\\s|$)"
  ],
  nativeReviews: true,
  // GitHub "Review changes → Approve / Request changes" counts for the plan version at the reviewed commit
  reviewUrl: "https://getlake.dev/lake-gate/app/",
  // Lake review UI linked from the PR summary ("" to hide the buttons)
  checkButtons: false,
  // experimental: Approve / Request changes buttons on a GitHub check run (needs checks: write)
  autoApprove: { mode: "on", maxUsd: 1.5, maxSteps: 3, maxComplexity: "low", maxCodeLines: 150 },
  // tiny plans with a small diff pass without a human. mode: "off" | "shadow" | "on"
  // Budget approval: above approverAbove (USD, upper estimate or the plan's "Budget cap") one of approvers
  // must approve the exact version too. List GitHub logins, e.g. ["alice", "bob"]. "@org/team" needs a token with
  // read:org, which the default Action token doesn't have (lake-gate then warns and lets repo admins approve).
  budget: { approverAbove: null, approvers: [], suggestAbove: 0, suggestCapAbove: 10 },
  catalog: {},
  // extra models in lake-meter's prices.json shape, e.g. { "my-model": { "label": "My model", "tier": "standard", "input": 1, "cacheRead": 0.1, "output": 5 } }
  provider: "anthropic"
  // model family for Lake's picks: "anthropic" | "openai". Prices: lake-meter's table (meter-core.js)
};
function isObj(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}
function merge(base, over) {
  if (!isObj(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}
function stripJsonc(text) {
  let out = "";
  let i = 0;
  let inStr = false;
  const s = String(text).replace(/^\uFEFF/, "");
  while (i < s.length) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += s[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && s[i + 1] === "/") {
      while (i < s.length && s[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && s[i + 1] === "*") {
      out += "  ";
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) {
        out += s[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  let res = "";
  inStr = false;
  for (let j = 0; j < out.length; j++) {
    const c = out[j];
    if (inStr) {
      res += c;
      if (c === "\\") {
        res += out[j + 1] ?? "";
        j++;
      } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      res += c;
      continue;
    }
    if (c === ",") {
      let k = j + 1;
      while (k < out.length && /\s/.test(out[k])) k++;
      if (out[k] === "}" || out[k] === "]") {
        res += " ";
        continue;
      }
    }
    res += c;
  }
  return res;
}
var ConfigError = class extends Error {
};
function parseConfig(text, file = ".lake/config.json") {
  if (!text || !String(text).trim()) return DEFAULT_CONFIG;
  const clean2 = stripJsonc(text);
  let data;
  try {
    data = JSON.parse(clean2);
  } catch (e) {
    const m = String(e.message).match(/position (\d+)/);
    const pos = m ? Number(m[1]) : null;
    const where = pos == null ? "" : (() => {
      const before = clean2.slice(0, pos).split("\n");
      return ` (line ${before.length}, column ${before.at(-1).length + 1})`;
    })();
    throw new ConfigError(`${file} is not valid JSON${where}: ${String(e.message).replace(/ in JSON at position \d+.*$/, "").replace(/\s*\(line \d+ column \d+\)$/, "")}`);
  }
  if (!isObj(data)) throw new ConfigError(`${file} must contain a JSON object ({ ... }).`);
  return merge(DEFAULT_CONFIG, data);
}
var STRICT_FALLBACK = { ...DEFAULT_CONFIG, autoApprove: { ...DEFAULT_CONFIG.autoApprove, mode: "off" } };
function safeParseConfig(text, file) {
  try {
    return parseConfig(text, file);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return { ...STRICT_FALLBACK, configError: e.message, policyBroken: true };
  }
}
function withLastValid(broken, lastText, from) {
  if (!broken.configError || lastText == null) return broken;
  try {
    return { ...parseConfig(lastText), configError: broken.configError, policyFrom: from };
  } catch {
    return broken;
  }
}
function configWarning(c) {
  if (!c?.configError) return null;
  return c.policyFrom ? `${c.configError}. lake-gate keeps the last valid policy (${c.policyFrom}) until it's fixed.` : `${c.configError}. No earlier valid version found, so lake-gate fails closed: nothing auto-approves and the PR check stays red until it's fixed.`;
}

// src/sha256.js
var K = new Uint32Array([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
function sha256Hex(str) {
  const bytes = new TextEncoder().encode(String(str));
  const len = bytes.length;
  const total = len + 9 + 63 >> 6 << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 128;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor(len / 536870912));
  dv.setUint32(total - 4, len << 3 >>> 0);
  const H = new Uint32Array([1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225]);
  const W = new Uint32Array(64);
  const rot = (x, n) => x >>> n | x << 32 - n;
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a2 = W[i - 15], b2 = W[i - 2];
      W[i] = W[i - 16] + (rot(a2, 7) ^ rot(a2, 18) ^ a2 >>> 3) + W[i - 7] + (rot(b2, 17) ^ rot(b2, 19) ^ b2 >>> 10) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = h + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + (e & f ^ ~e & g) + K[i] + W[i] >>> 0;
      const t2 = (rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + (a & b ^ a & c ^ b & c) >>> 0;
      h = g;
      g = f;
      f = e;
      e = d + t1 >>> 0;
      d = c;
      c = b;
      b = a;
      a = t1 + t2 >>> 0;
    }
    H[0] += a;
    H[1] += b;
    H[2] += c;
    H[3] += d;
    H[4] += e;
    H[5] += f;
    H[6] += g;
    H[7] += h;
  }
  return [...H].map((x) => x.toString(16).padStart(8, "0")).join("");
}

// src/plan.js
var EST_START = "<!-- lake:estimate:start (generated, not part of the approved digest) -->";
var EST_END = "<!-- lake:estimate:end -->";
function splitFrontmatter(text) {
  const t = String(text).replace(/\r\n?/g, "\n");
  const m = t.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: t };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^"(.*)"$/, "$1");
  }
  return { meta, body: t.slice(m[0].length) };
}
function stripEstimate(body) {
  const s = body.indexOf(EST_START);
  if (s === -1) return body;
  const e = body.indexOf(EST_END, s);
  return e === -1 ? body.slice(0, s) : body.slice(0, s) + body.slice(e + EST_END.length);
}
function normalizeBody(body) {
  return stripEstimate(body).replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/\s+$/, "")).join("\n").trim() + "\n";
}
function digestOf(body) {
  return sha256Hex(normalizeBody(body));
}
function titleOf(body) {
  const h = body.match(/^#\s+(.+)$/m);
  if (h) return h[1].trim();
  const first = body.split("\n").find((l) => l.trim());
  return (first || "Untitled plan").replace(/^[#>*\-\s]+/, "").slice(0, 80);
}
function readPlanText(text, fallbackId) {
  const { meta, body } = splitFrontmatter(text);
  const digest = digestOf(body);
  return { id: meta.id || fallbackId, title: meta.title || titleOf(body), meta, body, digest, short: digest.slice(0, 8) };
}
var forEstimator = (body) => normalizeBody(body).replace(/^(#{1,6}\s.*)\n(?=\S)/gm, "$1\n\n");

// src/meter-core.js
var PRICES = {
  "$comment": "Lake Meter price and model table. Edit this one file when list prices change. Prices are USD per 1M tokens, standard (non-batch, non-fast, global) API list prices.",
  "verifiedAt": "2026-11-12",
  "sources": {
    "anthropic": "https://platform.claude.com/docs/en/about-claude/pricing",
    "openai": "https://developers.openai.com/api/docs/pricing",
    "claudeCodeAliases": "https://code.claude.com/docs/en/model-config"
  },
  "models": {
    "claude-haiku-5-5": {
      "provider": "anthropic",
      "label": "Haiku 5.5",
      "tier": "light",
      "alias": "haiku",
      "match": [
        "haiku-5-5",
        "haiku-5.5"
      ],
      "input": 0.1,
      "cacheWrite5m": 0.125,
      "cacheWrite1h": 0.2,
      "cacheRead": 0.01,
      "output": 0.5,
      "longContext": {
        "overPromptTokens": 1e5,
        "input": 0.5,
        "cacheWrite5m": 0.625,
        "cacheWrite1h": 1,
        "cacheRead": 0.05,
        "output": 2.5
      }
    },
    "claude-haiku-4-5": {
      "provider": "anthropic",
      "label": "Haiku 4.5",
      "tier": "light",
      "match": [
        "haiku-4-5",
        "haiku-4.5"
      ],
      "input": 1,
      "cacheWrite5m": 1.25,
      "cacheWrite1h": 2,
      "cacheRead": 0.1,
      "output": 5
    },
    "claude-sonnet-5-5": {
      "provider": "anthropic",
      "label": "Sonnet 5.5",
      "tier": "standard",
      "alias": "sonnet",
      "match": [
        "sonnet-5-5",
        "sonnet-5.5"
      ],
      "input": 2,
      "cacheWrite5m": 2.5,
      "cacheWrite1h": 4,
      "cacheRead": 0.1,
      "output": 10
    },
    "claude-sonnet-5": {
      "provider": "anthropic",
      "label": "Sonnet 5",
      "tier": "standard",
      "match": [
        "sonnet-5"
      ],
      "input": 2,
      "cacheWrite5m": 2.5,
      "cacheWrite1h": 4,
      "cacheRead": 0.2,
      "output": 10
    },
    "claude-sonnet-4-6": {
      "provider": "anthropic",
      "label": "Sonnet 4.6",
      "tier": "standard",
      "match": [
        "sonnet-4-6",
        "sonnet-4.6",
        "sonnet-4-5",
        "sonnet-4.5"
      ],
      "input": 3,
      "cacheWrite5m": 3.75,
      "cacheWrite1h": 6,
      "cacheRead": 0.3,
      "output": 15
    },
    "claude-opus-5-5": {
      "provider": "anthropic",
      "label": "Opus 5.5",
      "tier": "heavy",
      "alias": "opus",
      "match": [
        "opus-5-5",
        "opus-5.5"
      ],
      "input": 4,
      "cacheWrite5m": 5,
      "cacheWrite1h": 8,
      "cacheRead": 0.2,
      "output": 20
    },
    "claude-opus-5": {
      "provider": "anthropic",
      "label": "Opus 5",
      "tier": "heavy",
      "match": [
        "opus-5",
        "opus-4-8",
        "opus-4-7",
        "opus-4-6",
        "opus-4-5"
      ],
      "input": 5,
      "cacheWrite5m": 6.25,
      "cacheWrite1h": 10,
      "cacheRead": 0.5,
      "output": 25
    },
    "claude-fable-5-2": {
      "provider": "anthropic",
      "label": "Fable 5.2",
      "tier": "frontier",
      "alias": "fable",
      "match": [
        "fable-5-2",
        "fable-5.2",
        "mythos-5-2"
      ],
      "input": 8,
      "cacheWrite5m": 10,
      "cacheWrite1h": 16,
      "cacheRead": 0.2,
      "output": 40
    },
    "claude-fable-5-1": {
      "provider": "anthropic",
      "label": "Fable 5.1",
      "tier": "frontier",
      "match": [
        "fable-5-1",
        "fable-5.1",
        "mythos-5-1"
      ],
      "input": 10,
      "cacheWrite5m": 12.5,
      "cacheWrite1h": 20,
      "cacheRead": 0.25,
      "output": 50
    },
    "gpt-6-luna": {
      "provider": "openai",
      "label": "GPT-6 Luna",
      "tier": "light",
      "match": [
        "gpt-6-luna"
      ],
      "input": 0.1,
      "cacheWrite5m": 0.125,
      "cacheRead": 0.01,
      "output": 0.5,
      "longContext": {
        "overPromptTokens": 272e3,
        "input": 0.2,
        "cacheWrite5m": 0.25,
        "cacheRead": 0.02,
        "output": 0.75
      }
    },
    "gpt-6.1-terra": {
      "provider": "openai",
      "label": "GPT-6.1 Terra",
      "tier": "standard",
      "match": [
        "gpt-6.1-terra",
        "gpt-6-1-terra"
      ],
      "input": 1,
      "cacheWrite5m": 1.25,
      "cacheRead": 0.05,
      "output": 5,
      "longContext": {
        "overPromptTokens": 272e3,
        "input": 2,
        "cacheWrite5m": 2.5,
        "cacheRead": 0.1,
        "output": 7.5
      }
    },
    "gpt-6.1-sol": {
      "provider": "openai",
      "label": "GPT-6.1 Sol",
      "tier": "heavy",
      "match": [
        "gpt-6.1-sol",
        "gpt-6-1-sol"
      ],
      "input": 2,
      "cacheWrite5m": 2.5,
      "cacheRead": 0.1,
      "output": 10,
      "longContext": {
        "overPromptTokens": 272e3,
        "input": 4,
        "cacheWrite5m": 5,
        "cacheRead": 0.2,
        "output": 15
      }
    },
    "gpt-6-astra": {
      "provider": "openai",
      "label": "GPT-6 Astra",
      "tier": "frontier",
      "match": [
        "gpt-6-astra"
      ],
      "input": 10,
      "cacheWrite5m": 12.5,
      "cacheRead": 1,
      "output": 50,
      "longContext": {
        "overPromptTokens": 272e3,
        "input": 20,
        "cacheWrite5m": 25,
        "cacheRead": 2,
        "output": 75
      }
    },
    "gpt-5.3-codex": {
      "provider": "openai",
      "label": "GPT-5.3 Codex",
      "tier": "standard",
      "match": [
        "gpt-5.3-codex",
        "gpt-5-3-codex"
      ],
      "input": 1.75,
      "cacheRead": 0.175,
      "output": 14
    },
    "gpt-5-mini": {
      "provider": "openai",
      "label": "GPT-5 mini",
      "tier": "light",
      "match": [
        "gpt-5-mini"
      ],
      "input": 0.25,
      "cacheRead": 0.025,
      "output": 2
    }
  },
  "recommend": {
    "anthropic": {
      "light": "claude-haiku-5-5",
      "standard": "claude-sonnet-5-5",
      "heavy": "claude-opus-5-5",
      "frontier": "claude-fable-5-2"
    },
    "openai": {
      "light": "gpt-6-luna",
      "standard": "gpt-6.1-terra",
      "heavy": "gpt-6.1-sol",
      "frontier": "gpt-6-astra"
    }
  },
  "baseline": {
    "anthropic": "claude-opus-5-5",
    "openai": "gpt-6.1-sol"
  },
  "familyFallback": {
    "haiku": "claude-haiku-5-5",
    "sonnet": "claude-sonnet-5-5",
    "opus": "claude-opus-5-5",
    "fable": "claude-fable-5-2",
    "mythos": "claude-fable-5-2"
  },
  "assumptions": {
    "$comment": "Heuristic token budgets per plan step by complexity (1-5). 'input' counts all prompt tokens processed across the step's agent turns, including cache reads. Tune these from your own `lake-meter report` history.",
    "stepTokens": {
      "1": {
        "input": [
          3e4,
          12e4
        ],
        "output": [
          1e3,
          4e3
        ]
      },
      "2": {
        "input": [
          8e4,
          3e5
        ],
        "output": [
          3e3,
          1e4
        ]
      },
      "3": {
        "input": [
          25e4,
          9e5
        ],
        "output": [
          8e3,
          25e3
        ]
      },
      "4": {
        "input": [
          7e5,
          25e5
        ],
        "output": [
          2e4,
          6e4
        ]
      },
      "5": {
        "input": [
          15e5,
          6e6
        ],
        "output": [
          4e4,
          15e4
        ]
      }
    },
    "inputMix": {
      "uncached": 0.05,
      "cacheWrite": 0.1,
      "cacheRead": 0.85
    },
    "avgPromptTokens": 6e4,
    "tierTokenMultiplier": {
      "light": 1.3,
      "standard": 1.1,
      "heavy": 1,
      "frontier": 1
    },
    "complexityToTier": {
      "1": "light",
      "2": "light",
      "3": "standard",
      "4": "heavy",
      "5": "heavy"
    }
  }
};
var SKIP_HEADINGS = /^(context|background|overview|summary|goal|goals|notes?|open questions?|assumptions|out of scope|non-goals|references|tl;?dr|why|problem|motivation)\b/i;
function splitPlan(markdown) {
  const text = String(markdown || "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const heads = [];
  lines.forEach((l, i) => {
    const m = /^(#{2,4})\s+(.*)$/.exec(l);
    if (m) heads.push({ i, level: m[1].length, title: m[2].trim() });
  });
  const CONTAINER = /^(steps?|plan|implementation( plan)?|tasks?|changes|approach|proposed changes|work items?)\b/i;
  const stepLike = (h) => !SKIP_HEADINGS.test(h.title.replace(/^(step|phase|part)?\s*\d+[.:)]?\s*/i, "")) && !CONTAINER.test(h.title);
  const byLevel = {};
  for (const h of heads) if (stepLike(h)) (byLevel[h.level] ||= []).push(h);
  const levels = Object.keys(byLevel).map(Number).sort((a, b) => byLevel[b].length - byLevel[a].length || b - a);
  if (levels.length && byLevel[levels[0]].length >= 2) {
    const level = levels[0];
    return byLevel[level].map((h) => {
      const next = heads.find((x) => x.i > h.i && x.level <= level);
      const body = lines.slice(h.i + 1, next ? next.i : lines.length).join("\n").trim();
      return { title: clean(h.title), body };
    });
  }
  for (const re of [/^(\d+)[.)]\s+(.*)$/, /^[-*]\s+\[[ xX]\]\s+(.*)$/, /^[-*]\s+(.*)$/]) {
    const items = [];
    let cur = null;
    for (const l of lines) {
      const m = re.exec(l);
      if (m) {
        cur = { title: clean(m[m.length - 1]), body: "" };
        items.push(cur);
        continue;
      }
      if (cur && (/^\s+\S/.test(l) || l.trim() === "")) {
        cur.body += l.trim() ? l.trim() + "\n" : "";
        continue;
      }
      if (cur && /^#{1,6}\s/.test(l)) cur = null;
      else if (cur && l.trim()) cur = null;
    }
    if (items.length >= 2) return items.map((s) => ({ title: s.title, body: s.body.trim() }));
  }
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p && !/^#\s/.test(p));
  return paras.slice(0, 30).map((p) => ({ title: clean(p.split("\n")[0]).slice(0, 90), body: p }));
}
function clean(s) {
  return s.replace(/^(step|phase|part)\s*\d+\s*[.:)\-–—]\s*/i, "").replace(/^\d+[.)]\s*/, "").replace(/\*\*|__|`/g, "").trim();
}
var SIGNALS = [
  // [regex, weight, reason]
  [/\b(architect\w*|redesign|re-?architect|system design)\b/i, 2, "architecture"],
  [/\b(migrat\w+|schema change|data model|backfill)\b/i, 2, "data/schema migration"],
  [/\b(concurren\w+|race condition|deadlock|lock(ing)?|distributed|consisten\w+|idempoten\w+|transaction\w*)\b/i, 2, "concurrency/consistency"],
  [/\b(security|auth\w*|permission\w*|encrypt\w*|secret\w*|oauth|csrf|xss|injection)\b/i, 2, "security-sensitive"],
  [/\b(payment\w*|billing|invoice\w*|money)\b/i, 1, "money paths"],
  [/\b(performance|optimi[sz]\w+|latency|memory leak|profil\w+)\b/i, 1, "performance work"],
  [/\b(refactor\w*|restructur\w+|rewrite)\b/i, 1, "refactor"],
  [/\b(algorithm\w*|parser|compiler|protocol|state machine)\b/i, 2, "algorithmic"],
  [/\b(debug\w*|investigat\w+|root cause|flaky|intermittent)\b/i, 1, "debugging/unknowns"],
  [/\b(across|cross-cutting|every (file|module|service)|monorepo|multiple services)\b/i, 1, "cross-cutting"],
  [/\b(implement\w*|integrat\w+|endpoint|api|component|service|hook|middleware|query|cache|websocket|queue)\b/i, 1, "new behavior"],
  [/\b(rename|typo|readme|docs?|documentation|comment\w*|changelog|format\w*|lint\w*|prettier|bump|version|copy|wording|text|label)\b/i, -1, "mechanical/docs"],
  [/\b(config\w*|env(ironment)? var\w*|flag|constant|stub|scaffold\w*|boilerplate|placeholder)\b/i, -1, "config/boilerplate"],
  [/\b(delete|remove unused|cleanup|clean up|dead code)\b/i, -1, "cleanup"]
];
function scoreStep(step) {
  const text = `${step.title}
${step.body || ""}`;
  let score = 0;
  const reasons = [];
  for (const [re, w, why] of SIGNALS) if (re.test(text)) {
    score += w;
    reasons.push(`${w > 0 ? "+" : ""}${w} ${why}`);
  }
  const files = new Set(text.match(/[\w@./-]+\.(ts|tsx|js|jsx|mjs|py|go|rs|java|kt|rb|php|cs|swift|sql|vue|svelte|css|scss|json|yaml|yml|md)\b/g) || []);
  if (files.size >= 6) {
    score += 2;
    reasons.push(`+2 touches ${files.size} files`);
  } else if (files.size >= 3) {
    score += 1;
    reasons.push(`+1 touches ${files.size} files`);
  }
  if (text.length > 900) {
    score += 1;
    reasons.push("+1 long step description");
  }
  const complexity = Math.max(1, Math.min(5, Math.round(2 + score * 0.75)));
  if (!reasons.length) reasons.push("no strong signals (default 2)");
  return { complexity, reasons };
}
function analyzePlan(markdown, prices, options = {}) {
  const provider = options.provider || "anthropic";
  const rec = prices.recommend[provider];
  const baseline = options.baseline || prices.baseline[provider];
  const a = prices.assumptions;
  const steps = splitPlan(markdown).map((s, idx) => {
    const { complexity, reasons } = scoreStep(s);
    let tier = a.complexityToTier[String(complexity)];
    if (complexity === 5 && options.allowFrontier) tier = "frontier";
    const model = rec[tier];
    const budget = a.stepTokens[String(complexity)];
    const mult = a.tierTokenMultiplier[tier] ?? 1;
    const tokLo = Math.round((budget.input[0] + budget.output[0]) * mult);
    const tokHi = Math.round((budget.input[1] + budget.output[1]) * mult);
    const usdLo = costOfBudget(model, budget.input[0] * mult, budget.output[0] * mult, prices);
    const usdHi = costOfBudget(model, budget.input[1] * mult, budget.output[1] * mult, prices);
    const baseLo = costOfBudget(baseline, budget.input[0], budget.output[0], prices);
    const baseHi = costOfBudget(baseline, budget.input[1], budget.output[1], prices);
    return { n: idx + 1, title: s.title, complexity, reasons, tier, model, modelLabel: prices.models[model].label, alias: prices.models[model].alias || model, tokens: [tokLo, tokHi], usd: [usdLo, usdHi], baselineUsd: [baseLo, baseHi] };
  });
  const sum = (k, i) => steps.reduce((t, s) => t + s[k][i], 0);
  const total = { tokens: [sum("tokens", 0), sum("tokens", 1)], usd: [sum("usd", 0), sum("usd", 1)], baselineUsd: [sum("baselineUsd", 0), sum("baselineUsd", 1)] };
  const mid = (r) => (r[0] + r[1]) / 2;
  total.savingsPct = mid(total.baselineUsd) > 0 ? Math.round((1 - mid(total.usd) / mid(total.baselineUsd)) * 100) : 0;
  return { provider, baseline, baselineLabel: prices.models[baseline].label, steps, total, pricesVerifiedAt: prices.verifiedAt, estimate: true };
}
function normalizeModelId(id) {
  return String(id || "").toLowerCase().replace(/\[.*?\]/g, "").replace(/^.*\//, "").replace(/\./g, "-").trim();
}
function resolveModel(rawId, prices) {
  if (!rawId) return null;
  const id = normalizeModelId(rawId);
  if (prices.models[rawId]) return rawId;
  let best = null, bestLen = 0;
  for (const [key, m] of Object.entries(prices.models)) {
    for (const token of [key, ...m.match || []]) {
      const t = normalizeModelId(token);
      if (id.includes(t) && t.length > bestLen) {
        best = key;
        bestLen = t.length;
      }
    }
    if (m.alias && id === m.alias) return key;
  }
  if (best) return best;
  for (const [fam, key] of Object.entries(prices.familyFallback || {})) if (id.includes(fam)) return key;
  return null;
}
function rate(m, field, promptTokens) {
  const lc = m.longContext;
  const src = lc && promptTokens > lc.overPromptTokens ? lc : m;
  const v = src[field] ?? m[field];
  if (v != null) return v;
  if (field === "cacheWrite1h") return (src.input ?? m.input) * 2;
  if (field === "cacheWrite5m") return (src.input ?? m.input) * 1.25;
  if (field === "cacheRead") return (src.input ?? m.input) * 0.1;
  return 0;
}
function costOfBudget(modelKey, inputTokens, outputTokens, prices) {
  const m = prices.models[modelKey];
  const a = prices.assumptions;
  const mix = a.inputMix;
  const p = a.avgPromptTokens;
  return (inputTokens * (mix.uncached * rate(m, "input", p) + mix.cacheWrite * rate(m, "cacheWrite5m", p) + mix.cacheRead * rate(m, "cacheRead", p)) + outputTokens * rate(m, "output", p)) / 1e6;
}

// src/models.js
var QUALITY = { light: 2, standard: 3, heavy: 4, frontier: 5 };
var NEED_LEVEL = { 1: 2, 2: 2, 3: 3, 4: 4, 5: 4 };
var NEED = { low: 2, medium: 3, high: 4 };
var need = (s) => NEED_LEVEL[s.level] ?? NEED[s.complexity];
var TIER_ALIAS = { fast: "light", light: "light", balanced: "standard", standard: "standard", frontier: "heavy", heavy: "heavy", max: "frontier" };
function catalogOf(config) {
  const prices = pricesFor(config);
  const out = {};
  for (const [k, m] of Object.entries(prices.models)) out[k] = { ...m, name: m.label || k, quality: m.quality ?? QUALITY[m.tier] ?? 3 };
  return out;
}
var norm = (s) => String(s || "").toLowerCase().replace(/[`*_]/g, "").replace(/^claude[\s-]+/, "").trim();
function resolveModel2(text, config) {
  const q = norm(text);
  if (!q) return null;
  const prices = pricesFor(config);
  const cat = catalogOf(config);
  const hit = (k) => k && cat[k] ? { key: k, ...cat[k] } : null;
  if (cat[text]) return hit(text);
  if (TIER_ALIAS[q]) return hit(prices.recommend[config.provider || "anthropic"][TIER_ALIAS[q]]);
  for (const [k, m] of Object.entries(cat)) if (norm(m.name) === q || norm(m.alias) === q) return hit(k);
  return hit(resolveModel(q.replace(/\s+/g, "-"), prices));
}
function recommendedKey(level, config) {
  const prices = pricesFor(config);
  const lv = typeof level === "number" ? level : { low: 2, medium: 3, high: 4 }[level] || 3;
  return prices.recommend[config.provider || "anthropic"][prices.assumptions.complexityToTier[String(lv)]];
}
function stepUsd(s, key, prices) {
  const b = prices.assumptions.stepTokens[String(s.level)] || prices.assumptions.stepTokens["3"];
  const mult = prices.assumptions.tierTokenMultiplier[prices.models[key].tier] ?? 1;
  return [0, 1].map((i) => costOfBudget(key, b.input[i] * mult, b.output[i] * mult, prices));
}
var PLAN_MODEL = /^\s*(?:[-*>]\s*)?(?:\*\*)?(?:agent\s*[^\n]*?·\s*)?model(?:\*\*)?\s*:(?:\*\*)?\s*(.+?)\s*$/im;
var STEP_MODEL = /\s*[([]\s*model\s*:\s*([^)\]]+)[)\]]/i;
var CAP = /^\s*(?:[-*>]\s*)?(?:\*\*)?budget\s*cap(?:\*\*)?\s*:(?:\*\*)?\s*\$?\s*([\d.,]+)/im;
var OPTIONAL = /\((?:optional|nice to have)\)|\boptional:/i;
function declarations(body) {
  const b = stripEstimate(String(body));
  const pm = b.match(PLAN_MODEL);
  const cap = b.match(CAP);
  return { model: pm ? pm[1].replace(/\*+$/, "").trim() : null, cap: cap ? Number(cap[1].replace(/,/g, "")) : null };
}
function stepModelTag(text) {
  const m = String(text).match(STEP_MODEL);
  return m ? m[1].trim() : null;
}
var isOptionalStep = (text) => OPTIONAL.test(String(text));
function applyDeclarations(est, body, config) {
  const d = declarations(body);
  const planModel = d.model ? resolveModel2(d.model, config) : null;
  const notes = [];
  if (d.model && !planModel) notes.push(`Unknown model "${d.model}". Add it to "catalog" in .lake/config.json to price it.`);
  const prices = pricesFor(config);
  const cat = catalogOf(config);
  const raw = splitPlan(forEstimator(body)).map((x) => ({ text: `${x.title}
${x.body || ""}` }));
  const steps = est.steps.map((s, i) => {
    const tag = stepModelTag(raw[i]?.text || "");
    const tagged = tag ? resolveModel2(tag, config) : null;
    if (tag && !tagged) notes.push(`Step ${s.n}: unknown model "${tag}".`);
    const m = tagged || planModel;
    const rec = s.modelKey || recommendedKey(s.level, config);
    const planned = m ? { key: m.key, name: m.name, quality: m.quality, usd: stepUsd(s, m.key, prices), source: tagged ? "step" : "plan" } : null;
    const fit = !m ? "ok" : m.quality < need(s) ? "risky" : m.quality > (cat[rec]?.quality ?? 9) ? "overkill" : "ok";
    return { ...s, recommendedKey: rec, planned, fit, optional: isOptionalStep(raw[i]?.text || ""), title: s.title.replace(STEP_MODEL, "").trim() };
  });
  const sum = (i) => steps.reduce((a, s) => a + (s.planned ? s.planned.usd[i] : s.usd[i]), 0);
  const plannedUsd = [sum(0), sum(1)];
  const declared = steps.some((s) => s.planned);
  const exposure = d.cap != null ? Math.min(d.cap, plannedUsd[1]) : plannedUsd[1];
  return { ...est, steps, model: planModel ? { key: planModel.key, name: planModel.name } : null, declared, plannedUsd, cap: d.cap, exposure, modelNotes: notes };
}
function costSuggestions(est, config) {
  const b = config.budget || {};
  const out = [];
  const cat = catalogOf(config);
  const over = est.steps.filter((s) => s.planned && s.planned.quality > cat[s.recommendedKey].quality);
  if (over.length) {
    const saving = [0, 1].map((i) => over.reduce((a, s) => a + s.planned.usd[i] - s.usd[i], 0));
    out.push({
      id: `models-${over.map((s) => s.n).join("-")}`,
      kind: "model",
      title: over.length === 1 ? `Run step ${over[0].n} on ${cat[over[0].recommendedKey].name}` : over.length === est.steps.length ? "Use the Lake pick for each step" : `Cheaper models for ${over.length} simpler steps`,
      detail: over.map((s) => `${s.n}. ${s.title.slice(0, 40)}: ${s.planned.name} \u2192 ${cat[s.recommendedKey].name}`).join("\n"),
      saving,
      patch: { type: "stepModels", steps: over.map((s) => ({ n: s.n, title: s.title, model: cat[s.recommendedKey].name })) }
    });
  }
  for (const s of est.steps.filter((x) => x.optional)) {
    const u = s.planned ? s.planned.usd : s.usd;
    out.push({ id: `drop-${s.n}`, kind: "drop", title: `Drop optional step ${s.n}`, detail: s.title, saving: u, patch: { type: "dropStep", n: s.n, title: s.title } });
  }
  const capAbove = b.suggestCapAbove ?? 10;
  if (est.cap == null && est.plannedUsd[1] > capAbove) {
    const mid = (est.plannedUsd[0] + est.plannedUsd[1]) / 2;
    const cap = Math.max(1, Math.ceil(mid * 1.15));
    if (cap < est.plannedUsd[1]) out.push({ id: `cap-${cap}`, kind: "cap", title: `Cap the run at $${cap}`, detail: "The agent stops and asks before spending more. Budget approval looks at the cap.", saving: [0, est.plannedUsd[1] - cap], patch: { type: "cap", usd: cap } });
  }
  const min = b.suggestAbove ?? 0;
  return est.plannedUsd[1] >= min ? out.filter((s) => s.saving[1] > 5e-3) : [];
}
function budgetRule(est, config, resolvedApprovers) {
  const b = config.budget || {};
  if (b.approverAbove == null || !(b.approvers || []).length) return { required: false };
  const exposure = est.exposure ?? est.usd[1];
  const required = exposure > b.approverAbove;
  const list = resolvedApprovers || b.approvers.filter((x) => !String(x).includes("/")).map((x) => String(x).replace(/^@/, ""));
  return { required, threshold: b.approverAbove, exposure, approvers: [...new Set(list)], teams: b.approvers.filter((x) => String(x).includes("/")), unreadable: resolvedApprovers?.unreadable || [], fallback: resolvedApprovers?.fallback || null };
}

// src/estimate.js
var RANK = { low: 0, medium: 1, high: 2 };
var complexityRank = (c) => RANK[c] ?? 1;
var levelToComplexity = (n) => n <= 2 ? "low" : n === 3 ? "medium" : "high";
function pricesFor(config) {
  const extra = config.catalog || {};
  return Object.keys(extra).length ? { ...PRICES, models: { ...PRICES.models, ...extra } } : PRICES;
}
function estimatePlan(body, config) {
  const prices = pricesFor(config);
  const a = analyzePlan(forEstimator(body), prices, { provider: config.provider || "anthropic" });
  const steps = a.steps.map((s) => ({
    n: s.n,
    title: s.title.replace(/\s*[([]\s*model\s*:\s*[^)\]]+[)\]]/i, "").slice(0, 90),
    complexity: levelToComplexity(s.complexity),
    level: s.complexity,
    reasons: s.reasons,
    tier: s.tier,
    model: s.modelLabel,
    modelKey: s.model,
    tokens: prices.assumptions.stepTokens[String(s.complexity)],
    usd: s.usd,
    frontierUsd: s.baselineUsd
  }));
  const maxC = steps.reduce((m, s) => complexityRank(s.complexity) > complexityRank(m) ? s.complexity : m, "low");
  return applyDeclarations({
    steps,
    complexity: maxC,
    usd: a.total.usd,
    frontierUsd: a.total.baselineUsd,
    baseline: a.baselineLabel,
    pricesAsOf: a.pricesVerifiedAt
  }, body, config);
}
var money = (n) => n < 0.01 ? "<$0.01" : n < 0.1 ? `$${n.toFixed(3)}` : n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString("en-US")}`;
var range = ([a, b]) => b < 0.01 ? "<$0.01" : `${money(a)}\u2013${money(b)}`;
var mixedModels = (est) => !!est.declared && est.steps.some((s) => s.planned && s.planned.name !== est.model?.name);
var modelLabel = (est) => mixedModels(est) ? est.model ? ` \xB7 planned per step (default ${est.model.name})` : " \xB7 planned per step" : est.model ? ` on ${est.model.name}` : "";
var costLabel = (est) => `${range(est.declared ? est.plannedUsd : est.usd)}${modelLabel(est)}`;
function autoApproveVerdict(est, config, ctx = {}) {
  const a = config.autoApprove || {};
  if (!a.mode || a.mode === "off") return { eligible: false, mode: "off", reasons: [] };
  const reasons = [];
  if (!est.steps.length) reasons.push("no steps");
  if (ctx.gatedBefore) reasons.push("an earlier version of this plan needed a human");
  const maxLines = a.maxCodeLines ?? 150;
  if (ctx.codeLines != null && ctx.codeLines > maxLines) reasons.push(`${ctx.codeLines} changed lines of code > ${maxLines}`);
  const top = est.exposure ?? est.usd[1];
  if (top > a.maxUsd) reasons.push(`upper estimate ${money(top)} > ${money(a.maxUsd)}`);
  if (config.budget?.approverAbove != null && top > config.budget.approverAbove) reasons.push("needs budget approval");
  if (est.steps.length > a.maxSteps) reasons.push(`${est.steps.length} steps > ${a.maxSteps}`);
  if (complexityRank(est.complexity) > complexityRank(a.maxComplexity)) reasons.push(`complexity ${est.complexity} > ${a.maxComplexity}`);
  return { eligible: reasons.length === 0, mode: a.mode, reasons };
}

// src/policy.js
var CMD = /^\s*\/lake\s+(approve|reject|revoke)\b[ \t]*([^\s@]+)?(?:@([0-9a-f]{7,64}))?/gim;
function parseCommands(body) {
  const out = [];
  for (const m of String(body || "").matchAll(CMD)) out.push({ action: m[1].toLowerCase(), id: m[2] || null, digest: m[3] ? m[3].toLowerCase() : null });
  return out;
}
function evaluatePlan({ plan, estimate, events, prAuthor, config, budgetApprovers, autoContext }) {
  const approvals = /* @__PURE__ */ new Map();
  const blockers = /* @__PURE__ */ new Map();
  const assoc = /* @__PURE__ */ new Map();
  const notes = [];
  const typos = /* @__PURE__ */ new Map();
  const sorted = [...events].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  for (const ev of sorted) {
    for (const c of parseCommands(ev.body)) {
      if (c.id && c.id !== plan.id) continue;
      if (!c.id) {
        typos.set(ev.login, `@${ev.login}: "/lake ${c.action}" needs a plan id and version: /lake ${c.action} ${plan.id}@${plan.short}`);
        continue;
      }
      const who = ev.login;
      const ineligible = ev.type === "Bot" ? "bots and agents cannot approve" : prAuthor && who.toLowerCase() === prAuthor.toLowerCase() ? "the plan author cannot approve their own plan" : (config.ignoreLogins || []).some((x) => x.toLowerCase() === who.toLowerCase()) ? "listed in ignoreLogins" : !config.allowedAssociations.includes(ev.association) ? `association ${ev.association} lacks write access` : null;
      if (c.action === "revoke") {
        approvals.delete(who);
        continue;
      }
      if (ineligible) {
        notes.push(`ignored ${c.action} from @${who}: ${ineligible}`);
        continue;
      }
      const matches = c.digest && plan.digest.startsWith(c.digest);
      if (!c.digest) {
        typos.set(who, `@${who}: missing version in "/lake ${c.action} ${c.id}": use /lake ${c.action} ${plan.id}@${plan.short}`);
        continue;
      }
      typos.delete(who);
      if (!matches) {
        notes.push(`ignored ${c.action} from @${who}: ${c.digest ? `refers to version ${c.digest.slice(0, 8)}, current is ${plan.short}` : ""} (edits invalidate approval)`);
        continue;
      }
      if (c.action === "approve") {
        approvals.set(who, ev.createdAt);
        assoc.set(who, ev.association);
        blockers.delete(who);
      } else {
        blockers.set(who, ev.createdAt);
        approvals.delete(who);
      }
    }
  }
  notes.push(...typos.values());
  const auto = estimate ? autoApproveVerdict(estimate, config, autoContext) : { eligible: false, mode: "off", reasons: [] };
  const rule = estimate ? budgetRule(estimate, config, budgetApprovers) : { required: false };
  const lc = (x) => String(x).toLowerCase();
  const budgetBy = rule.required ? [...approvals.keys()].filter((a) => rule.approvers.some((b) => lc(b) === lc(a)) || rule.fallback === "owner" && assoc.get(a) === "OWNER") : [];
  const budget = rule.required ? { ...rule, approvedBy: budgetBy, satisfied: budgetBy.length > 0 } : { required: false, satisfied: true };
  let state;
  if (blockers.size) state = "changes-requested";
  else if (approvals.size >= config.requiredApprovals && budget.satisfied) state = "approved";
  else if (approvals.size >= config.requiredApprovals) state = "needs-budget";
  else if (auto.mode === "on" && auto.eligible && !budget.required) state = "auto-approved";
  else state = "pending";
  return {
    id: plan.id,
    digest: plan.digest,
    short: plan.short,
    state,
    approvers: [...approvals.keys()],
    blockers: [...blockers.keys()],
    auto,
    notes,
    budget,
    needed: Math.max(0, config.requiredApprovals - approvals.size)
  };
}
var isPassing = (r) => r.state === "approved" || r.state === "auto-approved";

// src/review.js
var MARK = /<!--\s*lake:(c|resolve|v|proxy)\s+(\{[\s\S]*?\})\s*-->/g;
var PROXY_LOGIN = "github-actions[bot]";
function encodeMarker(kind, data) {
  return `<!-- lake:${kind} ${JSON.stringify(data).replace(/--/g, "\\u002d\\u002d")} -->`;
}
function parseMarkers(body) {
  const out = [];
  for (const m of String(body || "").matchAll(MARK)) {
    try {
      out.push({ kind: m[1], data: JSON.parse(m[2]) });
    } catch {
    }
  }
  return out;
}
var shortOf = (d) => String(d || "").slice(0, 8);
var footer = (via) => `<sub>via lake-gate${via ? ` \xB7 ${via}` : ""}</sub>`;
function verdictBody({ action, planId, version, text, via, resolves = [] }) {
  const cmd = action === "approve" ? "approve" : "reject";
  return [
    `/lake ${cmd} ${planId}@${shortOf(version)}`,
    text && String(text).trim() ? `
${String(text).trim()}` : null,
    "",
    footer(via),
    via ? encodeMarker("v", { via }) : null,
    ...resolves.map((t) => encodeMarker("resolve", { p: planId, t, r: true }))
  ].filter((x) => x !== null).join("\n");
}
var NATIVE = { APPROVED: "approve", CHANGES_REQUESTED: "reject" };
function expandEvents(events, { planId, digestAt = {}, config = {} }) {
  const out = [];
  for (const ev of events) {
    if (ev.source === "line") continue;
    let e = ev;
    const proxy = parseMarkers(ev.body).find((m) => m.kind === "proxy");
    if (proxy && ev.login === PROXY_LOGIN && ev.type === "Bot" && proxy.data.by) {
      e = { ...ev, login: proxy.data.by, type: "User", association: proxy.data.assoc || "NONE", via: "GitHub check button" };
    }
    if (config.nativeReviews !== false && ev.source === "review" && NATIVE[ev.state] && !parseCommands(ev.body).length) {
      const d = ev.commitId && digestAt[ev.commitId];
      if (d) e = { ...e, body: `/lake ${NATIVE[ev.state]} ${planId}@${d}
${ev.body || ""}`, via: "GitHub review", native: true };
    }
    out.push(e);
  }
  return out;
}

// src/github.js
var STATUS_CONTEXT = "lake/plan-approval";
var MARKER = "<!-- lake-gate:summary -->";
function fromBase64(b64) {
  const bin = atob(String(b64).replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
}
var RateLimitError = class extends Error {
  constructor(reset, authed) {
    const at = reset ? new Date(reset * 1e3) : null;
    super(`GitHub API rate limit reached${authed ? "" : " (60 requests/hour without a token)"}${at ? `; it resets at ${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}` : ""}.${authed ? "" : " Connect a GitHub token to keep going."}`);
    this.reset = reset;
    this.authed = authed;
    this.rateLimited = true;
  }
};
var IMMUTABLE = /[?&](ref|sha)=[0-9a-f]{40}(&|$)/;
function client({ token, repo, api = "https://api.github.com", fetchImpl = globalThis.fetch, cache = null, freshMs = 0 }) {
  const [owner, name] = repo.split("/");
  const mem = /* @__PURE__ */ new Map();
  const stats = { requests: 0, cached: 0, notModified: 0 };
  let since = 0;
  async function req(method, url, body) {
    const full = url.startsWith("http") ? url : url.startsWith("~/") ? `${api}${url.slice(1)}` : `${api}/repos/${owner}/${name}${url}`;
    const get = method === "GET";
    const immutable = get && IMMUTABLE.test(full);
    let hit = get ? mem.get(full) || cache?.get(full) || null : null;
    if (hit && (immutable || freshMs && (hit.at || 0) > since && Date.now() - (hit.at || 0) < freshMs)) {
      stats.cached++;
      return hit.data;
    }
    stats.requests++;
    const res = await fetchImpl(full, {
      method,
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...typeof window === "undefined" ? { "User-Agent": "lake-gate" } : {}, ...token ? { Authorization: `Bearer ${token}` } : {}, ...body ? { "Content-Type": "application/json" } : {}, ...hit?.etag ? { "If-None-Match": hit.etag } : {} },
      body: body ? JSON.stringify(body) : void 0
    });
    if (res.status === 304 && hit) {
      stats.notModified++;
      hit = { ...hit, at: Date.now() + 1 };
      mem.set(full, hit);
      cache?.set(full, hit);
      return hit.data;
    }
    if (res.status === 404 && get) return null;
    if (!res.ok) {
      const text = await res.text();
      const h = (k) => res.headers?.get?.(k);
      if ((res.status === 403 || res.status === 429) && (h("x-ratelimit-remaining") === "0" || /rate limit/i.test(text))) throw new RateLimitError(Number(h("x-ratelimit-reset")) || null, !!token);
      throw new Error(`GitHub ${method} ${url} -> ${res.status} ${text}`);
    }
    const data = res.status === 204 ? null : await res.json();
    if (get) {
      const e = { data, etag: res.headers?.get?.("etag") || null, at: Date.now() + 1 };
      mem.set(full, e);
      cache?.set(full, e);
    }
    return data;
  }
  async function all(url) {
    const out = [];
    for (let page = 1; page < 50; page++) {
      const chunk = await req("GET", `${url}${url.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      if (!chunk || !chunk.length) break;
      out.push(...chunk);
      if (chunk.length < 100) break;
    }
    return out;
  }
  const useRaw = !token && api === "https://api.github.com";
  async function rawFile(p, ref) {
    const url = `https://raw.githubusercontent.com/${owner}/${name}/${encodeURIComponent(ref)}/${p.split("/").map(encodeURIComponent).join("/")}`;
    const pinned = /^[0-9a-f]{40}$/.test(ref);
    const hit = mem.get(url) || cache?.get(url);
    if (hit && (pinned || freshMs && (hit.at || 0) > since && Date.now() - hit.at < freshMs)) {
      stats.cached++;
      return hit.data;
    }
    stats.raw = (stats.raw || 0) + 1;
    const res = await fetchImpl(url, { method: "GET" });
    if (res.status === 404) {
      const e2 = { data: null, at: Date.now() + 1 };
      if (pinned) {
        mem.set(url, e2);
        cache?.set(url, e2);
      }
      return null;
    }
    if (!res.ok) throw new Error(`GitHub raw ${p}@${ref} -> ${res.status}`);
    const e = { data: await res.text(), at: Date.now() + 1 };
    mem.set(url, e);
    cache?.set(url, e);
    return e.data;
  }
  async function file(p, ref) {
    if (useRaw) {
      try {
        return await rawFile(p, ref);
      } catch {
      }
    }
    const r = await req("GET", `/contents/${p.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`);
    return r && r.content ? fromBase64(r.content) : null;
  }
  const refresh = () => {
    since = Date.now() + 2;
  };
  return { req, all, file, owner, name, repo, api, stats, refresh, authed: !!token };
}
async function collectEvents(gh, number) {
  const [comments, reviews] = await Promise.all([gh.all(`/issues/${number}/comments`), gh.all(`/pulls/${number}/reviews`)]);
  return [
    ...comments.filter((c) => !String(c.body || "").startsWith(MARKER)).map((c) => ({ login: c.user.login, type: c.user.type, association: c.author_association, body: c.body, createdAt: c.created_at, source: "comment", id: c.id })),
    ...reviews.filter((r) => r.state !== "DISMISSED").map((r) => ({ login: r.user.login, type: r.user.type, association: r.author_association, body: r.body, createdAt: r.submitted_at, source: "review", id: r.id, state: r.state, commitId: r.commit_id }))
  ];
}
var NATIVE_STATES = /* @__PURE__ */ new Set(["APPROVED", "CHANGES_REQUESTED"]);
async function nativeDigests(gh, events, path, { headSha, headText, config }) {
  const out = {};
  if (config.nativeReviews === false) return out;
  for (const ev of events) {
    if (ev.source !== "review" || !NATIVE_STATES.has(ev.state) || !ev.commitId || ev.commitId in out || parseCommands(ev.body).length) continue;
    const t = ev.commitId === headSha && headText != null ? headText : await gh.file(path, ev.commitId);
    out[ev.commitId] = t == null ? null : readPlanText(t).digest;
  }
  return out;
}
async function resolveBudgetApprovers(gh, config) {
  const b = config.budget || {};
  if (b.approverAbove == null || !(b.approvers || []).length) return void 0;
  const out = b.approvers.filter((x) => !String(x).includes("/")).map((x) => String(x).replace(/^@/, ""));
  const unreadable = [];
  for (const t of b.approvers.filter((x) => String(x).includes("/"))) {
    const [org, slug] = String(t).replace(/^@/, "").split("/");
    try {
      out.push(...(await gh.all(`~/orgs/${org}/teams/${slug}/members`)).map((u) => u.login));
    } catch {
      unreadable.push(`@${org}/${slug}`);
    }
  }
  out.unreadable = unreadable;
  if (unreadable.length) {
    try {
      out.push(...(await gh.all("/collaborators?permission=admin")).filter((u) => u.permissions?.admin !== false).map((u) => u.login));
      out.fallback = "admins";
    } catch {
      out.fallback = "owner";
    }
  }
  return out;
}
var isPlanPath = (f) => /^\.lake\/plans\/[^/]+\.md$/.test(f) && !f.endsWith("/README.md");
var isCodePath = (f) => !f.startsWith(".lake/") && !/\.(md|txt)$/i.test(f) && !f.startsWith("docs/");
var codeLinesOf = (files) => files.filter((f) => !f.filename.startsWith(".lake/")).reduce((n, f) => n + (f.additions || 0) + (f.deletions || 0), 0);
async function loadBaseConfig(gh, pr) {
  const CFG = ".lake/config.json";
  const ref = pr.base.ref;
  const text = await gh.file(CFG, ref).catch(() => null) ?? await gh.file(CFG, pr.base.sha);
  const c = safeParseConfig(text, `${CFG} on ${ref}`);
  if (!c.configError) return c;
  const hist = await gh.req("GET", `/commits?sha=${encodeURIComponent(ref)}&path=${encodeURIComponent(CFG)}&per_page=10`).catch(() => null) || [];
  for (const h of hist) {
    const r = withLastValid(c, await gh.file(CFG, h.sha).catch(() => null), `${ref} at ${h.sha.slice(0, 7)}`);
    if (r.policyFrom) return r;
  }
  return c;
}
async function gatedBefore(gh, path, pr, prCommits, config, headDigest) {
  if ((config.autoApprove?.mode || "off") === "off") return false;
  const touching = (await gh.req("GET", `/commits?sha=${encodeURIComponent(pr.head.sha)}&path=${encodeURIComponent(path)}&per_page=20`) || []).map((c) => c.sha).filter((s) => prCommits.has(s) && s !== pr.head.sha).slice(0, 10);
  for (const sha of touching) {
    const t = await gh.file(path, sha);
    if (t == null) continue;
    const p = readPlanText(t);
    if (p.digest === headDigest) continue;
    if (!autoApproveVerdict(estimatePlan(p.body, config), config).eligible) return true;
  }
  return false;
}
async function evaluatePr(gh, number) {
  const pr = await gh.req("GET", `/pulls/${number}`);
  const config = await loadBaseConfig(gh, pr);
  const files = await gh.all(`/pulls/${number}/files`);
  const planFiles = files.filter((f) => isPlanPath(f.filename) && f.status !== "removed").map((f) => f.filename);
  const codeChanged = files.some((f) => isCodePath(f.filename));
  const codeLines = codeLinesOf(files);
  const prCommits = new Set((await gh.all(`/pulls/${number}/commits`)).map((c) => c.sha));
  const events = await collectEvents(gh, number);
  const budgetApprovers = await resolveBudgetApprovers(gh, config);
  const results = [];
  for (const p of planFiles) {
    const text = await gh.file(p, pr.head.sha);
    if (text == null) continue;
    const plan = readPlanText(text, p.split("/").pop().slice(0, -3));
    const estimate = estimatePlan(plan.body, config);
    const digestAt = await nativeDigests(gh, events, p, { headSha: pr.head.sha, headText: text, config });
    const planEvents = expandEvents(events.map((e) => ({ ...e, id: `${e.source}${e.id}` })), { planId: plan.id, digestAt, config });
    const autoContext = { codeLines, gatedBefore: await gatedBefore(gh, p, pr, prCommits, config, plan.digest) };
    results.push({ ...evaluatePlan({ plan, estimate, events: planEvents, prAuthor: pr.user.login, config, budgetApprovers, autoContext }), title: plan.title, path: p, estimate });
  }
  const sum = config.policyBroken ? { state: "failure", description: `Policy file unreadable: fix .lake/config.json on ${pr.base.ref} ${(config.configError.match(/\(line \d+, column \d+\)/) || [""])[0]}`.trim() } : summarize(results, codeChanged, config);
  if (config.policyFrom) sum.description = `.lake/config.json broken, last valid policy kept \xB7 ${sum.description}`;
  return { pr, config, results, codeChanged, repo: gh.repo, ...sum };
}
function summarize(results, codeChanged, config) {
  if (!results.length) {
    if (!codeChanged || config.requirePlan === "off") return { state: "success", description: "No plan in this PR" };
    return config.requirePlan === "fail" ? { state: "failure", description: "Code changed without a plan in .lake/plans/" } : { state: "success", description: "Warning: code changed without a plan in .lake/plans/" };
  }
  const bad = results.filter((r2) => !isPassing(r2));
  if (!bad.length) return { state: "success", description: `${results.length} plan(s) approved for their current version` };
  const r = bad[0];
  if (r.state === "needs-budget") return { state: "failure", description: `Needs budget approval for ${r.id} (up to ${money(r.budget.exposure)} > ${money(r.budget.threshold)})`.slice(0, 140) };
  return { state: "failure", description: r.state === "changes-requested" ? `Changes requested on ${r.id}` : `Waiting for approval: /lake approve ${r.id}@${r.short}`.slice(0, 140) };
}
function renderSummary(ev) {
  const lines = [MARKER, "### Lake plan gate", ""];
  if (ev.config?.configError) lines.push(`> **${ev.config.policyBroken ? "Error" : "Warning"}:** ${configWarning(ev.config)}`, "");
  if (!ev.results.length) {
    lines.push(ev.description + ".");
    return lines.join("\n");
  }
  lines.push("| Plan | Version | Status | Complexity | Est. cost |", "|---|---|---|---|---|");
  const autoWhy = [];
  for (const r of ev.results) {
    const status = r.state === "approved" ? `approved by ${r.approvers.map((a) => "@" + a).join(", ")}` : r.state === "auto-approved" ? "auto-approved by policy" : r.state === "changes-requested" ? `changes requested by ${r.blockers.map((a) => "@" + a).join(", ")}` : r.state === "needs-budget" ? `approved by ${r.approvers.map((a) => "@" + a).join(", ")}, **needs budget approval**` : `needs ${r.needed} approval(s)${r.budget?.required ? " + budget approval" : ""}`;
    if (r.auto?.mode !== "off" && r.auto?.reasons?.length && !isPassing(r)) autoWhy.push(`\`${r.id}\`: ${r.auto.reasons.join("; ")}`);
    const est = r.estimate;
    const cost = `${costLabel(est)}${est.cap != null ? ` (cap ${money(est.cap)})` : ""}`;
    lines.push(`| [${r.title.replace(/\|/g, "/")}](${r.path}) | \`${r.short}\` | ${status} | ${est.complexity} | ${cost} |`);
  }
  if (autoWhy.length) lines.push("", `Not auto-approved (needs a human): ${autoWhy.length === 1 ? autoWhy[0] : ""}`, ...autoWhy.length > 1 ? autoWhy.map((w) => `- ${w}`) : []);
  for (const r of ev.results.filter((x) => x.budget?.unreadable?.length).slice(0, 1)) {
    lines.push("", `> **Warning:** couldn't read ${r.budget.unreadable.join(", ")} with this token, so ${r.budget.fallback === "owner" ? "the repo owner" : "repo admins"} and any listed login can give the budget approval. List GitHub logins in \`budget.approvers\` (e.g. \`["alice","bob"]\`) to fix this.`);
  }
  for (const r of ev.results.filter((x) => x.budget?.required)) {
    lines.push("", `**Budget approval** for \`${r.id}\`: up to ${money(r.budget.exposure)} is above the team threshold of ${money(r.budget.threshold)}. ${r.budget.satisfied ? `Approved by @${r.budget.approvedBy.join(", @")} for v${r.short}.` : `${(() => {
      const who = [...r.budget.approvers.map((a) => "@" + a), ...r.budget.fallback === "owner" ? ["the repo owner"] : []];
      return who.length === 1 ? who[0] : who.length ? `One of ${who.join(", ")}` : `One of ${r.budget.teams.join(", ")}`;
    })()} must approve v${r.short} too.`}`);
  }
  for (const r of ev.results) {
    const sugg = costSuggestions(r.estimate, ev.config || {});
    if (sugg.length && !isPassing(r)) lines.push("", `<details><summary>Lake can cut \`${r.id}\` by up to ${money(Math.max(...sugg.map((x) => x.saving[1])))}</summary>`, "", ...sugg.map((x) => `- ${x.title} (saves up to ${money(x.saving[1])})`), "", "Apply in one click on the Lake review page, or ask your agent (lake_submit_revision).", "", "</details>");
    for (const n of r.estimate.modelNotes || []) lines.push("", `Note on \`${r.id}\`: ${n}`);
  }
  const pending = ev.results.filter((r) => !isPassing(r));
  if (pending.length) {
    const base = ev.config?.reviewUrl;
    if (base && ev.repo && ev.pr?.number) {
      const img = (n, alt) => `![${alt}](${base}btn/${n}.svg)`;
      lines.push("", "**Review in one click** (opens the Lake review page; posting needs a GitHub token the first time):", "");
      for (const r of pending) {
        const link = (act) => `${base}#/pr/${ev.repo}/${ev.pr.number}/${encodeURIComponent(r.id)}${act ? `?do=${act}&v=${r.short}` : ""}`;
        lines.push(`${pending.length > 1 ? `\`${r.id}\` ` : ""}[${img("approve", `Approve v${r.short}`)}](${link("approve")}) [${img("changes", "Request changes")}](${link("changes")}) [${img("open", "Open plan review")}](${link("")})`, "");
      }
    }
    if (ev.config?.nativeReviews !== false) lines.push("Or use GitHub's own **Review changes \u2192 Approve** on this PR. lake-gate counts it for the plan version at the reviewed commit.", "");
    lines.push(
      "Or comment (one line per plan):",
      "```",
      ...pending.map((r) => `/lake approve ${r.id}@${r.short}`),
      "```",
      "Approval is bound to this exact version. Editing the plan file needs a fresh approval."
    );
  }
  const shadow = ev.results.filter((r) => r.auto.mode === "shadow" && r.auto.eligible && !isPassing(r));
  if (shadow.length) lines.push("", `Shadow auto-approve: ${shadow.map((r) => r.id).join(", ")} would pass the auto-approve policy. It is in shadow mode, so a human still decides.`);
  const notes = ev.results.flatMap((r) => r.notes.filter((n) => !/refers to version/.test(n)));
  if (notes.length) lines.push("", "<details><summary>Ignored commands</summary>", "", ...notes.map((n) => `- ${n}`), "", "</details>");
  return lines.join("\n");
}
async function publish(gh, ev, { comment = true } = {}) {
  const target = ev.config?.reviewUrl && ev.repo && ev.pr?.number ? `${ev.config.reviewUrl}#/pr/${ev.repo}/${ev.pr.number}${ev.results[0] ? `/${encodeURIComponent(ev.results[0].id)}` : ""}` : void 0;
  await gh.req("POST", `/statuses/${ev.pr.head.sha}`, { state: ev.state, context: STATUS_CONTEXT, description: ev.description.slice(0, 140), ...target ? { target_url: target } : {} });
  if (!comment || !ev.results.length && ev.state === "success" && !/Warning/.test(ev.description)) return;
  const body = renderSummary(ev);
  try {
    const existing = (await gh.all(`/issues/${ev.pr.number}/comments`)).find((c) => c.user.type === "Bot" && String(c.body).startsWith(MARKER));
    if (existing) {
      if (existing.body !== body) await gh.req("PATCH", `/issues/comments/${existing.id}`, { body });
    } else await gh.req("POST", `/issues/${ev.pr.number}/comments`, { body });
  } catch (e) {
    console.log(`::warning::lake-gate couldn't post the summary comment (${String(e.message).slice(0, 120)}). Give the workflow "pull-requests: write" (see templates/lake-gate.yml).`);
  }
}

// src/action.js
var CHECK_NAME = "Lake plan review";
function prNumberFromEvent(name, payload) {
  if (payload.pull_request) return payload.pull_request.number;
  if (name === "issue_comment" && payload.issue && payload.issue.pull_request) return payload.issue.number;
  if (name === "check_run" && payload.check_run?.pull_requests?.length) return payload.check_run.pull_requests[0].number;
  return null;
}
function checkActions(ev) {
  const pending = ev.results.filter((r) => !isPassing(r));
  if (pending.length === 1) {
    const r = pending[0];
    return [
      { label: "Approve plan", description: `Approve ${r.id}@${r.short}`.slice(0, 40), identifier: `approve:${r.short}` },
      { label: "Request changes", description: `Block ${r.id}@${r.short}`.slice(0, 40), identifier: `reject:${r.short}` }
    ];
  }
  return pending.slice(0, 3).map((r) => ({ label: `Approve ${r.id}`.slice(0, 20), description: `Approve ${r.id}@${r.short}`.slice(0, 40), identifier: `approve:${r.short}` }));
}
async function publishCheck(gh, ev) {
  const actions = checkActions(ev);
  await gh.req("POST", "/check-runs", {
    name: CHECK_NAME,
    head_sha: ev.pr.head.sha,
    status: "completed",
    conclusion: actions.length ? "action_required" : "success",
    output: { title: ev.description.slice(0, 120), summary: renderSummary(ev).slice(0, 6e4) },
    ...actions.length ? { actions } : {}
  });
}
var WRITE = /* @__PURE__ */ new Set(["admin", "maintain", "write"]);
async function relayCheckAction(gh, payload, ev) {
  const [action, short] = String(payload.requested_action?.identifier || "").split(":");
  const login = payload.sender?.login;
  if (!["approve", "reject"].includes(action) || !short || !login || payload.sender.type === "Bot") return { relayed: false, reason: "bad request" };
  if (payload.check_run?.head_sha && payload.check_run.head_sha !== ev.pr.head.sha) return { relayed: false, reason: "stale check run (PR has new commits)" };
  const plan = ev.results.find((r) => r.short === short);
  if (!plan) return { relayed: false, reason: `no plan at version ${short}` };
  const perm = await gh.req("GET", `/collaborators/${encodeURIComponent(login)}/permission`);
  if (!perm || !WRITE.has(perm.permission)) return { relayed: false, reason: `@${login} lacks write access` };
  const body = verdictBody({ action, planId: plan.id, version: plan.digest, text: `${action === "approve" ? "Approved" : "Changes requested"} by @${login} with the check-run button.`, via: "GitHub check button" }) + "\n" + encodeMarker("proxy", { by: login, assoc: "COLLABORATOR" });
  await gh.req("POST", `/issues/${ev.pr.number}/comments`, { body });
  return { relayed: true, login, action, plan: plan.id };
}
async function runAction(env = process.env, fetchImpl) {
  const payload = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const number = prNumberFromEvent(env.GITHUB_EVENT_NAME, payload);
  const token = env.INPUT_TOKEN || env.GITHUB_TOKEN;
  const gh = client({ token, repo: env.GITHUB_REPOSITORY, api: env.GITHUB_API_URL || "https://api.github.com", fetchImpl });
  if (!number && env.GITHUB_EVENT_NAME === "push") {
    const branch = String(payload.ref || "").replace(/^refs\/heads\//, "");
    const prs = await gh.all(`/pulls?state=open&base=${encodeURIComponent(branch)}`) || [];
    console.log(`lake-gate: policy push to ${branch}: re-checking ${prs.length} open PR(s).`);
    for (const pr of prs) {
      try {
        await publish(gh, await evaluatePr(gh, pr.number), { comment: (env.INPUT_COMMENT || "true") !== "false" });
      } catch (e) {
        console.log(`::warning::lake-gate: PR #${pr.number}: ${e.message}`);
      }
    }
    return null;
  }
  if (!number) {
    console.log("lake-gate: not a pull request event, nothing to do.");
    return null;
  }
  let ev = await evaluatePr(gh, number);
  if (env.GITHUB_EVENT_NAME === "check_run" && payload.action === "requested_action") {
    const r = await relayCheckAction(gh, payload, ev);
    console.log(`lake-gate: check button: ${r.relayed ? `${r.action} ${r.plan} by @${r.login}` : `ignored (${r.reason})`}`);
    if (r.relayed) ev = await evaluatePr(gh, number);
  }
  await publish(gh, ev, { comment: (env.INPUT_COMMENT || "true") !== "false" });
  if (ev.config.checkButtons && ev.results.length) await publishCheck(gh, ev).catch((e) => console.log(`lake-gate: could not create check run buttons: ${e.message}`));
  const md = renderSummary(ev);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, md + "\n");
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `state=${ev.state}
`);
  console.log(`lake-gate: ${ev.state}: ${ev.description}`);
  return ev;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  runAction().catch((e) => {
    console.error(`::error::lake-gate: ${e.message}`);
    process.exit(1);
  });
}
export {
  CHECK_NAME,
  checkActions,
  prNumberFromEvent,
  publishCheck,
  relayCheckAction,
  runAction
};

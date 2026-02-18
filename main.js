const MIN_CHARS = 20;
const DEBOUNCE_MS = 1000;
const STEP_TRIGGER = 20;
const MAX_HIGHLIGHTS = 12;

const inputEl = document.querySelector("#promptInput");
const highlightLayerEl = document.querySelector("#highlightLayer");
const statusBadgeEl = document.querySelector("#statusBadge");
const statusScoreEl = document.querySelector("#statusScore");
const statusReasonEl = document.querySelector("#statusReason");
const runtimeInfoEl = document.querySelector("#runtimeInfo");
const whyListEl = document.querySelector("#whyList");
const modeSelectEl = document.querySelector("#modeSelect");
const runtimeSelectEl = document.querySelector("#runtimeSelect");

const state = {
  mode: "strict",
  runtime: "auto",
  timerId: null,
  analyzing: false,
  queuedText: "",
  lastAnalysisKey: "",
  lastResult: null,
  lastStepLength: 0,
  llm: {
    attempted: false,
    status: "idle", // idle | loading | ready | unavailable
    progress: "Not started",
    modelId: "",
    module: null,
    engine: null
  }
};

const HEURISTIC_RULES = [
  {
    id: "hazardous-agent",
    weight: 28,
    regex:
      /\b(pathogen|toxin|select agent|anthrax|smallpox|ebola|marburg|plague|ricin|botulinum)\b/gi,
    reason: "References hazardous biological agents or toxins.",
    consequence:
      "Could normalize discussion of hazardous agents outside controlled oversight."
  },
  {
    id: "creation-modification",
    weight: 24,
    regex: /\b(synthesize|synthesise|engineer|modify|enhance|design|construct)\b/gi,
    reason: "Describes creating or modifying biological material.",
    consequence: "Could enable harmful creation or modification of biological material."
  },
  {
    id: "culturing-handling",
    weight: 22,
    regex: /\b(culture|grow|propagate|amplify|handle live sample)\b/gi,
    reason: "Mentions culturing, growth, or handling of biological material.",
    consequence: "Could encourage unsafe handling of biological material."
  },
  {
    id: "weaponization",
    weight: 34,
    regex: /\b(weaponiz\w*|aerosoliz\w*|disseminat\w*|bioweapon|mass casualty)\b/gi,
    reason: "Signals harmful deployment intent.",
    consequence: "Could increase the risk of intentional biological misuse."
  },
  {
    id: "procurement",
    weight: 24,
    regex:
      /\b(procure|acquire|source|get)\b.{0,25}\b(pathogen|toxin|strain|select agent|sample)\b/gi,
    reason: "Asks about obtaining potentially restricted biological materials.",
    consequence: "Could facilitate unauthorized access to restricted materials."
  },
  {
    id: "evasion",
    weight: 30,
    regex:
      /\b(bypass biosafety|evade oversight|avoid detection|without approval|without ethics review)\b/gi,
    reason: "Suggests bypassing safety, ethics, or oversight safeguards.",
    consequence: "Could undermine biosafety and institutional safeguards."
  },
  {
    id: "protocol",
    weight: 16,
    regex: /\b(step[- ]?by[- ]?step|protocol|detailed method|exact procedure)\b/gi,
    reason: "Requests procedural detail.",
    consequence: "Detailed procedural framing may increase practical misuse risk."
  }
];

const SYSTEM_PROMPT =
  "You are a strict biosecurity risk classifier for text prompts. " +
  "Focus only on wet-lab misuse risk. Never output instructions. " +
  "Return a single JSON object only, with exactly these keys: label, score, rationale, highlights, consequences.";

init();

function init() {
  modeSelectEl.value = state.mode;
  runtimeSelectEl.value = state.runtime;

  inputEl.addEventListener("input", onInput);
  inputEl.addEventListener("scroll", syncOverlayScroll);

  modeSelectEl.addEventListener("change", () => {
    state.mode = modeSelectEl.value;
    state.lastAnalysisKey = "";
    scheduleAnalysis(true);
  });

  runtimeSelectEl.addEventListener("change", () => {
    state.runtime = runtimeSelectEl.value;
    state.lastAnalysisKey = "";
    state.queuedText = "";
    ensureRuntimeInitialized();
    updateRuntimeInfo();
    scheduleAnalysis(true);
  });

  renderHighlights(inputEl.value, []);
  setNeutralStatus("Type more to analyze", "Score: --", "Enter at least 20 characters.");
  updateWhyPanel([]);
  ensureRuntimeInitialized();
  updateRuntimeInfo();
}

function onInput() {
  const text = inputEl.value;
  const hasStepJump = Math.abs(text.length - state.lastStepLength) >= STEP_TRIGGER;

  if (hasStepJump) {
    state.lastStepLength = text.length;
  }

  if (state.lastResult && state.lastResult._text === text) {
    renderHighlights(text, state.lastResult.highlights);
  } else {
    renderHighlights(text, []);
  }

  if (text.length < MIN_CHARS) {
    state.lastAnalysisKey = "";
    setNeutralStatus("Type more to analyze", "Score: --", "Enter at least 20 characters.");
    updateWhyPanel([]);
    clearTimeout(state.timerId);
    return;
  }

  scheduleAnalysis(hasStepJump);
}

function scheduleAnalysis(immediate = false) {
  clearTimeout(state.timerId);
  if (immediate) {
    queueCurrentTextForAnalysis();
    return;
  }
  state.timerId = setTimeout(queueCurrentTextForAnalysis, DEBOUNCE_MS);
}

function queueCurrentTextForAnalysis() {
  const text = inputEl.value;
  queueAnalysisForText(text);
}

function queueAnalysisForText(text) {
  if (text.length < MIN_CHARS) {
    return;
  }

  const key = makeAnalysisKey(text);
  if (key && key === state.lastAnalysisKey) {
    return;
  }

  if (state.analyzing) {
    state.queuedText = text;
    return;
  }

  runAnalysis(text).catch(() => {
    setNeutralStatus("Check unavailable", "Score: --", "Fell back to local heuristic checks.");
  });
}

async function runAnalysis(text) {
  state.analyzing = true;
  setNeutralStatus("Analyzing...", "Score: --", "Running local check...");

  const backend = getActiveBackend();
  if (backend === "pending-webllm") {
    setNeutralStatus(
      "LLM loading",
      "Score: --",
      "Model is still loading. Analysis will run once ready."
    );
    state.analyzing = false;
    return;
  }

  let result;
  if (backend === "webllm") {
    result = await analyzeWithWebLLM(text);
  } else {
    const unavailableOverride =
      state.runtime === "webllm" && state.llm.status === "unavailable"
        ? "LLM unavailable; using heuristic checks."
        : "";
    result = heuristicAnalyze(text, state.mode, unavailableOverride);
  }

  result._text = text;
  state.lastResult = result;
  state.lastAnalysisKey = makeAnalysisKey(text);
  renderResult(result);

  state.analyzing = false;

  const latestText = state.queuedText || inputEl.value;
  state.queuedText = "";

  if (latestText && latestText !== text) {
    queueAnalysisForText(latestText);
  }
}

function makeAnalysisKey(text) {
  const backend = getActiveBackend();
  if (backend === "pending-webllm") {
    return "";
  }
  return `${state.mode}::${state.runtime}::${backend}::${text}`;
}

function getActiveBackend() {
  if (state.runtime === "heuristic") {
    return "heuristic";
  }
  if (state.runtime === "webllm") {
    if (state.llm.status === "ready") {
      return "webllm";
    }
    if (state.llm.status === "unavailable") {
      return "heuristic";
    }
    return "pending-webllm";
  }
  return state.llm.status === "ready" ? "webllm" : "heuristic";
}

async function ensureRuntimeInitialized() {
  if (state.runtime === "heuristic") {
    updateRuntimeInfo();
    return;
  }

  if (state.llm.status === "loading" || state.llm.status === "ready") {
    updateRuntimeInfo();
    return;
  }

  if (state.llm.attempted && state.llm.status === "unavailable") {
    updateRuntimeInfo();
    return;
  }

  state.llm.attempted = true;

  if (!("gpu" in navigator)) {
    state.llm.status = "unavailable";
    state.llm.progress = "WebGPU not detected";
    updateRuntimeInfo();
    return;
  }

  state.llm.status = "loading";
  state.llm.progress = "Preparing model...";
  updateRuntimeInfo();

  try {
    if (!state.llm.module) {
      state.llm.module = await import("@mlc-ai/web-llm");
    }

    const modelId = pickSmallModelId(state.llm.module);
    state.llm.modelId = modelId;

    const engine = await state.llm.module.CreateMLCEngine(modelId, {
      initProgressCallback: (report) => {
        const pct = Number.isFinite(report.progress)
          ? Math.round(report.progress * 100)
          : null;
        const textPart = report.text ? ` ${report.text}` : "";
        state.llm.progress = pct === null ? `Loading...${textPart}` : `${pct}%${textPart}`;
        updateRuntimeInfo();
      }
    });

    state.llm.engine = engine;
    state.llm.status = "ready";
    state.llm.progress = "Ready";
    updateRuntimeInfo();
    scheduleAnalysis(true);
  } catch (error) {
    console.error("WebLLM initialization failed:", error);
    state.llm.status = "unavailable";
    state.llm.progress = "LLM unavailable";
    updateRuntimeInfo();
    scheduleAnalysis(true);
  }
}

function pickSmallModelId(webllmModule) {
  const list = webllmModule.prebuiltAppConfig?.model_list ?? [];
  const fallback = "Llama-3.2-1B-Instruct-q4f16_1-MLC";

  if (!Array.isArray(list) || list.length === 0) {
    return fallback;
  }

  const candidates = list
    .map((item) => {
      const modelId = item.model_id ?? item.model ?? "";
      const vram = Number(item.vram_required_MB ?? Number.POSITIVE_INFINITY);
      return {
        modelId,
        vram,
        billions: extractModelSizeInBillions(modelId)
      };
    })
    .filter((item) => /instruct|chat/i.test(item.modelId));

  if (!candidates.length) {
    return fallback;
  }

  candidates.sort((a, b) => {
    if (a.billions !== b.billions) {
      return a.billions - b.billions;
    }
    if (a.vram !== b.vram) {
      return a.vram - b.vram;
    }
    return a.modelId.localeCompare(b.modelId);
  });

  return candidates[0].modelId || fallback;
}

function extractModelSizeInBillions(modelId) {
  const match = modelId.match(/(\d+(?:\.\d+)?)B/i);
  return match ? Number(match[1]) : 999;
}

async function analyzeWithWebLLM(text) {
  const engine = state.llm.engine;
  if (!engine) {
    return heuristicAnalyze(
      text,
      state.mode,
      "LLM unavailable; using heuristic risk checks."
    );
  }

  const modeLine =
    state.mode === "strict"
      ? "Use strict policy: if uncertain, label unsafe with score between 40 and 60."
      : "Use balanced policy: still conservative; uncertainty must still be unsafe, score 40-60.";

  const userPrompt =
    `${modeLine}
Classify this text for wet-lab biosecurity misuse risk only.
Rules:
- be conservative
- if unsure => label unsafe, score 40..60
- rationale <= 160 chars
- consequences: up to 3 bullets, each <= 90 chars
- highlights must use valid ranges: 0 <= start < end <= text length
- return strict JSON only; no markdown; no extra keys

Schema:
{
  "label": "safe" | "unsafe",
  "score": 0..100,
  "rationale": "short text",
  "highlights": [{"start":0,"end":1,"reason":"..."}],
  "consequences": ["..."]
}

TEXT_LENGTH=${text.length}
TEXT:
${text}`;

  let raw = "";
  try {
    const completion = await engine.chat.completions.create({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt }
      ],
      temperature: 0,
      max_tokens: 128
    });
    raw = completion?.choices?.[0]?.message?.content ?? "";
  } catch (error) {
    console.error("WebLLM inference failed:", error);
    return heuristicAnalyze(text, state.mode, "LLM failed during inference; using heuristics.");
  }

  const parsed = parseStrictJson(raw);
  if (!parsed) {
    return heuristicAnalyze(
      text,
      state.mode,
      "LLM output was not valid JSON; using heuristic checks."
    );
  }

  return sanitizeResult(parsed, text);
}

function parseStrictJson(raw) {
  if (typeof raw !== "string") {
    return null;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  const candidate = trimmed.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch (_error) {
    return null;
  }
}

function heuristicAnalyze(text, mode, overrideRationale = "") {
  const highlights = [];
  const consequenceSet = new Set();
  let risk = 0;
  let sawProcedural = false;
  let sawHazard = false;

  for (const rule of HEURISTIC_RULES) {
    rule.regex.lastIndex = 0;
    let match;

    while ((match = rule.regex.exec(text)) !== null) {
      const start = match.index;
      const end = match.index + match[0].length;

      highlights.push({
        start,
        end,
        reason: rule.reason
      });

      risk += rule.weight;
      consequenceSet.add(rule.consequence);

      if (rule.id === "protocol") {
        sawProcedural = true;
      } else {
        sawHazard = true;
      }

      if (highlights.length >= MAX_HIGHLIGHTS) {
        break;
      }
    }

    if (highlights.length >= MAX_HIGHLIGHTS) {
      break;
    }
  }

  if (sawProcedural && sawHazard) {
    risk += 20;
    consequenceSet.add("Combining procedural requests with hazard terms raises misuse risk.");
  }

  if (mode === "strict" && highlights.length > 0) {
    risk += 8;
  }

  if (highlights.length === 0) {
    return {
      label: "safe",
      score: mode === "strict" ? 90 : 94,
      rationale: "No clear wet-lab misuse indicators detected.",
      highlights: [],
      consequences: []
    };
  }

  const scoreCap = mode === "strict" ? 55 : 62;
  const score = clamp(Math.min(scoreCap, 100 - risk), 25, scoreCap);

  return {
    label: "unsafe",
    score,
    rationale:
      trimToLimit(overrideRationale, 160) ||
      "Potential wet-lab misuse intent detected; review this prompt before use.",
    highlights: sanitizeHighlights(highlights, text.length),
    consequences: [...consequenceSet].slice(0, 3).map((item) => trimToLimit(item, 90))
  };
}

function sanitizeResult(result, text) {
  const label = result?.label === "safe" ? "safe" : "unsafe";
  const score = clampInt(result?.score, 0, 100, label === "safe" ? 85 : 50);
  const rationale = trimToLimit(
    typeof result?.rationale === "string" ? result.rationale : "",
    160
  );
  const highlights = sanitizeHighlights(result?.highlights, text.length);
  const consequences = sanitizeConsequences(result?.consequences);

  return {
    label,
    score,
    rationale:
      rationale ||
      (label === "safe"
        ? "No major wet-lab misuse signal detected."
        : "Potential biosecurity misuse signal detected."),
    highlights,
    consequences
  };
}

function sanitizeHighlights(rawHighlights, textLength) {
  if (!Array.isArray(rawHighlights)) {
    return [];
  }

  const cleaned = rawHighlights
    .map((item) => {
      const start = Number(item?.start);
      const end = Number(item?.end);
      const reason = trimToLimit(String(item?.reason ?? ""), 90);
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        return null;
      }
      if (start < 0 || end > textLength || start >= end) {
        return null;
      }
      return { start, end, reason };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start)
    .slice(0, MAX_HIGHLIGHTS);

  return cleaned;
}

function sanitizeConsequences(rawConsequences) {
  if (!Array.isArray(rawConsequences)) {
    return [];
  }

  return rawConsequences
    .map((item) => trimToLimit(String(item ?? ""), 90))
    .filter((item) => item.length > 0)
    .slice(0, 3);
}

function renderResult(result) {
  const labelText = result.label === "safe" ? "Safe" : "Unsafe";
  const scoreText = `Score: ${result.score}/100`;
  const reason = result.rationale;
  const badgeClass = result.label === "safe" ? "safe" : "unsafe";

  statusBadgeEl.textContent = labelText;
  statusBadgeEl.className = `status-badge ${badgeClass}`;
  statusScoreEl.textContent = scoreText;
  statusReasonEl.textContent = reason;

  renderHighlights(inputEl.value, result.highlights);
  updateWhyPanel(result.consequences);
}

function setNeutralStatus(badge, score, reason) {
  statusBadgeEl.textContent = badge;
  statusBadgeEl.className = "status-badge neutral";
  statusScoreEl.textContent = score;
  statusReasonEl.textContent = reason;
}

function updateWhyPanel(consequences) {
  whyListEl.innerHTML = "";
  if (!Array.isArray(consequences) || consequences.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No major risk patterns detected yet.";
    whyListEl.appendChild(li);
    return;
  }

  for (const bullet of consequences.slice(0, 3)) {
    const li = document.createElement("li");
    li.textContent = bullet;
    whyListEl.appendChild(li);
  }
}

function renderHighlights(text, highlights) {
  if (!text) {
    highlightLayerEl.textContent = "";
    return;
  }

  const safeHighlights = sanitizeHighlights(highlights, text.length);
  if (safeHighlights.length === 0) {
    highlightLayerEl.innerHTML = escapeHtml(text);
    syncOverlayScroll();
    return;
  }

  let cursor = 0;
  let html = "";

  for (const h of safeHighlights) {
    html += escapeHtml(text.slice(cursor, h.start));
    const spanText = text.slice(h.start, h.end) || " ";
    html += `<mark title="${escapeAttr(h.reason)}">${escapeHtml(spanText)}</mark>`;
    cursor = h.end;
  }
  html += escapeHtml(text.slice(cursor));

  if (text.endsWith("\n")) {
    html += "\n";
  }

  highlightLayerEl.innerHTML = html;
  syncOverlayScroll();
}

function syncOverlayScroll() {
  highlightLayerEl.scrollTop = inputEl.scrollTop;
  highlightLayerEl.scrollLeft = inputEl.scrollLeft;
}

function updateRuntimeInfo() {
  const runtime = state.runtime;
  const llmStatus = state.llm.status;

  if (runtime === "heuristic") {
    runtimeInfoEl.textContent = "LLM status: Disabled (heuristic-only mode).";
    return;
  }

  if (runtime === "webllm") {
    if (llmStatus === "idle") {
      runtimeInfoEl.textContent = "LLM status: Initializing...";
      return;
    }
    if (llmStatus === "ready") {
      runtimeInfoEl.textContent = `LLM status: Ready (${state.llm.modelId}).`;
      return;
    }
    if (llmStatus === "loading") {
      runtimeInfoEl.textContent = `LLM status: Loading... ${state.llm.progress}`;
      return;
    }
    runtimeInfoEl.textContent = "LLM status: Unavailable. WebGPU missing or load failed.";
    return;
  }

  if (llmStatus === "idle") {
    runtimeInfoEl.textContent = "LLM status: Initializing... Heuristic active meanwhile.";
    return;
  }
  if (llmStatus === "ready") {
    runtimeInfoEl.textContent = `LLM status: Ready (${state.llm.modelId}).`;
    return;
  }
  if (llmStatus === "loading") {
    runtimeInfoEl.textContent = `LLM status: Loading... ${state.llm.progress}. Heuristic active meanwhile.`;
    return;
  }
  runtimeInfoEl.textContent = "LLM status: Unavailable. Heuristic fallback active.";
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return clamp(Math.round(n), min, max);
}

function trimToLimit(text, maxLen) {
  if (typeof text !== "string") {
    return "";
  }
  return text.trim().slice(0, maxLen);
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(text) {
  return escapeHtml(text).replaceAll("\n", " ");
}

# Prompt Safety Checker (Biosecurity Focus)

This is a static, browser-only web app that checks draft prompts for potential **wet-lab biosecurity misuse risk** and labels them as `Safe` or `Unsafe`.

It is designed for high-level risk detection only. It does **not** provide operational biology guidance.

## What it does

- Chat-like composer UI with large input area.
- Continuous analysis:
  - Debounced analysis after 1 second of typing pause.
  - Optional extra trigger every 20 characters.
- Output:
  - `Safe` / `Unsafe`
  - Safety score `0-100` (`100` is safest)
  - One-sentence rationale
  - Highlighted risky spans in the draft text
  - Up to 3 concise "Why flagged?" bullets
- Runtime options:
  - `Auto`: use WebLLM if ready, otherwise heuristic fallback
  - `WebLLM`: waits for local model readiness
  - `Heuristic-only`

## Privacy and runtime behavior

- Runs fully client-side.
- No API keys.
- Prompt text is not sent to a backend service.
- In WebLLM mode, model files are downloaded to the browser and cached for later use.
- If WebGPU is unavailable or model loading fails, the app degrades gracefully to heuristic checks and reports `LLM unavailable`.

## Tech stack

- Vite + vanilla HTML/CSS/JS
- `@mlc-ai/web-llm` for in-browser local LLM inference (WebGPU path)
- Heuristic rule-based fallback with the same JSON-shaped output contract

## Run locally

```bash
npm install
npm run dev
```

Build preview:

```bash
npm run build
npm run preview
```

## Deploy on GitHub Pages

This repo includes `.github/workflows/deploy-pages.yml` to deploy automatically on pushes to `main`.

Required GitHub repo settings:

1. In GitHub, open `Settings -> Pages`.
2. Set source to **GitHub Actions**.
3. Push to `main`; the workflow will build and deploy `dist/`.

`vite.config.js` uses `base: "./"` so built assets work on GitHub Pages project sites.

## Safety note

This tool is an educational screening aid, not a substitute for institutional review, biosafety committees, or legal/compliance oversight.

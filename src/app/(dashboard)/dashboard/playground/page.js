"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { Button, Card, Input, Select, Toggle, Badge } from "@/shared/components";
import { cn } from "@/shared/utils/cn";

// ─── Capability Configuration ──────────────────────────────────────────────

const CAPABILITY_CONFIG = {
  chat: {
    kind: "llm",
    path: "/v1/chat/completions",
    method: "POST",
    stream: true,
    inputField: { key: "messages", label: "Message", type: "textarea", placeholder: "Type your message..." },
    defaultInput: "Hello!",
    extraFields: [
      { key: "temperature", type: "number", label: "Temperature", min: 0, max: 2, step: 0.1 },
      { key: "max_tokens", type: "number", label: "Max Tokens", min: 1 },
      { key: "stream", type: "toggle", label: "Stream" },
    ],
  },
  embeddings: {
    kind: "embedding",
    path: "/v1/embeddings",
    method: "POST",
    inputField: { key: "input", label: "Input Text", type: "textarea", placeholder: "Text to embed..." },
    defaultInput: "Hello world",
    extraFields: [
      { key: "encoding_format", type: "select", label: "Format", options: ["float", "base64"] },
    ],
  },
  image: {
    kind: "image",
    path: "/v1/images/generations",
    method: "POST",
    inputField: { key: "prompt", label: "Prompt", type: "textarea", placeholder: "Describe the image..." },
    defaultInput: "A sunset over mountains",
    extraFields: [
      { key: "size", type: "select", label: "Size", options: ["1024x1024", "1024x1792", "1792x1024", "512x512"] },
      { key: "quality", type: "select", label: "Quality", options: ["standard", "hd"] },
      { key: "n", type: "number", label: "Count", min: 1, max: 4 },
    ],
  },
  tts: {
    kind: "tts",
    path: "/v1/audio/speech",
    method: "POST",
    binaryResponse: true,
    inputField: { key: "input", label: "Text", type: "textarea", placeholder: "Text to speak..." },
    defaultInput: "Hello, this is a test.",
    extraFields: [
      { key: "voice", type: "text", label: "Voice", placeholder: "alloy" },
      { key: "response_format", type: "select", label: "Format", options: ["mp3", "opus", "wav", "pcm"] },
    ],
  },
  stt: {
    kind: "stt",
    path: "/v1/audio/transcriptions",
    method: "POST",
    formData: true,
    inputField: { key: "file", label: "Audio File", type: "file", accept: "audio/*" },
    extraFields: [
      { key: "language", type: "text", label: "Language", placeholder: "en" },
    ],
  },
  search: {
    kind: "webSearch",
    path: "/v1/search",
    method: "POST",
    inputField: { key: "query", label: "Query", type: "text", placeholder: "Search query..." },
    defaultInput: "latest AI news",
    extraFields: [
      { key: "max_results", type: "number", label: "Max Results", min: 1, max: 20 },
    ],
  },
  fetch: {
    kind: "webFetch",
    path: "/v1/web/fetch",
    method: "POST",
    inputField: { key: "url", label: "URL", type: "text", placeholder: "https://example.com" },
    defaultInput: "https://example.com",
  },
  video: {
    kind: "video",
    path: "/v1/videos/generations",
    method: "POST",
    inputField: { key: "prompt", label: "Prompt", type: "textarea", placeholder: "Describe the video..." },
    defaultInput: "A waterfall in slow motion",
  },
};

const CAPABILITIES = [
  { value: "chat", label: "Chat", icon: "chat" },
  { value: "embeddings", label: "Embeddings", icon: "token" },
  { value: "image", label: "Image", icon: "image" },
  { value: "tts", label: "TTS", icon: "volume_up" },
  { value: "stt", label: "STT", icon: "mic" },
  { value: "search", label: "Search", icon: "search" },
  { value: "fetch", label: "Fetch", icon: "language" },
  { value: "video", label: "Video", icon: "videocam" },
];

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Build request body including ONLY fields the user explicitly provided.
 * Empty strings, nulls, and unset optional params are excluded.
 */
function buildRequestBody(config, model, inputValue, extraValues) {
  const body = { model };

  // Main input field
  if (config.inputField && config.inputField.key !== "file") {
    const val = inputValue?.trim();
    if (val) {
      if (config.inputField.key === "messages") {
        body.messages = [{ role: "user", content: val }];
      } else {
        body[config.inputField.key] = val;
      }
    }
  }

  // Extra fields — only include when user explicitly set a non-empty value
  for (const field of config.extraFields || []) {
    const val = extraValues[field.key];
    if (val === undefined || val === null || val === "") continue;
    // Toggles: only include if explicitly turned on
    if (field.type === "toggle") {
      if (val === true) body[field.key] = true;
      continue;
    }
    body[field.key] = field.type === "number" ? Number(val) : val;
  }

  return body;
}

function buildCurl(config, model, apiKey, inputValue, extraValues, host) {
  const lines = [`curl -X ${config.method} \\`];
  lines.push(`  -H 'Authorization: Bearer ${apiKey || "sk-..."}' \\`);

  if (config.formData) {
    lines.push(`  -F 'model=${model}' \\`);
    if (config.inputField?.key === "file") {
      lines.push(`  -F 'file=@audio-file.wav' \\`);
    }
    for (const field of config.extraFields || []) {
      const val = extraValues[field.key];
      if (val !== undefined && val !== null && val !== "") {
        lines.push(`  -F '${field.key}=${val}' \\`);
      }
    }
  } else {
    lines.push(`  -H 'Content-Type: application/json' \\`);
    const body = buildRequestBody(config, model, inputValue, extraValues);
    lines.push(`  -d '${JSON.stringify(body)}'`);
  }

  lines.push(`  ${host}${config.path}`);
  return lines.join("\n");
}

// ─── Page Component ────────────────────────────────────────────────────────

export default function PlaygroundPage() {
  const [capability, setCapability] = useState("chat");
  const [modelState, setModelState] = useState({});
  const [apiKey, setApiKey] = useState("");
  const [keys, setKeys] = useState([]);
  const [keysLoaded, setKeysLoaded] = useState(false);
  const [inputState, setInputState] = useState({});
  const [extraState, setExtraState] = useState({});
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState(null);
  const [latency, setLatency] = useState(null);
  const [response, setResponse] = useState(null);
  const [error, setError] = useState(null);
  const [viewMode, setViewMode] = useState("formatted"); // "formatted" | "raw"
  const fileRef = useRef(null);
  const abortRef = useRef(null);

  const config = CAPABILITY_CONFIG[capability];

  // Load virtual keys on mount — fetch list then reveal full key for each
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/keys");
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const activeKeys = (data.keys || []).filter((k) => k.isActive !== false);
        // Reveal full keys for all active keys so requests use real credentials
        const revealed = await Promise.all(
          activeKeys.map(async (k) => {
            try {
              const r = await fetch(`/api/keys/${k.id}/reveal`, { method: "POST" });
              if (r.ok) {
                const d = await r.json();
                return { ...k, fullKey: d.key };
              }
            } catch { /* silent */ }
            return { ...k, fullKey: k.key }; // fallback to masked (won't work but won't crash)
          }),
        );
        if (cancelled) return;
        setKeys(revealed);
        // Auto-select first key's full credential if none set
        if (revealed.length > 0 && revealed[0].fullKey) {
          setApiKey((prev) => prev || revealed[0].fullKey);
        }
      } catch {
        // silent
      } finally {
        if (!cancelled) setKeysLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Per-capability state accessors
  const selectedModel = modelState[capability]?.selected ?? "";
  const customModel = modelState[capability]?.custom ?? "";
  const useCustomModel = modelState[capability]?.useCustom ?? false;
  const inputValue = useMemo(() => {
    if (inputState[capability] !== undefined) return inputState[capability];
    return config.defaultInput || "";
  }, [inputState, capability, config]);
  const extraValues = useMemo(() => {
    // No defaults — only include what user explicitly sets
    return { ...(extraState[capability] || {}) };
  }, [extraState, capability]);

  const setSelectedModel = useCallback((v) => {
    setModelState((prev) => ({ ...prev, [capability]: { ...prev[capability], selected: v, useCustom: false } }));
  }, [capability]);
  const setCustomModel = useCallback((v) => {
    setModelState((prev) => ({ ...prev, [capability]: { ...prev[capability], custom: v } }));
  }, [capability]);
  const setUseCustomModel = useCallback((v) => {
    setModelState((prev) => ({ ...prev, [capability]: { ...prev[capability], useCustom: v, ...(v ? {} : { custom: "" }) } }));
  }, [capability]);
  const setInputValue = useCallback((v) => {
    setInputState((prev) => ({ ...prev, [capability]: v }));
  }, [capability]);
  const handleExtraChange = useCallback((key, value) => {
    setExtraState((prev) => ({
      ...prev,
      [capability]: { ...(prev[capability] || {}), [key]: value },
    }));
  }, [capability]);

  // Fetch models from /v1/models API once we have an API key
  const [modelOptions, setModelOptions] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  useEffect(() => {
    if (!apiKey) return;
    let cancelled = false;
    setModelsLoading(true);
    (async () => {
      try {
        const res = await fetch("/v1/models", {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const models = (data.data || []).map((m) => ({
          value: m.id,
          label: m.id,
        }));
        setModelOptions(models);
      } catch {
        // silent
      } finally {
        if (!cancelled) setModelsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [apiKey]);

  // Auto-select first model when capability changes and no model selected
  useEffect(() => {
    if (!selectedModel && !useCustomModel && modelOptions.length > 0) {
      setSelectedModel(modelOptions[0].value);
    }
  }, [modelOptions, selectedModel, useCustomModel, setSelectedModel]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const effectiveModel = useCustomModel ? customModel : selectedModel;

  const handleRun = useCallback(async () => {
    if (!apiKey || !effectiveModel) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setRunning(true);
    setError(null);
    setResponse(null);
    setStatus(null);
    setLatency(null);
    setViewMode("formatted");
    const start = performance.now();

    try {
      let body, headers, fetchOptions;
      headers = { Authorization: `Bearer ${apiKey}` };

      if (config.formData) {
        const fd = new FormData();
        if (fileRef.current?.files?.[0]) {
          fd.append("file", fileRef.current.files[0]);
        }
        fd.append("model", effectiveModel);
        for (const field of config.extraFields || []) {
          const val = extraValues[field.key];
          if (val !== undefined && val !== null && val !== "") {
            fd.append(field.key, String(val));
          }
        }
        body = fd;
        fetchOptions = { method: config.method, headers, body, signal: controller.signal };
      } else {
        headers["Content-Type"] = "application/json";
        body = buildRequestBody(config, effectiveModel, inputValue, extraValues);
        fetchOptions = {
          method: config.method,
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        };
      }

      const resp = await fetch(config.path, fetchOptions);
      const elapsed = Math.round(performance.now() - start);
      setStatus(resp.status);
      setLatency(elapsed);

      const ct = resp.headers.get("content-type") || "";

      if (config.stream && extraValues.stream !== false && ct.includes("text/event-stream")) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";
        setResponse({ type: "stream", content: "", raw: "" });

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          accumulated += decoder.decode(value, { stream: true });
          setResponse({ type: "stream", content: accumulated, raw: accumulated });
        }
      } else if (config.binaryResponse && ct.includes("audio")) {
        const blob = await resp.blob();
        setResponse({ type: "audio", url: URL.createObjectURL(blob), contentType: ct });
      } else if (!resp.ok) {
        const text = await resp.text();
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = null; }
        setError(parsed?.error?.message || parsed?.error || text || `HTTP ${resp.status}`);
        setResponse({ type: "json", data: parsed || { error: text } });
      } else {
        const text = await resp.text();
        try {
          const json = JSON.parse(text);
          if (json.data?.[0]?.b64_json) {
            setResponse({ type: "image", src: `data:image/png;base64,${json.data[0].b64_json}`, raw: text });
          } else if (json.data?.[0]?.url) {
            setResponse({ type: "image", src: json.data[0].url, raw: text });
          } else {
            setResponse({ type: "json", data: json, raw: text });
          }
        } catch {
          setResponse({ type: "text", content: text, raw: text });
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        setError(err.message);
      }
    } finally {
      setRunning(false);
    }
  }, [apiKey, effectiveModel, config, inputValue, extraValues]);

  // Curl preview
  const curlPreview = useMemo(() => {
    const host = typeof window !== "undefined" ? window.location.origin : "http://localhost:28701";
    return buildCurl(config, effectiveModel || "model", apiKey, inputValue, extraValues, host);
  }, [config, effectiveModel, apiKey, inputValue, extraValues]);

  // Extract usage metadata from response
  const usageMeta = useMemo(() => {
    if (response?.type !== "json" || !response.data) return null;
    const u = response.data.usage;
    if (!u) return null;
    return {
      prompt: u.prompt_tokens ?? u.input_tokens,
      completion: u.completion_tokens ?? u.output_tokens,
      total: u.total_tokens,
    };
  }, [response]);

  // Clean up blob URLs
  useEffect(() => {
    return () => {
      if (response?.type === "audio" && response.url) {
        URL.revokeObjectURL(response.url);
      }
    };
  }, [response]);

  // Reset response when capability changes
  useEffect(() => {
    setResponse(null);
    setError(null);
    setStatus(null);
    setLatency(null);
  }, [capability]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text-main">Playground</h1>
        <p className="text-sm text-text-muted mt-1">
          Test capabilities through the Switch-Router gateway
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* ─── Left Panel: Controls ─────────────────────────────────────── */}
        <div className="lg:col-span-4 xl:col-span-4 space-y-4">
          {/* Capability Selector */}
          <Card padding="sm">
            <label className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2 block">Capability</label>
            <div className="flex flex-wrap gap-1.5">
              {CAPABILITIES.map((cap) => (
                <button
                  key={cap.value}
                  onClick={() => setCapability(cap.value)}
                  className={cn(
                    "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer",
                    capability === cap.value
                      ? "bg-brand-500 text-white shadow-sm"
                      : "bg-surface-2 text-text-muted hover:text-text-main hover:bg-surface-3"
                  )}
                >
                  <span className="material-symbols-outlined text-sm">{cap.icon}</span>
                  {cap.label}
                </button>
              ))}
            </div>
          </Card>

          {/* Model + Key */}
          <Card padding="sm">
            <div className="space-y-3">
              <Select
                label="Model"
                placeholder="Select a model..."
                options={modelOptions}
                value={useCustomModel ? "" : selectedModel}
                onChange={(e) => {
                  setSelectedModel(e.target.value);
                  setUseCustomModel(false);
                }}
                disabled={useCustomModel}
                hint={`${modelOptions.length} models available`}
              />
              <div className="flex items-center gap-2">
                <Toggle
                  checked={useCustomModel}
                  onChange={(v) => {
                    setUseCustomModel(v);
                    if (!v) setCustomModel("");
                  }}
                  size="sm"
                />
                <span className="text-xs text-text-muted">Custom model ID</span>
              </div>
              {useCustomModel && (
                <Input
                  placeholder="provider/model-id"
                  value={customModel}
                  onChange={(e) => setCustomModel(e.target.value)}
                />
              )}
              <div className="pt-1 border-t border-border-subtle">
                <Select
                  label="Virtual Key"
                  placeholder="Select or paste a key..."
                  options={[
                    ...keys.map((k) => ({
                      value: k.fullKey || k.key,
                      label: `${k.name || k.keyId || "unnamed"} (${k.key})`,
                    })),
                    { value: "__custom__", label: "Paste custom key..." },
                  ]}
                  value={keys.find((k) => (k.fullKey || k.key) === apiKey)?.fullKey || (apiKey ? "__custom__" : "")}
                  onChange={(e) => {
                    if (e.target.value === "__custom__") {
                      setApiKey("");
                    } else {
                      setApiKey(e.target.value);
                    }
                  }}
                />
                {(apiKey === "" || keys.find((k) => k.key === apiKey) === undefined) && (
                  <Input
                    type="password"
                    placeholder="sk-..."
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className="mt-2"
                  />
                )}
              </div>
            </div>
          </Card>

          {/* Input Field */}
          <Card padding="sm">
            {config.inputField?.type === "file" ? (
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                  {config.inputField.label}
                </label>
                <input
                  ref={fileRef}
                  type="file"
                  accept={config.inputField.accept}
                  className="w-full py-2.5 px-3 text-sm text-text-main bg-surface-2 rounded-lg border border-transparent file:mr-3 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-brand-500 file:text-white file:cursor-pointer"
                />
              </div>
            ) : config.inputField?.type === "textarea" ? (
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                  {config.inputField.label}
                </label>
                <textarea
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  rows={4}
                  className={cn(
                    "w-full py-2.5 px-3 text-sm text-text-main bg-surface-2 rounded-lg",
                    "border border-transparent placeholder-text-muted/70 resize-y min-h-[80px]",
                    "focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500/40",
                    "transition-all duration-150 ease-out"
                  )}
                  placeholder={config.inputField.placeholder || "Enter input..."}
                />
              </div>
            ) : config.inputField ? (
              <Input
                label={config.inputField.label}
                type={config.inputField.type}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                placeholder={config.inputField.placeholder || ""}
              />
            ) : null}
          </Card>

          {/* Extra Fields */}
          {config.extraFields?.length > 0 && (
            <Card padding="sm">
              <label className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3 block">Parameters</label>
              <div className="space-y-3">
                {config.extraFields.map((field) => {
                  if (field.type === "toggle") {
                    return (
                      <Toggle
                        key={field.key}
                        label={field.label}
                        checked={!!extraValues[field.key]}
                        onChange={(v) => handleExtraChange(field.key, v)}
                        size="sm"
                      />
                    );
                  }
                  if (field.type === "select") {
                    return (
                      <Select
                        key={field.key}
                        label={field.label}
                        options={[
                          { value: "", label: "(default)" },
                          ...field.options.map((o) => ({ value: o, label: o })),
                        ]}
                        value={extraValues[field.key] ?? ""}
                        onChange={(e) => handleExtraChange(field.key, e.target.value)}
                      />
                    );
                  }
                  return (
                    <Input
                      key={field.key}
                      label={field.label}
                      type={field.type}
                      value={extraValues[field.key] ?? ""}
                      onChange={(e) => handleExtraChange(field.key, e.target.value)}
                      placeholder={field.placeholder || "(optional)"}
                      {...(field.min !== undefined ? { min: field.min } : {})}
                      {...(field.max !== undefined ? { max: field.max } : {})}
                      {...(field.step !== undefined ? { step: field.step } : {})}
                    />
                  );
                })}
              </div>
            </Card>
          )}

          {/* Run Button */}
          <Button
            fullWidth
            size="lg"
            loading={running}
            disabled={!effectiveModel || !apiKey}
            onClick={handleRun}
            icon="play_arrow"
          >
            {running ? "Running..." : "Run Request"}
          </Button>

          {/* Curl Preview (collapsible) */}
          <details className="group">
            <summary className="text-xs font-medium text-text-muted cursor-pointer hover:text-text-main transition-colors select-none">
              cURL Preview
            </summary>
            <pre className="mt-2 text-xs text-text-muted bg-bg rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all font-mono leading-relaxed border border-border-subtle">
              {curlPreview}
            </pre>
          </details>
        </div>

        {/* ─── Right Panel: Response ────────────────────────────────────── */}
        <div className="lg:col-span-8 xl:col-span-8">
          <Card padding="none" className="min-h-[600px] flex flex-col overflow-hidden">
            {/* Response Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle bg-surface-1/50">
              <div className="flex items-center gap-3">
                <span className="material-symbols-outlined text-lg text-text-muted">terminal</span>
                <span className="text-sm font-semibold text-text-main">Response</span>
                {status !== null && (
                  <Badge
                    variant={status >= 200 && status < 300 ? "success" : status >= 300 && status < 400 ? "warning" : "error"}
                    size="sm"
                  >
                    {status}
                  </Badge>
                )}
                {latency !== null && (
                  <span className="text-xs text-text-muted font-mono">{latency}ms</span>
                )}
                {usageMeta && (
                  <span className="text-xs text-text-muted">
                    {usageMeta.prompt ?? "?"}/{usageMeta.completion ?? "?"} tokens
                  </span>
                )}
              </div>
              {response && (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setViewMode("formatted")}
                    className={cn(
                      "px-2.5 py-1 rounded text-xs font-medium transition-colors",
                      viewMode === "formatted" ? "bg-surface-3 text-text-main" : "text-text-muted hover:text-text-main"
                    )}
                  >
                    Formatted
                  </button>
                  <button
                    onClick={() => setViewMode("raw")}
                    className={cn(
                      "px-2.5 py-1 rounded text-xs font-medium transition-colors",
                      viewMode === "raw" ? "bg-surface-3 text-text-main" : "text-text-muted hover:text-text-main"
                    )}
                  >
                    Raw
                  </button>
                </div>
              )}
            </div>

            {/* Response Content */}
            <div className="flex-1 min-h-0 p-4 overflow-auto">
              {error && (
                <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-4 mb-4">
                  <div className="flex items-start gap-2">
                    <span className="material-symbols-outlined text-red-500 text-lg mt-0.5 shrink-0">error</span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-red-600 dark:text-red-400">Request Failed</p>
                      <p className="text-sm text-red-600/80 dark:text-red-400/80 mt-1 font-mono break-words">{error}</p>
                    </div>
                  </div>
                </div>
              )}

              {!error && !response && !running && (
                <div className="flex flex-col items-center justify-center h-full text-text-muted py-20">
                  <span className="material-symbols-outlined text-5xl mb-4 opacity-20">science</span>
                  <p className="text-sm font-medium">Ready to test</p>
                  <p className="text-xs mt-1 opacity-70">Select a model and click Run</p>
                </div>
              )}

              {running && !response && (
                <div className="flex flex-col items-center justify-center h-full text-text-muted py-20">
                  <span className="material-symbols-outlined text-4xl mb-4 animate-spin">progress_activity</span>
                  <p className="text-sm">Sending request...</p>
                </div>
              )}

              {/* Raw view */}
              {viewMode === "raw" && response?.raw && (
                <pre className="text-xs text-text-main font-mono whitespace-pre-wrap break-words leading-relaxed">
                  {response.raw}
                </pre>
              )}

              {/* Formatted views */}
              {viewMode === "formatted" && (
                <>
                  {response?.type === "stream" && (
                    <pre className="text-sm text-text-main font-mono whitespace-pre-wrap break-words leading-relaxed">
                      {response.content}
                    </pre>
                  )}

                  {response?.type === "json" && !error && (
                    <FormattedJson data={response.data} />
                  )}

                  {response?.type === "text" && (
                    <pre className="text-sm text-text-main font-mono whitespace-pre-wrap break-words leading-relaxed">
                      {response.content}
                    </pre>
                  )}

                  {response?.type === "audio" && (
                    <div className="flex flex-col items-center gap-4 py-10">
                      <div className="w-full max-w-md p-6 rounded-xl bg-surface-2 border border-border-subtle">
                        <audio controls src={response.url} className="w-full" />
                      </div>
                      <Badge variant="neutral" size="sm">{response.contentType}</Badge>
                    </div>
                  )}

                  {response?.type === "image" && (
                    <div className="flex flex-col items-center gap-4 py-4">
                      <div className="relative max-w-full max-h-[500px] rounded-xl overflow-hidden border border-border-subtle shadow-sm">
                        <Image
                          src={response.src}
                          alt="Generated"
                          width={1024}
                          height={1024}
                          className="max-w-full h-auto"
                          unoptimized
                        />
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ─── Formatted JSON Viewer ─────────────────────────────────────────────────

function FormattedJson({ data }) {
  if (!data) return null;

  // Chat completions: show content prominently
  const choices = data.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    return (
      <div className="space-y-3">
        {choices.map((choice, i) => {
          const content = choice.message?.content || choice.delta?.content || "";
          const role = choice.message?.role || "assistant";
          return (
            <div key={i} className="rounded-lg bg-surface-2 p-4 border border-border-subtle">
              <div className="flex items-center gap-2 mb-2">
                <Badge variant="neutral" size="sm">{role}</Badge>
                {choice.finish_reason && (
                  <span className="text-xs text-text-muted">{choice.finish_reason}</span>
                )}
              </div>
              <p className="text-sm text-text-main whitespace-pre-wrap leading-relaxed">{content}</p>
            </div>
          );
        })}
      </div>
    );
  }

  // Embeddings: show summary
  if (data.data && Array.isArray(data.data) && data.data[0]?.embedding) {
    return (
      <div className="space-y-3">
        <div className="text-sm text-text-muted">
          {data.data.length} embedding{data.data.length !== 1 ? "s" : ""} returned
          {data.data[0].embedding && ` (${data.data[0].embedding.length} dimensions)`}
        </div>
        <pre className="text-xs text-text-main font-mono whitespace-pre-wrap break-words bg-surface-2 p-3 rounded-lg border border-border-subtle max-h-[400px] overflow-auto">
          {JSON.stringify(data, null, 2)}
        </pre>
      </div>
    );
  }

  // Search results: show as list
  if (data.results && Array.isArray(data.results)) {
    return (
      <div className="space-y-2">
        {data.results.map((r, i) => (
          <div key={i} className="rounded-lg bg-surface-2 p-3 border border-border-subtle">
            <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-brand-500 hover:underline">
              {r.title || r.url}
            </a>
            {r.snippet && <p className="text-xs text-text-muted mt-1">{r.snippet}</p>}
          </div>
        ))}
      </div>
    );
  }

  // Default: pretty-printed JSON
  return (
    <pre className="text-xs text-text-main font-mono whitespace-pre-wrap break-words leading-relaxed">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

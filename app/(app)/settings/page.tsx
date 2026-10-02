"use client";

import { useState } from "react";
import { useAppConfig } from "@/lib/store/config";
import { useToast } from "@/lib/toast";
import { cn, truncate } from "@/lib/utils";
import {
  ConfirmDialog,
  Field,
  PageHeader,
  SettingsFooter,
  SettingsRow,
  SettingsSection,
  btn,
} from "@/components/ui";
import { ConnectForm } from "@/components/ConnectGate";
import { Icon, Spinner } from "@/components/Icon";
import { ModelPicker } from "@/components/ModelPicker";

const GITHUB_URL = "https://github.com/hydra-db/open-glean";
const DOCS_URL = "https://docs.hydradb.com";
// From package.json, not a second copy. The two had to be bumped together and
// would have drifted on the first release, showing users a stale version.
import pkg from "../../../package.json";
const VERSION = pkg.version;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}

// The theme picker is removed until there is a theme to pick.
//
// app/globals.css defines one palette, under :root, with no
// [data-theme="light"] rules and no prefers-color-scheme block — so choosing
// Light (or System on a light OS) set an attribute nothing read and changed
// nothing on screen. A control that silently does nothing is worse than no
// control, and worse for the users who need a light theme most, since it looks
// like they tried and it failed.
//
// Implementing it properly means re-deriving and contrast-testing all 54
// tokens, which is a design task rather than a bug fix. Restore this with the
// light palette.

export default function Page() {
  const { config, setConfig } = useAppConfig();
  const toast = useToast();

  const llm = config.llm;
  const [baseUrl, setBaseUrl] = useState(llm?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(llm?.apiKey ?? "");
  const [model, setModel] = useState(llm?.model ?? "");
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const [instructions, setInstructions] = useState(config.instructions ?? "");
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmErase, setConfirmErase] = useState(false);

  /**
   * Erase every chat this browser owns.
   *
   * The subject is anonymous, so this is the only moment erasure is possible:
   * once the cookie is gone the rows have no owner and nobody can remove them.
   */
  const eraseChats = async () => {
    try {
      const res = await fetch("/api/chats/data", { method: "DELETE" });
      const body = (await res.json().catch(() => ({}))) as {
        deleted?: number;
        error?: string;
      };
      if (!res.ok) {
        toast.push({ kind: "error", title: "Could not delete", detail: body.error });
        return;
      }
      toast.push({
        kind: "success",
        title: `Deleted ${body.deleted ?? 0} ${body.deleted === 1 ? "chat" : "chats"}`,
      });
      setConfirmErase(false);
      window.location.reload();
    } catch {
      toast.push({ kind: "error", title: "Could not delete your chats" });
    }
  };

  const saveLlm = async () => {
    const m = model.trim();
    if (!m) {
      toast.push({ kind: "error", title: "Model is required" });
      return;
    }
    // The key is stored ONLY in the encrypted server-side session —
    // never in browser localStorage.
    //
    // A base-URL-only change still has to reach the server. Previously the
    // whole request was skipped when the key box was empty (which it is after
    // every save), so the new URL went to localStorage, the toast said
    // "saved", and answers kept hitting the old host.
    if (apiKey.trim() || baseUrl.trim() !== (config.llm?.baseUrl ?? "")) {
      try {
        const res = await fetch("/api/auth/key", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            llm: { apiKey: apiKey.trim(), baseUrl: baseUrl.trim() || undefined, model: m },
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          toast.push({
            kind: "error",
            title: "Could not save the key",
            detail: body.error,
          });
          return;
        }
      } catch (err) {
        toast.push({ kind: "error", title: "Could not save the key", detail: errMsg(err) });
        return;
      }
    }
    setConfig({
      llm: { baseUrl: baseUrl.trim() || undefined, model: m },
      llmConfigured: apiKey.trim() ? true : config.llmConfigured,
    });
    setApiKey("");
    toast.push({ kind: "success", title: "LLM provider saved" });
  };

  const testLlm = async () => {
    const m = model.trim();
    if (!m) {
      toast.push({ kind: "error", title: "Model is required" });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/llm/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          // Send the key from the form, not just the URL.
          //
          // resolveLlmCreds only honours a caller-supplied base URL when the
          // caller also supplies a key — that pinning is the control that
          // stops a stored key being sent to an attacker's host. Sending the
          // URL alone meant the server fell back to the STORED url and key, so
          // Test reported OK without exercising anything the user had typed
          //. Sending both tests exactly what is in the boxes, and the
          // key is the user's own, going to a host they chose.
          apiKey: apiKey.trim() || undefined,
          baseUrl: baseUrl.trim() || undefined,
          model: m,
          messages: [{ role: "user", content: "Reply with exactly: OK" }],
        }),
        cache: "no-store",
      });
      const text = (await res.text()).trim();
      if (res.ok) {
        setTestResult({
          ok: true,
          text: text ? truncate(text === "OK" ? "OK" : `Replied: ${text}`, 60) : "No output",
        });
      } else {
        setTestResult({
          ok: false,
          text: truncate(text || `Request failed (${res.status})`, 120),
        });
      }
    } catch (err) {
      setTestResult({ ok: false, text: truncate(errMsg(err), 120) });
    } finally {
      setTesting(false);
    }
  };

  const saveInstructions = () => {
    setConfig({ instructions: instructions.trim() });
    toast.push({ kind: "success", title: "Instructions saved" });
  };

  /**
   * Wipe local state AND the stored credentials.
   *
   * localStorage.clear() does not touch cookies, and the Hydra and LLM keys
   * live in an encrypted httpOnly cookie — so "Wipes everything stored in this
   * browser, API keys included" was false: the keys survived and were
   * re-adopted on the next load.
   *
   * The subject cookie is deliberately NOT cleared: it identifies the browser
   * that owns the chats, and clearing it would orphan the history rather than
   * delete it.
   */
  const resetAll = async () => {
    try {
      await fetch("/api/auth/key", { method: "DELETE" }).catch(() => {});
    } finally {
      try {
        localStorage.clear();
      } finally {
        window.location.reload();
      }
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[760px] px-4 pb-16 pt-8 md:px-6">
        <PageHeader
          title="Settings"
          subtitle="Your connection, model, and app preferences."
        />

        <div className="space-y-10">
          <SettingsSection
            title="Connection"
            description="The Hydra DB that answers are retrieved from."
          >
            <ConnectForm compact />
          </SettingsSection>

          <SettingsSection
            title="LLM provider"
            description="The model that writes your answers. Any OpenAI-compatible endpoint works."
          >
            <div className="space-y-4 px-4 py-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Base URL">
                  <input
                    className="input font-mono text-[12px]"
                    type="text"
                    placeholder="https://openrouter.ai/api/v1"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
                <Field label="Model">
                  <ModelPicker value={model} onChange={setModel} />
                </Field>
              </div>

              <Field label="API key" hint="Paste it once. It is not shown again after saving.">
                <div className="relative">
                  <input
                    className="input pr-9 font-mono text-[12px]"
                    type={showKey ? "text" : "password"}
                    placeholder="sk-or-v1-… or sk-…"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-fg-4 transition-colors hover:text-fg"
                    aria-label={showKey ? "Hide API key" : "Show API key"}
                  >
                    <Icon name={showKey ? "eyeOff" : "eye"} size={15} />
                  </button>
                </div>
              </Field>
            </div>

            <SettingsFooter
              note={
                testResult ? (
                  <span
                    className={cn(
                      "inline-flex max-w-full items-center gap-1.5",
                      testResult.ok ? "text-good" : "text-bad",
                    )}
                    title={testResult.text}
                  >
                    <Icon name={testResult.ok ? "check" : "alert"} size={12} className="shrink-0" />
                    <span className="truncate">{testResult.text}</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5">
                    <Icon name="lock" size={12} className="shrink-0" />
                    Stored encrypted on the server, sent only to your provider.
                  </span>
                )
              }
            >
              <button className={btn.secondary} onClick={() => void testLlm()} disabled={testing}>
                {testing ? <Spinner size={13} /> : <Icon name="bolt" size={13} />}
                Test
              </button>
              <button className={btn.primary} onClick={saveLlm}>
                Save
              </button>
            </SettingsFooter>
          </SettingsSection>

          <SettingsSection
            title="Personalize"
            description="Instructions added to every answer's system prompt."
          >
            <div className="px-4 py-4">
              <textarea
                className="input h-auto min-h-[110px] resize-y py-2.5 text-[13px] leading-relaxed"
                placeholder="e.g. Always answer in bullet points…"
                aria-label="Answer instructions"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
              />
            </div>
            <SettingsFooter note="Applies to new answers.">
              <button className={btn.primary} onClick={saveInstructions}>
                Save
              </button>
            </SettingsFooter>
          </SettingsSection>

          <SettingsSection
            title="Your data"
            description="Chats are saved against this browser, not an account."
          >
            <SettingsRow
              label="Export chats"
              description="Download every conversation as JSON. Clearing cookies makes chats unreachable, so export first to keep them."
            >
              <a className={btn.secondary} href="/api/chats/data" download="open-glean-chats.json">
                <Icon name="download" size={13} />
                Export
              </a>
            </SettingsRow>
            <SettingsRow
              label="Delete all chats"
              description="Remove every conversation saved against this browser from the server."
            >
              <button className={btn.danger} onClick={() => setConfirmErase(true)}>
                Delete all
              </button>
            </SettingsRow>
          </SettingsSection>

          <SettingsSection title="About">
            <SettingsRow label="Version">
              <span className="font-mono text-[12px] text-fg-3">v{VERSION}</span>
            </SettingsRow>
            <SettingsRow
              label="Open source"
              description="Open Glean runs against your Hydra DB with your model key."
            >
              <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className={btn.secondary}>
                <Icon name="github" size={13} />
                GitHub
              </a>
              <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className={btn.secondary}>
                <Icon name="book" size={13} />
                Docs
              </a>
            </SettingsRow>
          </SettingsSection>

          <SettingsSection title="Danger zone" danger>
            <SettingsRow
              label="Reset everything"
              description="Clears API keys, model settings, and chat history stored in this browser. Your Hydra DB is not affected."
            >
              <button className={btn.danger} onClick={() => setConfirmReset(true)}>
                Reset
              </button>
            </SettingsRow>
          </SettingsSection>
        </div>
      </div>

      <ConfirmDialog
        open={confirmErase}
        onClose={() => setConfirmErase(false)}
        onConfirm={eraseChats}
        title="Delete all chats?"
        message="Every conversation saved against this browser is removed from the server. This can't be undone."
        confirmLabel="Delete all"
      />

      <ConfirmDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        onConfirm={resetAll}
        title="Reset everything?"
        message="This clears all locally stored Open Glean data in this browser. This can't be undone."
        confirmLabel="Reset"
      />
    </div>
  );
}
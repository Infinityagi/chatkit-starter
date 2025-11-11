"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChatKit, useChatKit } from "@openai/chatkit-react";
import {
  STARTER_PROMPTS,
  PLACEHOLDER_INPUT,
  GREETING,
  CREATE_SESSION_ENDPOINT,
  WORKFLOW_ID,
  getThemeConfig,
} from "@/lib/config";
import { ErrorOverlay } from "./ErrorOverlay";
import type { ColorScheme } from "@/hooks/useColorScheme";

export type FactAction = {
  type: "save";
  factId: string;
  factText: string;
};

type ChatKitPanelProps = {
  theme: ColorScheme;
  onWidgetAction: (action: FactAction) => Promise<void>;
  onResponseEnd: () => void;
  onThemeRequest: (scheme: ColorScheme) => void;
};

type ErrorState = {
  script: string | null;
  session: string | null;
  integration: string | null;
  retryable: boolean;
};

type ClientToolInvocation = {
  name: string;
  params: Record<string, unknown>;
};

const isBrowser = typeof window !== "undefined";
const isDev = process.env.NODE_ENV !== "production";

const createInitialErrors = (): ErrorState => ({
  script: null,
  session: null,
  integration: null,
  retryable: false,
});

/* ----------------------------- small helpers ---------------------------- */

function hasChatKitWebComponent(): boolean {
  if (!isBrowser) return false;
  return typeof window.customElements?.get === "function"
    ? Boolean(window.customElements.get("openai-chatkit"))
    : false;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function getStringParam(
  params: Record<string, unknown>,
  key: string
): string | null {
  const v = params[key];
  return typeof v === "string" ? v : null;
}

function extractErrorDetail(
  payload: Record<string, unknown> | undefined,
  fallback: string
): string {
  if (!payload) return fallback;

  // { error: "..." }
  const errStr = payload.error;
  if (typeof errStr === "string") return errStr;

  // { error: { message: "..." } }
  const errObj = payload.error;
  if (isRecord(errObj)) {
    const msg = errObj.message;
    if (typeof msg === "string") return msg;
  }

  // { details: "..." }
  const detailsStr = payload.details;
  if (typeof detailsStr === "string") return detailsStr;

  // { details: { error: "..." | { message: "..." } } }
  const detailsObj = payload.details;
  if (isRecord(detailsObj)) {
    const nested = detailsObj.error;
    if (typeof nested === "string") return nested;
    if (isRecord(nested)) {
      const m = nested.message;
      if (typeof m === "string") return m;
    }
  }

  // { message: "..." }
  const topMsg = payload.message;
  if (typeof topMsg === "string") return topMsg;

  return fallback;
}

/* ----------------------------------------------------------------------- */

export function ChatKitPanel({
  theme,
  onWidgetAction,
  onResponseEnd,
  onThemeRequest,
}: ChatKitPanelProps) {
  const processedFacts = useRef(new Set<string>());
  const [errors, setErrors] = useState<ErrorState>(() => createInitialErrors());
  const [isInitializingSession, setIsInitializingSession] = useState(true);
  const isMountedRef = useRef(true);
  const [scriptStatus, setScriptStatus] = useState<"pending" | "ready" | "error">(
    () => (hasChatKitWebComponent() ? "ready" : "pending")
  );
  const [widgetInstanceKey, setWidgetInstanceKey] = useState(0);

  const setErrorState = useCallback((updates: Partial<ErrorState>) => {
    setErrors((current) => ({ ...current, ...updates }));
  }, []);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isBrowser) return;

    let timeoutId: number | undefined;

    const handleLoaded = () => {
      if (!isMountedRef.current) return;
      setScriptStatus("ready");
      setErrorState({ script: null });
    };

    const handleError = (_event: Event) => {
      // no reliance on event.detail, keeps strict typing
      if (!isMountedRef.current) return;
      setScriptStatus("error");
      setErrorState({
        script:
          "ChatKit web component failed to load. Verify the script URL is reachable.",
        retryable: false,
      });
      setIsInitializingSession(false);
    };

    window.addEventListener("chatkit-script-loaded", handleLoaded);
    window.addEventListener("chatkit-script-error", handleError);

    if (hasChatKitWebComponent()) {
      handleLoaded();
    } else if (scriptStatus === "pending") {
      timeoutId = window.setTimeout(() => {
        if (!hasChatKitWebComponent()) {
          handleError(new Event("chatkit-script-error"));
        }
      }, 5000);
    }

    return () => {
      window.removeEventListener("chatkit-script-loaded", handleLoaded);
      window.removeEventListener("chatkit-script-error", handleError);
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [scriptStatus, setErrorState]);

  const isWorkflowConfigured = Boolean(
    WORKFLOW_ID && !WORKFLOW_ID.startsWith("wf_replace")
  );

  useEffect(() => {
    if (!isWorkflowConfigured && isMountedRef.current) {
      setErrorState({
        session: "Set NEXT_PUBLIC_CHATKIT_WORKFLOW_ID in your .env.local file.",
        retryable: false,
      });
      setIsInitializingSession(false);
    }
  }, [isWorkflowConfigured, setErrorState]);

  const handleResetChat = useCallback(() => {
    processedFacts.current.clear();
    setScriptStatus(hasChatKitWebComponent() ? "ready" : "pending");
    setIsInitializingSession(true);
    setErrors(createInitialErrors());
    setWidgetInstanceKey((prev) => prev + 1);
  }, []);

  const getClientSecret = useCallback(
    async (currentSecret: string | null) => {
      if (!isWorkflowConfigured) {
        const detail =
          "Set NEXT_PUBLIC_CHATKIT_WORKFLOW_ID in your .env.local file.";
        if (isMountedRef.current) {
          setErrorState({ session: detail, retryable: false });
          setIsInitializingSession(false);
        }
        throw new Error(detail);
      }

      if (isMountedRef.current) {
        if (!currentSecret) setIsInitializingSession(true);
        setErrorState({ session: null, integration: null, retryable: false });
      }

      try {
        const response = await fetch(CREATE_SESSION_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workflow: { id: WORKFLOW_ID },
            chatkit_configuration: { file_upload: { enabled: true } },
          }),
        });

        const raw = await response.text();

        let data: Record<string, unknown> = {};
        if (raw) {
          try {
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            // keep quiet; we'll use fallback below
          }
        }

        if (!response.ok) {
          const detail = extractErrorDetail(data, response.statusText);
          throw new Error(detail);
        }

        const clientSecret = data?.client_secret;
        if (typeof clientSecret !== "string" || clientSecret.length === 0) {
          throw new Error("Missing client secret in response");
        }

        if (isMountedRef.current) {
          setErrorState({ session: null, integration: null });
        }
        return clientSecret;
      } catch (error) {
        const detail =
          error instanceof Error
            ? error.message
            : "Unable to start ChatKit session.";
        if (isMountedRef.current) {
          setErrorState({ session: detail, retryable: false });
        }
        throw error instanceof Error ? error : new Error(detail);
      } finally {
        if (isMountedRef.current && !currentSecret) {
          setIsInitializingSession(false);
        }
      }
    },
    [isWorkflowConfigured, setErrorState]
  );

  const chatkit = useChatKit({
    api: { getClientSecret },
    theme: { colorScheme: theme, ...getThemeConfig(theme) },
    startScreen: { greeting: GREETING, prompts: STARTER_PROMPTS },
    composer: {
      placeholder: PLACEHOLDER_INPUT,
      attachments: { enabled: true },
    },
    threadItemActions: { feedback: false },
    onClientTool: async (invocation: ClientToolInvocation) => {
      if (invocation.name === "switch_theme") {
        const requested = getStringParam(invocation.params, "theme");
        if (requested === "light" || requested === "dark") {
          onThemeRequest(requested);
          return { success: true };
        }
        return { success: false };
      }

      if (invocation.name === "record_fact") {
        const id = getStringParam(invocation.params, "fact_id") ?? "";
        const text = getStringParam(invocation.params, "fact_text") ?? "";
        if (!id || processedFacts.current.has(id)) {
          return { success: true };
        }
        processedFacts.current.add(id);
        void onWidgetAction({
          type: "save",
          factId: id,
          factText: text.replace(/\s+/g, " ").trim(),
        });
        return { success: true };
      }

      return { success: false };
    },
    onResponseEnd: () => {
      onResponseEnd();
    },
    onResponseStart: () => {
      setErrorState({ integration: null, retryable: false });
    },
    onThreadChange: () => {
      processedFacts.current.clear();
    },
    onError: ({ error }: { error: unknown }) => {
      // ChatKit UI already shows user-facing errors; keep logs developer-only.
      // This keeps types strict (no 'any').
      // eslint-disable-next-line no-console
      console.error("ChatKit error", error);
    },
  });

  const activeError = errors.session ?? errors.integration;
  const blockingError = errors.script ?? activeError;

  return (
    <div
      className={[
        "relative w-full",
        "h-[100dvh]", // fill visible window height across browsers
        "rounded-none md:rounded-2xl",
        "overflow-hidden",
        "bg-white/55 dark:bg-slate-900/55",
        "backdrop-blur-md",
        "border border-white/45 dark:border-slate-500/25",
        "shadow-[0_25px_60px_rgba(2,6,23,0.12),_0_10px_20px_rgba(2,6,23,0.08)]",
        "transition-colors",
      ].join(" ")}
      style={{ maxWidth: "1400px", marginInline: "auto" }}
    >
      <ChatKit
        key={widgetInstanceKey}
        control={chatkit.control}
        className={
          blockingError || isInitializingSession
            ? "pointer-events-none opacity-0"
            : "block h-full w-full"
        }
      />
      <ErrorOverlay
        error={blockingError}
        fallbackMessage={
          blockingError || !isInitializingSession
            ? null
            : "Loading assistant session..."
        }
        onRetry={blockingError && errors.retryable ? handleResetChat : null}
        retryLabel="Restart chat"
      />
    </div>
  );
}

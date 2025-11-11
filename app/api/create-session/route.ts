import { WORKFLOW_ID } from "@/lib/config";

/**
 * Run on Vercel Edge (low cold-start) and pin close to OpenAI's US-East.
 */
export const runtime = "edge";
export const preferredRegion = ["iad1"];

/** Incoming body schema (optional fields supported) */
interface CreateSessionRequestBody {
  workflow?: { id?: string | null } | null;
  workflowId?: string | null;
  scope?: { user_id?: string | null } | null; // accepted but unused
  chatkit_configuration?: {
    file_upload?: { enabled?: boolean };
  };
}

/** Upstream (OpenAI) session response */
interface ChatKitSessionResponse {
  client_secret?: string;
  expires_after?: number | string | null;
  error?: unknown;
  details?: unknown;
  message?: unknown;
}

const DEFAULT_CHATKIT_BASE = "https://api.openai.com";
const SESSION_COOKIE_NAME = "chatkit_session_id";
const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/** Create a session — POST only (GET shows a helper message) */
export async function POST(request: Request): Promise<Response> {
  let sessionCookie: string | null = null;

  try {
    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      return json(
        {
          error: "Missing OPENAI_API_KEY environment variable",
          hint:
            "Set it in Vercel → Project → Settings → Environment Variables (Production/Preview).",
        },
        500
      );
    }

    // Resolve sticky user id from cookie (or generate one)
    const resolved = await resolveUserId(request);
    const userId = resolved.userId;
    sessionCookie = resolved.sessionCookie;

    // Parse optional body
    const body = await safeParseJson<CreateSessionRequestBody>(request);

    // Resolve workflow id: body.workflow.id → body.workflowId → config default
    const resolvedWorkflowId =
      body?.workflow?.id ?? body?.workflowId ?? WORKFLOW_ID;

    if (!resolvedWorkflowId) {
      return json(
        {
          error: "Missing workflow id",
          hint:
            "Provide { workflow: { id: 'wf_...' } } in POST body, or set WORKFLOW_ID in '@/lib/config'.",
        },
        400,
        undefined,
        sessionCookie
      );
    }

    const apiBase = process.env.CHATKIT_API_BASE ?? DEFAULT_CHATKIT_BASE;
    const url = `${apiBase}/v1/chatkit/sessions`;

    const fileUploadEnabled =
      body?.chatkit_configuration?.file_upload?.enabled ?? false;

    // Call OpenAI ChatKit Sessions API
    const upstreamResponse = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "chatkit_beta=v1",
      },
      body: JSON.stringify({
        user: userId,
        workflow: { id: resolvedWorkflowId },
        chatkit_configuration: {
          file_upload: { enabled: fileUploadEnabled },
        },
      }),
      redirect: "manual",
      cache: "no-store",
    });

    const upstreamJson = (await upstreamResponse.json().catch(() => ({}))) as unknown;

    if (!upstreamResponse.ok) {
      const upstreamError = extractUpstreamError(upstreamJson);
      console.error("[create-session] upstream error", {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        error: upstreamError,
      });

      return json(
        {
          error:
            upstreamError ??
            `Failed to create session: ${upstreamResponse.status} ${upstreamResponse.statusText}`,
        },
        upstreamResponse.status,
        undefined,
        sessionCookie
      );
    }

    // Happy path
    const parsed = toChatKitSessionResponse(upstreamJson);
    const clientSecret = parsed.client_secret ?? null;
    const expiresAfter = parsed.expires_after ?? null;

    return json(
      { client_secret: clientSecret, expires_after: expiresAfter },
      200,
      undefined,
      sessionCookie
    );
  } catch (err) {
    console.error("[create-session] unexpected error", err);
    return json(
      { error: "Unexpected error while creating session" },
      500,
      undefined,
      sessionCookie
    );
  }
}

/** Helpful GET for quick sanity checks in a browser tab */
export async function GET(): Promise<Response> {
  return json({
    info: "POST here to create a ChatKit client_secret.",
    expects: { user: "derived from cookie", workflow: { id: "wf_..." } },
    ok_example: { client_secret: "cs_..." },
  });
}

/* ------------------------------- helpers -------------------------------- */

function json(
  payload: unknown,
  status = 200,
  headers?: Record<string, string>,
  sessionCookie?: string | null
): Response {
  const resHeaders = new Headers(
    headers ?? { "Content-Type": "application/json" }
  );
  if (sessionCookie) resHeaders.append("Set-Cookie", sessionCookie);
  return new Response(JSON.stringify(payload), { status, headers: resHeaders });
}

async function resolveUserId(
  request: Request
): Promise<{ userId: string; sessionCookie: string | null }> {
  const existing = getCookieValue(request.headers.get("cookie"), SESSION_COOKIE_NAME);
  if (existing) return { userId: existing, sessionCookie: null };

  const generated =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);

  return { userId: generated, sessionCookie: serializeSessionCookie(generated) };
}

function getCookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  const parts = header.split(";");
  for (const part of parts) {
    const [rawName, ...rest] = part.split("=");
    if (!rawName || rest.length === 0) continue;
    if (rawName.trim() === name) return rest.join("=").trim();
  }
  return null;
}

function serializeSessionCookie(value: string): string {
  const attrs = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${SESSION_COOKIE_MAX_AGE}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (process.env.NODE_ENV === "production") attrs.push("Secure");
  return attrs.join("; ");
}

async function safeParseJson<T>(req: Request): Promise<T | null> {
  try {
    const text = await req.text();
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

/** Type guards & extractors (avoid 'any') */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getNestedMessage(obj: unknown): string | null {
  if (!isRecord(obj)) return null;
  const err = obj["error"];
  if (isRecord(err)) {
    const msg = err["message"];
    if (typeof msg === "string") return msg;
  }
  const top = obj["message"];
  if (typeof top === "string") return top;

  const details = obj["details"];
  if (isRecord(details)) {
    const inner = details["error"];
    if (typeof inner === "string") return inner;
    if (isRecord(inner)) {
      const m = inner["message"];
      if (typeof m === "string") return m;
    }
  }
  return null;
}

function extractUpstreamError(payload: unknown): string | null {
  const msg = getNestedMessage(payload);
  if (msg) return msg;
  if (isRecord(payload)) {
    const asStr = payload["error"];
    if (typeof asStr === "string") return asStr;
  }
  return null;
}

function toChatKitSessionResponse(value: unknown): ChatKitSessionResponse {
  const out: ChatKitSessionResponse = {};
  if (!isRecord(value)) return out;

  const cs = value["client_secret"];
  if (typeof cs === "string") out.client_secret = cs;

  const exp = value["expires_after"];
  if (typeof exp === "number" || typeof exp === "string") {
    out.expires_after = exp;
  } else if (exp === null) {
    out.expires_after = null;
  }

  if ("error" in value) out.error = (value as Record<string, unknown>)["error"];
  if ("details" in value) out.details = (value as Record<string, unknown>)["details"];
  if ("message" in value) out.message = (value as Record<string, unknown>)["message"];

  return out;
}

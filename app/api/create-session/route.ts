import { WORKFLOW_ID } from "@/lib/config";

/**
 * Run on Vercel Edge (low cold-start) and pin close to OpenAI's US-East
 * You can change preferredRegion if most users are elsewhere.
 */
export const runtime = "edge";
export const preferredRegion = ["iad1"];

/** Incoming body schema (optional fields supported) */
interface CreateSessionRequestBody {
  workflow?: { id?: string | null } | null;
  workflowId?: string | null; // convenience alias
  scope?: { user_id?: string | null } | null; // not used here, but accepted
  chatkit_configuration?: {
    file_upload?: { enabled?: boolean };
  };
}

/** Defaults */
const DEFAULT_CHATKIT_BASE = "https://api.openai.com";
const SESSION_COOKIE_NAME = "chatkit_session_id";
const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/** Create a session — POST only (GET returns a helpful hint for debugging) */
export async function POST(request: Request): Promise<Response> {
  let sessionCookie: string | null = null;

  try {
    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      return json(
        {
          error: "Missing OPENAI_API_KEY environment variable",
          hint: "Set it in Vercel → Project → Settings → Environment Variables",
        },
        500
      );
    }

    // Resolve a sticky user id from a cookie (or generate one)
    const { userId, sessionCookie: resolvedSessionCookie } = await resolveUserId(
      request
    );
    sessionCookie = resolvedSessionCookie;

    // Parse optional body (Edge Request.body can be read once, so do it here)
    const body = await safeParseJson<CreateSessionRequestBody>(request);

    // Resolve workflow id: explicit in body → alias → config fallback
    const resolvedWorkflowId =
      body?.workflow?.id ?? body?.workflowId ?? WORKFLOW_ID;

    if (!resolvedWorkflowId) {
      return json(
        {
          error: "Missing workflow id",
          hint:
            "Provide { workflow: { id: 'wf_...' } } in the POST body, or set WORKFLOW_ID in '@/lib/config'.",
        },
        400,
        undefined,
        sessionCookie
      );
    }

    const apiBase = process.env.CHATKIT_API_BASE ?? DEFAULT_CHATKIT_BASE;
    const url = `${apiBase}/v1/chatkit/sessions`;

    // Optional passthrough for UI features like file upload
    const fileUploadEnabled =
      body?.chatkit_configuration?.file_upload?.enabled ?? false;

    // Create the session with ChatKit (beta header is REQUIRED)
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

    const upstreamJson = (await upstreamResponse
      .json()
      .catch(() => ({}))) as Record<string, unknown> | undefined;

    if (!upstreamResponse.ok) {
      const upstreamError = extractUpstreamError(upstreamJson);
      console.error("[create-session] upstream error", {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        body: upstreamJson,
      });
      return json(
        {
          error:
            upstreamError ??
            `Failed to create session: ${upstreamResponse.status} ${upstreamResponse.statusText}`,
          details: upstreamJson,
        },
        upstreamResponse.status,
        undefined,
        sessionCookie
      );
    }

    // Happy path: return only what the client needs
    const clientSecret = (upstreamJson as any)?.client_secret ?? null;
    const expiresAfter = (upstreamJson as any)?.expires_after ?? null;

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

/**
 * Helpful GET for quick sanity checks in a browser tab:
 *  - shows what the endpoint expects
 *  - avoids a blank 405 page
 */
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
  const resHeaders = new Headers(headers ?? { "Content-Type": "application/json" });
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
  for (const part of header.split(";")) {
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

function extractUpstreamError(
  payload: Record<string, unknown> | undefined
): string | null {
  if (!payload) return null;

  const error = (payload as any).error;
  if (typeof error === "string") return error;

  if (error && typeof error === "object" && "message" in error) {
    const msg = (error as any).message;
    if (typeof msg === "string") return msg;
  }

  const details = (payload as any).details;
  if (typeof details === "string") return details;

  if (details && typeof details === "object" && "error" in details) {
    const nested = (details as any).error;
    if (typeof nested === "string") return nested;
    if (nested && typeof nested === "object" && "message" in nested) {
      const msg = (nested as any).message;
      if (typeof msg === "string") return msg;
    }
  }

  if (typeof (payload as any).message === "string") return (payload as any).message;
  return null;
}

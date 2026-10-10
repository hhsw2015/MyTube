import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Response } from "express";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { DATA_DIR } from "../config/paths";
import { logger } from "../utils/logger";

/**
 * The signing key that shipped as a fallback before this was fixed. It is public
 * (it lived in the repository), so any token signed with it must be treated as
 * attacker-controlled. Kept here only so we can refuse to use it.
 */
export const COMPROMISED_LEGACY_JWT_SECRET =
  "default_development_secret_do_not_use_in_production";

/**
 * Resolve the JWT signing key, failing safe when none is configured.
 *
 * JWTs never leave this process: login mints one, `setAuthCookie` immediately
 * exchanges it for an opaque server-side session id, and no response body
 * returns a token. Sessions live in an in-memory Map, so nothing has to survive
 * a restart either. That means an unconfigured deployment can safely get a
 * random per-process key rather than a shared constant — no shipped compose file
 * sets JWT_SECRET, so refusing to boot would break every default install while
 * a random key breaks nothing.
 */
function resolveJwtSecret(): string {
  const configured = process.env.JWT_SECRET?.trim();

  if (configured === COMPROMISED_LEGACY_JWT_SECRET) {
    const message =
      "JWT_SECRET is set to the publicly known default that shipped with older " +
      "MyTube versions. Anyone can forge admin tokens with it. Unset JWT_SECRET " +
      "or replace it with a unique random value before starting.";
    logger.error(message);
    throw new Error(message);
  }

  if (configured) {
    return configured;
  }

  logger.warn(
    "JWT_SECRET is not set; generating a random per-process signing key. " +
      "Auth sessions are in-memory and do not survive a restart either way."
  );
  return crypto.randomBytes(64).toString("hex");
}

const JWT_SECRET = resolveJwtSecret();
const JWT_EXPIRES_IN = "24h";
const SESSION_COOKIE_NAME = "mytube_auth_session";
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface AuthSession {
  payload: UserPayload;
  expiresAt: number;
}

const authSessions = new Map<string, AuthSession>();

/**
 * Opaque session ids live in an in-memory Map, so a process restart (or a VM
 * recycle) would log everyone out. Persist the Map to disk on every mutation and
 * reload it on boot so logins survive restarts. The store holds bearer session
 * ids, so it MUST live outside any web-served directory: default to DATA_DIR
 * (never served), overridable via MYTUBE_SESSION_STORE to point at a volume that
 * survives recycles (e.g. a persistent mount) when DATA_DIR itself does not.
 */
const SESSION_STORE_PATH = process.env.MYTUBE_SESSION_STORE
  ? path.resolve(process.env.MYTUBE_SESSION_STORE)
  : path.join(DATA_DIR, "sessions.json");

function persistSessions(): void {
  try {
    fs.mkdirSync(path.dirname(SESSION_STORE_PATH), { recursive: true });
    const tmp = `${SESSION_STORE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...authSessions.entries()]), {
      mode: 0o600,
    });
    fs.renameSync(tmp, SESSION_STORE_PATH); // atomic replace
  } catch (error) {
    logger.warn(
      "Failed to persist auth sessions",
      error instanceof Error ? error : new Error(String(error))
    );
  }
}

function loadSessions(): void {
  try {
    const entries = JSON.parse(
      fs.readFileSync(SESSION_STORE_PATH, "utf8")
    ) as [string, AuthSession][];
    const now = Date.now();
    for (const [sessionId, session] of entries) {
      if (session?.expiresAt > now) {
        authSessions.set(sessionId, session);
      }
    }
    if (authSessions.size > 0) {
      logger.info(`Restored ${authSessions.size} auth session(s) from disk`);
    }
  } catch {
    // No store yet / unreadable / corrupt: start with an empty session map.
  }
}

loadSessions();

function pruneExpiredSessions(): void {
  const now = Date.now();
  let removed = 0;
  for (const [sessionId, session] of authSessions.entries()) {
    if (session.expiresAt <= now) {
      authSessions.delete(sessionId);
      removed += 1;
    }
  }
  if (removed > 0) {
    persistSessions();
  }
}

function createSession(payload: UserPayload): string {
  pruneExpiredSessions();
  const sessionId = uuidv4();
  authSessions.set(sessionId, {
    payload,
    expiresAt: Date.now() + SESSION_MAX_AGE_MS,
  });
  persistSessions();
  return sessionId;
}

export interface UserPayload {
  role: "admin" | "visitor";
  id?: string;
  userId?: string;
  username?: string;
  sessionVersion?: number;
}

/**
 * Generate a JWT token for a user
 */
export const generateToken = (payload: UserPayload): string => {
  return jwt.sign({ ...payload, id: payload.id || uuidv4() }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  });
};

/**
 * Verify a JWT token
 */
export const verifyToken = (token: string): UserPayload | null => {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as UserPayload;
    return decoded;
  } catch (error) {
    return null;
  }
};

/**
 * Resolve a session cookie to a user payload.
 */
export const getUserPayloadFromSession = (
  sessionId: string,
): UserPayload | null => {
  if (!sessionId) {
    return null;
  }

  pruneExpiredSessions();
  const session = authSessions.get(sessionId);
  if (!session) {
    return null;
  }

  return session.payload;
};

export const deleteSession = (sessionId: string): void => {
  if (!sessionId) {
    return;
  }

  if (authSessions.delete(sessionId)) {
    persistSessions();
  }
};

export const revokeSessionsByUserId = (userId: string): number => {
  let revoked = 0;

  for (const [sessionId, session] of authSessions.entries()) {
    if (session.payload.userId === userId) {
      authSessions.delete(sessionId);
      revoked += 1;
    }
  }

  if (revoked > 0) {
    persistSessions();
  }

  return revoked;
};

export const updateSessionUsernames = (
  userId: string,
  username: string
): void => {
  let changed = false;
  for (const session of authSessions.values()) {
    if (session.payload.userId === userId) {
      session.payload.username = username;
      changed = true;
    }
  }
  if (changed) {
    persistSessions();
  }
};

/**
 * Set HTTP-only cookie with opaque server-side session id
 * This avoids storing sensitive auth material in clear-text client cookies.
 */
/**
 * Decide whether auth cookies should carry the `Secure` attribute.
 *
 * Secure cookies are not sent by browsers over plain HTTP, which would break
 * the common LAN-over-HTTP self-hosted deployment. So we enable `Secure`
 * automatically when the request actually arrived over HTTPS (req.secure is
 * derived from x-forwarded-proto under `trust proxy`), and still honour an
 * explicit SECURE_COOKIES=true opt-in for setups that terminate TLS opaquely.
 */
const shouldUseSecureCookie = (res: Response): boolean => {
  return process.env.SECURE_COOKIES === "true" || res.req?.secure === true;
};

export const setAuthCookie = (
  res: Response,
  token: string,
  role: "admin" | "visitor",
): string => {
  const payload = verifyToken(token) ?? { role, id: uuidv4() };
  const sessionId = createSession(payload);
  const isSecure = shouldUseSecureCookie(res);

  res.cookie(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true, // Not accessible to JavaScript, preventing XSS attacks
    secure: isSecure, // Only sent over HTTPS if explicitly configured
    sameSite: "lax", // Better persistence across navigations
    maxAge: SESSION_MAX_AGE_MS,
    path: "/",
  });

  return sessionId;
};

/**
 * Clear authentication cookies
 */
export const clearAuthCookie = (res: Response): void => {
  const isSecure = shouldUseSecureCookie(res);
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax",
    path: "/",
  });
  // Legacy cleanup for older clients.
  res.clearCookie("mytube_role", {
    httpOnly: false,
    secure: isSecure,
    sameSite: "lax",
    path: "/",
  });
};

/**
 * Get cookie name for authentication session id
 */
export const getAuthCookieName = (): string => {
  return SESSION_COOKIE_NAME;
};

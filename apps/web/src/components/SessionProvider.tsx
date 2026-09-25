"use client";

import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/**
 * Who is signed in, as reported by the server. This decides only what the interface offers; every
 * operation is authorized again on the server and in the database.
 */
export interface SignedInUser {
  readonly userAccountId: string;
  readonly loginIdentifier: string;
  readonly displayName: string;
  readonly jobTitle: string | null;
  readonly legalEntityName: string;
  readonly permissions: readonly string[];
  readonly sessionExpiresAt: string;
}

interface SessionValue {
  readonly status: "loading" | "signed-in" | "signed-out";
  readonly user: SignedInUser | null;
  readonly can: (permission: string) => boolean;
  readonly refresh: () => Promise<void>;
  readonly signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

async function fetchMe(): Promise<SignedInUser | null> {
  try {
    const response = await fetch("/api/v1/auth/me", { cache: "no-store" });
    if (!response.ok) return null;
    const body = await response.json() as { ok: boolean; data?: SignedInUser };
    return body.ok && body.data ? body.data : null;
  } catch {
    return null;
  }
}

export function SessionProvider({ children }: Readonly<{ children: ReactNode }>) {
  const pathname = usePathname();
  const [user, setUser] = useState<SignedInUser | null>(null);
  const [status, setStatus] = useState<SessionValue["status"]>("loading");

  const refresh = useCallback(async () => {
    const next = await fetchMe();
    setUser(next);
    setStatus(next ? "signed-in" : "signed-out");
  }, []);

  // Re-read on navigation, so a suspension or permission change shows up without a reload.
  useEffect(() => {
    let current = true;
    void fetchMe().then((next) => {
      if (!current) return;
      setUser(next);
      setStatus(next ? "signed-in" : "signed-out");
    });
    return () => { current = false; };
  }, [pathname]);

  const signOut = useCallback(async () => {
    await fetch("/api/v1/auth/logout", { method: "POST", cache: "no-store" }).catch(() => undefined);
    setUser(null);
    setStatus("signed-out");
  }, []);

  const value = useMemo<SessionValue>(() => ({
    status, user, refresh, signOut,
    can: (permission: string) => user?.permissions.includes(permission) ?? false
  }), [refresh, signOut, status, user]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used within SessionProvider");
  return value;
}

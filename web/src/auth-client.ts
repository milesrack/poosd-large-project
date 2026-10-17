import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();

export type User = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
};

let renewing: Promise<boolean> | null = null;

export function renewAccess() {
  renewing ??= fetch("/api/access", { method: "POST" })
    .then((response) => response.ok)
    .finally(() => {
      renewing = null;
    });

  return renewing;
}

export async function apiFetch(path: string, options?: RequestInit) {
  const response = await fetch(path, options);

  if (response.status !== 401) {
    return response;
  }

  if (!(await renewAccess())) {
    return response;
  }

  return fetch(path, options);
}

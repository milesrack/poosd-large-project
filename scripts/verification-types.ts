import type { Profile, RunEvent, Settings } from "../shared/contracts.ts";

export interface RequestOptions {
  method?: string;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
  status?: number;
}

export interface AccountResponse {
  user: { id: string; name: string };
  token?: string | null;
  code?: string;
  message?: string;
}

export type { Profile, RunEvent } from "../shared/contracts.ts";

export interface MailSearch {
  messages?: { ID: string; Subject: string }[];
}

export interface MailMessage {
  Text: string;
}

export interface Run {
  id: string;
  status: string;
  error?: string;
  attempts: number;
  accepted: number;
  profile: Profile;
  settings: Settings;
  events: RunEvent[];
}

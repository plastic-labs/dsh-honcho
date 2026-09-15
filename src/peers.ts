/**
 * Per-session user peer bindings.
 *
 * `peerName` is resolved once per PROCESS (core-shim's ladder: env → host →
 * root → $USER). That is right for a terminal where one human drives one
 * install, and wrong for a long-lived `dsh-web` whose `/api` is driven by a
 * human in the browser AND by an agent over the RPC: both sets of turns land on
 * one Honcho peer, so the agent's phrasing is absorbed into the human's
 * representation and injected back at them next session.
 *
 * dsh cannot tell us who is talking — `user/message` carries
 * `source: { kind: 'user' }` with no identity, and `CommandSourceMap` documents
 * the assumption outright ("every executor caller is a human-facing UI surface
 * dispatching a human-typed line"). OpenClaw reads a `sender_id` the harness
 * stamps into the message; there is no equivalent here. So the binding is
 * declared instead of detected: the client that owns a session says who it is,
 * once, and we remember it against the dsh session id.
 *
 * Keyed by **dsh session id** for the same reason cursors are: many dsh
 * sessions map to one Honcho session, and "who is driving" is a property of the
 * dsh session, not of the Honcho session it feeds.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ResolvedConfig } from "./core-shim.js";

/** Honcho enforces RESOURCE_NAME_PATTERN = ^[a-zA-Z0-9_-]+$, 1..100, on peer ids. */
const PEER_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const PEER_ID_MAX_LEN = 100;

/** Drop bindings untouched for this long; a finished session never resumes.
 *  Matches the cursor TTL — the two files age out together. */
const BINDING_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function peersPath(): string {
  const dir = process.env.HONCHO_CONFIG_DIR || join(homedir(), ".honcho");
  return join(dir, "dsh", "peers.json");
}

interface BindingEntry {
  peer: string;
  /** Epoch ms of the last write, for pruning. */
  at: number;
}

type BindingFile = Record<string, BindingEntry>;

/**
 * Reject a peer name Honcho would refuse, rather than binding it and failing
 * every later upload with a server-side validation error the user cannot trace
 * back to this command.
 */
export function validatePeerName(raw: string): { ok: true; name: string } | { ok: false; reason: string } {
  const name = raw.trim();
  if (!name) return { ok: false, reason: "a peer name is required" };
  if (name.length > PEER_ID_MAX_LEN) {
    return { ok: false, reason: `too long — Honcho peer ids are at most ${PEER_ID_MAX_LEN} characters` };
  }
  if (!PEER_ID_PATTERN.test(name)) {
    return { ok: false, reason: "only letters, digits, `-` and `_` are allowed in a Honcho peer id" };
  }
  return { ok: true, name };
}

export function readBindings(path = peersPath()): BindingFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object") return {};
    const out: BindingFile = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as BindingEntry;
      if (entry && typeof entry === "object" && typeof entry.peer === "string" && entry.peer) {
        out[key] = { peer: entry.peer, at: typeof entry.at === "number" ? entry.at : Date.now() };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function writeBinding(dshSessionId: string, peer: string, path = peersPath()): void {
  try {
    const bindings = readBindings(path);
    bindings[dshSessionId] = { peer, at: Date.now() };
    const cutoff = Date.now() - BINDING_TTL_MS;
    for (const [key, entry] of Object.entries(bindings)) {
      if (key !== dshSessionId && entry.at < cutoff) delete bindings[key];
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(bindings, null, 2), { mode: 0o600 });
  } catch {
    // A binding we cannot persist still holds in memory for this process. The
    // cost is a restart reverting to the configured peer, which is the same
    // behavior as never having bound — not a wrong attribution.
  }
}

export interface PeerBindings {
  /** The user peer for this dsh session: its binding, else the configured peer. */
  resolve(dshSessionId: string | undefined): string;
  /** True when this session's peer came from a binding rather than the config. */
  isBound(dshSessionId: string | undefined): boolean;
  /** Record a binding for this dsh session, in memory and on disk. */
  bind(dshSessionId: string, peer: string): void;
}

/**
 * Bindings are read on every upload and every context fetch, so they are held
 * in memory and hydrated from disk once. Persistence exists for resume: a
 * `dsh-web` restart would otherwise silently revert a bound session to the
 * configured peer, which is exactly the misattribution this feature removes.
 */
export function createPeerBindings(config: ResolvedConfig, path = peersPath()): PeerBindings {
  let cache: Map<string, string> | undefined;

  const load = (): Map<string, string> => {
    if (cache) return cache;
    cache = new Map(Object.entries(readBindings(path)).map(([id, entry]) => [id, entry.peer]));
    return cache;
  };

  return {
    resolve(dshSessionId) {
      if (!dshSessionId) return config.peerName;
      return load().get(dshSessionId) ?? config.peerName;
    },

    isBound(dshSessionId) {
      return dshSessionId ? load().has(dshSessionId) : false;
    },

    bind(dshSessionId, peer) {
      load().set(dshSessionId, peer);
      writeBinding(dshSessionId, peer, path);
    },
  };
}

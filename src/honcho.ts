/**
 * Honcho SDK gateway.
 *
 * One place that knows the SDK, so `observationMode` routing lives here rather
 * than being repeated at every call site. Unified: the user observes themselves,
 * every operation goes through the user peer with no target. Directional: the AI
 * peer observes the user, so operations run from the AI peer with the user as
 * target (`claude-honcho/plugins/honcho/src/mcp/server.ts:1097-1103`).
 */

import { Honcho, type Peer, type Session } from "@honcho-ai/sdk";
import { clientOptions, sessionName, type ResolvedConfig } from "./core-shim.js";
import { HEADER_AGENT_MODEL, telemetryHeaders, telemetryIdentity, type TelemetryOverrides } from "./telemetry.js";
import type { HonchoGateway } from "./tools.js";
import type { CapturedMessage } from "./capture.js";
import type { SessionContextResult } from "./memory.js";

/** Honcho caps messages per request; stay well inside it. */
const BATCH_LIMIT = 50;

export interface Gateway extends HonchoGateway {
  /** One call: summary + representation + peer card, shaped for injection. */
  fetchContext(
    cwd: string | undefined,
    dshSessionId: string | undefined,
    searchQuery: string | undefined,
  ): Promise<SessionContextResult | null>;
  /** The periodic background dialectic, shaped by `injection.dialectic`. */
  backgroundDialectic(cwd: string | undefined, dshSessionId: string | undefined, userQuery: string): Promise<string>;
  /** Create the session and associate both peers. Idempotent per process. */
  ensureSession(cwd: string | undefined, dshSessionId: string | undefined): Promise<void>;
  upload(sessionName: string, messages: CapturedMessage[]): Promise<void>;
}

/**
 * @param telemetry - the identity fields only a running session knows (harness
 *   version, current model), read fresh on every client access rather than
 *   captured once: the model changes mid-session and the first requests are
 *   made before any model has answered.
 */
export function createGateway(config: ResolvedConfig, telemetry: () => TelemetryOverrides = () => ({})): Gateway {
  const directional = config.observationMode === "directional";
  const ensured = new Set<string>();

  /** Host and plugin, formatted once. Memoized on resolution only: the harness
   *  version can be unresolvable until dsh has booted. */
  let base: Record<string, string> | undefined;
  const baseHeaders = (hostVersion: string | undefined): Record<string, string> => {
    if (base) return base;
    const headers = telemetryHeaders(telemetryIdentity(hostVersion ? { hostVersion } : {}));
    return hostVersion ? (base = headers) : headers;
  };

  /** Put the current model on a live header map, or take it off. Core's merge
   *  cannot clear a field, which would strand a stale model on a held client. */
  const syncModel = (headers: Record<string, string>, model: string | undefined): void => {
    const value = model ? telemetryHeaders({ model })[HEADER_AGENT_MODEL] : undefined;
    if (value) headers[HEADER_AGENT_MODEL] = value;
    else delete headers[HEADER_AGENT_MODEL];
  };

  /**
   * `@honcho-ai/sdk` 2.4.0 caches its workspace get-or-create promise,
   * rejections included, so a client whose first call failed is dead for the
   * life of the process. Keep a client only once it has worked.
   */
  let honcho: Honcho | undefined;
  const client = async (): Promise<Honcho> => {
    const { hostVersion, model } = telemetry();
    // The SDK reads `defaultHeaders` per request, so writing to the held
    // client's map is enough for the next request to carry the change.
    if (honcho) {
      const headers = honcho.http.defaultHeaders;
      // A client built before the version resolved is missing the host header;
      // once `base` is set this stops.
      if (!base) Object.assign(headers, baseHeaders(hostVersion));
      syncModel(headers, model);
      return honcho;
    }
    const headers = { ...baseHeaders(hostVersion) }; // copy: syncModel must not touch `base`
    syncModel(headers, model);
    const fresh = new Honcho({ ...clientOptions(config), defaultHeaders: headers });
    await fresh.peer(config.peerName);
    return (honcho = fresh);
  };

  const userPeer = async (): Promise<Peer> => (await client()).peer(config.peerName);
  const aiPeer = async (): Promise<Peer> => (await client()).peer(config.aiPeer);
  /** The peer that acts. Unified → the user, observing themselves. */
  const activePeer = (): Promise<Peer> => (directional ? aiPeer() : userPeer());

  const nameFor = (cwd?: string, dshSessionId?: string): string => sessionName(config, cwd, dshSessionId);

  return {
    currentSessionName: nameFor,

    async ensureSession(cwd, dshSessionId) {
      const name = nameFor(cwd, dshSessionId);
      if (ensured.has(name)) return;
      const [session, user, ai] = await Promise.all([(await client()).session(name), userPeer(), aiPeer()]);
      // addPeers materializes the session server-side and associates both peers.
      await session.addPeers([user, ai]);
      ensured.add(name);
    },

    async fetchContext(cwd, dshSessionId, searchQuery) {
      const [session, target, perspective] = await Promise.all([
        (await client()).session(nameFor(cwd, dshSessionId)),
        userPeer(),
        directional ? aiPeer() : Promise.resolve(undefined),
      ]);
      const result = await session.context({
        summary: true,
        tokens: config.injection.contextTokens,
        peerTarget: target,
        ...(perspective ? { peerPerspective: perspective } : {}),
        // Deliberately NOT limitToSession: it restricts recall to explicit-only
        // conclusions and omits the peer card, discarding exactly the
        // cross-session synthesis the Deriver and Dreamer produce
        // (repos/honcho/src/routers/sessions.py:740).
        ...(searchQuery
          ? {
              representationOptions: {
                searchQuery: searchQuery.slice(0, 300),
                searchTopK: config.injection.searchTopK,
                searchMaxDistance: config.injection.searchMaxDistance,
                maxConclusions: config.injection.maxConclusions,
              },
            }
          : {}),
      });
      return {
        summary: result.summary ? { content: result.summary.content } : null,
        peerRepresentation: result.peerRepresentation,
        peerCard: result.peerCard,
      };
    },

    async upload(name, messages) {
      const [session, user, ai] = await Promise.all([(await client()).session(name), userPeer(), aiPeer()]);
      const built = messages.map((m) => (m.role === "user" ? user : ai).message(m.content));
      for (let i = 0; i < built.length; i += BATCH_LIMIT) {
        await session.addMessages(built.slice(i, i + BATCH_LIMIT));
      }
    },

    async backgroundDialectic(cwd, dshSessionId, userQuery) {
      const cfg = config.injection.dialectic;
      const query = cfg.template.replace(/%\{user_query\}/g, userQuery);
      // The client is awaited BEFORE the array below, never inside it. An
      // `await client()` as a later element throws while the array is still being
      // built, so `Promise.all` never runs and the rejection of `activePeer()`
      // (which also calls `client()`) has no handler. With Honcho unreachable
      // that is an unhandled rejection, and it kills the dsh turn.
      const c = await client();
      const [peer, target, session] = await Promise.all([
        activePeer(),
        directional ? userPeer() : Promise.resolve(undefined),
        c.session(nameFor(cwd, dshSessionId)),
      ]);
      const answer = await peer.chat(query, {
        ...(target ? { target } : {}),
        session,
        reasoningLevel: cfg.reasoning,
      });
      return (answer ?? "").trim().slice(0, cfg.maxChars);
    },

    async chat(query, options) {
      const c = await client();
      const [peer, target, session] = await Promise.all([
        activePeer(),
        directional ? userPeer() : Promise.resolve(undefined),
        options.sessionId ? c.session(options.sessionId) : Promise.resolve(undefined),
      ]);
      const answer = await peer.chat(query, {
        ...(target ? { target } : {}),
        ...(session ? { session } : {}),
      });
      return answer ?? "";
    },

    async searchMessages(query, limit) {
      const results = await (await client()).search(query, { limit });
      return results.map((r) => {
        const when = r.createdAt.slice(0, 16).replace("T", " ");
        return `[message ${r.peerId} ${when}] ${r.content.slice(0, 400)}`;
      });
    },

    async searchConclusions(query, limit) {
      const peer = await activePeer();
      const conclusions = await peer.conclusionsOf(config.peerName).query(query, limit);
      return conclusions.map((c) => `[conclusion:${c.level}] ${c.content.slice(0, 400)}`);
    },

    async remember(content, name) {
      const c = await client();
      const [peer, session] = await Promise.all([activePeer(), c.session(name)]);
      await peer.conclusionsOf(config.peerName).create({ content, sessionId: session.id });
    },
  };
}

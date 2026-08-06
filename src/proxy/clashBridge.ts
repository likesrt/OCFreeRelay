/**
 * Switch Clash/Mihomo select-group to a node, then traffic exits via local mixed-port.
 * Used so vless/hysteria2/tuic subscription nodes can back OpenCode free workers.
 */

import type { ClashBridgeConfig } from "./pool.js";

/**
 * PUT /proxies/{group}  body: { name: nodeName }
 * Tries configured group, then GLOBAL and other Selector groups that contain the node.
 */
export async function selectClashProxy(
  bridge: ClashBridgeConfig,
  nodeName: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<{ group: string }> {
  const base = bridge.apiBase.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (bridge.apiSecret) {
    headers.Authorization = `Bearer ${bridge.apiSecret}`;
  }

  const trySwitch = async (group: string): Promise<boolean> => {
    const url = `${base}/proxies/${encodeURIComponent(group)}`;
    const res = await fetchImpl(url, {
      method: "PUT",
      headers,
      body: JSON.stringify({ name: nodeName }),
    });
    if (res.ok) return true;
    // drain body
    await res.text().catch(() => "");
    return false;
  };

  // 1) configured group
  if (await trySwitch(bridge.selectorGroup)) {
    return { group: bridge.selectorGroup };
  }

  // 2) discover selectors that actually contain this node
  const candidates = await listSelectorGroupsContaining(
    base,
    headers,
    nodeName,
    fetchImpl
  );
  // Prefer GLOBAL, then 主代理, then rest
  const ordered = [
    ...candidates.filter((g) => g === "GLOBAL"),
    ...candidates.filter((g) => g === "主代理" || g === "Proxy" || g === "PROXY"),
    ...candidates.filter((g) => g !== "GLOBAL" && g !== "主代理" && g !== "Proxy" && g !== "PROXY"),
  ];
  // Also try GLOBAL even if not listed as containing (some builds allow it)
  if (!ordered.includes("GLOBAL")) ordered.unshift("GLOBAL");

  for (const group of ordered) {
    if (group === bridge.selectorGroup) continue;
    if (await trySwitch(group)) {
      return { group };
    }
  }

  throw new Error(
    `Clash switch failed: node "${nodeName}" not selectable in group "${bridge.selectorGroup}"` +
      (candidates.length
        ? ` (also tried: ${candidates.slice(0, 8).join(", ")})`
        : " (controller reachable? is the same subscription loaded in Clash?)")
  );
}

async function listSelectorGroupsContaining(
  base: string,
  headers: Record<string, string>,
  nodeName: string,
  fetchImpl: typeof fetch
): Promise<string[]> {
  try {
    const res = await fetchImpl(`${base}/proxies`, { headers });
    if (!res.ok) return [];
    const body = (await res.json()) as {
      proxies?: Record<
        string,
        { type?: string; all?: string[]; now?: string }
      >;
    };
    const out: string[] = [];
    for (const [name, info] of Object.entries(body.proxies || {})) {
      if (info?.type !== "Selector") continue;
      if (Array.isArray(info.all) && info.all.includes(nodeName)) {
        out.push(name);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Probe controller: GET /version or /proxies */
export async function probeClashBridge(
  bridge: ClashBridgeConfig,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<{ ok: boolean; message: string; groups?: string[] }> {
  const base = bridge.apiBase.replace(/\/+$/, "");
  const headers: Record<string, string> = {};
  if (bridge.apiSecret) headers.Authorization = `Bearer ${bridge.apiSecret}`;

  try {
    const verRes = await fetchImpl(`${base}/version`, { headers });
    if (!verRes.ok) {
      return { ok: false, message: `controller HTTP ${verRes.status} on /version` };
    }
    const ver = (await verRes.json().catch(() => ({}))) as { version?: string };
    let groups: string[] | undefined;
    try {
      const pRes = await fetchImpl(`${base}/proxies`, { headers });
      if (pRes.ok) {
        const body = (await pRes.json()) as {
          proxies?: Record<string, { type?: string }>;
        };
        groups = Object.entries(body.proxies || {})
          .filter(([, v]) => v?.type === "Selector")
          .map(([k]) => k);
      }
    } catch {
      /* optional */
    }
    return {
      ok: true,
      message: `Clash connected${ver.version ? ` v${ver.version}` : ""}`,
      groups,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Serialize Clash selector switches so concurrent workers don't race the same mixed-port.
 */
export class ClashSwitchQueue {
  private chain: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

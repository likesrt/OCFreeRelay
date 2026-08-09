/**
 * Proxy pool + Clash subscription parse + worker binding tests.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assignHealthyProxiesToWorkers,
  mergeSubscriptionProxies,
  resolveAccountProxy,
  resolveAccountEgress,
  normalizeProxyPool,
  newProxyId,
  type PoolProxy,
} from "../src/proxy/pool.js";
import { parseSubscriptionBody, fetchClashSubscription } from "../src/proxy/clash.js";
import { UpstreamClient } from "../src/proxy/upstream.js";
import { SettingsStore, type GatewaySettings } from "../src/settings/store.js";
import { createApp, close, listen, type App } from "../src/server/http.js";
import { ProbeResultCache } from "../src/proxy/probe.js";

function settings(over: Partial<GatewaySettings> = {}): GatewaySettings {
  return {
    baseUrl: "https://opencode.ai/zen/v1",
    synthesizeCliHeaders: false,
    cliUserAgent: "opencode-cli/1.0.0",
    cliClient: "cli",
    cliProject: "default",
    accounts: [{ id: "w1", apiKey: "k1", proxyId: null, proxy: null }],
    proxyPool: [],
    proxySubscriptions: [],
    clashBridge: {
      enabled: false,
      apiBase: "http://127.0.0.1:9090",
      apiSecret: "",
      localProxyHost: "127.0.0.1",
      localProxyPort: 7890,
      selectorGroup: "GLOBAL",
    },
    port: 9876,
    ...over,
  };
}

describe("parseSubscriptionBody", () => {
  it("parses Clash YAML http/socks5 proxies", () => {
    const yaml = `
proxies:
  - name: "HK-HTTP"
    type: http
    server: 1.1.1.1
    port: 8080
    username: u1
    password: p1
  - name: "JP-SOCKS"
    type: socks5
    server: 2.2.2.2
    port: 1080
  - name: "SS-skip"
    type: ss
    server: 3.3.3.3
    port: 8388
    cipher: aes-256-gcm
    password: x
`;
    const result = parseSubscriptionBody(yaml, "sub1");
    expect(result.format).toBe("clash-yaml");
    expect(result.usableCount).toBe(2);
    expect(result.proxies.some((p) => p.name === "HK-HTTP" && p.usable)).toBe(true);
    expect(result.proxies.some((p) => p.name === "JP-SOCKS" && p.type === "socks5")).toBe(
      true
    );
    const ss = result.proxies.find((p) => p.name === "SS-skip");
    expect(ss?.usable).toBe(false);
    expect(ss?.bridgeable).toBe(true);
  });

  it("parses base64 URI list", () => {
    const lines = [
      "http://user:pass@10.0.0.1:8888",
      "socks5://10.0.0.2:1080",
    ].join("\n");
    const b64 = Buffer.from(lines, "utf8").toString("base64");
    const result = parseSubscriptionBody(b64, "sub-uri");
    expect(result.usableCount).toBe(2);
    expect(result.proxies[0].host).toBe("10.0.0.1");
    expect(result.proxies[0].username).toBe("user");
    expect(result.proxies[1].type).toBe("socks5");
  });

  it("parses plain multi-line URI list", () => {
    const result = parseSubscriptionBody(
      "http://1.2.3.4:7890\nsocks5://5.6.7.8:1080\n",
      "s"
    );
    expect(result.format).toBe("uri-list");
    expect(result.usableCount).toBe(2);
  });

  it("parses JSON proxy-source API (proxy.scdn.io style)", () => {
    const json = JSON.stringify({
      code: 200,
      message: "success",
      data: {
        count: 20,
        proxies: [
          "121.37.199.23:10443",
          "123.57.1.78:20000",
          "47.121.183.107:3129",
        ],
      },
    });
    const result = parseSubscriptionBody(json, "scdn");
    expect(result.format).toBe("json-proxies");
    expect(result.proxies.length).toBe(3);
    expect(result.usableCount).toBe(3);
    const p = result.proxies[0];
    expect(p.host).toBe("121.37.199.23");
    expect(p.port).toBe(10443);
    expect(p.type).toBe("socks5");
    expect(p.usable).toBe(true);
    expect(p.source).toBe("subscription");
    expect(p.subscriptionId).toBe("scdn");
  });

  it("JSON proxy-source with a bare data array", () => {
    const json = JSON.stringify({
      result: ["1.1.1.1:8080", "2.2.2.2:1080"],
    });
    const result = parseSubscriptionBody(json, "s2");
    expect(result.format).toBe("json-proxies");
    expect(result.proxies.length).toBe(2);
    expect(result.proxies[0].host).toBe("1.1.1.1");
    expect(result.proxies[1].host).toBe("2.2.2.2");
  });

  it("JSON without host:port lists yields empty", () => {
    const result = parseSubscriptionBody(JSON.stringify({ ok: true, data: [] }), "s3");
    expect(result.proxies.length).toBe(0);
    expect(result.format).toBe("empty");
  });

  it("parses mitce-style base64 vless/hysteria2 URI list (was empty before)", () => {
    const lines = [
      "vless://F2987FBA-B653-444D-8057-6B6474E448C6@hk1-r.example.com:10126?type=grpc&security=reality#HK-1",
      "hysteria2://secret@jp1-hy2.example.com:443?insecure=0#JP1-HY2",
      "tuic://uuid:pass@us1.example.com:8443?congestion_control=bbr#US-TUIC",
    ].join("\n");
    const b64 = Buffer.from(lines, "utf8").toString("base64");
    const result = parseSubscriptionBody(b64, "mitce");
    expect(result.format).toBe("uri-list");
    expect(result.proxies.length).toBe(3);
    expect(result.usableCount).toBe(0);
    expect(result.bridgeableCount).toBe(3);
    expect(result.proxies[0].name).toBe("HK-1");
    expect(result.proxies[0].host).toBe("hk1-r.example.com");
    expect(result.proxies[0].port).toBe(10126);
    expect(result.proxies[0].type).toBe("vless");
    expect(result.proxies[1].type).toBe("hysteria2");
    expect(result.proxies[2].type).toBe("tuic");
  });

  it("parses Clash YAML with vless nodes + hints", () => {
    const yaml = `
mixed-port: 7892
port: 7890
external-controller: '127.0.0.1:9090'
proxies:
  - name: HK-1
    type: vless
    server: hk1.example.com
    port: 10126
    uuid: abc
  - name: JP-1
    type: hysteria2
    server: jp1.example.com
    port: 443
    password: x
  - name: HK2-HY2
    type: hysteria2
    server: hk2.example.com
    ports: "20200-20399"
    password: x
proxy-groups:
  - name: 主代理
    type: select
    proxies: [HK-1, JP-1]
  - name: OpenAI
    type: select
    proxies: [HK-1]
`;
    const result = parseSubscriptionBody(yaml, "sub");
    expect(result.format).toBe("clash-yaml");
    expect(result.proxies.length).toBe(3);
    expect(result.bridgeableCount).toBe(3);
    expect(result.proxies.find((p) => p.name === "HK2-HY2")?.port).toBe(20200);
    expect(result.clashHints?.mixedPort).toBe(7892);
    expect(result.clashHints?.selectorGroups?.[0]).toBe("主代理");
  });
});

describe("resolveAccountProxy + merge", () => {
  it("binds worker to pool proxy by proxyId", () => {
    const pool: PoolProxy[] = [
      {
        id: "px_a",
        name: "a",
        type: "http",
        host: "9.9.9.9",
        port: 8000,
        enabled: true,
        source: "manual",
        usable: true,
      },
    ];
    const resolved = resolveAccountProxy({ proxyId: "px_a", proxy: null }, pool);
    expect(resolved).toEqual({
      type: "http",
      host: "9.9.9.9",
      port: 8000,
      username: undefined,
      password: undefined,
    });
  });

  it("falls back to legacy inline proxy when proxyId missing", () => {
    const resolved = resolveAccountProxy(
      { proxyId: null, proxy: { type: "http", host: "127.0.0.1", port: 7890 } },
      []
    );
    expect(resolved?.host).toBe("127.0.0.1");
  });

  it("resolves vless node via Clash bridge to local mixed-port", () => {
    const pool: PoolProxy[] = [
      {
        id: "px_v",
        name: "HK-1",
        type: "vless",
        host: "hk.example.com",
        port: 10126,
        enabled: true,
        source: "subscription",
        usable: false,
        bridgeable: true,
        clashNodeName: "HK-1",
      },
    ];
    const bridge = {
      enabled: true,
      apiBase: "http://127.0.0.1:9090",
      apiSecret: "",
      localProxyHost: "127.0.0.1",
      localProxyPort: 7892,
      selectorGroup: "主代理",
    };
    const egress = resolveAccountEgress({ proxyId: "px_v" }, pool, bridge);
    expect(egress.proxy).toEqual({
      type: "http",
      host: "127.0.0.1",
      port: 7892,
    });
    expect(egress.clashNodeName).toBe("HK-1");
  });

  it("mergeSubscriptionProxies replaces only same subscription entries", () => {
    const pool: PoolProxy[] = [
      {
        id: "m1",
        name: "manual",
        type: "http",
        host: "1.1.1.1",
        port: 1,
        enabled: true,
        source: "manual",
        usable: true,
      },
      {
        id: "s1",
        name: "old",
        type: "http",
        host: "2.2.2.2",
        port: 2,
        enabled: true,
        source: "subscription",
        subscriptionId: "subA",
        usable: true,
      },
    ];
    const imported: PoolProxy[] = [
      {
        id: "s2",
        name: "new",
        type: "socks5",
        host: "3.3.3.3",
        port: 3,
        enabled: true,
        source: "subscription",
        usable: true,
      },
    ];
    const merged = mergeSubscriptionProxies(pool, "subA", imported);
    expect(merged.find((p) => p.id === "m1")).toBeTruthy();
    expect(merged.find((p) => p.id === "s1")).toBeFalsy();
    expect(merged.find((p) => p.host === "3.3.3.3")?.subscriptionId).toBe("subA");
  });
});

describe("assignHealthyProxiesToWorkers", () => {
  function px(
    id: string,
    over: Partial<PoolProxy> = {}
  ): PoolProxy {
    return {
      id,
      name: id,
      type: "http",
      host: "10.0.0." + id.slice(-1),
      port: 8000,
      enabled: true,
      source: "manual",
      usable: true,
      ...over,
    };
  }

  it("assigns unique healthy proxies sorted by latency", () => {
    const result = assignHealthyProxiesToWorkers({
      accounts: [
        { id: "w1", apiKey: "k1", proxyId: null, proxy: null },
        { id: "w2", apiKey: "k2", proxyId: "old", proxy: null },
        { id: "w3", apiKey: "k3", proxyId: null, proxy: null },
      ],
      pool: [px("slow"), px("fast"), px("mid"), px("bad")],
      probeResults: {
        slow: { ok: true, health: "healthy", latencyMs: 300 },
        fast: { ok: true, health: "healthy", latencyMs: 40 },
        mid: { ok: true, health: "healthy", latencyMs: 120 },
        bad: { ok: false, health: "bad", latencyMs: null },
      },
    });

    expect(result.healthyAvailable).toBe(3);
    expect(result.assigned).toBe(3);
    expect(result.unassigned).toBe(0);
    expect(result.accounts.map((a) => a.proxyId)).toEqual(["fast", "mid", "slow"]);
    expect(new Set(result.accounts.map((a) => a.proxyId)).size).toBe(3);
  });

  it("leaves surplus workers unbound when healthy proxies run out", () => {
    const result = assignHealthyProxiesToWorkers({
      accounts: [
        { id: "w1", apiKey: "", proxyId: "keep-me", proxy: null },
        { id: "w2", apiKey: "", proxyId: null, proxy: null },
      ],
      pool: [px("only")],
      probeResults: {
        only: { ok: true, health: "healthy", latencyMs: 10 },
      },
    });
    expect(result.assigned).toBe(1);
    expect(result.unassigned).toBe(1);
    expect(result.accounts[0].proxyId).toBe("only");
    expect(result.accounts[1].proxyId).toBeNull();
  });

  it("ignores structural-usable nodes that never probed healthy", () => {
    const result = assignHealthyProxiesToWorkers({
      accounts: [{ id: "w1", apiKey: "", proxyId: null, proxy: null }],
      pool: [px("untested")],
      probeResults: {},
    });
    expect(result.healthyAvailable).toBe(0);
    expect(result.assigned).toBe(0);
    expect(result.accounts[0].proxyId).toBeNull();
  });

  it("skips bridge-only healthy nodes when Clash bridge is off", () => {
    const result = assignHealthyProxiesToWorkers({
      accounts: [{ id: "w1", apiKey: "", proxyId: null, proxy: null }],
      pool: [
        px("vless", {
          type: "vless",
          usable: false,
          bridgeable: true,
          clashNodeName: "vless",
        }),
      ],
      probeResults: {
        vless: { ok: true, health: "healthy", latencyMs: 50 },
      },
      bridge: {
        enabled: false,
        apiBase: "http://127.0.0.1:9090",
        apiSecret: "",
        localProxyHost: "127.0.0.1",
        localProxyPort: 7890,
        selectorGroup: "GLOBAL",
      },
    });
    expect(result.healthyAvailable).toBe(0);
    expect(result.assigned).toBe(0);
  });
});

describe("UpstreamClient uses bound pool proxy", () => {
  it("passes dispatcher when worker has proxyId in pool", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit & { dispatcher?: unknown }) => {
      expect(init?.dispatcher).toBeTruthy();
      return new Response(
        JSON.stringify({
          id: "1",
          object: "chat.completion",
          choices: [{ message: { role: "assistant", content: "ok" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const client = new UpstreamClient(
      settings({
        proxyPool: [
          {
            id: "px1",
            name: "egress-1",
            type: "http",
            host: "10.0.0.9",
            port: 8888,
            enabled: true,
            source: "manual",
            usable: true,
          },
        ],
        accounts: [{ id: "w1", apiKey: "key", proxyId: "px1", proxy: null }],
      }),
      fetchImpl
    );

    const result = await client.chatCompletions({
      body: { model: "big-pickle", messages: [{ role: "user", content: "x" }] },
      stream: false,
    });
    expect(result.status).toBe(200);
    expect(result.proxyId).toBe("px1");
    expect(fetchImpl).toHaveBeenCalled();
  });
});

describe("admin proxy-pool HTTP APIs", () => {
  let app: App | null = null;
  let dir = "";

  afterEach(async () => {
    if (app) {
      await close(app);
      app = null;
    }
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  it("adds manual proxy, binds worker, fetches clash subscription into pool", async () => {
    dir = await mkdtemp(join(tmpdir(), "ocfr-pool-"));
    const store = new SettingsStore(join(dir, "settings.json"));
    await store.save(settings());

    const clashBody = `
proxies:
  - { name: "sub-node", type: http, server: 8.8.8.8, port: 3128 }
`;
    const subFetch = vi.fn(async () => new Response(clashBody, { status: 200 }));

    app = await createApp({
      store,
      port: 0,
      fetchImpl: async () => new Response("{}", { status: 200 }),
      subscriptionFetch: subFetch as unknown as typeof fetch,
    });
    await listen(app);
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    const base = `http://127.0.0.1:${addr.port}`;

    // manual add
    const addRes = await fetch(`${base}/admin/api/proxy-pool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "manual-1",
        type: "http",
        host: "127.0.0.1",
        port: 7890,
      }),
    });
    expect(addRes.status).toBe(200);
    let s = (await addRes.json()) as GatewaySettings;
    expect(s.proxyPool.length).toBe(1);
    const manualId = s.proxyPool[0].id;

    // bind worker
    const put = await fetch(`${base}/admin/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...s,
        accounts: [{ id: "worker-a", apiKey: "ak", proxyId: manualId, proxy: null }],
      }),
    });
    expect(put.status).toBe(200);
    s = (await put.json()) as GatewaySettings;
    expect(s.accounts[0].proxyId).toBe(manualId);

    // add subscription + fetch
    const subRes = await fetch(`${base}/admin/api/proxy-subscriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test-sub", url: "https://example.com/clash" }),
    });
    expect(subRes.status).toBe(200);
    const subBody = (await subRes.json()) as {
      subscription: { id: string };
      settings: GatewaySettings;
    };
    const subId = subBody.subscription.id;

    const fetchRes = await fetch(
      `${base}/admin/api/proxy-subscriptions/${encodeURIComponent(subId)}/fetch`,
      { method: "POST" }
    );
    expect(fetchRes.status).toBe(200);
    const fetched = (await fetchRes.json()) as {
      usableCount: number;
      settings: GatewaySettings;
    };
    expect(fetched.usableCount).toBe(1);
    expect((fetched as { totalCount?: number }).totalCount).toBe(1);
    expect(fetched.settings.proxyPool.some((p) => p.host === "8.8.8.8")).toBe(true);
    expect(fetched.settings.proxyPool.some((p) => p.host === "127.0.0.1")).toBe(true);
    expect(subFetch).toHaveBeenCalled();

    // status reflects pool
    const st = (await (await fetch(`${base}/admin/api/status`)).json()) as {
      proxyPoolCount: number;
      proxyPoolUsable: number;
    };
    expect(st.proxyPoolCount).toBeGreaterThanOrEqual(2);
    expect(st.proxyPoolUsable).toBeGreaterThanOrEqual(2);

    // admin page mentions proxy pool
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toMatch(/Proxy [Pp]ool/);
    expect(html).toContain("Clash");
    expect(html).toContain("btn-assign-proxies");
    expect(html).toContain("/admin/api/workers/assign-proxies");
  });

  it("returns 400 when no probe-healthy proxies exist", async () => {
    dir = await mkdtemp(join(tmpdir(), "ocfr-assign-empty-"));
    const store = new SettingsStore(join(dir, "settings.json"));
    await store.save(
      settings({
        accounts: [{ id: "w1", apiKey: "a", proxyId: null, proxy: null }],
        proxyPool: [
          {
            id: "px1",
            name: "n1",
            type: "http",
            host: "1.1.1.1",
            port: 8080,
            enabled: true,
            source: "manual",
            usable: true,
          },
        ],
      })
    );
    app = await createApp({
      store,
      port: 0,
      probes: new ProbeResultCache(),
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });
    await listen(app);
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    const res = await fetch(
      `http://127.0.0.1:${addr.port}/admin/api/workers/assign-proxies`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
    );
    expect(res.status).toBe(400);
  });

  it("auto-assigns unique healthy proxies to each worker", async () => {
    dir = await mkdtemp(join(tmpdir(), "ocfr-assign-"));
    const store = new SettingsStore(join(dir, "settings.json"));
    await store.save(
      settings({
        accounts: [
          { id: "w1", apiKey: "a", proxyId: null, proxy: null },
          { id: "w2", apiKey: "b", proxyId: null, proxy: null },
          { id: "w3", apiKey: "c", proxyId: null, proxy: null },
        ],
        proxyPool: [
          {
            id: "px-fast",
            name: "fast",
            type: "http",
            host: "1.1.1.1",
            port: 8080,
            enabled: true,
            source: "manual",
            usable: true,
          },
          {
            id: "px-slow",
            name: "slow",
            type: "http",
            host: "2.2.2.2",
            port: 8080,
            enabled: true,
            source: "manual",
            usable: true,
          },
          {
            id: "px-dead",
            name: "dead",
            type: "http",
            host: "3.3.3.3",
            port: 8080,
            enabled: true,
            source: "manual",
            usable: true,
          },
        ],
      })
    );

    const probes = new ProbeResultCache();
    probes.setMany([
      {
        id: "px-fast",
        ok: true,
        latencyMs: 30,
        error: null,
        testedAt: new Date().toISOString(),
        health: "healthy",
      },
      {
        id: "px-slow",
        ok: true,
        latencyMs: 200,
        error: null,
        testedAt: new Date().toISOString(),
        health: "healthy",
      },
      {
        id: "px-dead",
        ok: false,
        latencyMs: null,
        error: "Timeout",
        testedAt: new Date().toISOString(),
        health: "bad",
      },
    ]);

    app = await createApp({
      store,
      port: 0,
      probes,
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });
    await listen(app);
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    const base = `http://127.0.0.1:${addr.port}`;

    const res = await fetch(`${base}/admin/api/workers/assign-proxies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      assigned: number;
      unassigned: number;
      healthyAvailable: number;
      settings: GatewaySettings;
    };
    expect(body.healthyAvailable).toBe(2);
    expect(body.assigned).toBe(2);
    expect(body.unassigned).toBe(1);
    expect(body.settings.accounts[0].proxyId).toBe("px-fast");
    expect(body.settings.accounts[1].proxyId).toBe("px-slow");
    expect(body.settings.accounts[2].proxyId).toBeNull();

    const saved = (await (await fetch(`${base}/admin/api/settings`)).json()) as GatewaySettings;
    expect(saved.accounts.map((a) => a.proxyId)).toEqual(["px-fast", "px-slow", null]);
  });
});

describe("normalizeProxyPool", () => {
  it("drops invalid entries", () => {
    const pool = normalizeProxyPool([
      { id: "ok", host: "1.1.1.1", port: 80, type: "http" },
      { host: "", port: 1 },
      null,
    ]);
    expect(pool).toHaveLength(1);
    expect(pool[0].host).toBe("1.1.1.1");
    expect(newProxyId().startsWith("px_")).toBe(true);
  });
});

describe("listModels resilience", () => {
  it("falls back to direct when Clash switch fails", async () => {
    const bridgeFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ message: "Resource not found" }), {
        status: 404,
      });
    });
    const upstreamFetch = vi.fn(async (url: string, init?: RequestInit) => {
      // direct (no dispatcher) path
      if (String(url).includes("/models") && !(init as { dispatcher?: unknown })?.dispatcher) {
        return new Response(
          JSON.stringify({
            object: "list",
            data: [{ id: "big-pickle", object: "model" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error("should not use proxy path successfully");
    });

    const client = new UpstreamClient(
      settings({
        clashBridge: {
          enabled: true,
          apiBase: "http://127.0.0.1:9090",
          apiSecret: "",
          localProxyHost: "127.0.0.1",
          localProxyPort: 7892,
          selectorGroup: "主代理",
        },
        proxyPool: [
          {
            id: "px_jp",
            name: "JP-2",
            type: "vless",
            host: "jp.example.com",
            port: 1,
            enabled: true,
            source: "subscription",
            usable: false,
            bridgeable: true,
            clashNodeName: "JP-2",
          },
        ],
        accounts: [{ id: "w1", apiKey: "", proxyId: "px_jp", proxy: null }],
      }),
      upstreamFetch as unknown as import("../src/proxy/upstream.js").ProxyFetch,
      bridgeFetch as unknown as typeof fetch
    );

    const result = await client.listModels();
    expect(result.status).toBe(200);
    expect(result.accountId).toBe("direct-fallback");
    const body = JSON.parse(await new Response(result.body).text());
    expect(body.object).toBe("list");
    expect(body.data[0].id).toBe("big-pickle");
  });
});

describe("fetchClashSubscription multi-UA", () => {
  it("prefers clash UA YAML over base64 vless list", async () => {
    const yaml = `
mixed-port: 7892
proxies:
  - name: N1
    type: vless
    server: a.example.com
    port: 1
  - name: N2
    type: vless
    server: b.example.com
    port: 2
proxy-groups:
  - name: 主代理
    type: select
    proxies: [N1, N2]
`;
    const b64 = Buffer.from(
      "vless://u@a.example.com:1#OnlyOne\n",
      "utf8"
    ).toString("base64");

    const fetchImpl = async (_url: string, init?: RequestInit) => {
      const ua = String((init?.headers as Record<string, string>)?.["User-Agent"] || "");
      if (ua === "clash") return new Response(yaml, { status: 200 });
      return new Response(b64, { status: 200 });
    };

    const result = await fetchClashSubscription({
      url: "https://example.com/sub",
      subscriptionId: "s1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.format).toBe("clash-yaml");
    expect(result.proxies.length).toBe(2);
    expect(result.usedUserAgent).toBe("clash");
    expect(result.clashHints?.mixedPort).toBe(7892);
  });
});

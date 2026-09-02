import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const installMocks = vi.hoisted(() => ({
  ensureLlamaServerInstalled: vi.fn(),
  resolveManagedLlamaServerPaths: vi.fn(),
}));

vi.mock("./llama-server-install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./llama-server-install.js")>()),
  ensureLlamaServerInstalled: installMocks.ensureLlamaServerInstalled,
  resolveManagedLlamaServerPaths: installMocks.resolveManagedLlamaServerPaths,
}));

import { selectLlamaServerAsset } from "./llama-server-install.js";
import {
  ensureLlamaCppModel,
  ensureManagedLlamaServerForChat,
  inspectLlamaServerRuntime,
  prepareManagedLlamaServer,
  reconcileManagedLlamaServer,
} from "./managed-server.js";

const servers: http.Server[] = [];
const tempRoots: string[] = [];

async function listen(server: http.Server, port = 0): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing test server address");
  }
  return address.port;
}

async function createPresetFixture(label: string) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `llama-server-${label}-`));
  tempRoots.push(tempRoot);
  const presetPath = path.join(tempRoot, "models.ini");
  const asset = selectLlamaServerAsset("darwin", "arm64");
  installMocks.ensureLlamaServerInstalled.mockResolvedValue({
    command: path.join(tempRoot, "llama-server"),
    asset,
  });
  installMocks.resolveManagedLlamaServerPaths.mockReturnValue({
    installDir: tempRoot,
    command: path.join(tempRoot, "llama-server"),
    presetPath,
  });
  return { tempRoot, presetPath };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("managed llama-server", () => {
  it.each([
    [
      "darwin",
      "arm64",
      "metal",
      "tar.gz",
      "llama-b10534-bin-macos-arm64.tar.gz",
      "51f193eef26b053554e288fb924b24d41d3d7b2bafa338c19e2817fa793d5e86",
    ],
    [
      "darwin",
      "x64",
      "cpu",
      "tar.gz",
      "llama-b10534-bin-macos-x64.tar.gz",
      "69b13035f4301354922a8cfacd1bcf2bb2de4ff0c2e19fedb44963378ff53dc5",
    ],
    [
      "linux",
      "arm64",
      "cpu",
      "tar.gz",
      "llama-b10534-bin-ubuntu-arm64.tar.gz",
      "66535de5cb9293c075a1951c51a3b2ae6f1899623e21177845f6d2a73b78c94e",
    ],
    [
      "linux",
      "x64",
      "cpu",
      "tar.gz",
      "llama-b10534-bin-ubuntu-x64.tar.gz",
      "cc6a12b026edcf1b211be2bb7366c5dadcad778fd8f13019d0694038053d5e4a",
    ],
    [
      "win32",
      "arm64",
      "cpu",
      "zip",
      "llama-b10534-bin-win-cpu-arm64.zip",
      "d33618b10fda35d34d85da60926c6c470f98f3f66ce6b52c3c1f583461416012",
    ],
    [
      "win32",
      "x64",
      "cpu",
      "zip",
      "llama-b10534-bin-win-cpu-x64.zip",
      "295ae03ad58d9276afa36f5f8d111d67fc1491c7aff3a3e6d13051a772f93c21",
    ],
  ] as const)(
    "selects the pinned %s/%s asset",
    (platform, arch, backend, archive, name, sha256) => {
      expect(selectLlamaServerAsset(platform, arch)).toMatchObject({
        platform,
        arch,
        backend,
        archive,
        name,
        sha256,
      });
    },
  );

  it("fails unsupported platforms with an actionable manual path", () => {
    expect(() => selectLlamaServerAsset("freebsd", "x64")).toThrow(
      "Install a compatible llama-server manually",
    );
  });

  it("writes a 2048-token physical batch in the combined preset", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llama-server-preset-"));
    const presetPath = path.join(tempRoot, "models.ini");
    const asset = selectLlamaServerAsset("darwin", "arm64");
    installMocks.ensureLlamaServerInstalled.mockResolvedValue({
      command: path.join(tempRoot, "llama-server"),
      asset,
    });
    installMocks.resolveManagedLlamaServerPaths.mockReturnValue({
      installDir: tempRoot,
      command: path.join(tempRoot, "llama-server"),
      presetPath,
    });

    try {
      await prepareManagedLlamaServer({
        chatModel: {
          mode: "configure",
          id: "chat-model",
          path: "/models/chat.gguf",
          contextSize: 8192,
          maxTokens: 2048,
        },
        embeddingModelIsDefault: true,
        embeddingModelPath: "/models/embedding.gguf",
        port: 19_432,
      });
      const preset = await fs.readFile(presetPath, "utf8");
      expect(preset).toContain("[chat-model]\nmodel = /models/chat.gguf\nctx-size = 8192");
      expect(preset).toContain(
        "[embeddinggemma-300m-qat-q8_0]\nmodel = /models/embedding.gguf\nubatch-size = 2048\nembedding = true",
      );
      expect(preset).not.toMatch(/mmproj|draft/iu);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves the llama.cpp physical batch default for a custom embedding model", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llama-server-embedding-only-"));
    const presetPath = path.join(tempRoot, "models.ini");
    const asset = selectLlamaServerAsset("darwin", "arm64");
    installMocks.ensureLlamaServerInstalled.mockResolvedValue({
      command: path.join(tempRoot, "llama-server"),
      asset,
    });
    installMocks.resolveManagedLlamaServerPaths.mockReturnValue({
      installDir: tempRoot,
      command: path.join(tempRoot, "llama-server"),
      presetPath,
    });

    try {
      await fs.writeFile(
        presetPath,
        "version = 1\n\n[stale-chat]\nmodel = /models/stale-chat.gguf\n\n" +
          "[embeddinggemma-300m-qat-q8_0]\nmodel = /models/old-embedding.gguf\nembedding = true\n",
      );
      await prepareManagedLlamaServer({
        chatModel: { mode: "remove" },
        embeddingModelPath: "/models/custom-embedding.gguf",
        port: 19_432,
      });
      const preset = await fs.readFile(presetPath, "utf8");
      expect(preset).toBe(
        "version = 1\n\n[embeddinggemma-300m-qat-q8_0]\nmodel = /models/custom-embedding.gguf\nembedding = true\n",
      );
      expect(preset).not.toContain("jinja");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves a custom embedding model when chat prepares the shared restart preset", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llama-server-chat-preset-"));
    const presetPath = path.join(tempRoot, "models.ini");
    const chatModelPath = path.join(tempRoot, "chat.gguf");
    const embeddingModelPath = path.join(tempRoot, "custom-embedding.gguf");
    const asset = selectLlamaServerAsset("darwin", "arm64");
    installMocks.ensureLlamaServerInstalled.mockResolvedValue({
      command: path.join(tempRoot, "llama-server"),
      asset,
    });
    installMocks.resolveManagedLlamaServerPaths.mockReturnValue({
      installDir: tempRoot,
      command: path.join(tempRoot, "llama-server"),
      presetPath,
    });

    try {
      await Promise.all([
        fs.writeFile(chatModelPath, "GGUF"),
        fs.writeFile(embeddingModelPath, "GGUF"),
      ]);
      await Promise.all([
        prepareManagedLlamaServer({
          chatModel: { mode: "preserve" },
          embeddingModelPath,
          port: 19_434,
        }),
        ensureManagedLlamaServerForChat({
          provider: {
            baseUrl: "http://127.0.0.1:19434/v1",
            localService: { command: path.join(tempRoot, "llama-server"), args: [] },
            models: [],
            params: { modelCacheDir: tempRoot },
          },
          model: {
            id: "chat-model",
            params: { modelPath: chatModelPath, contextSize: 8192 },
            maxTokens: 2048,
          },
        }),
      ]);

      const preset = await fs.readFile(presetPath, "utf8");
      expect(preset).toContain(`[chat-model]\nmodel = ${chatModelPath}\nctx-size = 8192`);
      expect(preset).toContain(
        `[embeddinggemma-300m-qat-q8_0]\nmodel = ${embeddingModelPath}\nembedding = true`,
      );
      expect(preset).not.toContain("ubatch-size");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("retains the chat inventory across A to B to A and reapplies changed limits", async () => {
    const { tempRoot, presetPath } = await createPresetFixture("chat-transitions");
    const firstPath = path.join(tempRoot, "first.gguf");
    const secondPath = path.join(tempRoot, "second.gguf");
    const first = {
      id: "first",
      params: { modelPath: firstPath, contextSize: 16_384 },
      maxTokens: 1024,
    };
    const second = {
      id: "second",
      params: { modelPath: secondPath, contextSize: 32_768 },
      maxTokens: 2048,
    };
    const provider = {
      baseUrl: "http://127.0.0.1:29432/v1",
      localService: { command: path.join(tempRoot, "llama-server"), args: [] },
      models: [first, second],
      params: { modelCacheDir: tempRoot },
    };
    await Promise.all([fs.writeFile(firstPath, "GGUF"), fs.writeFile(secondPath, "GGUF")]);
    for (const model of [
      first,
      second,
      { ...first, params: { ...first.params, contextSize: 32_768 }, maxTokens: 4096 },
    ]) {
      await ensureManagedLlamaServerForChat({ provider, model });
    }
    const preset = await fs.readFile(presetPath, "utf8");
    expect(preset).toContain(
      `[first]\nmodel = ${firstPath}\nctx-size = 32768\nn-predict = 4096\njinja = true`,
    );
    expect(preset).toContain(
      `[second]\nmodel = ${secondPath}\nctx-size = 32768\nn-predict = 2048\njinja = true`,
    );
    expect(preset.indexOf("[first]")).toBeLessThan(preset.indexOf("[second]"));
  });

  it("prunes and orders sections without rewriting or reloading unchanged bytes", async () => {
    const { tempRoot, presetPath } = await createPresetFixture("chat-prune");
    let reloads = 0;
    const server = http.createServer((req, res) => {
      reloads += Number(req.url === "/models?reload=1");
      res.end("{}");
    });
    servers.push(server);
    const port = await listen(server);
    const rename = vi.spyOn(fs, "rename");
    const params = {
      chatModel: { mode: "preserve" as const },
      configuredChatModelIds: ["zeta", "alpha"],
      port,
    };
    await fs.writeFile(
      presetPath,
      [
        "version = 1",
        "",
        "[stale]",
        "model = /models/stale.gguf",
        "",
        "[zeta]",
        "model = /models/zeta.gguf",
        "",
        "[alpha]",
        "model = /models/alpha.gguf",
        "",
        "[embeddinggemma-300m-qat-q8_0]",
        "model = /models/embedding.gguf",
        "embedding = true",
        "",
      ].join("\n"),
    );
    await prepareManagedLlamaServer(params);
    await prepareManagedLlamaServer(params);
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    await reconcileManagedLlamaServer({ baseUrl });
    await reconcileManagedLlamaServer({ baseUrl });
    expect(await fs.readFile(presetPath, "utf8")).toBe(
      [
        "version = 1",
        "",
        "[alpha]",
        "model = /models/alpha.gguf",
        "",
        "[zeta]",
        "model = /models/zeta.gguf",
        "",
        "[embeddinggemma-300m-qat-q8_0]",
        "model = /models/embedding.gguf",
        "embedding = true",
        "",
      ].join("\n"),
    );
    expect(rename).toHaveBeenCalledTimes(1);
    expect(reloads).toBe(1);
  });

  it("retains a failed reload revision for the next reconciliation", async () => {
    await createPresetFixture("reload-failure");
    let status = 500;
    let reloads = 0;
    const server = http.createServer((_req, res) => {
      reloads += 1;
      res.statusCode = status;
      res.end("{}");
    });
    servers.push(server);
    const port = await listen(server);
    await prepareManagedLlamaServer({
      chatModel: { mode: "remove" },
      configuredChatModelIds: [],
      embeddingModelPath: "/models/embedding.gguf",
      port,
    });
    await expect(
      reconcileManagedLlamaServer({ baseUrl: `http://127.0.0.1:${port}/v1` }),
    ).rejects.toThrow("llama.cpp preset reload failed: HTTP 500");
    status = 200;
    await reconcileManagedLlamaServer({ baseUrl: `http://127.0.0.1:${port}/v1` });
    expect(reloads).toBe(2);
  });

  it("reconciles a mutation after the child reads the preset but before it listens", async () => {
    const { tempRoot, presetPath } = await createPresetFixture("startup-race");
    const probe = http.createServer();
    const port = await listen(probe);
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const prepare = async (contextSize: number) =>
      await prepareManagedLlamaServer({
        chatModel: {
          mode: "configure",
          id: "chat",
          path: "/models/chat.gguf",
          contextSize,
          maxTokens: 2048,
        },
        configuredChatModelIds: ["chat"],
        defaultEmbeddingModelPath: "/models/embedding.gguf",
        port,
      });
    await prepare(8192);
    let loadedPreset = await fs.readFile(presetPath, "utf8");
    await prepare(16_384);

    let reloads = 0;
    const server = http.createServer(async (req, res) => {
      if (req.url === "/models?reload=1") {
        reloads += 1;
        loadedPreset = await fs.readFile(presetPath, "utf8");
      }
      res.end("{}");
    });
    servers.push(server);
    await listen(server, port);
    await reconcileManagedLlamaServer({ baseUrl: `http://127.0.0.1:${port}/v1` });
    await reconcileManagedLlamaServer({ baseUrl: `http://127.0.0.1:${port}/v1` });

    expect(reloads).toBe(1);
    expect(loadedPreset).toContain("ctx-size = 16384");
  });

  it("reports a missing local GGUF with the setup repair path", async () => {
    await expect(
      ensureLlamaCppModel({
        source: path.join(os.tmpdir(), "missing-openclaw-model.gguf"),
        cacheDir: os.tmpdir(),
        download: false,
      }),
    ).rejects.toThrow("Run interactive llama.cpp setup or correct params.modelPath");
  });

  it("reports only facts observed from health, models, props, and metrics", async () => {
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/health") {
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (req.url === "/models") {
        res.end(
          JSON.stringify({
            data: [
              {
                id: "embedding-model",
                path: "/models/from-models.gguf",
                status: { value: "loaded" },
              },
            ],
          }),
        );
        return;
      }
      if (req.url?.startsWith("/props?")) {
        res.end(
          JSON.stringify({
            build_info: "b10357 (689e227db)",
            model_path: "/models/from-props.gguf",
            modalities: { vision: false },
          }),
        );
        return;
      }
      if (req.url?.startsWith("/metrics?")) {
        res.setHeader("content-type", "text/plain");
        res.end("llamacpp:prompt_tokens_total 1\n");
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("missing test server address");
    }

    await expect(
      inspectLlamaServerRuntime({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        modelId: "embedding-model",
        backend: "metal",
      }),
    ).resolves.toEqual({
      engine: "llama.cpp",
      state: "ready",
      backend: "metal",
      buildInfo: "b10357 (689e227db)",
      model: { id: "embedding-model", path: "/models/from-props.gguf" },
      capabilities: { vision: false, draft: false },
      endpoints: {
        health: "ready",
        models: "ready",
        props: "ready",
        metrics: "ready",
      },
    });
  });

  it.each(["metrics", "props"] as const)(
    "bounds %s inspection responses while accepting a legitimate large body",
    async (endpoint) => {
      let padding = "x".repeat(1024 * 1024);
      const server = http.createServer((req, res) => {
        if (req.url?.startsWith(`/${endpoint}?`)) {
          res.setHeader("content-type", endpoint === "metrics" ? "text/plain" : "application/json");
          res.end(endpoint === "metrics" ? padding : JSON.stringify({ padding }));
          return;
        }
        res.setHeader("content-type", "application/json");
        if (req.url === "/health") {
          res.end(JSON.stringify({ status: "ok" }));
          return;
        }
        if (req.url === "/models") {
          res.end(JSON.stringify({ data: [{ id: "embedding-model" }] }));
          return;
        }
        if (req.url?.startsWith("/props?")) {
          res.end(JSON.stringify({ modalities: { vision: false } }));
          return;
        }
        if (req.url?.startsWith("/metrics?")) {
          res.setHeader("content-type", "text/plain");
          res.end("llamacpp:requests_total 1\n");
          return;
        }
        res.statusCode = 404;
        res.end("{}");
      });
      servers.push(server);
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("missing test server address");
      }
      const inspect = () =>
        inspectLlamaServerRuntime({
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          modelId: "embedding-model",
        });

      await expect(inspect()).resolves.toMatchObject({
        state: "ready",
        endpoints: { health: "ready", models: "ready", props: "ready", metrics: "ready" },
      });

      padding = "x".repeat(32 * 1024 * 1024);
      await expect(inspect()).resolves.toMatchObject({
        state: "failed",
        endpoints: {
          health: "ready",
          models: "ready",
          props: endpoint === "props" ? "unavailable" : "ready",
          metrics: endpoint === "metrics" ? "unavailable" : "ready",
        },
      });
    },
  );
});

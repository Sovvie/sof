"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// No saved or env sign-in may leak into these tests.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sof-registry-test-"));
process.env.SOF_HOME = home;
delete process.env.SOF_REGISTRY_TOKEN;
process.env.SOF_TOKEN = "must-not-be-used";
process.env.GITHUB_TOKEN = "must-not-be-used";

const { SofProvider } = require("../src/packages/providers/sof");
const { WallyProvider } = require("../src/packages/providers/wally");
const { WALLY_CLIENT_VERSION } = require("../src/packages/constants");
const { indexBody, sendJson, startServer } = require("./helpers");

const ARCHIVE = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3, 4, 5, 250, 251, 252]);
const CHECKSUM = "sha256:abc123";

function packageEntry(overrides = {}) {
  return {
    name: "sovvie/router",
    version: "1.0.0",
    realm: "shared",
    description: "UI navigation",
    license: "MIT",
    authors: ["Sovereignty"],
    dependencies: [
      { alias: "Butler", name: "sovvie/butler", range: "^1.0.0", specifier: "sovvie/butler@^1.0.0" },
    ],
    ...overrides,
  };
}

function writeArchive() {
  const archivePath = path.join(home, `archive-${Math.random().toString(36).slice(2)}.tar.gz`);
  fs.writeFileSync(archivePath, ARCHIVE);
  return archivePath;
}

test("a 404 means the package isn't in the registry (null), so Wally gets asked next", async () => {
  const server = await startServer((_request, response) => sendJson(response, 404, { error: "not found" }));
  try {
    const provider = new SofProvider({ registryUrl: server.url });
    assert.equal(await provider.queryPackage("evaera/promise"), null);
  } finally {
    await server.close();
  }
});

test("any other failure while reading an index entry throws with the status and body", async () => {
  const server = await startServer((_request, response) => {
    response.writeHead(500);
    response.end("database on fire");
  });
  try {
    const provider = new SofProvider({ registryUrl: server.url });
    await assert.rejects(provider.queryPackage("sovvie/router"), /\(500\).*database on fire/);
  } finally {
    await server.close();
  }
});

test("names are looked up in lowercase, and a trailing slash on the URL is harmless", async () => {
  const server = await startServer((_request, response) =>
    sendJson(
      response,
      200,
      indexBody("sovvie", "router", {
        "1.0.0": {
          realm: "shared",
          dependencies: { Butler: "sovvie/butler@^1.0.0" },
          checksum: CHECKSUM,
          artifact: "packages/sovvie/router/1.0.0.tar.gz",
          yanked: true,
        },
      })
    )
  );
  try {
    const provider = new SofProvider({ registryUrl: `${server.url}/` });
    const result = await provider.queryPackage("Sovvie/Router");

    assert.equal(server.requests[0].url, "/index/sovvie/router.json");
    assert.equal(result.source, "sof");
    assert.equal(result.packageName, "Sovvie/Router");
    assert.deepEqual(result.versions, [
      {
        version: "1.0.0",
        metadata: {
          realm: "shared",
          dependencies: { Butler: "sovvie/butler@^1.0.0" },
          checksum: CHECKSUM,
          artifact: "packages/sovvie/router/1.0.0.tar.gz",
          yanked: true,
        },
        dependencies: { Butler: "sovvie/butler@^1.0.0" },
      },
    ]);
  } finally {
    await server.close();
  }
});

test("a name that can't exist in the registry isn't even requested", async () => {
  const server = await startServer((_request, response) => sendJson(response, 404, {}));
  try {
    const provider = new SofProvider({ registryUrl: server.url });
    assert.equal(await provider.queryPackage("../secret"), null);
    assert.equal(await provider.queryPackage("sovvie/.."), null);
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test("a package downloads from its artifact path", async () => {
  const server = await startServer((request, response) => {
    if (request.url === "/index/sovvie/router.json") {
      return sendJson(
        response,
        200,
        indexBody("sovvie", "router", { "1.0.0": { artifact: "packages/sovvie/router/1.0.0.tar.gz" } })
      );
    }
    response.writeHead(200);
    response.end(ARCHIVE);
  });
  try {
    const provider = new SofProvider({ registryUrl: server.url });
    const downloaded = await provider.downloadPackage("sovvie/router", "1.0.0");

    assert.equal(downloaded.archiveType, "tar.gz");
    assert.deepEqual(downloaded.buffer, ARCHIVE);
    assert.deepEqual(
      server.requests.map((request) => request.url),
      ["/index/sovvie/router.json", "/packages/sovvie/router/1.0.0.tar.gz"]
    );
  } finally {
    await server.close();
  }
});

test("an artifact path outside the registry's layout is refused and never fetched", async () => {
  const badPaths = [
    "../../etc/passwd",
    "/packages/sovvie/router/1.0.0.tar.gz",
    "http://evil.example/packages/a/b/1.0.0.tar.gz",
    "packages/sovvie/router/1.0.0.zip",
    "packages/sovvie/router/extra/1.0.0.tar.gz",
    "packages/../x/1.0.0.tar.gz",
    "packages/../../1.0.0.tar.gz",
    "packages/sovvie/./1.0.0.tar.gz",
    "packages\\sovvie\\router\\1.0.0.tar.gz",
    "packages/sovvie/router/1.0.0.tar.gz?x=1",
  ];

  for (const artifact of badPaths) {
    const server = await startServer((request, response) => {
      if (request.url === "/index/sovvie/router.json") {
        return sendJson(response, 200, indexBody("sovvie", "router", { "1.0.0": { artifact } }));
      }
      response.writeHead(200);
      response.end(ARCHIVE);
    });
    try {
      const provider = new SofProvider({ registryUrl: server.url });
      await assert.rejects(
        provider.downloadPackage("sovvie/router", "1.0.0"),
        /Refusing to download/,
        `should refuse ${artifact}`
      );
      assert.deepEqual(
        server.requests.map((request) => request.url),
        ["/index/sovvie/router.json"],
        `${artifact} must not be requested`
      );
    } finally {
      await server.close();
    }
  }
});

test("search walks every page until offset + 100 reaches the total", async () => {
  const server = await startServer((request, response) => {
    const url = new URL(request.url, "http://x");
    const offset = Number(url.searchParams.get("offset"));
    const count = Math.min(100, 250 - offset);
    sendJson(response, 200, {
      total: 250,
      packages: Array.from({ length: count }, (_unused, index) => ({
        name: `sofaddon/pkg${offset + index}`,
        latest: "1.0.0",
        versions: 1,
        description: "",
        updated: "2026-01-01T00:00:00.000Z",
      })),
    });
  });
  try {
    const provider = new SofProvider({ registryUrl: server.url });
    const found = await provider.searchPackages({ query: "a b", scope: "sofaddon" });

    assert.equal(found.length, 250);
    assert.deepEqual(
      server.requests.map((request) => request.url),
      [
        "/v1/packages?q=a%20b&limit=100&offset=0&scope=sofaddon",
        "/v1/packages?q=a%20b&limit=100&offset=100&scope=sofaddon",
        "/v1/packages?q=a%20b&limit=100&offset=200&scope=sofaddon",
      ]
    );
  } finally {
    await server.close();
  }
});

test("publish sends the length prefix, the metadata, then the archive bytes", async () => {
  const server = await startServer((_request, response) =>
    sendJson(response, 200, { state: "published", package: "sovvie/router", version: "1.0.0" })
  );
  try {
    const provider = new SofProvider({ registryUrl: server.url, token: "tok-123" });
    const result = await provider.publishPackage(packageEntry(), writeArchive(), CHECKSUM);

    const request = server.requests[0];
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/publish");
    assert.equal(request.headers.authorization, "Bearer tok-123");
    assert.equal(request.headers["content-type"], "application/x-sof-publish");

    const metadataLength = request.body.readUInt32BE(0);
    const metadataBytes = request.body.subarray(4, 4 + metadataLength);
    assert.deepEqual(request.body.subarray(4 + metadataLength), ARCHIVE);

    const metadata = JSON.parse(metadataBytes.toString("utf8"));
    assert.deepEqual(Object.keys(metadata).sort(), [
      "authors",
      "checksum",
      "dependencies",
      "description",
      "license",
      "name",
      "realm",
      "version",
    ]);
    assert.deepEqual(metadata, {
      name: "sovvie/router",
      version: "1.0.0",
      realm: "shared",
      description: "UI navigation",
      license: "MIT",
      authors: ["Sovereignty"],
      dependencies: { Butler: "sovvie/butler@^1.0.0" },
      checksum: CHECKSUM,
    });

    assert.equal(result.state, "published");
    assert.equal(result.packageName, "sovvie/router");
    assert.equal(result.version, "1.0.0");
  } finally {
    await server.close();
  }
});

test("a 202 is reported as held for review, with the findings, not as a failure", async () => {
  const findings = [
    { rule: "remote-asset", file: "src/Loader.luau", line: 12, why: "requires a remote asset id" },
  ];
  const server = await startServer((_request, response) =>
    sendJson(response, 202, { state: "quarantined", findings })
  );
  try {
    const provider = new SofProvider({ registryUrl: server.url, token: "tok" });
    const result = await provider.publishPackage(packageEntry(), writeArchive(), CHECKSUM);

    assert.equal(result.state, "quarantined");
    assert.deepEqual(result.findings, findings);
  } finally {
    await server.close();
  }
});

test("a rejected publish shows the status and the server's reason verbatim", async () => {
  const cases = [
    [401, "bad token", /\(401\): bad token[\s\S]*package login/],
    [403, "you are not an owner of scope sovvie", /\(403\): you are not an owner of scope sovvie/],
    [409, "sovvie/router@1.0.0 already exists", /\(409\): sovvie\/router@1\.0\.0 already exists[\s\S]*bump "version"/],
    [422, "archive rejected: symlink at src/x", /\(422\): archive rejected: symlink at src\/x/],
  ];

  for (const [status, message, pattern] of cases) {
    const server = await startServer((_request, response) => sendJson(response, status, { error: message }));
    try {
      const provider = new SofProvider({ registryUrl: server.url, token: "tok" });
      await assert.rejects(provider.publishPackage(packageEntry(), writeArchive(), CHECKSUM), pattern);
    } finally {
      await server.close();
    }
  }
});

test("a rate-limited publish mentions Retry-After", async () => {
  const server = await startServer((_request, response) =>
    sendJson(response, 429, { error: "slow down" }, { "Retry-After": "42" })
  );
  try {
    const provider = new SofProvider({ registryUrl: server.url, token: "tok" });
    await assert.rejects(
      provider.publishPackage(packageEntry(), writeArchive(), CHECKSUM),
      /\(429\): slow down[\s\S]*42/
    );
  } finally {
    await server.close();
  }
});

test("publishing without a token tells the user to log in and sends nothing", async () => {
  const server = await startServer((_request, response) => sendJson(response, 200, { state: "published" }));
  try {
    // SOF_TOKEN and GITHUB_TOKEN are set (see top of file) and must not count.
    const provider = new SofProvider({ registryUrl: server.url });
    await assert.rejects(
      provider.publishPackage(packageEntry(), writeArchive(), CHECKSUM),
      /Not signed in\. Run "sof run package login" first\./
    );
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test("a token from SOF_REGISTRY_TOKEN is used for publishing", async () => {
  const server = await startServer((_request, response) => sendJson(response, 200, { state: "published" }));
  process.env.SOF_REGISTRY_TOKEN = "from-env";
  try {
    const provider = new SofProvider({ registryUrl: server.url });
    await provider.publishPackage(packageEntry(), writeArchive(), CHECKSUM);
    assert.equal(server.requests[0].headers.authorization, "Bearer from-env");
  } finally {
    delete process.env.SOF_REGISTRY_TOKEN;
    await server.close();
  }
});

test("a Wally download carries the Wally-Version header", async () => {
  const zip = Buffer.from("PK-pretend-zip");
  const server = await startServer((request, response) => {
    if (!request.headers["wally-version"]) {
      response.writeHead(426);
      return response.end("Wally version header required");
    }
    response.writeHead(200);
    response.end(zip);
  });
  try {
    const provider = new WallyProvider({ apiBaseUrl: server.url });
    const downloaded = await provider.downloadPackage("evaera/promise", "4.0.0");

    assert.equal(server.requests[0].url, "/v1/package-contents/evaera/promise/4.0.0");
    assert.equal(server.requests[0].headers["wally-version"], WALLY_CLIENT_VERSION);
    assert.match(WALLY_CLIENT_VERSION, /^\d+\.\d+\.\d+$/);
    assert.equal(downloaded.archiveType, "zip");
    assert.deepEqual(downloaded.buffer, zip);
  } finally {
    await server.close();
  }
});

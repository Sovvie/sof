"use strict";

// A tiny stand-in for the sof registry: the same two JSON endpoints the extension reads
//   GET /index/<scope>/<name>.json
//   GET /v1/packages?limit=&offset=
// Used by the integration tests and the screenshot script.

const http = require("http");

/**
 * @param {Record<string, { description: string, versions: Record<string, object> }>} packages
 */
function startRegistry(packages) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    const indexMatch = /^\/index\/([^/]+)\/([^/]+)\.json$/.exec(req.url);
    if (indexMatch) {
      const pkg = packages[`${indexMatch[1]}/${indexMatch[2]}`];
      if (!pkg) return send(404, { error: "not found" });
      const versions = {};
      for (const [version, extra] of Object.entries(pkg.versions)) {
        versions[version] = {
          realm: "shared",
          description: pkg.description,
          license: "MIT",
          authors: ["Acme"],
          dependencies: {},
          published: "2026-01-01T00:00:00.000Z",
          ...extra,
        };
      }
      return send(200, { scope: indexMatch[1], name: indexMatch[2], versions });
    }

    if (req.url.startsWith("/v1/packages")) {
      const list = Object.entries(packages).map(([name, pkg]) => ({
        name,
        latest: Object.keys(pkg.versions)
          .filter((version) => !pkg.versions[version].yanked)
          .pop(),
        versions: Object.keys(pkg.versions).length,
        description: pkg.description,
      }));
      return send(200, { total: list.length, packages: list });
    }

    send(404, { error: "no such route" });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, hits, close: () => server.close() });
    });
  });
}

module.exports = { startRegistry };

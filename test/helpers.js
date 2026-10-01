"use strict";

// Shared by the registry tests: a throwaway local HTTP server that records every request.

const http = require("http");

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(JSON.stringify(payload));
}

// handler(request, response, record) answers each request; record = { method, url, headers, body }.
async function startServer(handler) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const record = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: await readBody(request),
    };
    requests.push(record);

    try {
      await handler(request, response, record);
    } catch (err) {
      response.writeHead(500);
      response.end(String(err && err.stack));
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

// An index file body in the registry's format.
function indexBody(scope, name, versions) {
  return { scope, name, versions };
}

module.exports = { indexBody, readBody, sendJson, startServer };

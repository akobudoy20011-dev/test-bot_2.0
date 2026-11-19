"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");
const HttpsProxyAgent = require("https-proxy-agent");
const { createProxyManager, parseProxyUrl, verifyProxyLocation } = require("../proxy-config");

test("proxy URL requires an explicit HTTP or HTTPS proxy and port", () => {
  assert.throws(() => parseProxyUrl(""), /PROXY_URL is required/);
  assert.throws(() => parseProxyUrl("socks5://proxy.example:1080"), /HTTP\/HTTPS/);
  assert.throws(() => parseProxyUrl("http://proxy.example"), /explicit port/);
  assert.equal(
    parseProxyUrl("http://user:pass@proxy.example:8080"),
    "http://user:pass@proxy.example:8080/"
  );
});

test("missing PROXY_URL fails closed and never invokes the location check", async () => {
  let checks = 0;
  let fetchProxyConfigurations = 0;
  const logs = [];
  const manager = createProxyManager({
    env: {},
    verifyLocation: async () => { checks++; return { ok: true, country: "PH", city: "Manila" }; },
    configureFetchProxy: () => { fetchProxyConfigurations++; },
    logger: { log() {}, warn() {}, error: message => logs.push(message) }
  });

  const status = await manager.initialize();
  assert.equal(status.ready, false);
  assert.equal(status.configured, false);
  assert.equal(checks, 0);
  assert.equal(fetchProxyConfigurations, 0);
  assert.throws(() => manager.getLoginOptions(), /PROXY_URL is required/);
  assert.match(logs[0], /direct fallback is disabled/);
});

test("proxy manager configures global fetch and verifies location once", async () => {
  let checks = 0;
  const fetchProxyConfigurations = [];
  const manager = createProxyManager({
    env: { PROXY_URL: "http://user:secret@proxy.example:8080" },
    verifyLocation: async () => {
      checks++;
      return { ok: true, country: "PH", city: "Manila", region: "Metro Manila" };
    },
    configureFetchProxy: url => fetchProxyConfigurations.push(url),
    logger: { log() {}, warn() {}, error() {} }
  });

  const [first, second] = await Promise.all([manager.initialize(), manager.initialize()]);
  assert.equal(checks, 1);
  assert.deepEqual(fetchProxyConfigurations, ["http://user:secret@proxy.example:8080/"]);
  assert.equal(first.ready, true);
  assert.equal(second.locationVerified, true);
  assert.deepEqual(manager.getLoginOptions(), { proxy: "http://user:secret@proxy.example:8080/" });
  assert.equal(JSON.stringify(manager.getStatus()).includes("secret"), false);
});

test("unexpected egress location warns but does not switch to direct networking", async () => {
  const warnings = [];
  const manager = createProxyManager({
    env: { PROXY_URL: "http://proxy.example:8080" },
    verifyLocation: async () => ({ ok: true, country: "US", city: "New York", region: "New York" }),
    configureFetchProxy() {},
    logger: { log() {}, warn: message => warnings.push(message), error() {} }
  });

  const status = await manager.initialize();
  assert.equal(status.ready, true);
  assert.match(status.warning, /expected Manila, Philippines/);
  assert.match(warnings[0], /Proxy-only mode remains enforced/);
});

test("ipinfo lookup uses an HTTPS proxy agent and parses only location fields", async () => {
  let receivedOptions;
  const fakeHttps = {
    get(url, options, callback) {
      assert.equal(url, "https://ipinfo.io/json");
      receivedOptions = options;
      const request = new EventEmitter();
      request.setTimeout = () => {};
      request.destroy = () => {};
      process.nextTick(() => {
        const response = new EventEmitter();
        response.statusCode = 200;
        callback(response);
        process.nextTick(() => {
          response.emit("data", Buffer.from(JSON.stringify({
            ip: "203.0.113.1", country: "PH", city: "Manila", region: "Metro Manila"
          })));
          response.emit("end");
        });
      });
      return request;
    }
  };

  const result = await verifyProxyLocation("http://proxy.example:8080", { httpsImpl: fakeHttps });
  assert.equal(receivedOptions.agent instanceof HttpsProxyAgent, true);
  assert.deepEqual(result, { ok: true, country: "PH", city: "Manila", region: "Metro Manila" });
  assert.equal(JSON.stringify(result).includes("203.0.113.1"), false);
});


test("proxy can be disabled for direct mode and re-enabled without losing the configured URL", async () => {
  const configured = [];
  const direct = [];
  const persisted = [];
  const manager = createProxyManager({
    env: { PROXY_URL: "http://user:secret@proxy.example:8080" },
    initialEnabled: false,
    persistEnabled: value => persisted.push(value),
    configureFetchProxy: url => configured.push(url),
    configureFetchDirect: () => direct.push("direct"),
    verifyLocation: async () => ({ ok: true, country: "PH", city: "Manila" }),
    logger: { log() {}, warn() {}, error() {} }
  });

  const initial = await manager.initialize();
  assert.equal(initial.ready, true);
  assert.equal(initial.enabled, false);
  assert.deepEqual(manager.getLoginOptions(), {});
  assert.equal(direct.length, 1);

  const disabled = manager.setEnabled(false);
  assert.equal(disabled.enabled, false);
  assert.deepEqual(persisted, [false]);

  manager.setEnabled(true);
  const enabled = await manager.initialize();
  assert.equal(enabled.ready, true);
  assert.equal(enabled.enabled, true);
  assert.deepEqual(manager.getLoginOptions(), { proxy: "http://user:secret@proxy.example:8080/" });
  assert.deepEqual(configured, ["http://user:secret@proxy.example:8080/"]);
  assert.deepEqual(persisted, [false, true]);
});

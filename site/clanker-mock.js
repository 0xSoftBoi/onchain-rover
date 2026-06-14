/* CLANKER 500 — standalone demo layer for GitHub Pages.
 *
 * The dashboard normally talks to the sidecar (port 4021). On static hosting
 * there is no backend, so this patches window.fetch + window.EventSource BEFORE
 * the page's main script runs and feeds it a coherent, evolving mock of the
 * whole stack — settlements, on-device reasoning, the live RACE CONTROL bus,
 * pending→confirmed tx, gas/purse, race odds, proof, reputation, the works.
 *
 * Loaded only by site/index.html. The real sidecar build (sidecar/public/
 * mux.html) is untouched and still uses the live endpoints.
 */
(function () {
  "use strict";
  var EX = "https://testnet.arcscan.app";
  var SEPOLIA = "https://sepolia.etherscan.io";
  var hex = function (n) { var s = ""; for (var i = 0; i < n; i++) s += "0123456789abcdef"[(Math.random() * 16) | 0]; return s; };
  var tx = function () { return "0x" + hex(40); };
  var pick = function (a) { return a[(Math.random() * a.length) | 0]; };

  // ---- slowly-changing state (polled tiles) --------------------------------
  var robots = {
    guard:   { ok: true, role: "guard",   battery_v: 12.4, ens: "guard.roverfleet.eth",   url: "#", feed: "./mock-cam.svg?guard" },
    courier: { ok: true, role: "courier", battery_v: 12.1, ens: "courier.roverfleet.eth", url: "#", feed: "./mock-cam.svg?courier" },
  };
  var feed = [];          // /onchain/feed events
  var reasonLog = [];     // /reason/feed events
  var settled = 0, count = 0, block = 14797000;
  var race = { id: "clanker-500", status: "betting", racers: ["guard", "courier"], winner: undefined, finishMs: undefined };

  var routes = {
    "/status": function () {
      return { ok: true, arc: { chainId: 5042002, explorer: EX }, robots: robots,
        ens: { parent: "roverfleet.eth", courier: { resolved: true }, guard: { resolved: true } } };
    },
    "/onchain/feed": function () {
      return { events: feed.slice(0, 40), settledUsdc: +settled.toFixed(2), count: count };
    },
    "/reason/feed": function () { return { events: reasonLog.slice(0, 40) }; },
    "/learning": function () { return { demand: 0.72, n: 6, sellRate: 0.83, avgRounds: 2.2 }; },
    "/reputation": function () {
      return { guard: { ens: "guard.roverfleet.eth", count: 7, avg: 95 },
               courier: { ens: "courier.roverfleet.eth", count: 4, avg: 91 } };
    },
    "/race/odds": function () { return { pool: { guard: 3, courier: 5 }, total: 8, odds: { guard: 2.67, courier: 1.6 }, count: 6 }; },
    "/race/state": function () { return race; },
    "/worldid/config": function () { return { configured: true, action: "rover-gp-bet", appId: "app_clanker500" }; },
    "/session/status": function () { return { authorized: race.status === "racing" }; },
    "/treasury/info": function () { return { deployed: true, balanceUsdc6: "12500000", owner: "0x5afeC1ankeR500Trea5uryD0e5b00b1e5000 Led".replace(/[^0-9a-fA-Fx]/g, "").slice(0, 42) }; },
    "/cre/latest": function () {
      return { configured: true, exists: true, verified: true, score: 92, job: "demo-1",
        tx: "0x" + hex(40), explorer: SEPOLIA };
    },
    "/leaderboard/network": function () {
      return { configured: true, rows: [
        { agent: "vroom.eth", feedback: 142 }, { agent: "guard.roverfleet.eth", feedback: 96 },
        { agent: "pitstop.eth", feedback: 71 }, { agent: "courier.roverfleet.eth", feedback: 58 },
        { agent: "boxbox.eth", feedback: 33 } ] };
    },
    "/privy/status": function () { return { configured: true, custody: "privy-tee" }; },
    "/proof/latest": function () {
      var blobId = "zTOQNkKtqGa-ziBkSF6Z-_oGuKYWvAQq79wkZZ-MhRw";
      return { proof: { blobId: blobId, sha256: "44d5699262c4714e87e07bd65fd34f774fe253fc5ed9563ef922a08fb58e2d5a",
        label: "courier · photo finish @ checkered flag" },
        aggregator: "https://aggregator.walrus-testnet.walrus.space",
        url: "https://aggregator.walrus-testnet.walrus.space/v1/blobs/" + blobId };
    },
  };

  // Optional live backend: ?api=https://your-sidecar  (must run the new build
  // with CORS). When set, real data is tried first and mock is the fallback;
  // unset → pure mock (the default published experience).
  var API = (new URLSearchParams(location.search).get("api") || window.CLANKER_API || "").replace(/\/$/, "");
  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  function mockResp(path) {
    if (!routes[path]) return null;
    var body = routes[path]();
    return { ok: true, status: 200, json: function () { return Promise.resolve(body); } };
  }
  window.fetch = function (u) {
    var raw = String(u), path = raw.replace(location.origin, "").split("?")[0];
    if (API && realFetch && path.charAt(0) === "/") {
      // try the live sidecar; on any error/!ok fall back to mock for that call
      return realFetch(API + raw.replace(location.origin, ""), { headers: { "ngrok-skip-browser-warning": "1" } })
        .then(function (r) { return r.ok ? r : (mockResp(path) || r); })
        .catch(function () { var m = mockResp(path); if (m) return m; throw new Error("offline"); });
    }
    var mk = mockResp(path);
    if (mk) return Promise.resolve(mk);
    return realFetch ? realFetch.apply(window, arguments) : Promise.reject(new Error("offline"));
  };

  // ---- live bus (SSE) ------------------------------------------------------
  var subs = [];
  function push(e) {
    e.id = push._id = (push._id || 0) + 1;
    e.t = Date.now();
    if (e.severity === undefined) e.severity = "info";
    var line = "data:" + JSON.stringify(e) + "\n\n";
    subs.forEach(function (s) { if (s.onmessage) s.onmessage({ data: JSON.stringify(e) }); });
  }
  var RealES = window.EventSource;
  function FakeEventSource() { this.onmessage = null; this.onerror = null; subs.push(this); }
  FakeEventSource.prototype.close = function () { var i = subs.indexOf(this); if (i >= 0) subs.splice(i, 1); };
  // With a live API, stream the real bus; otherwise (and the published default)
  // use the mock bus. If the live stream is unreachable the fetch tiles still
  // animate via the mock fallback above.
  window.EventSource = function () {
    if (API && RealES) { try { return new RealES(API + "/events/stream"); } catch (e) { /* mock */ } }
    return new FakeEventSource();
  };

  // ---- the show: a repeating Grand Prix lap of activity --------------------
  var reasonScript = [
    ["guard", "reserve", "demand 0.72 — strong. reserve $0.75, step $0.25. holding value.", "plan"],
    ["guard", "offer", "EventPass on the grid. opening at $2.00. do I hear two?", "offer"],
    ["courier", "observe", "offer $2.00, budget $1.25. over budget — hold the line.", "thought"],
    ["courier", "decide", "WAIT. price dropping ~$0.25/lap, expect lower.", "decision"],
    ["guard", "offer", "no takers. down to $1.75.", "offer"],
    ["courier", "observe", "$1.75 still rich. no rival buyers on track. hold.", "thought"],
    ["guard", "offer", "$1.50, going once…", "offer"],
    ["courier", "decide", "ACCEPT @ $1.25 — at budget, clock's ticking. box box box.", "decision"],
    ["guard", "settle", "SOLD to courier.rover.eth for $1.25. chequered flag.", "decision"],
  ];
  var settleCycle = [
    { kind: "PAY", detail: "courier → guard $1.25 USDC", usdc: 1.25 },
    { kind: "MINT", detail: "EventPass → courier @ $1.25", usdc: 0 },
    { kind: "REPUTATION", detail: "guard rated 95 (skill: guard)", usdc: 0 },
    { kind: "BET", detail: "$2 on courier (World-verified human)", usdc: 2 },
    { kind: "RACE SETTLE", detail: "courier wins · proof DhDkmlGywO…", usdc: 0 },
  ];
  var busChatter = [
    ["robot", "CALL", "guard /negotiate/sell → 200", "ok"],
    ["robot", "CALL", "courier /negotiate/buy → 200", "ok"],
    ["backend", "x402", "paid POST /pilot/courier/start · 0x9af3…", "ok"],
    ["robot", "GET", "guard /telemetry → 200", "ok"],
    ["robot", "CALL", "guard /capture → 200", "ok"],
    ["robot", "CALL", "guard /store-proof → 200", "ok"],
    ["backend", "AUCTION", "haggling… price $1.50", "info"],
  ];

  var ri = 0, ci = 0, bi = 0;

  // reasoning ticks
  setInterval(function () {
    var r = reasonScript[ri++ % reasonScript.length];
    var evt = { robot: r[0], phase: r[1], text: r[2], kind: r[3], t: Date.now() };
    reasonLog.unshift(evt);
    if (reasonLog.length > 40) reasonLog.pop();
    push({ layer: "reason", kind: r[3], detail: r[2], extra: { robot: r[0], phase: r[1] } });
  }, 2600);

  // backend / robot chatter on the bus
  setInterval(function () {
    var c = busChatter[bi++ % busChatter.length];
    push({ layer: c[0], kind: c[1], detail: c[2], severity: c[3], ms: 90 + ((bi * 53) % 380) });
  }, 2100);

  // settlement lap: pending → confirmed, advancing purse + ledger
  setInterval(function () {
    var s = settleCycle[ci++ % settleCycle.length];
    var ms = 1400 + ((Math.random() * 2200) | 0);
    var gasUsdc = +(0.0018 + Math.random() * 0.0032).toFixed(6);
    var h = tx();
    block += 1 + ((Math.random() * 3) | 0);
    // open
    push({ layer: "chain", kind: s.kind, detail: s.detail, usdc: s.usdc, extra: { pending: true } });
    // race state flourish
    if (s.kind === "BET") { race.status = "racing"; race.winner = undefined; race.finishMs = undefined; }
    if (s.kind === "RACE SETTLE") { race.status = "finished"; race.winner = "courier"; race.finishMs = 4200 + ((Math.random() * 1500) | 0); }
    // confirm after the "block time"
    setTimeout(function () {
      var conf = { layer: "chain", kind: s.kind, detail: s.detail, severity: "ok", tx: h,
        explorer: EX + "/tx/" + h, usdc: s.usdc, ms: ms, gasUsdc: gasUsdc, block: block, chain: "Arc" };
      push(conf);
      feed.unshift({ t: Date.now(), kind: s.kind, detail: s.detail, tx: h, explorer: EX + "/tx/" + h,
        usdc: s.usdc, ms: ms, gasUsdc: gasUsdc, block: block, chain: "Arc" });
      if (feed.length > 60) feed.pop();
      settled += s.usdc; count += 1;
      if (s.kind === "RACE SETTLE") setTimeout(function () { race.status = "betting"; }, 4000);
    }, Math.min(ms, 1300));
  }, 3400);

  // seed a little history so the wall isn't empty on first paint
  for (var k = 0; k < 5; k++) {
    var s0 = settleCycle[k], h0 = tx();
    feed.push({ t: Date.now() - (5 - k) * 6000, kind: s0.kind, detail: s0.detail, tx: h0,
      explorer: EX + "/tx/" + h0, usdc: s0.usdc, ms: 1800 + k * 200, gasUsdc: 0.0024, block: block + k, chain: "Arc" });
    settled += s0.usdc; count++;
    reasonLog.push({ robot: reasonScript[k][0], phase: reasonScript[k][1], text: reasonScript[k][2], kind: reasonScript[k][3], t: Date.now() - k * 3000 });
  }
})();

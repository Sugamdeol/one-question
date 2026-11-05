/* One Question - ask several models the same prompt, in parallel, paid with the
   visitor's own Pollen. No build step, no dependencies, no server. */
(function () {
  "use strict";

  var CFG = {
    clientId: "pk_yLPV9dPlAHJ9LNyj",
    authEndpoint: "https://enter.pollinations.ai/authorize",
    tokenEndpoint: "https://enter.pollinations.ai/api/oauth/token",
    userinfoEndpoint: "https://enter.pollinations.ai/api/oauth/userinfo",
    chatEndpoint: "https://gen.pollinations.ai/v1/chat/completions",
    scope: "profile usage",
    budget: 5,
    expiryDays: 7,
    judgeModel: "openai/gpt-5.4-mini"
  };

  // The redirect URI is this page itself, so the code exchange happens here and
  // the address bar can be cleaned straight away. index.html is normalised away
  // because the registered URI is the directory.
  function pageUrl() {
    var path = window.location.pathname.replace(/index\.html$/, "");
    return window.location.origin + path;
  }

  // One model per lab, so a comparison shows a spread of house styles rather
  // than four versions of the same one.
  var MODELS = [
    { id: "openai/gpt-5.4-nano", lab: "[OI]" },
    { id: "openai/gpt-5.4-mini", lab: "[OI]" },
    { id: "deepseek/deepseek-v4.1-flash", lab: "DeepSeek" },
    { id: "meta/llama-3.3-70b-instruct", lab: "Meta" },
    { id: "mistralai/mistral-large-3", lab: "Mistral" },
    { id: "x-ai/grok-4.3", lab: "xAI" },
    { id: "moonshotai/kimi-k2.6", lab: "Moonshot" },
    { id: "openai/gpt-oss-20b", lab: "[OI]" }
  ];
  var DEFAULT_ON = 4;
  var TIMEOUT_MS = 90000;
  var MAX_TOKENS = 600;

  var EXAMPLES = [
    "Is a hot dog a sandwich? Two sentences.",
    "Name one book everyone should read, and why.",
    "Explain why the sky is blue to a ten year old.",
    "What is the most overrated technology right now?"
  ];

  var $ = function (s) { return document.querySelector(s); };
  var tokenKey = "oq.token";
  var pickedKey = "oq.picked";

  var state = {
    token: sessionStorage.getItem(tokenKey) || null,
    user: null,
    picked: new Set(),
    answers: [],
    prompt: "",
    judge: null,
    judging: false,
    running: false
  };

  /* --------------------------------------------------------------- models */
  function buildModels() {
    var saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(pickedKey) || "null"); } catch (e) { saved = null; }
    var box = $("#models");
    box.textContent = "";
    MODELS.forEach(function (m, i) {
      var on = Array.isArray(saved) ? saved.indexOf(m.id) !== -1 : i < DEFAULT_ON;
      if (on) state.picked.add(m.id);
      var label = document.createElement("label");
      label.className = "chip" + (on ? " on" : "");
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = on;
      cb.addEventListener("change", function () {
        if (cb.checked) state.picked.add(m.id); else state.picked.delete(m.id);
        label.classList.toggle("on", cb.checked);
        sessionStorage.setItem(pickedKey, JSON.stringify(Array.from(state.picked)));
        renderCost();
      });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(m.lab));
      label.title = m.id;
      box.appendChild(label);
    });
  }

  function buildExamples() {
    var box = $("#examples");
    box.textContent = "";
    EXAMPLES.forEach(function (text) {
      var b = document.createElement("button");
      b.className = "ex";
      b.type = "button";
      b.textContent = text;
      b.addEventListener("click", function () {
        $("#q").value = text;
        $("#qcount").textContent = text.length + " chars";
        $("#q").focus();
      });
      box.appendChild(b);
    });
  }

  function renderCost() {
    var n = state.picked.size;
    $("#costHint").textContent = n + (n === 1 ? " model selected" : " models selected");
    $("#askBtn").disabled = state.running || n < 2;
  }

  /* ----------------------------------------------------------------- auth */
  function b64url(buf) {
    var bytes = new Uint8Array(buf);
    var s = "";
    for (var i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function rnd(n) {
    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    var b = new Uint8Array(n);
    crypto.getRandomValues(b);
    var out = "";
    for (var i = 0; i < n; i += 1) out += alphabet[b[i] % alphabet.length];
    return out;
  }
  function challenge(verifier) {
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)).then(b64url);
  }

  function signIn() {
    var verifier = rnd(64);
    var stateParam = rnd(24);
    sessionStorage.setItem("oq.verifier", verifier);
    sessionStorage.setItem("oq.state", stateParam);
    challenge(verifier).then(function (ch) {
      var params = new URLSearchParams({
        response_type: "code",
        client_id: CFG.clientId,
        redirect_uri: pageUrl(),
        scope: CFG.scope,
        budget: String(CFG.budget),
        models: "text",
        expiry: String(CFG.expiryDays),
        state: stateParam,
        code_challenge: ch,
        code_challenge_method: "S256"
      });
      window.location.assign(CFG.authEndpoint + "?" + params.toString());
    });
  }

  // The authorization code comes back in the query string; swap it for a token
  // and strip it from the address bar so a reload or a copied link cannot
  // replay it.
  function finishSignIn() {
    var params = new URLSearchParams(window.location.search);
    var code = params.get("code");
    var err = params.get("error");
    if (!code && !err) return Promise.resolve(false);
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, "", pageUrl());
    }
    if (err) {
      setStatus("Sign in failed: " + err + " " + (params.get("error_description") || ""), true);
      return Promise.resolve(true);
    }
    var verifier = sessionStorage.getItem("oq.verifier");
    if (!verifier) {
      setStatus("Sign in could not finish because this tab lost its PKCE verifier. Sign in again.", true);
      return Promise.resolve(true);
    }
    setStatus("Finishing sign in...", false);
    return fetch(CFG.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        client_id: CFG.clientId,
        redirect_uri: pageUrl(),
        code_verifier: verifier
      })
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok || !data.access_token) {
          throw new Error((data && (data.error_description || data.error)) || ("HTTP " + r.status));
        }
        state.token = data.access_token;
        sessionStorage.setItem(tokenKey, data.access_token);
        sessionStorage.removeItem("oq.verifier");
        return loadUser();
      });
    }).then(function () {
      setStatus("Signed in. Your own Pollen pays for the calls.", false);
      return true;
    }).catch(function (e) {
      setStatus("Sign in failed: " + (e && e.message ? e.message : "unknown error"), true);
      return true;
    });
  }

  function loadUser() {
    if (!state.token) {
      $("#who").textContent = "Not signed in";
      $("#signBtn").textContent = "Sign in with Pollen";
      return Promise.resolve();
    }
    return fetch(CFG.userinfoEndpoint, { headers: { Authorization: "Bearer " + state.token } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (u) {
        state.user = u;
        var name = (u && (u.name || u.email || u.githubUsername || u.username)) || "Pollen account";
        $("#who").textContent = name;
        $("#signBtn").textContent = "Sign out";
      });
  }

  /* ------------------------------------------------------------- agreement */
  function contentWords(text) {
    var stop = {};
    ("a an the and or but if then than that this these those is are was were be been being " +
     "to of in on at for with from by as it its not no yes so do does did can could would " +
     "should will may might must have has had i you he she they we my your our their there " +
     "here what which who whom about into over under more most some any all one two also " +
     "just very really quite while because when where how why").split(" ").forEach(function (w) { stop[w] = 1; });
    return String(text).toLowerCase().replace(/[^a-z0-9\s'-]/g, " ").split(/\s+/)
      .filter(function (w) { return w.length > 2 && !stop[w]; });
  }

  // Dice coefficient over the distinguishable words of two answers.
  function overlap(a, b) {
    var wa = new Set(a), wb = new Set(b);
    if (!wa.size || !wb.size) return 0;
    var hit = 0;
    wa.forEach(function (w) { if (wb.has(w)) hit += 1; });
    return (2 * hit) / (wa.size + wb.size);
  }

  function scoreAgreement(answers) {
    var words = answers.map(function (a) { return contentWords(a.text || ""); });
    return answers.map(function (_, i) {
      var others = answers.map(function (_, j) { return j; })
        .filter(function (j) { return j !== i && answers[j].ok; });
      if (!others.length) return null;
      var sum = others.reduce(function (acc, j) { return acc + overlap(words[i], words[j]); }, 0);
      return sum / others.length;
    });
  }

  function biggestSplit(answers) {
    var ok = answers.filter(function (a) { return a.ok; });
    if (ok.length < 2) return null;
    var worst = null;
    for (var i = 0; i < ok.length; i += 1) {
      for (var j = i + 1; j < ok.length; j += 1) {
        var d = 1 - overlap(contentWords(ok[i].text), contentWords(ok[j].text));
        if (!worst || d > worst.distance) worst = { a: ok[i], b: ok[j], distance: d };
      }
    }
    return worst;
  }

  /* ----------------------------------------------------------------- cards */
  function card(a, bestId) {
    var el = document.createElement("article");
    el.className = "card" + (a.ok ? "" : a.done ? " bad" : " pending") + (a.id === bestId ? " best" : "");
    var head = document.createElement("div");
    head.className = "head";
    var name = document.createElement("span");
    name.className = "mname";
    name.textContent = a.id;
    name.title = a.id;
    var lab = document.createElement("span");
    lab.className = "lab";
    lab.textContent = a.state;
    head.appendChild(name);
    head.appendChild(lab);

    var body = document.createElement("div");
    body.className = "answer" + (a.text ? "" : " empty");
    body.textContent = a.text || (a.ok ? "" : (a.error || "Waiting for an answer"));

    var foot = document.createElement("div");
    foot.className = "foot";
    var ms = document.createElement("span");
    ms.textContent = a.ms ? (a.ms / 1000).toFixed(1) + "s" : "-";
    var meta = document.createElement("span");
    meta.textContent = a.tokens ? a.tokens + " tok" : "";
    foot.appendChild(ms);
    foot.appendChild(meta);
    if (a.agree !== null && a.agree !== undefined) {
      var wrap = document.createElement("span");
      wrap.style.display = "flex";
      wrap.style.alignItems = "center";
      wrap.style.gap = "6px";
      var barEl = document.createElement("span");
      barEl.className = "agree";
      var fill = document.createElement("i");
      fill.style.width = Math.round(a.agree * 100) + "%";
      barEl.appendChild(fill);
      var pct = document.createElement("span");
      pct.textContent = Math.round(a.agree * 100) + "%";
      wrap.appendChild(barEl);
      wrap.appendChild(pct);
      wrap.title = "Word overlap with the other answers";
      foot.appendChild(wrap);
    }
    el.appendChild(head);
    el.appendChild(body);
    el.appendChild(foot);
    return el;
  }

  function render() {
    var grid = $("#grid");
    grid.textContent = "";
    var scored = state.answers.filter(function (a) { return a.ok && a.agree !== null; });
    var best = scored.slice().sort(function (a, b) { return b.agree - a.agree; })[0];
    state.answers.forEach(function (a) { grid.appendChild(card(a, best && best.id)); });
    var answered = state.answers.filter(function (a) { return a.ok; }).length;
    var done = state.answers.filter(function (a) { return a.done; }).length;
    $("#resultStat").textContent = done ? answered + " of " + done + " answered" : "";
    $("#afterRow").style.display = answered >= 2 ? "flex" : "none";
    $("#judgeBtn").disabled = state.judging;
    renderSummary(best);
  }

  function renderSummary(best) {
    var node = $("#summary");
    node.textContent = "";
    var split = biggestSplit(state.answers);
    if (!best || !split) return;
    node.appendChild(document.createTextNode("Most typical: "));
    var b1 = document.createElement("b");
    b1.textContent = best.id + " (" + Math.round(best.agree * 100) + "% average overlap)";
    node.appendChild(b1);
    node.appendChild(document.createTextNode(". Widest gap: "));
    var b2 = document.createElement("b");
    b2.textContent = split.a.id + " vs " + split.b.id + " (" + Math.round(split.distance * 100) + "% apart)";
    node.appendChild(b2);
    node.appendChild(document.createTextNode("."));
  }

  /* -------------------------------------------------------------- requests */
  function textOf(data) {
    var ch = data && data.choices && data.choices[0];
    if (!ch) return "";
    var msg = ch.message || {};
    var c = msg.content;
    if (Array.isArray(c)) {
      return c.map(function (p) { return typeof p === "string" ? p : (p && p.text) || ""; }).join(" ").trim();
    }
    return String(c || msg.reasoning_content || "").trim();
  }

  function call(model, messages, maxTokens) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
    var started = performance.now();
    return fetch(CFG.chatEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + state.token },
      body: JSON.stringify({ model: model, messages: messages, max_tokens: maxTokens }),
      signal: ctrl.signal
    }).then(function (r) {
      return r.text().then(function (raw) {
        var data = null;
        try { data = JSON.parse(raw); } catch (e) { data = null; }
        clearTimeout(timer);
        if (!r.ok) {
          var msg = (data && data.error && (data.error.message || data.error)) || raw || ("HTTP " + r.status);
          var err = new Error(String(typeof msg === "string" ? msg : JSON.stringify(msg)).slice(0, 200));
          err.status = r.status;
          throw err;
        }
        return { text: textOf(data), tokens: (data.usage && data.usage.total_tokens) || 0, ms: performance.now() - started };
      });
    }).catch(function (e) {
      clearTimeout(timer);
      if (e && e.name === "AbortError") {
        var t = new Error("No answer within 90s");
        t.status = 0;
        throw t;
      }
      if (e && !e.status) e.status = -1;
      throw e;
    });
  }

  function askOne(m, prompt) {
    var answer = { id: m.id, lab: m.lab, text: "", state: "asking", ok: false, done: false, ms: 0, tokens: 0, error: "", agree: null };
    return call(m.id, [{ role: "user", content: prompt }], MAX_TOKENS).then(function (res) {
      answer.ms = res.ms;
      answer.tokens = res.tokens;
      if (!res.text) {
        answer.error = "Empty answer";
        answer.state = "empty";
        return answer;
      }
      answer.text = res.text;
      answer.ok = true;
      answer.state = "answered";
      return answer;
    }).catch(function (e) {
      answer.error = e && e.message ? e.message : "Request failed";
      answer.state = e && e.status === 402 ? "needs Pollen" : e && e.status === 401 ? "not signed in" : "failed";
      return answer;
    }).then(function (a) {
      a.done = true;
      return a;
    });
  }

  function askAll() {
    var prompt = $("#q").value.trim();
    if (prompt.length < 3) { setStatus("Type a question first.", true); return; }
    if (!state.token) {
      setStatus("Sign in with Pollinations first, so your own Pollen pays for the calls.", true);
      return;
    }
    var picked = MODELS.filter(function (m) { return state.picked.has(m.id); });
    if (picked.length < 2) { setStatus("Pick at least two models to compare.", true); return; }

    state.running = true;
    state.prompt = prompt;
    state.judge = null;
    $("#judgePanel").style.display = "none";
    $("#askBtn").disabled = true;
    $("#askBtn").textContent = "Asking " + picked.length + " models...";
    setStatus("Sent. Answers appear together once the slowest model is done.", false);
    state.answers = picked.map(function (m) {
      return { id: m.id, lab: m.lab, text: "", state: "queued", ok: false, done: false, ms: 0, tokens: 0, error: "", agree: null };
    });
    render();

    Promise.all(picked.map(function (m) { return askOne(m, prompt); })).then(function (results) {
      state.answers = results;
      var scores = scoreAgreement(results);
      results.forEach(function (a, i) { a.agree = scores[i]; });
      state.running = false;
      $("#askBtn").disabled = false;
      $("#askBtn").textContent = "Ask every model";
      renderCost();
      render();
      var ok = results.filter(function (a) { return a.ok; }).length;
      if (!ok) setStatus("No model answered. Check your Pollen balance and try again.", true);
      else if (ok === 1) setStatus("Only one model answered. Try again, or pick different models.", true);
      else setStatus("", false);
    });
  }

  /* ----------------------------------------------------------------- judge */
  function judge() {
    var ok = state.answers.filter(function (a) { return a.ok; });
    if (ok.length < 2 || state.judging) return;
    var transcript = ok.map(function (a) { return "### " + a.id + "\n" + a.text; }).join("\n\n");
    var instruction =
      "Several language models answered the same prompt. Compare their answers.\n\n" +
      "Prompt: " + state.prompt + "\n\n" + transcript + "\n\n" +
      "Reply in exactly four short lines, plain text, no preamble:\n" +
      "Split: the one question the models actually disagree about.\n" +
      "Camps: which models fall in which camp, by name.\n" +
      "Outlier: the model furthest from the others, and why.\n" +
      "Missing: one thing every answer leaves out.";

    state.judging = true;
    $("#judgeBtn").disabled = true;
    $("#judgeBtn").textContent = "Asking the judge...";
    call(CFG.judgeModel, [{ role: "user", content: instruction }], 500).then(function (res) {
      state.judge = res.text;
      var body = $("#judgeBody");
      body.textContent = "";
      String(res.text).split(/\n+/).filter(Boolean).forEach(function (line) {
        var p = document.createElement("p");
        p.textContent = line.replace(/^[-*]\s*/, "");
        body.appendChild(p);
      });
      $("#judgePanel").style.display = "block";
      setStatus("", false);
    }).catch(function (e) {
      setStatus("The judge call failed: " + (e && e.message ? e.message : "unknown error"), true);
    }).then(function () {
      state.judging = false;
      $("#judgeBtn").disabled = false;
      $("#judgeBtn").textContent = "Ask a judge to map the split";
    });
  }

  /* ------------------------------------------------------------------ misc */
  function setStatus(msg, isErr) {
    var node = $("#status");
    node.textContent = msg || "";
    node.className = "status" + (isErr ? " err" : "");
  }

  function toMarkdown() {
    var lines = ["# One Question", "", "**Prompt:** " + state.prompt, ""];
    state.answers.filter(function (a) { return a.ok; }).forEach(function (a) {
      lines.push("## " + a.id);
      lines.push("");
      lines.push(a.text);
      lines.push("");
      lines.push("_" + (a.ms / 1000).toFixed(1) + "s" +
        (a.tokens ? ", " + a.tokens + " tokens" : "") +
        (a.agree !== null ? ", " + Math.round(a.agree * 100) + "% overlap with the other answers" : "") + "_");
      lines.push("");
    });
    if (state.judge) {
      lines.push("## Judge on the split");
      lines.push("");
      lines.push(state.judge);
      lines.push("");
    }
    return lines.join("\n");
  }

  /* ---------------------------------------------------------------- wiring */
  document.addEventListener("DOMContentLoaded", function () {
    buildModels();
    buildExamples();
    renderCost();

    $("#q").addEventListener("input", function () {
      $("#qcount").textContent = $("#q").value.length + " chars";
    });
    $("#signBtn").addEventListener("click", function () {
      if (state.token) {
        sessionStorage.removeItem(tokenKey);
        state.token = null;
        state.user = null;
        $("#who").textContent = "Not signed in";
        $("#signBtn").textContent = "Sign in with Pollen";
        setStatus("Signed out. The key was removed from this tab.", false);
        return;
      }
      signIn();
    });
    $("#keyBtn").addEventListener("click", function () {
      var v = $("#keyInput").value.trim();
      if (!v) { setStatus("Paste a Pollinations key first.", true); return; }
      if (v.indexOf("sk_") !== 0) { setStatus("That is not a secret key. Keys start with sk_.", true); return; }
      state.token = v;
      sessionStorage.setItem(tokenKey, v);
      $("#keyInput").value = "";
      loadUser();
      setStatus("Key loaded for this tab. Your own Pollen pays for the calls.", false);
    });
    $("#askBtn").addEventListener("click", askAll);
    $("#judgeBtn").addEventListener("click", judge);
    $("#clearBtn").addEventListener("click", function () {
      $("#q").value = "";
      $("#qcount").textContent = "0 chars";
      state.answers = [];
      state.judge = null;
      state.prompt = "";
      $("#judgePanel").style.display = "none";
      render();
      setStatus("", false);
    });
    $("#mdBtn").addEventListener("click", function () {
      navigator.clipboard.writeText(toMarkdown()).then(function () {
        setStatus("Copied as Markdown.", false);
      }).catch(function () {
        setStatus("Copy failed. Select the answers by hand instead.", true);
      });
    });

    render();
    finishSignIn().then(loadUser);
  });
})();

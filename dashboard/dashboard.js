(function () {
  const checking = document.getElementById("checking");
  const loginForm = document.getElementById("login-form");
  const loginError = document.getElementById("login-error");
  const loginNotice = document.getElementById("login-notice");
  const ready = document.getElementById("ready");
  const notice = document.getElementById("notice");
  const stats = document.getElementById("stats");
  const visitsBody = document.getElementById("visits");
  const pageLabel = document.getElementById("page-label");
  const detail = document.getElementById("detail");
  const tokenKey = "force-dashboard-token";
  let csrf = "";
  let accessToken = "";
  let origin = "";
  let refreshTimer = 0;
  try {
    accessToken = sessionStorage.getItem(tokenKey) || "";
  } catch (error) {
    accessToken = "";
  }
  let page = 1;
  let total = 0;
  const pageSize = 25;
  const selected = new Set();
  const revealed = {};

  function url(path) {
    return origin + path;
  }

  function rememberToken(token) {
    accessToken = token || "";
    try {
      if (accessToken) sessionStorage.setItem(tokenKey, accessToken);
      else sessionStorage.removeItem(tokenKey);
    } catch (error) {
      accessToken = token || "";
    }
  }

  function startRefresh() {
    if (refreshTimer) return;
    refreshTimer = window.setInterval(function () {
      if (document.visibilityState === "visible" && !ready.hidden) load(page);
    }, 10000);
  }

  function api(path, init) {
    const headers = { accept: "application/json" };
    if (accessToken) headers.authorization = "Bearer " + accessToken;
    if (init && init.body !== undefined) headers["content-type"] = "application/json";
    if (init && init.csrf) headers["x-csrf-token"] = init.csrf;
    return fetch(url(path), {
      method: (init && init.method) || "GET",
      headers: headers,
      body: init && init.body !== undefined ? JSON.stringify(init.body) : undefined,
      credentials: origin ? "include" : "same-origin",
      cache: "no-store"
    }).then(function (response) {
      return response.text().then(function (text) {
        let data = {};
        if (text) {
          try { data = JSON.parse(text); } catch (error) { data = {}; }
        }
        return { ok: response.ok, status: response.status, data: data };
      });
    }).catch(function () {
      return { ok: false, status: 0, data: {} };
    });
  }

  function message(result, fallback) {
    if (result.data && typeof result.data.error === "string" && result.data.error) return result.data.error;
    if (result.status === 0 || result.status === 404) return "The dashboard service is unavailable on this host.";
    return fallback;
  }

  function show(node, text) {
    node.hidden = !text;
    node.textContent = text || "";
  }

  function filters() {
    const params = new URLSearchParams();
    params.set("range", document.getElementById("range").value);
    if (document.getElementById("bots").checked) params.set("bots", "1");
    if (document.getElementById("tests").checked) params.set("tests", "1");
    return params;
  }

  function when(ms) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short"
    }).format(ms);
  }

  function renderStats(summary) {
    const clicks = summary.clicks || {};
    const cards = [
      ["Active", summary.activeVisitors],
      ["Visitors", summary.browserVisitors],
      ["Visits", summary.visits],
      ["Page views", summary.pageViews],
      ["Telegram", clicks.telegram || 0],
      ["X", clicks.x || 0],
      ["DexTools", clicks.dextools || 0],
      ["Chart", clicks.chart || 0],
      ["Copy", clicks.copy || 0],
      ["Film", clicks.film || 0],
      ["Community", clicks.community || 0]
    ];
    stats.replaceChildren();
    cards.forEach(function (card) {
      const item = document.createElement("div");
      item.className = "stat";
      const label = document.createElement("span");
      label.textContent = card[0];
      const value = document.createElement("b");
      value.textContent = String(card[1] ?? 0);
      item.append(label, value);
      stats.appendChild(item);
    });
  }

  function renderVisits(rows) {
    visitsBody.replaceChildren();
    rows.forEach(function (visit) {
      const row = document.createElement("tr");
      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = selected.has(visit.id);
      check.addEventListener("change", function () {
        if (check.checked) selected.add(visit.id);
        else selected.delete(visit.id);
      });
      const checkCell = document.createElement("td");
      checkCell.appendChild(check);
      const time = document.createElement("td");
      const open = document.createElement("button");
      open.className = "link";
      open.type = "button";
      open.textContent = when(visit.startedAt);
      open.addEventListener("click", function () { openDetail(visit.id); });
      time.appendChild(open);
      const place = document.createElement("td");
      place.textContent = visit.location || "";
      const ip = document.createElement("td");
      const reveal = document.createElement("button");
      reveal.className = "link";
      reveal.type = "button";
      reveal.textContent = revealed[visit.id] || visit.ip || "Hidden";
      reveal.addEventListener("click", function () { revealIp(visit.id, reveal); });
      ip.appendChild(reveal);
      const device = document.createElement("td");
      device.textContent = [visit.device, visit.browser, visit.os].filter(Boolean).join(" · ");
      const path = document.createElement("td");
      path.textContent = visit.path || "";
      const referrer = document.createElement("td");
      referrer.textContent = visit.referrer || "";
      row.append(checkCell, time, place, ip, device, path, referrer);
      visitsBody.appendChild(row);
    });
    const pages = Math.max(1, Math.ceil(total / pageSize));
    pageLabel.textContent = "Page " + page + " of " + pages + " · " + total + " visits";
    document.getElementById("prev").disabled = page <= 1;
    document.getElementById("next").disabled = page >= pages;
  }

  function load(nextPage) {
    const query = filters().toString();
    return Promise.all([
      api("/api/dashboard/analytics/summary?" + query),
      api("/api/dashboard/analytics/visits?" + query + "&page=" + nextPage + "&pageSize=" + pageSize)
    ]).then(function (results) {
      if (results[0].status === 401) {
        showLogin("");
        return;
      }
      if (!results[0].ok || !results[1].ok) {
        notice.textContent = message(results[0], "Visitor estimates could not be loaded.");
        return;
      }
      page = nextPage;
      total = results[1].data.total || 0;
      renderStats(results[0].data);
      renderVisits(results[1].data.visits || []);
      notice.textContent = "";
    });
  }

  function showLogin(text) {
    checking.hidden = true;
    ready.hidden = true;
    loginForm.hidden = false;
    show(loginNotice, text);
  }

  function showReady() {
    checking.hidden = true;
    loginForm.hidden = true;
    ready.hidden = false;
  }

  function openDetail(id) {
    api("/api/dashboard/analytics/visits/" + id).then(function (result) {
      if (!result.ok) {
        notice.textContent = message(result, "Visit details could not be loaded.");
        return;
      }
      const visit = result.data;
      detail.hidden = false;
      detail.replaceChildren();
      const title = document.createElement("h2");
      title.textContent = when(visit.startedAt);
      const body = document.createElement("p");
      const views = (visit.pageViews || []).map(function (item) { return item.path; }).join(", ");
      const clicks = (visit.clicks || []).map(function (item) { return item.kind; }).join(", ");
      body.textContent = [visit.location, visit.browser, visit.os, visit.device, visit.path, views && ("Pages: " + views), clicks && ("Clicks: " + clicks)].filter(Boolean).join(" · ");
      detail.append(title, body);
    });
  }

  function revealIp(id, button) {
    if (revealed[id]) {
      delete revealed[id];
      button.textContent = "Hidden";
      return;
    }
    api("/api/dashboard/analytics/visits/" + id + "?reveal=1").then(function (result) {
      if (!result.ok) {
        notice.textContent = message(result, "The IP address could not be revealed.");
        return;
      }
      revealed[id] = result.data.ip;
      button.textContent = result.data.ip;
    });
  }

  loginForm.addEventListener("submit", function (event) {
    event.preventDefault();
    const button = document.getElementById("login-button");
    button.disabled = true;
    api("/api/dashboard/login", {
      method: "POST",
      csrf: csrf,
      body: { password: document.getElementById("dashboard-password").value }
    }).then(function (result) {
      button.disabled = false;
      if (!result.ok || !result.data.accessToken) {
        show(loginError, message(result, "Incorrect password. Please try again."));
        return;
      }
      rememberToken(result.data.accessToken);
      csrf = result.data.csrfToken || csrf;
      document.getElementById("dashboard-password").value = "";
      show(loginError, "");
      showReady();
      startRefresh();
      load(1);
    });
  });

  document.getElementById("logout").addEventListener("click", function () {
    api("/api/dashboard/logout", { method: "POST", csrf: csrf, body: {} }).then(function () {
      rememberToken("");
      return api("/api/dashboard/session");
    }).then(function (session) {
      if (session.data.csrfToken) csrf = session.data.csrfToken;
      showLogin("");
    });
  });

  document.getElementById("filters").addEventListener("submit", function (event) {
    event.preventDefault();
    selected.clear();
    load(1);
  });

  document.getElementById("prev").addEventListener("click", function () { if (page > 1) load(page - 1); });
  document.getElementById("next").addEventListener("click", function () { load(page + 1); });

  document.getElementById("delete").addEventListener("click", function () {
    const ids = Array.from(selected);
    if (!ids.length) {
      notice.textContent = "Select at least one visit.";
      return;
    }
    api("/api/dashboard/analytics/delete", { method: "POST", csrf: csrf, body: { ids: ids } }).then(function (result) {
      if (!result.ok) {
        notice.textContent = message(result, "Those visits could not be deleted.");
        return;
      }
      notice.textContent = "Deleted " + (result.data.deleted || ids.length) + " visits.";
      selected.clear();
      detail.hidden = true;
      load(1);
    });
  });

  document.getElementById("export").addEventListener("click", function () {
    const query = filters();
    if (document.getElementById("include-ips").checked) query.set("reveal", "1");
    const exportHeaders = { "x-csrf-token": csrf, accept: "text/csv" };
    if (accessToken) exportHeaders.authorization = "Bearer " + accessToken;
    fetch(url("/api/dashboard/analytics/export?" + query.toString()), {
      headers: exportHeaders,
      credentials: origin ? "include" : "same-origin",
      cache: "no-store"
    }).then(function (response) {
      if (!response.ok) throw new Error("export");
      return response.blob();
    }).then(function (blob) {
      const file = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = file;
      link.download = "musk-gravity-visits.csv";
      link.click();
      URL.revokeObjectURL(file);
      notice.textContent = "Export downloaded.";
    }).catch(function () {
      notice.textContent = "The CSV export could not be downloaded.";
    });
  });

  fetch("/site.config.json", { cache: "no-cache" })
    .then(function (response) { return response.ok ? response.json() : {}; })
    .catch(function () { return {}; })
    .then(function (config) {
      const configured = config.analytics && typeof config.analytics.apiOrigin === "string" ? config.analytics.apiOrigin : "";
      origin = configured.replace(/\/$/, "");
      return api("/api/dashboard/session");
    })
    .then(function (result) {
      if (!result.ok || !result.data.csrfToken) {
        showLogin("");
        show(loginError, message(result, "The dashboard service is unavailable on this host."));
        return;
      }
      csrf = result.data.csrfToken;
      if (result.data.authenticated) {
        showReady();
        startRefresh();
        load(1);
        return;
      }
      rememberToken("");
      showLogin("");
    });
})();

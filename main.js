(function () {
  const coinVideo = document.getElementById("coin-video");
  const overlay = document.getElementById("film-overlay");
  const dialog = overlay.querySelector(".film-dialog");
  const playerSlot = document.getElementById("film-player");
  const closeButton = overlay.querySelector(".film-close");
  const page = document.getElementById("page");
  const nav = document.getElementById("site-nav");
  const navToggle = document.querySelector(".nav-toggle");

  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const saveData = !!(connection && connection.saveData);
  const slow = !!(connection && /(^|-)2g$/.test(connection.effectiveType || ""));
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const holdPoster = saveData || slow || reduceMotion;

  let config = null;
  let analyticsOrigin = "";
  let filmVideo = null;
  let lastFocus = null;
  let coinVisible = false;
  let coinUserPaused = false;
  let coinArmed = false;
  let filmOpen = false;
  let storyOpen = false;
  let coinObserver = null;

  function safeHttpUrl(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const url = new URL(value, window.location.href);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      return url.href;
    } catch (error) {
      return null;
    }
  }

  function clock(seconds, padded) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const minutes = Math.floor(total / 60);
    const remain = total % 60;
    const mm = padded ? String(minutes).padStart(2, "0") : String(minutes);
    return mm + ":" + String(remain).padStart(2, "0");
  }

  function applyConfig(next) {
    config = next;
    const media = next.media || {};
    const coin = media.coin || {};
    const film = media.film || {};

    if (coin.poster) {
      const poster = document.querySelector(".coin-poster");
      if (poster) poster.src = coin.poster;
    }
    if (coin.src) coinVideo.dataset.src = coin.src;
    if (film.poster) {
      const poster = document.querySelector(".poster img");
      if (poster) poster.src = film.poster;
    }

    const filmTime = document.querySelector(".film-time");
    if (filmTime && film.seconds) filmTime.textContent = clock(film.seconds, true);

    const contract = next.token && next.token.contractAddress;
    const contractNode = document.getElementById("contract-value");
    if (typeof contract === "string" && contract.trim()) {
      contractAddress = contract.trim();
      contractNode.className = "value value-contract";
      contractNode.textContent = contractAddress;
    } else if (next.token && next.token.pendingContractLabel) {
      contractAddress = String(next.token.pendingContractLabel).trim();
      contractNode.className = "value";
      contractNode.textContent = contractAddress;
    }

    const links = next.links || {};
    activateResource("chart", links.chart);
    activateResource("explorer", links.explorer);
    activateSocial("telegram", links.telegram);
    activateSocial("x", links.x);
    const analytics = next.analytics || {};
    analyticsOrigin = typeof analytics.apiOrigin === "string" ? analytics.apiOrigin.replace(/\/$/, "") : "";
  }

  let contractAddress = "";
  const copyButton = document.getElementById("copy-contract");

  function showCopied() {
    const squares = copyButton.querySelector(".icon-squares");
    const check = copyButton.querySelector(".icon-check");
    squares.hidden = true;
    check.hidden = false;
    copyButton.classList.add("is-copied");
    copyButton.setAttribute("aria-label", "Contract address copied");
    trackClick("copy");
    window.setTimeout(function () {
      squares.hidden = false;
      check.hidden = true;
      copyButton.classList.remove("is-copied");
      copyButton.setAttribute("aria-label", "Copy contract address");
    }, 1600);
  }

  function writeAddress(text) {
    if (navigator.clipboard && window.isSecureContext && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () {
        return writeAddressFallback(text);
      });
    }
    return writeAddressFallback(text);
  }

  function writeAddressFallback(text) {
    return new Promise(function (resolve, reject) {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.top = "0";
      area.style.left = "0";
      area.style.width = "1px";
      area.style.height = "1px";
      area.style.padding = "0";
      area.style.border = "0";
      area.style.opacity = "0";
      area.style.fontSize = "16px";
      document.body.appendChild(area);
      const selection = document.getSelection();
      const previous = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
      area.focus();
      area.select();
      area.setSelectionRange(0, text.length);
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (error) {
        ok = false;
      }
      area.remove();
      if (previous && selection) {
        selection.removeAllRanges();
        selection.addRange(previous);
      }
      ok ? resolve() : reject(new Error("copy failed"));
    });
  }

  copyButton.addEventListener("click", function () {
    if (!contractAddress) return;
    writeAddress(contractAddress).then(showCopied).catch(function () {});
  });

  function activateSocial(key, value) {
    const href = safeHttpUrl(value);
    if (!href) return;
    document.querySelectorAll('[data-social="' + key + '"]').forEach(function (el) {
      el.href = href;
      el.target = "_blank";
      el.rel = "noopener noreferrer";
      el.removeAttribute("aria-disabled");
    });
  }

  function activateResource(key, value) {
    const pending = document.querySelector('[data-pending="' + key + '"]');
    if (!pending) return;
    const href = safeHttpUrl(value);
    if (!href) return;
    const link = document.createElement("a");
    link.className = "resource";
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.innerHTML = pending.innerHTML;
    if (key === 'explorer') link.dataset.track = 'dextools';
    if (key === 'chart') link.dataset.track = 'chart';
    pending.replaceWith(link);
  }

  function coinShouldPlay() {
    return coinArmed && coinVisible && !coinUserPaused && !filmOpen && !storyOpen && !document.hidden;
  }

  function attachCoin() {
    if (coinVideo.getAttribute("src")) return;
    const src = coinVideo.dataset.src;
    if (!src) return;
    coinVideo.src = src;
  }

  function playCoin() {
    attachCoin();
    const attempt = coinVideo.play();
    if (attempt && attempt.catch) {
      attempt.then(function () {
        coinVideo.classList.add("is-ready");
      }).catch(function () {
        coinVideo.classList.remove("is-ready");
      });
    }
  }

  function pauseCoin() {
    if (!coinVideo.paused) coinVideo.pause();
  }

  function refreshCoin() {
    if (coinShouldPlay()) playCoin();
    else pauseCoin();
  }

  function armCoin() {
    coinObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        coinVisible = entry.isIntersecting && entry.intersectionRatio >= 0.15;
      });
      if (!coinArmed) return;
      refreshCoin();
    }, { threshold: [0, 0.15, 0.4, 0.75] });
    coinObserver.observe(document.querySelector(".coin"));

    if (!holdPoster) coinArmed = true;
    refreshCoin();
  }

  coinVideo.addEventListener("play", function () {
    coinVideo.classList.add("is-ready");
  });

  document.addEventListener("visibilitychange", refreshCoin);

  function openFilm() {
    filmOpen = true;
    trackClick("film");
    pauseCoin();
    lastFocus = document.activeElement;
    if (!filmVideo) {
      filmVideo = document.createElement("video");
    filmVideo.controls = true;
    filmVideo.playsInline = true;
    filmVideo.setAttribute("playsinline", "");
    filmVideo.preload = "metadata";
    filmVideo.tabIndex = 0;
    filmVideo.setAttribute("aria-label", "Founding film");
      playerSlot.appendChild(filmVideo);
    }
    const src = (config && config.media && config.media.film && config.media.film.src) || "assets/videos/founding-film.mp4";
    if (filmVideo.getAttribute("src") !== src) filmVideo.src = src;
    filmVideo.muted = false;
    overlay.hidden = false;
    page.inert = true;
    document.body.classList.add("film-open");
    closeButton.focus();
    const attempt = filmVideo.play();
    if (attempt && attempt.catch) attempt.catch(function () {});
  }

  function closeFilm() {
    filmOpen = false;
    if (filmVideo) filmVideo.pause();
    overlay.hidden = true;
    page.inert = false;
    document.body.classList.remove("film-open");
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    refreshCoin();
  }

  document.querySelectorAll("[data-open-film]").forEach(function (control) {
    control.addEventListener("click", openFilm);
  });
  closeButton.addEventListener("click", closeFilm);
  overlay.addEventListener("click", function (event) {
    if (event.target === overlay) closeFilm();
  });
  overlay.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeFilm();
      return;
    }
    if (event.key === "Tab" && event.shiftKey && document.activeElement === closeButton) {
      event.preventDefault();
      if (filmVideo) filmVideo.focus();
    }
  });

  document.addEventListener("focusin", function (event) {
    if (!filmOpen || overlay.contains(event.target)) return;
    closeButton.focus();
  });

  const storyOverlay = document.getElementById("story-overlay");
  const storyWindow = storyOverlay.querySelector(".story-window");
  const storyClose = storyOverlay.querySelector(".story-close");
  let storyFocus = null;

  function storyFocusables() {
    return Array.prototype.filter.call(
      storyWindow.querySelectorAll("a[href], button:not([disabled])"),
      function (el) { return !el.hasAttribute("hidden"); }
    );
  }

  function openStory() {
    storyOpen = true;
    noteSection("story");
    trackClick("community");
    pauseCoin();
    setMenu(false);
    storyFocus = document.activeElement;
    storyOverlay.hidden = false;
    page.inert = true;
    document.body.classList.add("story-open");
    storyOverlay.querySelector(".story-scroll").scrollTop = 0;
    storyClose.focus();
  }

  function closeStory() {
    storyOpen = false;
    storyOverlay.hidden = true;
    if (!filmOpen) page.inert = false;
    document.body.classList.remove("story-open");
    if (storyFocus && storyFocus.focus) storyFocus.focus();
    refreshCoin();
  }

  document.querySelectorAll("[data-open-story]").forEach(function (control) {
    control.addEventListener("click", openStory);
  });
  storyClose.addEventListener("click", closeStory);
  storyOverlay.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeStory();
      return;
    }
    if (event.key !== "Tab") return;
    const items = storyFocusables();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  document.addEventListener("focusin", function (event) {
    if (!storyOpen || storyOverlay.contains(event.target)) return;
    storyClose.focus();
  });

  function setMenu(open) {
    nav.classList.toggle("is-open", open);
    navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    navToggle.textContent = open ? "Close" : "Menu";
  }

  navToggle.addEventListener("click", function () {
    setMenu(navToggle.getAttribute("aria-expanded") !== "true");
  });
  nav.addEventListener("click", function (event) {
    if (event.target.closest("a, button")) setMenu(false);
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && nav.classList.contains("is-open")) {
      setMenu(false);
      navToggle.focus();
    }
  });

  function start() {
    const idle = window.requestIdleCallback || function (fn) { setTimeout(fn, 200); };
    idle(armCoin, { timeout: 1200 });
    startPublicAnalytics();
  }

  let latestSection = "hero";
  let pageViewSent = false;

  function trackingRefused() {
    const nav = navigator;
    if (nav.globalPrivacyControl) return true;
    const dnt = nav.doNotTrack;
    return dnt === "1" || dnt === "yes";
  }

  function analyticsUrl(path) {
    return analyticsOrigin + path;
  }

  function postAnalytics(route, body) {
    return fetch(analyticsUrl(route), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      credentials: analyticsOrigin ? "include" : "same-origin",
      cache: "no-store",
      keepalive: true
    }).then(function (response) {
      return response.ok;
    }).catch(function () {
      return false;
    });
  }

  function analyticsPayload(type, eventId, click) {
    const params = new URLSearchParams(window.location.search);
    return {
      type: type,
      eventId: eventId,
      path: window.location.pathname + window.location.search,
      section: latestSection,
      referrer: document.referrer,
      click: click,
      utmSource: params.get("utm_source") || undefined,
      utmMedium: params.get("utm_medium") || undefined,
      utmCampaign: params.get("utm_campaign") || undefined
    };
  }

  function noteSection(section) {
    if (!section || section === latestSection) return;
    latestSection = section;
    if (trackingRefused() || pageViewSent === false) return;
    postAnalytics("/api/analytics/collect", analyticsPayload("section", crypto.randomUUID()));
  }

  function trackClick(click) {
    if (trackingRefused()) return;
    postAnalytics("/api/analytics/collect", analyticsPayload("click", crypto.randomUUID(), click));
  }

  function startPublicAnalytics() {
    if (trackingRefused()) return;
    if (!pageViewSent) {
      pageViewSent = true;
      const pageEventId = crypto.randomUUID();
      postAnalytics("/api/analytics/collect", analyticsPayload("pageview", pageEventId)).then(function (ok) {
        if (!ok) postAnalytics("/api/analytics/collect", analyticsPayload("pageview", pageEventId));
      });
    }

    let heartbeatId = crypto.randomUUID();
    let timer = 0;
    function beat() {
      if (document.visibilityState !== "visible") return;
      const id = heartbeatId;
      postAnalytics("/api/analytics/heartbeat", analyticsPayload("heartbeat", id)).then(function (ok) {
        if (ok) heartbeatId = crypto.randomUUID();
      });
    }
    function arm() {
      window.clearInterval(timer);
      if (document.visibilityState !== "visible") return;
      timer = window.setInterval(beat, 30000);
    }
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") {
        beat();
        arm();
      } else {
        window.clearInterval(timer);
      }
    });
    if (document.visibilityState === "visible") arm();

    if ("IntersectionObserver" in window) {
      const watch = [
        [".hero", "hero"],
        ["#token", "token"],
        ["#film", "film"]
      ];
      const observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting || entry.intersectionRatio < 0.45) return;
          const name = entry.target.getAttribute("data-section");
          noteSection(name);
        });
      }, { threshold: [0.45] });
      watch.forEach(function (pair) {
        const node = document.querySelector(pair[0]);
        if (!node) return;
        node.setAttribute("data-section", pair[1]);
        observer.observe(node);
      });
    }

    document.addEventListener("click", function (event) {
      const social = event.target.closest("[data-social]");
      if (social && (social.dataset.social === "telegram" || social.dataset.social === "x")) {
        trackClick(social.dataset.social);
        return;
      }
      const tracked = event.target.closest("[data-track]");
      if (tracked && tracked.dataset.track) trackClick(tracked.dataset.track);
    });
  }

  fetch("site.config.json", { cache: "no-cache" })
    .then(function (response) {
      if (!response.ok) throw new Error("config");
      return response.json();
    })
    .then(function (json) {
      applyConfig(json);
    })
    .catch(function () {
      config = {
        media: {
          coin: { src: coinVideo.dataset.src, seconds: 18 },
          film: { src: "assets/videos/founding-film.mp4", seconds: 22 }
        }
      };
    })
    .then(function () {
      requestAnimationFrame(function () {
        requestAnimationFrame(start);
      });
    });
})();

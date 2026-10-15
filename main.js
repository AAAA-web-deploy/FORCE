(function () {
  const coinVideo = document.getElementById("coin-video");
  const coinToggle = document.getElementById("coin-toggle");
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
  let filmVideo = null;
  let lastFocus = null;
  let coinVisible = false;
  let coinUserPaused = false;
  let coinArmed = false;
  let filmOpen = false;
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

    const watch = document.querySelector(".watch-label");
    if (watch && film.seconds) watch.textContent = "Watch film · " + clock(film.seconds, false);
    const filmTime = document.querySelector(".film-time");
    if (filmTime && film.seconds) filmTime.textContent = clock(film.seconds, true);
    const coinNote = document.querySelector(".coin-note");
    if (coinNote && coin.seconds) coinNote.textContent = coin.seconds + "s loop · muted";

    if (typeof next.footer === "string" && next.footer.trim()) {
      document.getElementById("footer-note").textContent = next.footer;
    }

    const contract = next.token && next.token.contractAddress;
    const contractNode = document.getElementById("contract-value");
    if (typeof contract === "string" && contract.trim()) {
      renderContract(contractNode, contract.trim());
    } else if (next.token && next.token.pendingContractLabel) {
      contractNode.className = "value";
      contractNode.textContent = next.token.pendingContractLabel;
    }

    const links = next.links || {};
    activateResource("chat", links.chat);
    activateResource("explorer", links.explorer);
  }

  function renderContract(node, address) {
    node.className = "value value-contract";
    node.replaceChildren();
    const text = document.createElement("span");
    text.className = "address";
    text.textContent = address;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy";
    button.setAttribute("aria-label", "Copy contract address");
    button.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.2" y="5.2" width="7.2" height="7.2" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3.6 10.2V3.8h6.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    button.addEventListener("click", function () {
      const done = function (ok) {
        button.classList.toggle("is-copied", ok);
        button.setAttribute("aria-label", ok ? "Contract address copied" : "Copy contract address failed");
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(address).then(function () { done(true); }).catch(function () { done(false); });
      } else {
        done(false);
      }
    });
    node.append(text, button);
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
    pending.replaceWith(link);
  }

  function coinShouldPlay() {
    return coinArmed && coinVisible && !coinUserPaused && !filmOpen && !document.hidden;
  }

  function attachCoin() {
    if (coinVideo.getAttribute("src")) return;
    const src = coinVideo.dataset.src;
    if (!src) return;
    coinVideo.src = src;
  }

  function syncCoinButton() {
    const playing = !coinVideo.paused && !coinVideo.ended;
    coinToggle.setAttribute("aria-pressed", playing ? "true" : "false");
    coinToggle.setAttribute("aria-label", playing ? "Pause founding coin" : "Play founding coin");
    coinToggle.querySelector(".icon-play").hidden = playing;
    coinToggle.querySelector(".icon-pause").hidden = !playing;
  }

  function playCoin() {
    attachCoin();
    const attempt = coinVideo.play();
    if (attempt && attempt.catch) {
      attempt.then(function () {
        coinVideo.classList.add("is-ready");
      }).catch(function () {
        coinVideo.classList.remove("is-ready");
        syncCoinButton();
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
    syncCoinButton();
  });
  coinVideo.addEventListener("pause", syncCoinButton);
  coinToggle.addEventListener("click", function () {
    if (!coinVideo.paused && !coinVideo.ended) {
      coinUserPaused = true;
      pauseCoin();
      return;
    }
    coinUserPaused = false;
    coinArmed = true;
    playCoin();
  });

  document.addEventListener("visibilitychange", refreshCoin);

  function openFilm() {
    filmOpen = true;
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

  function setMenu(open) {
    nav.classList.toggle("is-open", open);
    navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    navToggle.textContent = open ? "Close" : "Menu";
  }

  navToggle.addEventListener("click", function () {
    setMenu(navToggle.getAttribute("aria-expanded") !== "true");
  });
  nav.addEventListener("click", function (event) {
    if (event.target.closest("a")) setMenu(false);
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

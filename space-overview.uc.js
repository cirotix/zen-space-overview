// ==UserScript==
// @name            Zen Space Overview
// @description     Vue d'ensemble de tous les spaces de Zen, façon Mission Control, pilotable au clavier.
// @include         main
// @version         1.1.0
// ==/UserScript==

/* Space Overview for Zen Browser
 *
 * Raccourci (par défaut Ctrl+Alt+W) : affiche tous les spaces dans une grille
 * avec un aperçu de leur dernier onglet. Flèches pour naviguer, Entrée pour
 * ouvrir, 1-9 pour un accès direct, taper du texte pour filtrer (nom du space
 * ou titre d'un onglet), Échap pour fermer. Alt+flèches ou glisser une carte
 * pour réordonner les spaces.
 *
 * Chargé par Sine (ou fx-autoconfig) dans chaque fenêtre du navigateur.
 * Repose sur l'API interne de Zen (gZenWorkspaces), écrit de façon défensive
 * pour survivre aux variations entre versions.
 */

(function zenSpaceOverview() {
  "use strict";

  if (window.location.href !== "chrome://browser/content/browser.xhtml") {
    return;
  }

  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const ID = "zen-space-overview";
  const PREF_BRANCH = "zen.space-overview.";
  const DEFAULTS = {
    shortcut: "Ctrl+Alt+W",
    thumbnails: true,
    animations: true,
  };

  const LAYOUT = {
    gap: 28,
    metaHeight: 58,
    minCardWidth: 190,
    maxCardWidth: 460,
  };

  const STRINGS = (() => {
    let fr = false;
    try {
      fr = Services.locale.appLocaleAsBCP47.toLowerCase().startsWith("fr");
    } catch {}
    return fr
      ? {
          title: "Spaces",
          tabs: n => (n === 0 ? "aucun onglet" : n === 1 ? "1 onglet" : `${n} onglets`),
          current: "actuel",
          filter: "Tape pour filtrer…",
          noResult: "Aucun space ne correspond",
          emptySpace: "Space vide",
          hints: [
            ["← ↑ → ↓", "naviguer"],
            ["Alt + flèches", "déplacer"],
            ["Entrée", "ouvrir"],
            ["1–9", "accès direct"],
            ["abc", "filtrer"],
            ["Échap", "fermer"],
          ],
        }
      : {
          title: "Spaces",
          tabs: n => (n === 0 ? "no tabs" : n === 1 ? "1 tab" : `${n} tabs`),
          current: "current",
          filter: "Type to filter…",
          noResult: "No matching space",
          emptySpace: "Empty space",
          hints: [
            ["← ↑ → ↓", "navigate"],
            ["Alt + arrows", "move"],
            ["Enter", "open"],
            ["1–9", "jump"],
            ["abc", "filter"],
            ["Esc", "close"],
          ],
        };
  })();

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const log = (...args) => console.log("[Space Overview]", ...args);
  const warn = (...args) => console.warn("[Space Overview]", ...args);

  function getPref(name) {
    const full = PREF_BRANCH + name;
    const def = DEFAULTS[name];
    try {
      if (typeof def === "boolean") {
        return Services.prefs.getBoolPref(full, def);
      }
      const value = Services.prefs.getStringPref(full, "");
      return value.trim() || def;
    } catch {
      return def;
    }
  }

  function el(tag, className, text) {
    const node = document.createElementNS(HTML_NS, tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined && text !== null) {
      node.textContent = text;
    }
    return node;
  }

  function normalize(str) {
    return String(str ?? "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase();
  }

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise(resolve => setTimeout(() => resolve(null), ms)),
    ]);
  }

  function idle(fn) {
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(fn, { timeout: 2000 });
    } else {
      setTimeout(fn, 200);
    }
  }

  function prefersReducedMotion() {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  }

  // "Ctrl+Alt+W" -> { ctrl, alt, shift, meta, key | keyName }
  function parseShortcut(str) {
    const parts = String(str ?? "")
      .split("+")
      .map(s => s.trim())
      .filter(Boolean);
    if (!parts.length) {
      return null;
    }
    const keyPart = parts.pop();
    const isMac = navigator.platform.startsWith("Mac");
    const spec = { ctrl: false, alt: false, shift: false, meta: false, key: null, keyName: null };
    for (const part of parts) {
      switch (part.toLowerCase()) {
        case "ctrl":
        case "control":
          spec.ctrl = true;
          break;
        case "alt":
        case "opt":
        case "option":
          spec.alt = true;
          break;
        case "shift":
          spec.shift = true;
          break;
        case "meta":
        case "cmd":
        case "command":
        case "super":
        case "win":
          spec.meta = true;
          break;
        case "accel":
          spec[isMac ? "meta" : "ctrl"] = true;
          break;
        default:
          return null;
      }
    }
    const lower = keyPart.toLowerCase();
    if (lower === "space") {
      spec.keyName = " ";
    } else if (lower === "tab") {
      spec.keyName = "Tab";
    } else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) {
      spec.keyName = lower.toUpperCase();
    } else if ([...keyPart].length === 1) {
      spec.key = keyPart.toUpperCase();
    } else {
      return null;
    }
    if (!spec.ctrl && !spec.alt && !spec.meta && !spec.keyName?.startsWith("F")) {
      // A bare letter would fire while typing in pages: refuse it.
      return null;
    }
    return spec;
  }

  function matchesShortcut(event, spec) {
    if (
      !spec ||
      event.ctrlKey !== spec.ctrl ||
      event.altKey !== spec.alt ||
      event.shiftKey !== spec.shift ||
      event.metaKey !== spec.meta
    ) {
      return false;
    }
    if (spec.keyName) {
      return event.key === spec.keyName;
    }
    if (event.key.length === 1 && event.key.toUpperCase() === spec.key) {
      return true;
    }
    // Shift+digit gives a symbol on most layouts: fall back to the key position.
    return /^[0-9]$/.test(spec.key) && event.code === `Digit${spec.key}`;
  }

  // ---------------------------------------------------------------------------
  // Zen access (defensive against API changes between versions)
  // ---------------------------------------------------------------------------

  const Zen = {
    get spaces() {
      return window.gZenWorkspaces;
    },

    available() {
      const zw = this.spaces;
      if (!zw) {
        return false;
      }
      if (zw.workspaceEnabled === false || zw.privateWindowOrDisabled === true) {
        return false;
      }
      return true;
    },

    async listSpaces() {
      const zw = this.spaces;
      let spaces = zw.getWorkspaces?.();
      if (spaces && typeof spaces.then === "function") {
        spaces = await spaces;
      }
      if (spaces && !Array.isArray(spaces) && Array.isArray(spaces.workspaces)) {
        spaces = spaces.workspaces;
      }
      return Array.isArray(spaces) ? spaces : [];
    },

    activeId() {
      const active = this.spaces?.activeWorkspace;
      if (active && typeof active === "object") {
        return active.uuid;
      }
      return active || this.spaces?.getActiveWorkspaceFromCache?.()?.uuid || null;
    },

    allTabs() {
      let tabs = null;
      try {
        tabs = this.spaces?.allStoredTabs;
      } catch {}
      if (!Array.isArray(tabs) || !tabs.length) {
        tabs = Array.from(gBrowser.tabs);
      }
      return tabs.filter(tab => gBrowser.isTab?.(tab) ?? true);
    },

    tabsOf(uuid, allTabs) {
      return allTabs.filter(
        tab =>
          tab.getAttribute("zen-workspace-id") === uuid &&
          !tab.hasAttribute("zen-essential") &&
          !tab.hasAttribute("zen-empty-tab") &&
          !tab.hasAttribute("glance-id") &&
          !tab.closing
      );
    },

    representativeTab(uuid, tabs, activeId) {
      if (uuid === activeId) {
        return gBrowser.selectedTab;
      }
      const last = this.spaces?.lastSelectedWorkspaceTabs?.[uuid];
      if (last && last.isConnected && !last.closing) {
        return last;
      }
      let best = null;
      for (const tab of tabs) {
        if (!best || (tab.lastAccessed || 0) > (best.lastAccessed || 0)) {
          best = tab;
        }
      }
      return best;
    },

    icon(space) {
      try {
        const icon = this.spaces.getWorkspaceIcon?.(space);
        if (icon) {
          return icon;
        }
      } catch {}
      return space.icon || Array.from(space.name || "?")[0]?.toUpperCase() || "?";
    },

    look(space) {
      const fallbackAccent = "var(--zen-primary-color, #7c9cff)";
      try {
        const data = window.gZenThemePicker?.getGradientForWorkspace?.(space);
        if (data?.toolbarGradient || data?.gradient) {
          return {
            background: data.toolbarGradient || data.gradient,
            accent: data.primaryColor || fallbackAccent,
          };
        }
      } catch {}
      const colors = (space.theme?.gradientColors || []).filter(Boolean);
      const css = colors
        .map(c =>
          c.isCustom ? c.c : Array.isArray(c.c) ? `rgb(${c.c.slice(0, 3).join(", ")})` : null
        )
        .filter(Boolean);
      let background = "linear-gradient(135deg, #3a3d4a, #23252e)";
      if (css.length === 1) {
        background = css[0];
      } else if (css.length > 1) {
        background = `linear-gradient(-30deg, ${css.join(", ")})`;
      }
      return { background, accent: css[0] || fallbackAccent };
    },

    async switchTo(space, tab) {
      const zw = this.spaces;
      if (tab && tab !== gBrowser.selectedTab) {
        if (typeof zw.switchTabIfNeeded === "function") {
          await zw.switchTabIfNeeded(tab);
          return;
        }
        if (zw.lastSelectedWorkspaceTabs) {
          zw.lastSelectedWorkspaceTabs[space.uuid] = tab;
        }
      }
      if (space.uuid !== this.activeId()) {
        await zw.changeWorkspace(space);
      }
      if (tab && tab !== gBrowser.selectedTab) {
        gBrowser.selectedTab = tab;
      }
    },

    canReorder() {
      return typeof this.spaces?.reorderWorkspace === "function";
    },

    // Same call the sidebar uses for its own drag and drop: updates every
    // window and the saved session.
    async reorder(uuid, index) {
      await this.spaces.reorderWorkspace(uuid, index);
    },
  };

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  const CSS = `
#${ID} {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: flex;
  flex-direction: column;
  color: #f4f4f6;
  font: menu;
  font-size: 13px;
  outline: none;
  -moz-window-dragging: no-drag;
  user-select: none;
}
#${ID} [hidden] {
  display: none !important;
}
#${ID} .zso-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(14, 14, 18, 0.62);
  backdrop-filter: blur(24px) saturate(140%);
}
#${ID} .zso-header,
#${ID} .zso-grid,
#${ID} .zso-footer {
  position: relative;
}
#${ID} .zso-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 26px 40px 0;
}
#${ID} .zso-title {
  font-size: 20px;
  font-weight: 650;
  letter-spacing: -0.01em;
}
#${ID} .zso-total {
  opacity: 0.55;
  font-variant-numeric: tabular-nums;
}
#${ID} .zso-filter {
  margin-inline-start: auto;
  min-width: 240px;
  max-width: 420px;
  padding: 7px 14px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.09);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
#${ID} .zso-filter[empty] {
  color: rgba(244, 244, 246, 0.45);
}
#${ID} .zso-filter:not([empty])::after {
  content: "";
  display: inline-block;
  width: 1.5px;
  height: 1.05em;
  margin-inline-start: 2px;
  vertical-align: text-bottom;
  background: currentColor;
  animation: zso-caret 1s steps(1) infinite;
}
@keyframes zso-caret {
  50% { opacity: 0; }
}
#${ID} .zso-grid {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 24px 40px;
  display: grid;
  grid-template-columns: repeat(var(--zso-cols, 3), var(--zso-card-w, 320px));
  justify-content: center;
  align-content: safe center;
  gap: ${LAYOUT.gap}px;
  scrollbar-width: thin;
}
#${ID} .zso-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-width: 0;
  cursor: pointer;
  touch-action: none;
  transition: transform 140ms ease;
}
#${ID} .zso-card[selected] {
  transform: translateY(-3px) scale(1.025);
}
#${ID}[reordering],
#${ID}[reordering] .zso-card {
  cursor: grabbing;
}
#${ID} .zso-card[dragging] {
  z-index: 5;
  transition: none;
}
#${ID} .zso-card[dragging] .zso-thumb {
  box-shadow:
    0 0 0 3px var(--zso-accent),
    0 26px 60px rgba(0, 0, 0, 0.55);
}
#${ID} .zso-thumb {
  position: relative;
  aspect-ratio: var(--zso-aspect, 1.6);
  border-radius: 12px;
  overflow: hidden;
  background: var(--zso-space-bg);
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.10),
    0 12px 32px rgba(0, 0, 0, 0.38);
  transition: box-shadow 140ms ease;
}
#${ID} .zso-card[selected] .zso-thumb {
  box-shadow:
    0 0 0 3px var(--zso-accent),
    0 18px 44px rgba(0, 0, 0, 0.48);
}
#${ID} .zso-thumb canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: top center;
}
#${ID} .zso-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 16px;
  text-align: center;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
}
#${ID} .zso-placeholder img {
  width: 36px;
  height: 36px;
  border-radius: 8px;
}
#${ID} .zso-placeholder .zso-big-icon {
  font-size: 34px;
  line-height: 1;
}
#${ID} .zso-placeholder .zso-ph-title {
  max-width: 100%;
  font-size: 12px;
  opacity: 0.85;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#${ID} .zso-badge,
#${ID} .zso-current {
  position: absolute;
  top: 8px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  background: rgba(10, 10, 14, 0.58);
  backdrop-filter: blur(6px);
  font-size: 11.5px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
#${ID} .zso-badge {
  inset-inline-start: 8px;
  min-width: 22px;
  padding: 0 6px;
}
#${ID} .zso-current {
  inset-inline-end: 8px;
  padding: 0 8px;
  gap: 6px;
  font-weight: 550;
}
#${ID} .zso-current::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--zso-accent);
}
#${ID} .zso-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 2px;
  min-width: 0;
}
#${ID} .zso-icon {
  flex: none;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  line-height: 1;
}
#${ID} .zso-icon img {
  width: 16px;
  height: 16px;
  -moz-context-properties: fill, fill-opacity;
  fill: currentColor;
}
#${ID} .zso-name {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  font-weight: 620;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#${ID} .zso-count {
  flex: none;
  opacity: 0.55;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
#${ID} .zso-favs {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 16px;
  padding: 0 2px;
  overflow: hidden;
}
#${ID} .zso-favs img {
  flex: none;
  width: 16px;
  height: 16px;
  border-radius: 3px;
}
#${ID} .zso-more {
  font-size: 11px;
  opacity: 0.55;
}
#${ID} .zso-match {
  font-size: 12px;
  opacity: 0.85;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#${ID} .zso-match mark {
  background: var(--zso-accent);
  color: inherit;
  border-radius: 3px;
  padding: 0 1px;
}
#${ID} .zso-empty {
  grid-column: 1 / -1;
  justify-self: center;
  opacity: 0.6;
  font-size: 14px;
}
#${ID} .zso-footer {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 8px 22px;
  padding: 0 40px 24px;
  font-size: 12px;
  color: rgba(244, 244, 246, 0.72);
}
#${ID} .zso-footer kbd {
  font: inherit;
  font-weight: 650;
  padding: 2px 6px;
  margin-inline-end: 6px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.12);
  color: #f4f4f6;
}
#${ID} .zso-flyer {
  position: fixed;
  z-index: 10;
  overflow: hidden;
  transform-origin: 0 0;
  pointer-events: none;
  border-radius: 12px;
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.45);
  background: var(--zso-space-bg, #222);
}
#${ID} .zso-flyer canvas {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: top center;
  display: block;
}
`;

  // ---------------------------------------------------------------------------
  // Overview
  // ---------------------------------------------------------------------------

  class SpaceOverview {
    #root = null;
    #grid = null;
    #filterEl = null;
    #totalEl = null;

    #entries = [];
    #visible = [];
    #selected = 0;
    #query = "";
    #cols = 1;
    #aspect = 1.6;

    #opening = false;
    #closing = false;
    #pendingClose = null;
    #switching = false;
    #pointerOrigin = null;
    #pointerArmed = false;

    #drag = null; // pointer drag in progress (reordering)
    #suppressClick = false;
    #reorderChain = Promise.resolve();

    #thumbs = new Map(); // uuid -> { bitmap }
    #currentFull = null; // full-resolution shot of the page shown when opening
    #lastActive = null;

    #styleEl = null;
    #shortcut = null;
    #destroyed = false;

    // --- lifecycle -----------------------------------------------------------

    async init() {
      try {
        await window.gZenWorkspaces?.promiseInitialized;
      } catch {}
      if (this.#destroyed) {
        return;
      }
      this.#installStyles();
      this.#installShortcut();
      Services.prefs.addObserver(PREF_BRANCH, this.#prefObserver);
      this.#lastActive = Zen.activeId();
      window.gZenWorkspaces?.addChangeListeners?.(this.#onSpaceChange);
      log("ready, shortcut:", getPref("shortcut"));
    }

    destroy() {
      this.#destroyed = true;
      this.#teardownOverlay();
      try {
        Services.prefs.removeObserver(PREF_BRANCH, this.#prefObserver);
      } catch {}
      try {
        window.gZenWorkspaces?.removeChangeListeners?.(this.#onSpaceChange);
      } catch {}
      this.#removeShortcut();
      this.#styleEl?.remove();
      this.#styleEl = null;
      for (const entry of this.#thumbs.values()) {
        entry.bitmap?.close?.();
      }
      this.#thumbs.clear();
      if (window.ZenSpaceOverview === this) {
        delete window.ZenSpaceOverview;
      }
    }

    toggle() {
      if (this.#closing) {
        return;
      }
      if (this.#root) {
        this.close();
      } else {
        this.open();
      }
    }

    get isOpen() {
      return !!this.#root;
    }

    // --- setup -----------------------------------------------------------------

    #installStyles() {
      this.#styleEl?.remove();
      const style = el("style");
      style.id = `${ID}-style`;
      style.textContent = CSS;
      (document.head || document.documentElement).appendChild(style);
      this.#styleEl = style;
    }

    // A capturing keydown listener on the chrome window sees the key before
    // web content does (same approach as Firefox's own Ctrl+Tab handling), and
    // stays out of Zen's own shortcut manager, which rebuilds its keysets.
    #installShortcut() {
      this.#shortcut = parseShortcut(getPref("shortcut")) || parseShortcut(DEFAULTS.shortcut);
      window.removeEventListener("keydown", this.#onWindowKeyDown, true);
      window.addEventListener("keydown", this.#onWindowKeyDown, true);
    }

    #removeShortcut() {
      window.removeEventListener("keydown", this.#onWindowKeyDown, true);
      this.#shortcut = null;
    }

    #onWindowKeyDown = event => {
      if (!matchesShortcut(event, this.#shortcut)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) {
        this.toggle();
      }
    };

    #prefObserver = {
      observe: (_subject, _topic, data) => {
        if (data === `${PREF_BRANCH}shortcut`) {
          this.#installShortcut();
        }
      },
      QueryInterface: ChromeUtils.generateQI(["nsIObserver", "nsISupportsWeakReference"]),
    };

    // When leaving a space, keep a snapshot of the tab we were on: unloaded
    // tabs can't be captured later, so this is what the overview will show.
    #onSpaceChange = ({ workspace, onInit } = {}) => {
      try {
        const previous = this.#lastActive;
        this.#lastActive = workspace?.uuid ?? Zen.activeId();
        if (onInit || !previous || previous === this.#lastActive || this.#root) {
          return;
        }
        const tab = window.gZenWorkspaces?.lastSelectedWorkspaceTabs?.[previous];
        if (tab) {
          idle(() => this.#refreshThumb(previous, tab));
        }
      } catch (e) {
        warn("change listener failed", e);
      }
    };

    // --- thumbnails ------------------------------------------------------------

    // Width in device pixels a cached thumbnail needs to look sharp in the
    // largest possible card.
    get #thumbPixelWidth() {
      return Math.round(LAYOUT.maxCardWidth * 1.1 * window.devicePixelRatio);
    }

    #thumbScale() {
      const browserWidth = gBrowser.selectedBrowser?.getBoundingClientRect().width || 1200;
      return Math.min(2, Math.max(0.15, this.#thumbPixelWidth / browserWidth));
    }

    // Stores a snapshot for a space, downsizing it if needed. The cache owns
    // the stored bitmap; returns it.
    async #store(uuid, bitmap) {
      let stored = bitmap;
      const maxWidth = this.#thumbPixelWidth;
      if (bitmap.width > maxWidth * 1.2) {
        const width = maxWidth;
        const height = Math.max(1, Math.round((bitmap.height * maxWidth) / bitmap.width));
        try {
          const canvas = new window.OffscreenCanvas(width, height);
          const ctx = canvas.getContext("2d");
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(bitmap, 0, 0, width, height);
          stored = canvas.transferToImageBitmap();
        } catch {
          try {
            stored = await window.createImageBitmap(bitmap, { resizeWidth: width, resizeHeight: height });
          } catch {
            stored = null;
          }
        }
      }
      if (!stored || this.#destroyed) {
        return null;
      }
      const previous = this.#thumbs.get(uuid)?.bitmap;
      if (previous && previous !== stored && previous !== bitmap) {
        previous.close?.();
      }
      this.#thumbs.set(uuid, { bitmap: stored });
      return stored;
    }

    async #capture(tab, scale) {
      if (!getPref("thumbnails")) {
        return null;
      }
      const browser = tab?.linkedBrowser;
      if (!browser || tab.closing || tab.hasAttribute("pending") || !tab.linkedPanel) {
        return null;
      }
      const wg = browser.browsingContext?.currentWindowGlobal;
      if (!wg || typeof wg.drawSnapshot !== "function") {
        return null;
      }
      try {
        return await withTimeout(wg.drawSnapshot(null, scale, "white"), 1500);
      } catch (e) {
        return null;
      }
    }

    async #refreshThumb(uuid, tab) {
      const bitmap = await this.#capture(tab, this.#thumbScale());
      if (!bitmap) {
        return null;
      }
      const stored = await this.#store(uuid, bitmap);
      if (stored !== bitmap) {
        bitmap.close?.();
      }
      return stored;
    }

    #bitmapCanvas(bitmap) {
      const canvas = el("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      return canvas;
    }

    #paintThumb(entry) {
      const cached = this.#thumbs.get(entry.uuid);
      entry.thumbEl.querySelector("canvas")?.remove();
      if (cached?.bitmap) {
        entry.thumbEl.querySelector(".zso-placeholder")?.setAttribute("hidden", "true");
        entry.thumbEl.prepend(this.#bitmapCanvas(cached.bitmap));
      }
    }

    // --- data --------------------------------------------------------------------

    async #collect() {
      const spaces = await Zen.listSpaces();
      if (!spaces.length) {
        return [];
      }
      const activeId = Zen.activeId();
      const allTabs = Zen.allTabs();
      return spaces.map((space, index) => {
        const tabs = Zen.tabsOf(space.uuid, allTabs);
        return {
          space,
          uuid: space.uuid,
          index,
          name: space.name || `Space ${index + 1}`,
          icon: Zen.icon(space),
          tabs,
          isActive: space.uuid === activeId,
          look: Zen.look(space),
          repTab: Zen.representativeTab(space.uuid, tabs, activeId),
          matchTab: null,
          cardEl: null,
          thumbEl: null,
        };
      });
    }

    // --- open / close -----------------------------------------------------------

    async open() {
      if (this.#root || this.#opening || this.#closing || this.#destroyed) {
        return;
      }
      if (!Zen.available()) {
        return;
      }
      this.#opening = true;
      let fullShot = null;
      try {
        const entries = await this.#collect();
        if (!entries.length) {
          return;
        }
        this.#entries = entries;
        this.#visible = entries.slice();
        this.#query = "";
        const activeIndex = entries.findIndex(e => e.isActive);
        this.#selected = Math.max(0, activeIndex);
        const active = entries[activeIndex] || null;

        const contentRect = gBrowser.selectedBrowser?.getBoundingClientRect();
        if (contentRect?.width && contentRect?.height) {
          this.#aspect = Math.min(2.4, Math.max(1.15, contentRect.width / contentRect.height));
        }

        // Full-resolution snapshot of what is on screen right now: the
        // zoom-out starts from it, so it has to be pixel-identical.
        const shotPromise = active
          ? withTimeout(this.#capture(active.repTab, Math.min(2, window.devicePixelRatio || 1)), 250)
          : Promise.resolve(null);

        this.#build();
        this.#root.style.visibility = "hidden";
        document.documentElement.appendChild(this.#root);
        this.#applyFilter();
        for (const entry of this.#entries) {
          this.#renderFavicons(entry);
        }

        fullShot = await shotPromise;
        if (!this.#root) {
          return;
        }
        if (fullShot && active) {
          await this.#store(active.uuid, fullShot);
        }
        for (const entry of this.#entries) {
          this.#paintThumb(entry);
        }
        this.#root.style.visibility = "";
        this.#root.focus({ preventScroll: true });
        this.#attachRuntimeListeners();

        await this.#animateIn(active, contentRect, fullShot);
      } catch (e) {
        warn("open failed", e);
        this.#teardownOverlay();
      } finally {
        if (fullShot) {
          if (this.#root) {
            // Kept while open: Esc zooms back into a sharp image.
            this.#currentFull = fullShot;
          } else if (!this.#isCached(fullShot)) {
            fullShot.close?.();
          }
        }
        this.#opening = false;
      }

      if (this.#pendingClose) {
        const args = this.#pendingClose;
        this.#pendingClose = null;
        this.close(args);
        return;
      }
      if (this.#root) {
        this.#captureOthers();
      }
    }

    #isCached(bitmap) {
      for (const entry of this.#thumbs.values()) {
        if (entry.bitmap === bitmap) {
          return true;
        }
      }
      return false;
    }

    async close({ target = null, tab = null } = {}) {
      if (!this.#root || this.#closing) {
        return;
      }
      if (this.#opening) {
        // Still zooming out: run the action as soon as the intro is done.
        this.#pendingClose = { target, tab };
        return;
      }
      this.#closing = true;
      try {
        const from = target || this.#entries.find(e => e.isActive) || null;
        const contentRect = gBrowser.selectedBrowser?.getBoundingClientRect();
        const sameView = !tab || tab === gBrowser.selectedTab;
        // Jumping to a specific tab: grab it so the zoom-in shows the right page.
        const tabShot =
          !sameView && this.#animated ? withTimeout(this.#capture(tab, this.#thumbScale()), 150) : null;
        let switchPromise = null;
        if (target && (!target.isActive || !sameView)) {
          this.#switching = true;
          switchPromise = Zen.switchTo(target.space, tab).catch(e => warn("switch failed", e));
        }
        const shot = tabShot ? await tabShot : null;
        try {
          await this.#animateOut(from, contentRect, sameView, shot);
        } finally {
          shot?.close?.();
        }
        if (switchPromise) {
          if (this.#root) {
            this.#root.style.pointerEvents = "none";
          }
          await withTimeout(switchPromise, 1500);
        }
      } catch (e) {
        warn("close failed", e);
      } finally {
        this.#teardownOverlay();
        this.#switching = false;
        this.#closing = false;
        try {
          gBrowser.selectedBrowser?.focus();
        } catch {}
      }
    }

    #teardownOverlay() {
      this.#endDrag({ animate: false });
      this.#detachRuntimeListeners();
      if (this.#currentFull && !this.#isCached(this.#currentFull)) {
        this.#currentFull.close?.();
      }
      this.#currentFull = null;
      this.#pendingClose = null;
      this.#root?.remove();
      this.#root = null;
      this.#grid = null;
      this.#filterEl = null;
      this.#totalEl = null;
      this.#entries = [];
      this.#visible = [];
      this.#pointerOrigin = null;
      this.#pointerArmed = false;
    }

    // Live snapshots of the other spaces, for those whose tab is still loaded.
    async #captureOthers() {
      const entries = this.#entries.slice();
      for (const entry of entries) {
        if (!this.#root || this.#closing || this.#destroyed) {
          return;
        }
        if (entry.isActive || !entry.repTab) {
          continue;
        }
        const bitmap = await this.#refreshThumb(entry.uuid, entry.repTab);
        if (bitmap && this.#root && !this.#closing && entry.thumbEl?.isConnected) {
          this.#paintThumb(entry);
        }
      }
    }

    // --- DOM ----------------------------------------------------------------------

    #build() {
      const root = el("div");
      root.id = ID;
      root.setAttribute("tabindex", "-1");
      root.setAttribute("role", "dialog");
      root.setAttribute("aria-label", STRINGS.title);
      root.style.setProperty("--zso-aspect", String(this.#aspect));

      const backdrop = el("div", "zso-backdrop");
      backdrop.addEventListener("click", () => this.close());
      root.appendChild(backdrop);

      const header = el("div", "zso-header");
      header.appendChild(el("div", "zso-title", STRINGS.title));
      this.#totalEl = el("div", "zso-total");
      header.appendChild(this.#totalEl);
      this.#filterEl = el("div", "zso-filter");
      header.appendChild(this.#filterEl);
      root.appendChild(header);

      const grid = el("div", "zso-grid");
      grid.addEventListener("click", event => {
        if (event.target === grid) {
          this.close();
        }
      });
      root.appendChild(grid);
      this.#grid = grid;

      for (const entry of this.#entries) {
        this.#buildCard(entry);
        grid.appendChild(entry.cardEl);
      }

      const footer = el("div", "zso-footer");
      for (const [keys, label] of STRINGS.hints) {
        const item = el("span");
        item.appendChild(el("kbd", null, keys));
        item.appendChild(document.createTextNode(label));
        footer.appendChild(item);
      }
      root.appendChild(footer);

      root.addEventListener("keydown", this.#onKeyDown);
      root.addEventListener(
        "click",
        event => {
          if (this.#suppressClick) {
            this.#suppressClick = false;
            event.stopPropagation();
            event.preventDefault();
          }
        },
        true
      );
      root.addEventListener("mousemove", this.#onMouseMove);
      this.#root = root;
    }

    #buildCard(entry) {
      const card = el("div", "zso-card");
      card.dataset.uuid = entry.uuid;
      card.style.setProperty("--zso-space-bg", entry.look.background);
      card.style.setProperty("--zso-accent", entry.look.accent);

      const thumb = el("div", "zso-thumb");
      const placeholder = el("div", "zso-placeholder");
      if (entry.repTab) {
        const icon = entry.repTab.getAttribute("image");
        if (icon) {
          const img = el("img");
          img.src = icon;
          placeholder.appendChild(img);
        } else {
          placeholder.appendChild(this.#iconNode(entry.icon, "zso-big-icon"));
        }
        placeholder.appendChild(el("div", "zso-ph-title", entry.repTab.label || ""));
      } else {
        placeholder.appendChild(this.#iconNode(entry.icon, "zso-big-icon"));
        placeholder.appendChild(el("div", "zso-ph-title", STRINGS.emptySpace));
      }
      thumb.appendChild(placeholder);

      const badge = el("div", "zso-badge");
      thumb.appendChild(badge);
      if (entry.isActive) {
        thumb.appendChild(el("div", "zso-current", STRINGS.current));
      }
      card.appendChild(thumb);

      const meta = el("div", "zso-meta");
      meta.appendChild(this.#iconNode(entry.icon, "zso-icon"));
      meta.appendChild(el("div", "zso-name", entry.name));
      meta.appendChild(el("div", "zso-count", STRINGS.tabs(entry.tabs.length)));
      card.appendChild(meta);

      const favs = el("div", "zso-favs");
      card.appendChild(favs);
      const match = el("div", "zso-match");
      match.hidden = true;
      card.appendChild(match);

      card.addEventListener("click", event => {
        event.stopPropagation();
        this.close({ target: entry, tab: entry.matchTab });
      });
      card.addEventListener("pointerdown", event => this.#onCardPointerDown(event, entry));
      // Native image dragging would hijack the pointer.
      card.addEventListener("dragstart", event => event.preventDefault());

      entry.cardEl = card;
      entry.thumbEl = thumb;
      entry.badgeEl = badge;
      entry.favsEl = favs;
      entry.matchEl = match;
      this.#renderFavicons(entry);
    }

    #iconNode(icon, className) {
      const node = el("div", className);
      if (typeof icon === "string" && /\.(svg|png)$|^(chrome|moz-extension|data):/.test(icon)) {
        const img = el("img");
        img.src = icon;
        node.appendChild(img);
      } else {
        node.textContent = icon || "";
      }
      return node;
    }

    #renderFavicons(entry) {
      const favs = entry.favsEl;
      favs.textContent = "";
      const max = Math.max(3, Math.floor((parseFloat(this.#root?.style.getPropertyValue("--zso-card-w")) || 320) / 23) - 1);
      const tabs = entry.tabs.slice(0, max);
      for (const tab of tabs) {
        const img = el("img");
        img.src = tab.getAttribute("image") || "chrome://global/skin/icons/defaultFavicon.svg";
        img.title = tab.label || "";
        favs.appendChild(img);
      }
      if (entry.tabs.length > tabs.length) {
        favs.appendChild(el("span", "zso-more", `+${entry.tabs.length - tabs.length}`));
      }
    }

    // --- filtering & layout ----------------------------------------------------

    #applyFilter() {
      const q = normalize(this.#query);
      const previous = this.#visible[this.#selected];
      this.#visible = [];

      for (const entry of this.#entries) {
        entry.matchTab = null;
        let visible = true;
        if (q) {
          const nameMatch = normalize(entry.name).includes(q);
          if (!nameMatch) {
            entry.matchTab =
              entry.tabs.find(tab => normalize(tab.label).includes(q)) ||
              entry.tabs.find(tab => {
                try {
                  return normalize(tab.linkedBrowser?.currentURI?.spec).includes(q);
                } catch {
                  return false;
                }
              }) ||
              null;
            visible = !!entry.matchTab;
          }
        }
        entry.cardEl.hidden = !visible;
        if (visible) {
          this.#visible.push(entry);
        }
        this.#renderMatch(entry, q);
      }

      this.#grid.querySelector(".zso-empty")?.remove();
      if (!this.#visible.length) {
        this.#grid.appendChild(el("div", "zso-empty", STRINGS.noResult));
      }

      this.#renumber();

      const keep = previous ? this.#visible.indexOf(previous) : -1;
      this.#selected = keep >= 0 ? keep : 0;

      this.#filterEl.textContent = this.#query || STRINGS.filter;
      this.#filterEl.toggleAttribute("empty", !this.#query);
      this.#totalEl.textContent = q
        ? `${this.#visible.length} / ${this.#entries.length}`
        : String(this.#entries.length);

      this.#layout();
      this.#updateSelection();
    }

    // Numbers follow what is visible, so 1–9 always match what you see.
    #renumber() {
      this.#visible.forEach((entry, i) => {
        entry.badgeEl.textContent = i < 9 ? String(i + 1) : i === 9 ? "0" : "";
        entry.badgeEl.hidden = i > 9;
      });
    }

    #renderMatch(entry, q) {
      const match = entry.matchEl;
      match.textContent = "";
      if (!entry.matchTab || !q) {
        match.hidden = true;
        entry.favsEl.hidden = false;
        return;
      }
      const label = entry.matchTab.label || "";
      const norm = normalize(label);
      const at = norm.indexOf(q);
      match.appendChild(document.createTextNode("↳ "));
      if (at >= 0 && norm.length === label.length) {
        match.appendChild(document.createTextNode(label.slice(0, at)));
        match.appendChild(el("mark", null, label.slice(at, at + q.length)));
        match.appendChild(document.createTextNode(label.slice(at + q.length)));
      } else {
        match.appendChild(document.createTextNode(label));
      }
      match.hidden = false;
      entry.favsEl.hidden = true;
    }

    #layout() {
      if (!this.#root || !this.#grid) {
        return;
      }
      const n = Math.max(1, this.#visible.length);
      const style = window.getComputedStyle(this.#grid);
      const W =
        this.#grid.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const H =
        this.#grid.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      const { gap, metaHeight, minCardWidth, maxCardWidth } = LAYOUT;

      let best = null;
      for (let cols = 1; cols <= n; cols++) {
        const rows = Math.ceil(n / cols);
        const byWidth = (W - gap * (cols - 1)) / cols;
        const byHeight = ((H - gap * (rows - 1)) / rows - metaHeight) * this.#aspect;
        const cardW = Math.min(maxCardWidth, byWidth, byHeight);
        if (cardW > 0 && (!best || cardW > best.cardW + 0.5)) {
          best = { cols, cardW };
        }
      }
      if (!best || best.cardW < minCardWidth) {
        // Too many spaces to fit: fixed minimum size and the grid scrolls.
        const cols = Math.max(1, Math.floor((W + gap) / (minCardWidth + gap)));
        best = { cols, cardW: Math.min(maxCardWidth, (W - gap * (cols - 1)) / cols) };
      }
      this.#cols = best.cols;
      this.#root.style.setProperty("--zso-cols", String(best.cols));
      this.#root.style.setProperty("--zso-card-w", `${Math.floor(best.cardW)}px`);
      this.#root.style.setProperty("--zso-aspect", String(this.#aspect));
    }

    #updateSelection({ scroll = true } = {}) {
      this.#visible.forEach((entry, i) => {
        entry.cardEl.toggleAttribute("selected", i === this.#selected);
      });
      if (scroll) {
        const current = this.#visible[this.#selected];
        current?.cardEl.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    }

    #move(delta) {
      const n = this.#visible.length;
      if (!n) {
        return;
      }
      this.#selected = (this.#selected + delta + n) % n;
      this.#updateSelection();
    }

    #moveVertical(direction) {
      const n = this.#visible.length;
      if (!n) {
        return;
      }
      const next = this.#selected + direction * this.#cols;
      if (next >= 0 && next < n) {
        this.#selected = next;
      } else if (direction > 0) {
        // Last row may be incomplete: go to the last card.
        const lastRowStart = Math.floor((n - 1) / this.#cols) * this.#cols;
        if (this.#selected < lastRowStart) {
          this.#selected = n - 1;
        }
      }
      this.#updateSelection();
    }

    #activate(index = this.#selected) {
      const entry = this.#visible[index];
      if (!entry) {
        return;
      }
      this.#selected = index;
      this.#updateSelection();
      this.close({ target: entry, tab: entry.matchTab });
    }

    // --- reordering -------------------------------------------------------------
    // Only without a filter: positions in a filtered grid don't map to Zen's order.

    get #canReorder() {
      return !this.#query && !this.#opening && !this.#closing && Zen.canReorder();
    }

    // Moves a card in the grid (model + DOM), animating the cards that shift.
    // Zen itself is updated separately by #commitOrder.
    #moveEntry(from, to, exclude = null) {
      const n = this.#entries.length;
      if (from === to || from < 0 || to < 0 || from >= n || to >= n) {
        return false;
      }
      const cards = this.#entries.map(e => e.cardEl).filter(card => card !== exclude);
      const before = new Map(cards.map(card => [card, card.getBoundingClientRect()]));

      const [entry] = this.#entries.splice(from, 1);
      this.#entries.splice(to, 0, entry);
      this.#grid.insertBefore(entry.cardEl, this.#entries[to + 1]?.cardEl ?? null);
      this.#visible = this.#entries.slice();
      this.#renumber();

      if (this.#animated) {
        for (const card of cards) {
          const a = before.get(card);
          const b = card.getBoundingClientRect();
          const dx = a.left - b.left;
          const dy = a.top - b.top;
          if (dx || dy) {
            card.animate(
              [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0px, 0px)" }],
              { duration: 200, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", composite: "add" }
            );
          }
        }
      }
      return true;
    }

    // Zen's reorderWorkspace reads its current order, so calls are chained.
    #commitOrder(entry) {
      const index = this.#entries.indexOf(entry);
      const uuid = entry.uuid;
      this.#reorderChain = this.#reorderChain
        .then(() => Zen.reorder(uuid, index))
        .catch(e => warn("reorder failed", e));
    }

    #moveSelectedBy(key) {
      if (!this.#canReorder) {
        return;
      }
      const from = this.#selected;
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -this.#cols, ArrowDown: this.#cols }[key] ?? 0;
      const to = Math.min(this.#entries.length - 1, Math.max(0, from + step));
      const entry = this.#entries[from];
      if (entry && this.#moveEntry(from, to)) {
        this.#selected = to;
        this.#updateSelection();
        this.#commitOrder(entry);
      }
    }

    // Layout box of a card, ignoring transforms (drag offset, FLIP, selection).
    #slotRect(card) {
      const grid = this.#grid.getBoundingClientRect();
      return {
        left: grid.left + this.#grid.clientLeft + card.offsetLeft - this.#grid.scrollLeft,
        top: grid.top + this.#grid.clientTop + card.offsetTop - this.#grid.scrollTop,
        width: card.offsetWidth,
        height: card.offsetHeight,
      };
    }

    #onCardPointerDown(event, entry) {
      if (event.button !== 0 || this.#drag || !this.#canReorder) {
        return;
      }
      const slot = this.#slotRect(entry.cardEl);
      this.#drag = {
        entry,
        pointerId: event.pointerId,
        x0: event.clientX,
        y0: event.clientY,
        grabX: event.clientX - slot.left,
        grabY: event.clientY - slot.top,
        fromIndex: this.#entries.indexOf(entry),
        started: false,
      };
      window.addEventListener("pointermove", this.#onDragMove, true);
      window.addEventListener("pointerup", this.#onDragUp, true);
      window.addEventListener("pointercancel", this.#onDragUp, true);
    }

    #onDragMove = event => {
      const drag = this.#drag;
      if (!drag || event.pointerId !== drag.pointerId || !this.#root) {
        return;
      }
      if (!drag.started) {
        const dx = event.clientX - drag.x0;
        const dy = event.clientY - drag.y0;
        if (dx * dx + dy * dy < 49) {
          return; // still a click
        }
        drag.started = true;
        this.#root.setAttribute("reordering", "true");
        drag.entry.cardEl.setAttribute("dragging", "true");
        try {
          drag.entry.cardEl.setPointerCapture(drag.pointerId);
        } catch {}
      }
      event.preventDefault();

      for (const other of this.#entries) {
        if (other === drag.entry) {
          continue;
        }
        const r = this.#slotRect(other.cardEl);
        const inside =
          event.clientX >= r.left &&
          event.clientX <= r.left + r.width &&
          event.clientY >= r.top &&
          event.clientY <= r.top + r.height;
        if (inside) {
          const from = this.#entries.indexOf(drag.entry);
          const to = this.#entries.indexOf(other);
          if (this.#moveEntry(from, to, drag.entry.cardEl)) {
            this.#selected = to;
            // No auto-scroll: the dragged card's offset would drag the grid along.
            this.#updateSelection({ scroll: false });
          }
          break;
        }
      }

      const slot = this.#slotRect(drag.entry.cardEl);
      const x = event.clientX - drag.grabX - slot.left;
      const y = event.clientY - drag.grabY - slot.top;
      drag.entry.cardEl.style.transform = `translate(${x}px, ${y}px) scale(1.04)`;
    };

    #onDragUp = event => {
      const drag = this.#drag;
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }
      if (drag.started) {
        // The click that follows the drop must not open the space.
        this.#suppressClick = true;
        setTimeout(() => (this.#suppressClick = false), 0);
      }
      this.#endDrag();
    };

    #endDrag({ animate = true } = {}) {
      const drag = this.#drag;
      if (!drag) {
        return;
      }
      this.#drag = null;
      window.removeEventListener("pointermove", this.#onDragMove, true);
      window.removeEventListener("pointerup", this.#onDragUp, true);
      window.removeEventListener("pointercancel", this.#onDragUp, true);
      if (!drag.started) {
        return;
      }
      const card = drag.entry.cardEl;
      try {
        card.releasePointerCapture(drag.pointerId);
      } catch {}
      this.#root?.removeAttribute("reordering");
      const dropped = card.style.transform;
      card.removeAttribute("dragging");
      card.style.transform = "";
      if (this.#root) {
        this.#updateSelection();
      }
      if (animate && this.#animated && dropped && card.isConnected) {
        // Single keyframe: glides from where it was dropped to its slot.
        card.animate([{ transform: dropped, offset: 0 }], {
          duration: 180,
          easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
        });
      }
      if (this.#entries.indexOf(drag.entry) !== drag.fromIndex) {
        this.#commitOrder(drag.entry);
      }
    }

    // --- events -----------------------------------------------------------------

    #onKeyDown = event => {
      if (this.#closing) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (this.#drag?.started) {
        // Esc drops the card where it is; other keys wait for the drop.
        if (event.key === "Escape") {
          this.#endDrag();
        }
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const isArrow = event.key.startsWith("Arrow");
      if (isArrow && (event.altKey || event.shiftKey) && !event.ctrlKey && !event.metaKey) {
        this.#moveSelectedBy(event.key);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const plain = !event.ctrlKey && !event.altKey && !event.metaKey;
      let handled = true;

      switch (event.key) {
        case "Escape":
          if (this.#query) {
            this.#query = "";
            this.#applyFilter();
          } else {
            this.close();
          }
          break;
        case "Enter":
          this.#activate();
          break;
        case "ArrowRight":
          this.#move(1);
          break;
        case "ArrowLeft":
          this.#move(-1);
          break;
        case "ArrowDown":
          this.#moveVertical(1);
          break;
        case "ArrowUp":
          this.#moveVertical(-1);
          break;
        case "Tab":
          this.#move(event.shiftKey ? -1 : 1);
          break;
        case "Home":
          this.#selected = 0;
          this.#updateSelection();
          break;
        case "End":
          this.#selected = Math.max(0, this.#visible.length - 1);
          this.#updateSelection();
          break;
        case "Backspace":
          if (this.#query) {
            this.#query = event.ctrlKey ? "" : [...this.#query].slice(0, -1).join("");
            this.#applyFilter();
          }
          break;
        default:
          handled = false;
      }

      if (!handled && plain && /^[0-9]$/.test(event.key)) {
        const index = event.key === "0" ? 9 : Number(event.key) - 1;
        if (index < this.#visible.length) {
          this.#activate(index);
        }
        handled = true;
      } else if (!handled && plain && event.key.length === 1 && !event.isComposing) {
        if (event.key !== " " || this.#query) {
          this.#query += event.key;
          this.#applyFilter();
        } else {
          this.#activate();
        }
        handled = true;
      }

      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    #onMouseMove = event => {
      if (this.#drag?.started) {
        return;
      }
      // Ignore the synthetic mousemove fired when the overlay appears under
      // a still pointer: only react once the mouse has really moved.
      if (!this.#pointerArmed) {
        if (!this.#pointerOrigin) {
          this.#pointerOrigin = { x: event.screenX, y: event.screenY };
          return;
        }
        const dx = event.screenX - this.#pointerOrigin.x;
        const dy = event.screenY - this.#pointerOrigin.y;
        if (dx * dx + dy * dy < 25) {
          return;
        }
        this.#pointerArmed = true;
      }
      const card = event.target.closest?.(".zso-card");
      if (!card) {
        return;
      }
      const index = this.#visible.findIndex(e => e.cardEl === card);
      if (index >= 0 && index !== this.#selected) {
        this.#selected = index;
        this.#updateSelection();
      }
    };

    #onResize = () => {
      this.#layout();
      for (const entry of this.#visible) {
        this.#renderFavicons(entry);
      }
    };

    #onTabSelect = () => {
      // Something else changed the tab under us (shortcut, click…): get out of the way.
      if (!this.#switching && !this.#closing && !this.#opening) {
        this.#teardownOverlay();
      }
    };

    #attachRuntimeListeners() {
      window.addEventListener("resize", this.#onResize);
      gBrowser.tabContainer.addEventListener("TabSelect", this.#onTabSelect);
    }

    #detachRuntimeListeners() {
      window.removeEventListener("resize", this.#onResize);
      gBrowser.tabContainer?.removeEventListener("TabSelect", this.#onTabSelect);
    }

    // --- animations -------------------------------------------------------------

    get #animated() {
      return getPref("animations") && !prefersReducedMotion();
    }

    async #animateIn(active, contentRect, fullShot) {
      if (!this.#root) {
        return;
      }
      const backdrop = this.#root.querySelector(".zso-backdrop");
      const chrome = [...this.#root.querySelectorAll(".zso-header, .zso-footer")];
      if (!this.#animated) {
        return;
      }
      const duration = 260;
      const easing = "cubic-bezier(0.2, 0.8, 0.2, 1)";
      const animations = [];

      animations.push(backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing }));
      for (const node of chrome) {
        animations.push(
          node.animate([{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 1, transform: "none" }], {
            duration,
            easing,
          })
        );
      }

      const bitmap = fullShot || (active ? this.#thumbs.get(active.uuid)?.bitmap : null);
      const flyer = bitmap && contentRect ? this.#makeFlyer(active, bitmap) : null;

      this.#visible.forEach((entry, i) => {
        if (flyer && entry === active) {
          entry.thumbEl.style.visibility = "hidden";
          animations.push(
            entry.cardEl.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing })
          );
          return;
        }
        animations.push(
          entry.cardEl.animate(
            [
              { opacity: 0, transform: "scale(0.92)" },
              { opacity: 1, transform: "none" },
            ],
            { duration: duration + 40, delay: Math.min(i, 8) * 14, easing, fill: "backwards" }
          )
        );
      });

      if (flyer) {
        const to = active.thumbEl.getBoundingClientRect();
        flyer.style.left = `${to.left}px`;
        flyer.style.top = `${to.top}px`;
        flyer.style.width = `${to.width}px`;
        flyer.style.height = `${to.height}px`;
        const from = contentRect;
        animations.push(
          flyer.animate(
            [
              {
                transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`,
                borderRadius: "8px",
                boxShadow: "0 0 0 rgba(0,0,0,0)",
              },
              { transform: "none", borderRadius: "12px" },
            ],
            { duration: duration + 40, easing }
          )
        );
      }

      await Promise.allSettled(animations.map(a => a.finished));
      if (flyer) {
        flyer.remove();
        if (active?.thumbEl) {
          active.thumbEl.style.visibility = "";
        }
      }
    }

    async #animateOut(from, contentRect, sameView = true, tabShot = null) {
      if (!this.#root || !this.#animated) {
        return;
      }
      const duration = 230;
      const easing = "cubic-bezier(0.3, 0, 0.2, 1)";
      const animations = [];
      const backdrop = this.#root.querySelector(".zso-backdrop");
      const chrome = [...this.#root.querySelectorAll(".zso-header, .zso-footer")];

      animations.push(
        backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration, easing, fill: "forwards" })
      );
      for (const node of chrome) {
        animations.push(
          node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: duration * 0.6, easing, fill: "forwards" })
        );
      }
      for (const entry of this.#visible) {
        if (entry === from) {
          continue;
        }
        animations.push(
          entry.cardEl.animate([{ opacity: 1 }, { opacity: 0, transform: "scale(0.94)" }], {
            duration: duration * 0.7,
            easing,
            fill: "forwards",
          })
        );
      }

      // When jumping to a specific tab, the space snapshot would show the
      // wrong page: only that tab's own shot is used.
      let bitmap = tabShot;
      if (!bitmap && from && sameView) {
        bitmap = (from.isActive && this.#currentFull) || this.#thumbs.get(from.uuid)?.bitmap || null;
      }
      const visibleCard = from && !from.cardEl.hidden;
      if (from && visibleCard && !bitmap) {
        // Nothing to zoom into (unloaded tab): the card just swells and fades.
        animations.push(
          from.cardEl.animate([{ opacity: 1 }, { opacity: 0, transform: "scale(1.08)" }], {
            duration,
            easing,
            fill: "forwards",
          })
        );
      } else if (from && visibleCard && contentRect) {
        const start = from.thumbEl.getBoundingClientRect();
        const flyer = this.#makeFlyer(from, bitmap);
        flyer.style.left = `${start.left}px`;
        flyer.style.top = `${start.top}px`;
        flyer.style.width = `${start.width}px`;
        flyer.style.height = `${start.height}px`;
        from.cardEl.style.visibility = "hidden";
        const to = contentRect;
        const grow = flyer.animate(
          [
            { transform: "none", borderRadius: "12px" },
            {
              transform: `translate(${to.left - start.left}px, ${to.top - start.top}px) scale(${to.width / start.width}, ${to.height / start.height})`,
              borderRadius: "8px",
              boxShadow: "0 0 0 rgba(0,0,0,0)",
            },
          ],
          { duration: duration + 30, easing, fill: "forwards" }
        );
        animations.push(grow);
        await grow.finished.catch(() => {});
        // Reveal the real page underneath.
        await flyer
          .animate([{ opacity: 1 }, { opacity: 0 }], { duration: 110, fill: "forwards" })
          .finished.catch(() => {});
      }
      await Promise.allSettled(animations.map(a => a.finished));
    }

    #makeFlyer(entry, bitmap) {
      const flyer = el("div", "zso-flyer");
      flyer.style.setProperty("--zso-space-bg", entry.look.background);
      if (bitmap) {
        flyer.appendChild(this.#bitmapCanvas(bitmap));
      }
      this.#root.appendChild(flyer);
      return flyer;
    }
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  try {
    window.ZenSpaceOverview?.destroy?.();
  } catch {}

  const overview = new SpaceOverview();
  window.ZenSpaceOverview = overview;

  // Sine: lets the mod be disabled without restarting the browser.
  if (typeof window.addUnloadListener === "function") {
    try {
      window.addUnloadListener(() => overview.destroy());
    } catch {}
  }
  window.addEventListener("unload", () => overview.destroy(), { once: true });

  const ready =
    window.gBrowserInit?.delayedStartupFinished || !window.delayedStartupPromise
      ? Promise.resolve()
      : window.delayedStartupPromise;
  ready.then(() => overview.init()).catch(e => warn("init failed", e));
})();

(() => {
  "use strict";
  const $ = (selector, root = document) => root.querySelector(selector);
  const panel = $("#game-panel");
  const modal = $("#modal");
  const dialPalette = $("#dial-palette");
  const dialColors = { blue: "蓝色", yellow: "黄色" };
  const maxGuesses = 16;
  const reconnectMessage = "联机连接暂时断开，正在重连";
  const invite = new URLSearchParams(location.search).get("room");
  const storage = {
    get(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* Storage is optional. */
      }
    },
  };
  const empty = (key) => Array(key === "roomCode" ? 6 : 4).fill("");
  const ui = {
    mode: invite || storage.get("guessnum_mode") === "duel" ? "duel" : "solo",
    loading: true,
    error: false,
    busy: false,
    connected: false,
    reveal: false,
    history: "you",
    dialog: null,
    drafts: {
      soloGuess: empty("soloGuess"),
      roomGuess: empty("roomGuess"),
      secret: empty("secret"),
      roomCode: /^[0-9]{6}$/.test(invite || "")
        ? [...invite]
        : empty("roomCode"),
    },
    selected: { soloGuess: 0, roomGuess: 0, secret: 0, roomCode: 0 },
    pinned: {
      soloGuess: Array(4).fill(false),
      roomGuess: Array(4).fill(false),
    },
    excluded: { solo: new Set(), duel: new Set() },
    checked: { solo: new Set(), duel: new Set() },
    colors: { solo: {}, duel: {} },
    dialMenu: null,
  };
  let state = { version: 0, solo: null, room: null };
  let socket, reconnectTimer, connectionWarningTimer, toastTimer, confirmAction;
  let connectionWarningShown = false;
  let reconnectDelay = 1000;
  let longPress;
  let lastLongPress;
  let lastDialTap;
  let suppressedDialClick;
  const touchInput = navigator.maxTouchPoints > 0;
  const mobileDevice =
    Boolean(navigator.userAgentData?.mobile) ||
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
    (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  document.documentElement.dataset.device = mobileDevice ? "mobile" : "desktop";
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char],
    );
  const icon = (name) =>
    `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const disable = (condition) => (condition ? " disabled" : "");
  const normalize = (value) =>
    value
      .replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 0xff10))
      .replace(/[^0-9]/g, "");
  const draftValue = (key) => ui.drafts[key].join("");
  const resetDraft = (key, preservePinned = false) => {
    ui.drafts[key] = empty(key).map((_, i) =>
      preservePinned && ui.pinned[key]?.[i] ? ui.drafts[key][i] : "",
    );
    if (ui.pinned[key] && !preservePinned) ui.pinned[key].fill(false);
    const selected = ui.drafts[key].findIndex(
      (digit, i) => !digit && !ui.pinned[key]?.[i],
    );
    ui.selected[key] = selected === -1 ? 0 : selected;
  };

  function gameId(mode, data = state) {
    return mode === "solo"
      ? data.solo?.startedAt
      : data.room
        ? `${data.room.code}:${data.room.match}`
        : null;
  }
  function saveNotes(mode) {
    const key = mode === "solo" ? "soloGuess" : "roomGuess";
    storage.set(
      `guessnum_notes_${mode}`,
      JSON.stringify({
        game: gameId(mode),
        excluded: [...ui.excluded[mode]],
        checked: [...ui.checked[mode]],
        colors: ui.colors[mode],
        pinned: ui.pinned[key],
        digits: ui.drafts[key].map((digit, i) =>
          ui.pinned[key][i] ? digit : "",
        ),
      }),
    );
  }
  function restoreNotes(mode) {
    const key = mode === "solo" ? "soloGuess" : "roomGuess";
    resetDraft(key);
    ui.excluded[mode].clear();
    ui.checked[mode].clear();
    ui.colors[mode] = {};
    lastDialTap = null;
    if (ui.dialMenu?.mode === mode) closeDialPalette();
    try {
      const notes = JSON.parse(storage.get(`guessnum_notes_${mode}`));
      if (!notes || notes.game !== gameId(mode)) return;
      ui.excluded[mode] = new Set(
        (notes.excluded || []).filter((n) => /^[0-9]$/.test(n)),
      );
      ui.checked[mode] = new Set(
        (notes.checked || []).filter(
          (n) => /^[0-9]$/.test(n) && !ui.excluded[mode].has(n),
        ),
      );
      const savedColors = Object.entries(notes.colors || {});
      ui.colors[mode] = Object.fromEntries(
        savedColors.filter(
          ([digit, color]) =>
            /^[0-9]$/.test(digit) && Object.hasOwn(dialColors, color),
        ),
      );
      for (let i = 0; i < 4; i++) {
        if (notes.pinned?.[i] === true && /^[0-9]$/.test(notes.digits?.[i])) {
          ui.pinned[key][i] = true;
          ui.drafts[key][i] = notes.digits[i];
        }
      }
      ui.selected[key] = Math.max(
        0,
        ui.pinned[key].findIndex((value) => !value),
      );
      if (savedColors.length !== Object.keys(ui.colors[mode]).length)
        saveNotes(mode);
    } catch {
      /* Older or unavailable local notes can be discarded. */
    }
  }

  function toast(message) {
    const settingsError = $("#settings-error");
    if (modal.open && settingsError) {
      settingsError.textContent = message;
      settingsError.hidden = false;
      return;
    }
    clearTimeout(toastTimer);
    $("#toast").textContent = message;
    $("#toast").hidden = false;
    toastTimer = setTimeout(() => {
      $("#toast").hidden = true;
    }, 3500);
  }
  function announce(message) {
    $("#announcer").textContent = "";
    setTimeout(() => {
      $("#announcer").textContent = message;
    }, 20);
  }
  function updateConnection() {
    document.documentElement.dataset.connection = ui.connected
      ? "online"
      : needsRealtime()
        ? "offline"
        : "idle";
  }

  function numberForm(key, type, label, submit, disabled = false) {
    const values = ui.drafts[key];
    return `<form class="number-form" data-form="${type}" data-key="${key}">
      <div class="digit-entry" role="group" aria-label="${label}" data-length="${values.length}">
        ${values.map((digit, i) => `<span class="digit-cell${ui.pinned[key]?.[i] ? " pinned" : ""}"><input id="${key}-${i}" class="digit-box${ui.selected[key] === i ? " selected" : ""}" type="text" inputmode="none" maxlength="1" pattern="[0-9]" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="−" aria-label="第${i + 1}位"${ui.pinned[key] ? ` title="${ui.pinned[key][i] ? "已固定，长按或右键取消" : "长按或右键固定"}" data-lockable="true" data-pinned="${ui.pinned[key][i]}"` : ""} data-draft="${key}" data-slot="${i}" value="${digit}"${touchInput || ui.pinned[key]?.[i] ? " readonly" : ""}${disable(disabled || ui.busy)} required>${ui.pinned[key]?.[i] ? `<span class="pin-mark" aria-label="已固定">${icon("lock")}</span>` : ""}</span>`).join("")}
      </div>
      <div class="keypad" aria-label="数字键盘">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button class="number-key" type="button" data-action="digit" data-digit="${n}"${disable(disabled || ui.busy)}>${n}</button>`).join("")}
        <button class="number-key delete-key" type="button" data-action="delete-digit" aria-label="删除选中位"${disable(disabled || ui.busy)}>删除</button>
        <button class="number-key" type="button" data-action="digit" data-digit="0"${disable(disabled || ui.busy)}>0</button>
        <button class="number-key submit-key" type="submit"${disable(disabled || ui.busy || values.some((v) => !v))}>${ui.busy ? "…" : submit}</button>
      </div>
    </form>`;
  }

  function historyPanel(guesses, duel = false) {
    const records = guesses.slice(0, maxGuesses);
    const sheets = [0, 8]
      .map((start) => {
        const entries = records.slice(start, start + 8);
        const blanks = Array.from(
          { length: 8 - entries.length },
          () =>
            '<tr class="empty-row" aria-hidden="true"><td></td><td></td><td></td></tr>',
        ).join("");
        const rows = entries
          .map(
            (g, i) =>
              `<tr data-guess="${start + i + 1}" class="${start + i === records.length - 1 ? "newest " : ""}${g.positions === 4 ? "won-row" : ""}"><td class="guess-number">${esc(g.guess)}</td><td>${g.digits}</td><td>${g.positions}</td></tr>`,
          )
          .join("");
        return `<div class="record-sheet"><div class="sheet-range" aria-hidden="true">${String(start + 1).padStart(2, "0")} — ${start + 8}</div><table class="history-table" aria-label="第 ${start + 1} 至 ${start + 8} 次猜测"><thead><tr><th scope="col">猜测</th><th scope="col">数字对</th><th scope="col">位置对</th></tr></thead><tbody>${blanks}${rows}</tbody></table></div>`;
      })
      .join("");
    return `<section class="history-panel" aria-label="猜测记录">
      <div class="history-toolbar">${duel ? `<div class="history-tabs" role="tablist" aria-label="查看猜测记录"><button id="history-you" role="tab" aria-selected="${ui.history === "you"}" aria-controls="history-tables" data-action="history-you">我的猜测</button><button id="history-opponent" role="tab" aria-selected="${ui.history === "opponent"}" aria-controls="history-tables" data-action="history-opponent">对手的猜测</button></div>` : '<span class="history-label">猜测记录</span>'}</div>
      <div id="history-tables" class="record-sheets">${sheets}</div>
      ${mobileDevice ? "" : numberDial()}
    </section>${mobileDevice ? numberDial() : ""}`;
  }

  function numberDial() {
    return `<div class="number-dial" role="group" aria-label="数字标记表盘">${Array.from({ length: 10 }, (_, n) => `<button type="button" class="dial-number" data-action="exclude-digit" data-digit="${n}" aria-label="标记数字${n}为排除" title="单击排除，双击打勾，长按或右键选色" aria-haspopup="true" aria-expanded="false"><span>${n}</span><span class="dial-check" aria-hidden="true" hidden>${icon("check")}</span></button>`).join("")}</div>`;
  }

  function inputHeading(count = 0) {
    return `<header class="input-heading"><h1>数字炸弹</h1><span class="attempt-count" aria-label="已猜 ${count} 次，共 ${maxGuesses} 次机会"><b>${String(Math.min(count, maxGuesses)).padStart(2, "0")}</b><span> / ${maxGuesses}</span></span></header>`;
  }

  function result(code, action, label, disabled = false) {
    return `<div class="round-result"><div class="result-code" aria-label="答案 ${esc(code || "未设置")}">${Array.from({ length: 4 }, (_, i) => `<span class="result-digit">${esc(code?.[i] || "−")}</span>`).join("")}</div><button class="result-action" data-action="${action}"${disable(disabled || ui.busy)}>${label}</button></div>`;
  }

  function soloPanel() {
    const solo = state.solo;
    const ended = solo && solo.status !== "playing";
    return `<section class="input-panel" aria-label="单机输入">${inputHeading(solo?.guesses.length || 0)}${ended ? `<div class="context-bar" role="status">${solo.status === "won" ? "猜中了" : solo.status === "lost" ? "挑战失败" : "答案"}</div>${result(solo.answer, "new-solo", "再来一局")}` : numberForm("soloGuess", "solo-guess", "输入四位猜测数字", "猜一下", !solo)}</section>${historyPanel(solo?.guesses || [])}`;
  }

  function lobbyPanel() {
    return `<section class="input-panel lobby-panel" aria-label="联机设置">${inputHeading()}<button class="button button-primary lobby-start" data-action="settings">创建或加入房间</button></section>${historyPanel([])}`;
  }

  function roomPanel() {
    const room = state.room;
    const me = room.you;
    const opponent = room.opponent;
    const ended = ["finished", "closed"].includes(room.phase);
    const yourTurn = room.phase === "playing" && room.turn === "you";
    let controls;
    let status;
    if (ended) {
      status =
        room.winner === "you"
          ? "你赢了"
          : room.winner
            ? "对手获胜"
            : room.reason === "limit"
              ? "流局"
              : "已结束";
      controls = result(
        opponent?.secret,
        room.phase === "finished" ? "rematch" : "leave-room",
        room.phase === "closed"
          ? "退出房间"
          : me.rematch
            ? "等待对手"
            : opponent?.rematch
              ? "接受再战"
              : "再来一局",
        me.rematch,
      );
    } else if (!me.ready) {
      status = "设置数字";
      controls = numberForm(
        "secret",
        "set-secret",
        "设置你的四位秘密数字",
        "锁定",
      );
    } else {
      status =
        room.phase === "waiting"
          ? "等待加入"
          : room.phase === "setup"
            ? "等待准备"
            : yourTurn
              ? "你的回合"
              : "对手回合";
      controls = numberForm(
        "roomGuess",
        "room-guess",
        "猜测对手的四位数字",
        yourTurn ? "猜一下" : "等待",
        !yourTurn,
      );
    }
    return `<section class="input-panel" aria-label="联机输入">${inputHeading(me.guesses.length)}<div class="context-bar"><span role="status">${status}</span><div class="context-actions">${["waiting", "setup"].includes(room.phase) ? `<button class="room-code-button" data-action="copy-invite" aria-label="复制邀请"><span class="room-code-value">${room.code}</span>${icon("copy")}</button>` : me.secret ? `<button class="secret-peek" data-action="toggle-secret" aria-label="${ui.reveal ? "隐藏" : "查看"}我的秘密数字" aria-pressed="${ui.reveal}">${ui.reveal ? me.secret : "••••"}</button>` : ""}<button class="icon-button" data-action="leave-room" aria-label="退出房间" title="退出房间"${disable(ui.busy)}>${icon("close")}</button></div></div>${controls}</section>${historyPanel(ui.history === "you" ? me.guesses : opponent?.guesses || [], true)}`;
  }

  function render() {
    const active = panel.contains(document.activeElement)
      ? document.activeElement.id
      : null;
    panel.setAttribute(
      "aria-label",
      ui.mode === "solo" ? "单机游戏" : "联机游戏",
    );
    if (ui.loading)
      panel.innerHTML =
        '<div class="input-panel loading" aria-label="正在连接"><span class="loader"></span></div>' +
        historyPanel([]);
    else if (ui.error)
      panel.innerHTML =
        '<div class="input-panel loading"><button class="button button-primary" data-action="retry">重新连接</button></div>' +
        historyPanel([]);
    else
      panel.innerHTML =
        ui.mode === "solo"
          ? soloPanel()
          : state.room
            ? roomPanel()
            : lobbyPanel();
    if (active) {
      const input = document.getElementById(active);
      if (input && !input.disabled) input.focus({ preventScroll: true });
    }
    updateDial();
    positionDialPalette();
    updateSettingsActions();
  }

  function applyState(next) {
    if (next.version < state.version) return;
    const previous = state;
    const changed =
      JSON.stringify({ solo: previous.solo, room: previous.room }) !==
      JSON.stringify({ solo: next.solo, room: next.room });
    state = { version: next.version, solo: next.solo, room: next.room };
    for (const mode of ["solo", "duel"]) {
      if (gameId(mode, previous) !== gameId(mode, next)) restoreNotes(mode);
    }
    if (previous.room && next.room && previous.room.match !== next.room.match) {
      resetDraft("secret");
      resetDraft("roomGuess");
      ui.reveal = false;
      ui.history = "you";
      announce("请重新设置数字。");
    }
    if (
      next.room?.phase === "playing" &&
      previous.room?.turn !== next.room.turn &&
      next.room.turn === "you"
    )
      announce("你的回合。");
    if (changed || ui.loading || ui.error) {
      ui.loading = false;
      ui.error = false;
      render();
    }
    connect();
  }

  async function request(path, body, method = "POST") {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(path, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
        ...(method === "POST"
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body || {}),
            }
          : {}),
      });
      let data;
      try {
        data = await response.json();
      } catch (error) {
        if (error.name === "AbortError") throw error;
        throw new Error("服务器响应异常，请重试");
      }
      if (!response.ok) throw new Error(data.error || "操作失败，请重试。");
      return data;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("请求超时，请重试");
      if (error instanceof TypeError)
        throw new Error(
          navigator.onLine === false
            ? "网络不可用，请检查网络"
            : "网络请求失败，请重试",
        );
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function act(path, body = {}, options = {}) {
    if (ui.busy) return;
    ui.busy = true;
    render();
    try {
      const next = await request(path, body);
      if (options.clear) resetDraft(options.clear, options.preservePinned);
      options.then?.(next);
      if (options.closeModal && modal.open) modal.close();
      applyState(next);
      storage.set("guessnum_state_version", String(next.version));
      if (options.preservePinned) saveNotes(ui.mode);
      if (options.announce) announce(options.announce(next));
    } catch (error) {
      toast(error.message);
      refreshState().catch(() => {});
    } finally {
      ui.busy = false;
      render();
    }
  }

  function refreshState() {
    return request("/api/state", null, "GET").then(applyState);
  }

  function needsRealtime() {
    return (
      ui.mode === "duel" &&
      state.room &&
      state.room.phase !== "closed" &&
      !ui.loading &&
      !ui.error &&
      document.visibilityState === "visible"
    );
  }

  function clearConnectionWarning() {
    clearTimeout(connectionWarningTimer);
    connectionWarningTimer = null;
    if (connectionWarningShown && $("#toast").textContent === reconnectMessage)
      $("#toast").hidden = true;
    const settingsError = $("#settings-error");
    if (
      connectionWarningShown &&
      settingsError?.textContent === reconnectMessage
    )
      settingsError.hidden = true;
    connectionWarningShown = false;
  }

  function disconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    clearConnectionWarning();
    reconnectDelay = 1000;
    const previous = socket;
    socket = null;
    ui.connected = false;
    updateConnection();
    previous?.close();
  }

  function connect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (!needsRealtime()) {
      disconnect();
      return;
    }
    if (
      socket &&
      [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)
    )
      return;
    const current = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`,
    );
    socket = current;
    current.addEventListener("open", () => {
      if (socket !== current) return;
      if (!needsRealtime()) {
        disconnect();
        return;
      }
      ui.connected = true;
      reconnectDelay = 1000;
      clearConnectionWarning();
      updateConnection();
    });
    current.addEventListener("message", (event) => {
      if (socket !== current) return;
      try {
        const next = JSON.parse(event.data);
        if (next.type === "state") applyState(next);
      } catch {
        /* Ignore malformed frames. */
      }
    });
    current.addEventListener("close", () => {
      if (socket !== current) return;
      socket = null;
      ui.connected = false;
      updateConnection();
      if (!needsRealtime()) return;
      if (!connectionWarningTimer && !connectionWarningShown) {
        connectionWarningTimer = setTimeout(() => {
          connectionWarningTimer = null;
          if (needsRealtime() && !ui.connected) {
            toast(reconnectMessage);
            connectionWarningShown = true;
          }
        }, 6000);
      }
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 10000);
    });
    current.addEventListener("error", () => current.close());
  }

  async function initialize() {
    ui.loading = true;
    ui.error = false;
    try {
      render();
      let next = await request("/api/state", null, "GET");
      if (!next.solo) next = await request("/api/solo/start", {});
      applyState(next);
      if (/^[0-9]{6}$/.test(invite || "") && next.room?.code !== invite)
        openSettings();
    } catch {
      ui.loading = false;
      ui.error = true;
      render();
    }
  }
  function setMode(mode) {
    closeDialPalette();
    lastDialTap = null;
    ui.mode = mode;
    storage.set("guessnum_mode", mode);
    render();
    connect();
    if (ui.dialog === "settings" && modal.open) openSettings();
  }
  function openModal(html, kind = null) {
    closeDialPalette();
    lastDialTap = null;
    ui.dialog = kind;
    $("#modal-content").innerHTML = html;
    if (!modal.open) modal.showModal();
  }
  function updateSettingsActions() {
    if (ui.dialog !== "settings" || !modal.open) return;
    for (const button of modal.querySelectorAll("[data-api]")) {
      button.disabled =
        ui.busy ||
        ui.loading ||
        ui.error ||
        (button.dataset.action === "reveal-solo" &&
          state.solo?.status !== "playing");
    }
  }
  function openSettings() {
    const room = state.room;
    openModal(
      `<div class="modal-heading"><h2 id="modal-title">设置</h2><button class="icon-button" aria-label="关闭设置" data-action="close-modal">${icon("close")}</button></div>
      <div class="mode-switch settings-modes" role="tablist" aria-label="游戏模式"><button id="mode-solo" role="tab" aria-selected="${ui.mode === "solo"}" data-action="mode-solo">单机</button><button id="mode-duel" role="tab" aria-selected="${ui.mode === "duel"}" data-action="mode-duel">联机</button></div>
      <div class="settings-content">${ui.mode === "solo" ? `<div class="settings-actions"><button class="button" data-action="new-solo" data-api>${icon("refresh")}新开一局</button><button class="button" data-action="reveal-solo" data-api>${icon("eye")}揭晓答案</button></div>` : room ? `<div class="settings-room"><span>房间号</span><button class="room-code-button" data-action="copy-invite" aria-label="复制邀请"><span class="room-code-value">${room.code}</span>${icon("copy")}</button></div><button class="button settings-exit" data-action="leave-room" data-api>退出房间</button>` : `<form data-form="settings-join" class="settings-join"><label for="joinRoomCode">房间号</label><div class="join-row"><input id="joinRoomCode" class="text-input" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="off" placeholder="六位房间号" value="${esc(draftValue("roomCode"))}" required><button class="button button-primary" type="submit" data-api>加入房间</button></div></form><button class="button settings-create" data-action="create-room" data-api>创建房间</button>`}</div>
      <p id="settings-error" class="settings-error" role="alert" hidden></p><button class="button rules-link" data-action="rules">玩法说明</button>`,
      "settings",
    );
    updateSettingsActions();
  }
  function openRules() {
    openModal(
      `<div class="modal-heading"><h2 id="modal-title">玩法说明</h2><button class="icon-button" aria-label="关闭说明" data-action="close-modal">${icon("close")}</button></div><div class="rules-content"><p>猜一个四位数，首位可以是 0，数字可以重复。单机有 16 次机会，用完仍未猜中则挑战失败。</p><ul><li><strong>数字对：</strong>匹配的数字总数，包含位置正确的数字；重复数字按次数匹配。</li><li><strong>位置对：</strong>数字和位置都正确的个数。四个位置全对即获胜。</li></ul><p>例如答案 <b>0012</b>，猜 <b>0001</b>：数字对 <b>3</b> 个，位置对 <b>2</b> 个。</p><ul><li>联机时双方先设置自己的数字，再轮流猜对方；房主先手，先猜中者获胜，再战交换先手。每人有 16 次机会，双方均未猜中则流局。</li></ul></div><div class="modal-actions"><button class="button" data-action="settings">返回设置</button><button class="button button-primary" data-action="close-modal">知道了</button></div>`,
      "rules",
    );
  }
  function confirm(title, callback) {
    confirmAction = callback;
    openModal(
      `<div class="modal-heading"><h2 id="modal-title">${title}</h2><button class="icon-button" aria-label="关闭" data-action="close-modal">${icon("close")}</button></div><div class="modal-actions"><button class="button" data-action="close-modal">取消</button><button class="button button-primary" data-action="confirm">确定</button></div>`,
    );
  }
  async function copyInvite() {
    const link = `${location.origin}/?room=${state.room.code}`;
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(link);
      toast("邀请链接已复制");
    } catch {
      openModal(
        `<div class="modal-heading"><h2 id="modal-title">${state.room.code}</h2><button class="icon-button" aria-label="关闭" data-action="close-modal">${icon("close")}</button></div><label class="sr-only" for="inviteLink">邀请链接</label><input id="inviteLink" class="text-input" value="${esc(link)}" readonly><div class="modal-actions"><button class="button" data-action="close-modal">关闭</button></div>`,
      );
      $("#inviteLink").select();
    }
  }

  function selectSlot(key, index, focus = true) {
    ui.selected[key] = index;
    panel
      .querySelectorAll(`[data-draft="${key}"]`)
      .forEach((input) =>
        input.classList.toggle(
          "selected",
          Number(input.dataset.slot) === index,
        ),
      );
    const input = document.getElementById(`${key}-${index}`);
    if (focus && input && !input.disabled) {
      input.focus({ preventScroll: true });
      if (!input.readOnly) input.select();
    }
  }
  function activeKey() {
    return $(".number-form", panel)?.dataset.key;
  }
  function updateSubmit(key) {
    const form = $(`[data-key="${key}"]`, panel);
    const submit = form && $('[type="submit"]', form);
    if (submit)
      submit.disabled =
        ui.busy ||
        ui.drafts[key].some((v) => !v) ||
        $("[data-slot]", form).disabled;
  }
  function writeSlot(key, index, value, advance = false) {
    const input = document.getElementById(`${key}-${index}`);
    if (!input || input.disabled || ui.busy || ui.pinned[key]?.[index]) return;
    ui.drafts[key][index] = value;
    input.value = value;
    updateSubmit(key);
    const next = advance
      ? ui.drafts[key].findIndex((_, i) => i > index && !ui.pinned[key]?.[i])
      : -1;
    selectSlot(key, next === -1 ? index : next);
  }
  function enterDigit(value) {
    const key = activeKey();
    if (key) writeSlot(key, ui.selected[key], value, true);
  }
  function deleteDigit() {
    const key = activeKey();
    if (key) writeSlot(key, ui.selected[key], "");
  }

  function togglePin(key, index) {
    if (!ui.pinned[key] || !ui.drafts[key][index] || ui.busy) return;
    ui.pinned[key][index] = !ui.pinned[key][index];
    selectSlot(key, index, false);
    saveNotes(key === "soloGuess" ? "solo" : "duel");
    announce(
      `第${index + 1}位${ui.pinned[key][index] ? "已固定" : "已取消固定"}`,
    );
    render();
  }

  function updateDial() {
    for (const button of panel.querySelectorAll(".dial-number")) {
      const digit = button.dataset.digit;
      const excluded = ui.excluded[ui.mode].has(digit);
      const checked = ui.checked[ui.mode].has(digit);
      const color = ui.colors[ui.mode][digit] || "";
      button.classList.toggle("excluded", excluded);
      button.classList.toggle("checked", checked);
      button.dataset.checked = String(checked);
      button.dataset.color = color;
      button.setAttribute("aria-pressed", String(excluded));
      button.setAttribute(
        "aria-expanded",
        String(ui.dialMenu?.digit === digit && ui.dialMenu.mode === ui.mode),
      );
      button.setAttribute(
        "aria-description",
        `${checked ? "已打勾" : excluded ? "已排除" : "未标记"}${color ? `，${dialColors[color]}填充` : ""}。单击切换排除，双击切换打勾，长按或右键选择颜色。`,
      );
      $(".dial-check", button).hidden = !checked;
    }
  }

  function toggleDialMark(button, event) {
    const digit = button.dataset.digit;
    if (
      suppressedDialClick?.digit === digit &&
      Date.now() - suppressedDialClick.at < 1500
    ) {
      suppressedDialClick = null;
      return;
    }
    closeDialPalette();
    const now = performance.now();
    const doubleTap =
      event.detail !== 0 &&
      lastDialTap?.digit === digit &&
      lastDialTap.mode === ui.mode &&
      lastDialTap.game === gameId(ui.mode) &&
      now - lastDialTap.at <= 320;
    if (doubleTap) {
      ui.excluded[ui.mode].delete(digit);
      if (lastDialTap.checked) ui.checked[ui.mode].delete(digit);
      else ui.checked[ui.mode].add(digit);
      lastDialTap = null;
    } else {
      lastDialTap =
        event.detail === 0
          ? null
          : {
              digit,
              mode: ui.mode,
              game: gameId(ui.mode),
              at: now,
              checked: ui.checked[ui.mode].has(digit),
            };
      ui.checked[ui.mode].delete(digit);
      if (ui.excluded[ui.mode].has(digit)) ui.excluded[ui.mode].delete(digit);
      else ui.excluded[ui.mode].add(digit);
    }
    updateDial();
    saveNotes(ui.mode);
  }

  function closeDialPalette(focus = false) {
    const digit = ui.dialMenu?.digit;
    ui.dialMenu = null;
    dialPalette.hidden = true;
    updateDial();
    if (focus && digit !== undefined)
      $(`.dial-number[data-digit="${digit}"]`)?.focus({ preventScroll: true });
  }

  function positionDialPalette() {
    const menu = ui.dialMenu;
    if (!menu) return;
    const anchor = $(`.dial-number[data-digit="${menu.digit}"]`);
    if (
      !anchor ||
      menu.mode !== ui.mode ||
      menu.game !== gameId(ui.mode) ||
      modal.open
    ) {
      closeDialPalette();
      return;
    }
    const rect = anchor.getBoundingClientRect();
    const palette = dialPalette.getBoundingClientRect();
    dialPalette.style.left = `${Math.max(8, Math.min(rect.left + (rect.width - palette.width) / 2, innerWidth - palette.width - 8))}px`;
    const top = rect.top - palette.height - 8;
    dialPalette.style.top = `${Math.max(8, Math.min(top >= 8 ? top : rect.bottom + 8, innerHeight - palette.height - 8))}px`;
  }

  function openDialPalette(digit) {
    lastDialTap = null;
    ui.dialMenu = { digit, mode: ui.mode, game: gameId(ui.mode) };
    dialPalette.setAttribute("aria-label", `数字${digit}填充颜色`);
    for (const button of dialPalette.querySelectorAll(".color-swatch"))
      button.setAttribute(
        "aria-pressed",
        String(ui.colors[ui.mode][digit] === button.dataset.color),
      );
    dialPalette.hidden = false;
    updateDial();
    positionDialPalette();
    ($('[aria-pressed="true"]', dialPalette) || $("button", dialPalette)).focus(
      { preventScroll: true },
    );
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button || button.disabled) return;
    if (button.dataset.action !== "exclude-digit") lastDialTap = null;
    const newSolo = () =>
      act(
        "/api/solo/start",
        {},
        {
          clear: "soloGuess",
        },
      );
    switch (button.dataset.action) {
      case "settings":
        openSettings();
        break;
      case "rules":
        openRules();
        break;
      case "digit":
        enterDigit(button.dataset.digit);
        break;
      case "delete-digit":
        deleteDigit();
        break;
      case "exclude-digit": {
        toggleDialMark(button, event);
        break;
      }
      case "dial-color": {
        const menu = ui.dialMenu;
        const color = button.dataset.color;
        if (!menu || menu.mode !== ui.mode || menu.game !== gameId(ui.mode))
          break;
        if (Object.hasOwn(dialColors, color))
          ui.colors[ui.mode][menu.digit] = color;
        else delete ui.colors[ui.mode][menu.digit];
        saveNotes(ui.mode);
        closeDialPalette(true);
        break;
      }
      case "mode-solo":
        setMode("solo");
        break;
      case "mode-duel":
        setMode("duel");
        break;
      case "retry":
        initialize();
        break;
      case "close-modal":
        modal.close();
        confirmAction = null;
        break;
      case "confirm": {
        const callback = confirmAction;
        modal.close();
        confirmAction = null;
        callback?.();
        break;
      }
      case "new-solo":
        if (state.solo?.status === "playing" && state.solo.guesses.length)
          confirm("清空记录，重新开始？", newSolo);
        else {
          if (modal.open) modal.close();
          newSolo();
        }
        break;
      case "reveal-solo":
        confirm("揭晓答案并结束本局？", () => act("/api/solo/reveal"));
        break;
      case "create-room":
        act(
          "/api/rooms/create",
          {},
          {
            closeModal: true,
            then: () => {
              resetDraft("secret");
              ui.reveal = false;
              ui.history = "you";
            },
          },
        );
        break;
      case "copy-invite":
        copyInvite();
        break;
      case "toggle-secret":
        ui.reveal = !ui.reveal;
        render();
        break;
      case "history-you":
        ui.history = "you";
        render();
        break;
      case "history-opponent":
        ui.history = "opponent";
        render();
        break;
      case "leave-room":
        confirm("退出房间并结束对弈？", () =>
          act(
            "/api/rooms/leave",
            {},
            {
              then: () => {
                resetDraft("secret");
                resetDraft("roomGuess");
                ui.reveal = false;
                history.replaceState(null, "", location.pathname);
              },
            },
          ),
        );
        break;
      case "rematch":
        act("/api/rooms/rematch");
        break;
    }
  });

  document.addEventListener("focusin", (event) => {
    const input = event.target;
    if (input.dataset.slot === undefined) return;
    selectSlot(input.dataset.draft, Number(input.dataset.slot), false);
    if (!input.readOnly) input.select();
  });
  document.addEventListener("input", (event) => {
    const input = event.target;
    if (input.id === "joinRoomCode") {
      input.value = normalize(input.value).slice(0, 6);
      ui.drafts.roomCode = [...input.value.padEnd(6, " ")].map((digit) =>
        digit === " " ? "" : digit,
      );
      return;
    }
    if (input.dataset.slot === undefined) return;
    const value = normalize(input.value).slice(-1);
    writeSlot(
      input.dataset.draft,
      Number(input.dataset.slot),
      value,
      Boolean(value),
    );
  });
  document.addEventListener("paste", (event) => {
    const input = event.target;
    if (input.dataset.slot === undefined || input.disabled || ui.busy) return;
    event.preventDefault();
    const value = normalize(event.clipboardData.getData("text"));
    const key = input.dataset.draft;
    const count = ui.drafts[key].length;
    const start = value.length >= count ? 0 : Number(input.dataset.slot);
    [...value.slice(0, count - start)].forEach((digit, i) =>
      writeSlot(key, start + i, digit),
    );
    selectSlot(key, Math.min(start + value.length, count - 1));
  });

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!form.dataset.form) return;
    event.preventDefault();
    if (ui.busy) return;
    if (form.dataset.form === "settings-join") {
      const code = normalize($("#joinRoomCode").value);
      if (!/^[0-9]{6}$/.test(code)) {
        toast("请输入六位房间号");
        return;
      }
      act(
        "/api/rooms/join",
        { code },
        {
          closeModal: true,
          then: () => {
            resetDraft("secret");
            ui.reveal = false;
            ui.history = "you";
          },
        },
      );
      return;
    }
    const key = form.dataset.key;
    const value = draftValue(key);
    if (ui.drafts[key].some((v) => !v)) {
      selectSlot(
        key,
        ui.drafts[key].findIndex((v) => !v),
      );
      return;
    }
    if (key === "roomCode") {
      act(
        "/api/rooms/join",
        { code: value },
        {
          then: () => {
            resetDraft("secret");
            ui.reveal = false;
            ui.history = "you";
          },
        },
      );
    } else if (key === "secret") {
      act("/api/rooms/secret", { secret: value }, { clear: key });
    } else {
      act(
        key === "soloGuess" ? "/api/solo/guess" : "/api/rooms/guess",
        { guess: value },
        {
          clear: key,
          preservePinned: true,
          announce: (next) => {
            const last = (
              key === "soloGuess" ? next.solo.guesses : next.room.you.guesses
            ).at(-1);
            return `${value}：数字对 ${last.digits} 个，位置对 ${last.positions} 个。`;
          },
        },
      );
    }
  });

  function cancelLongPress() {
    clearTimeout(longPress?.timer);
    longPress = null;
  }
  document.addEventListener("pointerdown", (event) => {
    cancelLongPress();
    suppressedDialClick = null;
    if (!event.target.closest(".dial-number, #dial-palette")) {
      closeDialPalette();
      lastDialTap = null;
    }
    const target = event.target.closest("[data-lockable], .dial-number");
    if (
      !target ||
      target.disabled ||
      !["touch", "pen"].includes(event.pointerType)
    )
      return;
    const dial = target.classList.contains("dial-number");
    const key = target.dataset.draft;
    const index = Number(target.dataset.slot);
    const digit = target.dataset.digit;
    const mode = ui.mode;
    const game = gameId(mode);
    longPress = {
      type: dial ? "dial" : "input",
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      timer: setTimeout(() => {
        if (!target.isConnected || ui.mode !== mode || gameId(mode) !== game)
          return;
        if (dial) {
          lastLongPress = { type: "dial", digit, at: Date.now() };
          suppressedDialClick = { digit, at: Date.now() };
          openDialPalette(digit);
        } else {
          lastLongPress = { type: "input", key, index, at: Date.now() };
          togglePin(key, index);
        }
      }, 550),
    };
  });
  document.addEventListener("pointermove", (event) => {
    if (
      longPress &&
      longPress.pointerId === event.pointerId &&
      Math.hypot(event.clientX - longPress.x, event.clientY - longPress.y) > 10
    )
      cancelLongPress();
  });
  document.addEventListener("pointerup", cancelLongPress);
  document.addEventListener("pointercancel", cancelLongPress);
  document.addEventListener("contextmenu", (event) => {
    const dial = event.target.closest(".dial-number");
    if (dial) {
      event.preventDefault();
      const digit = dial.dataset.digit;
      const touch =
        longPress?.type === "dial" ||
        event.pointerType === "touch" ||
        event.pointerType === "pen";
      cancelLongPress();
      if (
        lastLongPress?.type === "dial" &&
        lastLongPress.digit === digit &&
        Date.now() - lastLongPress.at < 1500
      )
        return;
      if (touch) {
        lastLongPress = { type: "dial", digit, at: Date.now() };
        suppressedDialClick = { digit, at: Date.now() };
      }
      openDialPalette(digit);
      return;
    }
    const input = event.target.closest("[data-lockable]");
    if (!input) return;
    event.preventDefault();
    const key = input.dataset.draft;
    const index = Number(input.dataset.slot);
    if (
      lastLongPress?.type === "input" &&
      lastLongPress.key === key &&
      lastLongPress.index === index &&
      Date.now() - lastLongPress.at < 1200
    )
      return;
    cancelLongPress();
    togglePin(key, index);
  });

  document.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing)
      return;
    if (ui.dialMenu) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDialPalette(true);
      } else if (
        ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
      ) {
        event.preventDefault();
        const buttons = [...dialPalette.querySelectorAll("button")];
        const index =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (buttons.indexOf(document.activeElement) +
                  (event.key === "ArrowRight" ? 1 : -1) +
                  buttons.length) %
                buttons.length;
        buttons[index].focus({ preventScroll: true });
      }
      return;
    }
    const tab = event.target.closest('[role="tab"]');
    if (tab && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const tabs = [...tab.parentElement.querySelectorAll('[role="tab"]')];
      const index =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : (tabs.indexOf(tab) +
                (event.key === "ArrowRight" ? 1 : -1) +
                tabs.length) %
              tabs.length;
      const target = tabs[index].id;
      tabs[index].click();
      document.getElementById(target)?.focus();
      return;
    }
    const key = activeKey();
    if (modal.open) return;
    if (!key || $(`[data-draft="${key}"]`).disabled) return;
    if (/^[0-9０-９]$/.test(event.key)) {
      event.preventDefault();
      enterDigit(normalize(event.key));
    } else if (["Backspace", "Delete"].includes(event.key)) {
      event.preventDefault();
      deleteDigit();
    } else if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const index =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? ui.drafts[key].length - 1
            : (ui.selected[key] +
                (event.key === "ArrowRight" ? 1 : -1) +
                ui.drafts[key].length) %
              ui.drafts[key].length;
      selectSlot(key, index);
    } else if (event.key === "Enter" && !event.target.closest("button")) {
      event.preventDefault();
      $(".number-form").requestSubmit();
    }
  });

  modal.addEventListener("close", () => {
    ui.dialog = null;
    confirmAction = null;
  });
  window.addEventListener("resize", () => closeDialPalette());
  modal.addEventListener("click", (event) => {
    const rect = modal.getBoundingClientRect();
    if (
      event.target === modal &&
      (event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom)
    )
      modal.close();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") disconnect();
    else if (!ui.loading)
      refreshState()
        .catch(() => {})
        .finally(connect);
  });
  window.addEventListener("storage", (event) => {
    // Solo tabs synchronize through browser notifications, without a server socket.
    if (
      event.key === "guessnum_state_version" &&
      !ui.loading &&
      !ui.connected &&
      document.visibilityState === "visible"
    )
      refreshState().catch(() => {});
  });
  window.addEventListener("online", () => {
    if (ui.loading) return;
    disconnect();
    refreshState()
      .catch(() => {})
      .finally(connect);
  });
  initialize();
})();

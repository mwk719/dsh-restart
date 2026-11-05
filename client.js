window.__ModuleLoader__.load({
  // The loader keys this module by the package name, so a scoped package needs the scope here too.
  id: '@mwk719/dsh-restart',
  factory(require) {
    // The application's own document language wins: it is what the surrounding menus speak. A shell
    // that has not synced `lang` yet is read from the browser's own order instead.
    const detectZh = (documentLanguage, browserLanguage) => {
      const tag = typeof documentLanguage === 'string' ? documentLanguage : '';
      if (/^zh(-|$)/i.test(tag)) return true;
      if (tag !== '' && !/^en(-|$)/i.test(tag)) return false;
      const first = Array.isArray(browserLanguage) ? browserLanguage[0] : browserLanguage;
      return typeof first === 'string' && /^zh(-|$)/i.test(first);
    };
    const COPY = (zh) => zh
      ? {
          label: '重启',
          hint: '重启 DeepSeek Harness（会先弹出确认框）',
          dialogTitle: '重启 DeepSeek Harness？',
          dialogBody: '应用会关闭并立即重新打开，等同退出后重开。',
          checking: '正在检查正在运行的任务…',
          idle: '当前没有正在运行的会话。',
          busy: (n) => `有 ${n} 个会话正在运行，重启会中断它们。`,
          cancel: '取消',
          confirm: '重启应用',
          working: '正在重启…',
          leaving: '应用正在关闭并重新打开…',
          failed: (detail) => `重启失败：${detail}`,
          stuck: '重启没有生效：应用仍在运行。请从「应用」菜单退出后重新打开。',
        }
      : {
          label: 'Restart',
          hint: 'Restart DeepSeek Harness (asks for confirmation first)',
          dialogTitle: 'Restart DeepSeek Harness?',
          dialogBody: 'The app closes and reopens right away, exactly like quitting and opening it again.',
          checking: 'Checking for running work…',
          idle: 'Nothing is running right now.',
          busy: (n) => `${n} session(s) are running; a restart interrupts them.`,
          cancel: 'Cancel',
          confirm: 'Restart app',
          working: 'Restarting…',
          leaving: 'The app is closing and reopening…',
          failed: (detail) => `Restart failed: ${detail}`,
          stuck: 'The restart did not happen: the app is still running. Quit it from the Application menu and open it again.',
        };

    // The caption menubar only exists in the Windows desktop shell; a browser tab has no titlebar
    // row to extend, and no application to restart behind it.
    const desktop = /Electron\//.test(navigator.userAgent || '');
    const HOST_BASE = '/dsh-restart'; // ui-copy-ignore
    const BUTTON_ATTR = 'data-dsh-restart'; // ui-copy-ignore
    const DIALOG_ATTR = 'data-dsh-restart-dialog'; // ui-copy-ignore
    const MENUBAR_HOST = '[data-windows-menu]'; // ui-copy-ignore
    const ATTACH_TIMEOUT_MS = 20000; // ui-copy-ignore
    const STUCK_AFTER_MS = 20000; // ui-copy-ignore

    const language = () => (detectZh(document.documentElement?.lang, navigator.languages || navigator.language) ? 'zh' : 'en');

    /** The caption menubar the desktop preload installs in this document, when it is there yet. */
    function captionBar() {
      const host = document.querySelector(MENUBAR_HOST);
      if (host === null || host.shadowRoot === null) return null;
      const bar = host.shadowRoot.querySelector('[role="menubar"]');
      return bar !== null && bar.isConnected ? bar : null;
    }

    /**
     * One button in the shell's own menubar row, plus the dialog it opens.
     *
     * A restart ends every running turn, so no press restarts anything by itself: the button opens
     * a dialog that names what would be interrupted, and only its confirming action reaches the
     * Host. The Host refuses an unconfirmed press as well, so the promise holds even if a page is
     * older than the code it is talking to.
     */
    function mount() {
      let button = null;
      let attachTimer = 0;
      let languageObserver = null;
      const startedAt = Date.now();
      let copy = COPY(language() === 'zh');
      let dialog = null;

      /** What this page did, written to the Host's log so a press can be accounted for later. */
      function report(event) {
        try {
          void fetch(`${HOST_BASE}/state?event=${encodeURIComponent(event)}`, {
            method: 'POST', // ui-copy-ignore
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json', 'x-dsh-restart': '1' }, // ui-copy-ignore
            body: '{}', // ui-copy-ignore
            cache: 'no-store', // ui-copy-ignore
            keepalive: true, // ui-copy-ignore
          }).catch(() => {});
        } catch {
          // A page that cannot report still works; the log is evidence, not a step.
        }
      }

      /**
       * The confirmation dialog: its own shadow root, so the shell's stylesheet cannot reach it and
       * it cannot leak into the shell. Colours come from the app's theme tokens, so it follows light
       * and dark without describing either.
       */
      function createDialog() {
        const host = document.createElement('div');
        host.setAttribute(DIALOG_ATTR, '');
        host.style.cssText = [
          'position:fixed',
          'inset:0',
          'z-index:1200',
          'display:none',
          'font-family:var(--dsw-font-family, system-ui, -apple-system, "Segoe UI", sans-serif)',
        ].join(';');
        const shadow = host.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = `
          .overlay { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
            background: rgba(0, 0, 0, 0.34); }
          .card { box-sizing: border-box; width: min(420px, calc(100vw - 48px)); padding: 20px 20px 16px;
            border-radius: 12px; background: var(--dsw-alias-bg-overlay, #ffffff);
            border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.10));
            box-shadow: 0 18px 48px rgba(0, 0, 0, 0.24); color: var(--dsw-alias-label-primary, #111111);
            font-size: 13px; line-height: 1.6; }
          h2 { margin: 0 0 8px; font-size: 15px; font-weight: 600; }
          p { margin: 0; color: var(--dsw-alias-label-secondary, #666666); }
          .status { margin-top: 10px; }
          .status[data-tone='warn'] { color: var(--dsw-alias-state-warn-primary, #b26b00); }
          .status[data-tone='error'] { color: var(--dsw-alias-state-error-primary, #c0392b); }
          .row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
          button { height: 32px; padding: 0 14px; border-radius: 8px; font: inherit; font-size: 13px;
            cursor: pointer; border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.16));
            background: transparent; color: var(--dsw-alias-label-primary, #111111); }
          button:hover { background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.05)); }
          button.solid { border-color: transparent; background: var(--dsw-alias-label-primary, #111111);
            color: var(--dsw-alias-bg-overlay, #ffffff); }
          button.solid:hover { opacity: 0.9; background: var(--dsw-alias-label-primary, #111111); }
          button:disabled { opacity: 0.55; cursor: default; }
          button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #1d6fd8); outline-offset: 1px; }
        `;
        const overlay = document.createElement('div');
        overlay.className = 'overlay';
        const card = document.createElement('div');
        card.className = 'card';
        card.setAttribute('role', 'dialog');
        card.setAttribute('aria-modal', 'true');
        card.setAttribute('aria-labelledby', 'dsh-restart-title');
        card.setAttribute('aria-describedby', 'dsh-restart-body');
        const title = document.createElement('h2');
        title.id = 'dsh-restart-title';
        const body = document.createElement('p');
        body.id = 'dsh-restart-body';
        const status = document.createElement('p');
        status.className = 'status';
        status.setAttribute('aria-live', 'polite');
        const row = document.createElement('div');
        row.className = 'row';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        const confirm = document.createElement('button');
        confirm.type = 'button';
        confirm.className = 'solid';
        row.append(cancel, confirm);
        card.append(title, body, status, row);
        overlay.append(card);
        shadow.append(style, overlay);
        document.body.append(host);

        let visible = false;
        let working = false;
        let stuckTimer = 0;

        const setStatus = (text, tone) => {
          status.textContent = text;
          if (tone === undefined) status.removeAttribute('data-tone');
          else status.setAttribute('data-tone', tone);
        };

        /** What a restart would interrupt, asked of the Host while the dialog waits. */
        async function describe() {
          try {
            const response = await fetch(`${HOST_BASE}/state`, { cache: 'no-store', credentials: 'same-origin' });
            if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
            const data = await response.json();
            if (!visible) return;
            const running = Number(data?.busy) > 0 ? Number(data.busy) : 0;
            setStatus(running > 0 ? copy.busy(running) : copy.idle, running > 0 ? 'warn' : undefined);
          } catch {
            if (visible) setStatus('', undefined);
          }
        }

        function close(why) {
          clearTimeout(stuckTimer);
          if (!visible) return;
          visible = false;
          working = false;
          host.style.display = 'none';
          overlay.removeEventListener('click', onBackdrop);
          document.removeEventListener('keydown', onKey, true);
          confirm.disabled = false;
          cancel.disabled = false;
          if (why !== undefined) report(why);
          try {
            button?.focus({ preventScroll: true });
          } catch {
            /* a shell that refuses focus costs nothing */
          }
        }

        function onBackdrop(event) {
          if (working) return;
          if (event.target === overlay) close('dialog-cancel');
        }

        function onKey(event) {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (!working) close('dialog-cancel');
            return;
          }
          if (event.key !== 'Tab') return;
          // Two actions: keep the focus inside the dialog instead of letting Tab reach the app.
          const stops = [cancel, confirm].filter((node) => !node.disabled);
          if (stops.length === 0) return;
          const active = shadow.activeElement;
          const index = stops.indexOf(active);
          const next = event.shiftKey ? stops[(index <= 0 ? stops.length : index) - 1] : stops[(index + 1) % stops.length];
          event.preventDefault();
          next.focus();
        }

        function show() {
          clearTimeout(stuckTimer);
          working = false;
          copy = COPY(language() === 'zh');
          title.textContent = copy.dialogTitle;
          body.textContent = copy.dialogBody;
          cancel.textContent = copy.cancel;
          confirm.textContent = copy.confirm;
          confirm.disabled = false;
          cancel.disabled = false;
          setStatus(copy.checking, undefined);
          overlay.addEventListener('click', onBackdrop);
          document.addEventListener('keydown', onKey, true);
          if (!visible) report('dialog-open');
          visible = true;
          host.style.display = 'block';
          void describe();
          try {
            cancel.focus({ preventScroll: true });
          } catch {
            /* focus is a courtesy here */
          }
        }

        async function restart() {
          if (working) return;
          working = true;
          clearTimeout(stuckTimer);
          confirm.disabled = true;
          cancel.disabled = true;
          setStatus(copy.working, undefined);
          report('dialog-confirm');
          try {
            const response = await fetch(`${HOST_BASE}/restart?force=1`, {
              method: 'POST', // ui-copy-ignore
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json', 'x-dsh-restart': '1' }, // ui-copy-ignore
              body: '{}', // ui-copy-ignore
              cache: 'no-store', // ui-copy-ignore
            });
            const data = await response.json().catch(() => null);
            const detail = typeof data?.detail === 'string' && data.detail !== '' ? data.detail : `HTTP ${String(response.status)}`;
            if (!response.ok || data?.status !== 'restarting') throw new Error(detail);
            setStatus(copy.leaving, undefined);
            // A page still here long afterwards is a restart that did not happen, and saying so
            // beats a dialog that waits forever.
            stuckTimer = setTimeout(() => {
              working = false;
              confirm.disabled = false;
              cancel.disabled = false;
              setStatus(copy.stuck, 'error');
              report('dialog-stuck');
            }, STUCK_AFTER_MS);
          } catch (error) {
            working = false;
            confirm.disabled = false;
            cancel.disabled = false;
            setStatus(copy.failed(String(error?.message ?? error)), 'error');
            report('dialog-failed');
          }
        }

        cancel.addEventListener('click', () => {
          if (!working) close('dialog-cancel');
        });
        confirm.addEventListener('click', () => {
          void restart();
        });

        return {
          open: show,
          destroy() {
            clearTimeout(stuckTimer);
            overlay.removeEventListener('click', onBackdrop);
            document.removeEventListener('keydown', onKey, true);
            host.remove();
          },
        };
      }

      const attach = () => {
        const bar = captionBar();
        if (bar === null) return false;
        if (button !== null && button.isConnected && button.parentElement === bar) return true;
        button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('role', 'menuitem');
        button.setAttribute(BUTTON_ATTR, '');
        button.textContent = copy.label;
        button.title = copy.hint;
        button.addEventListener('click', () => {
          if (dialog === null) dialog = createDialog();
          dialog.open();
        });
        bar.append(button);
        report('button-attached');
        return true;
      };

      const waitForBar = () => {
        if (attach()) {
          // The shell rewrites this menubar row on a locale change; the row itself survives, so only
          // the words need to follow the document language.
          languageObserver = new MutationObserver(() => {
            copy = COPY(language() === 'zh');
            if (button === null) return;
            button.title = copy.hint;
            button.textContent = copy.label;
          });
          languageObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
          return;
        }
        if (Date.now() - startedAt > ATTACH_TIMEOUT_MS) return; // ui-copy-ignore
        attachTimer = setTimeout(waitForBar, 250); // ui-copy-ignore
      };

      if (desktop) waitForBar();

      return () => {
        clearTimeout(attachTimer);
        languageObserver?.disconnect();
        dialog?.destroy();
        dialog = null;
        if (button !== null) {
          button.remove();
          button = null;
        }
      };
    }

    return {
      apply(ctx) {
        if (typeof ctx?.effect === 'function') ctx.effect(() => mount());
        else mount();
      },
    };
  },
});

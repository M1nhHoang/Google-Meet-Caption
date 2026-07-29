/* Turn captions on automatically.
   Click the real button instead of faking the "c" key: Meet listens through jsaction so
   el.click() still fires, while a synthetic KeyboardEvent is usually ignored.

   The most important safety rule: NEVER click blind. If captions are already on we do
   not touch the button, and if clicking does not produce captions we click back to
   restore — a missed click is far better than turning off captions the user had on. */

/* var, not const: content scripts share one global scope, like sibling <script>
   tags. A second `const MC` would throw "Identifier MC has already been declared"
   and block every file listed after it. */
var MC = (window.__MC ||= {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

MC.cc = {
  /**
   * @returns {Promise<"already-on"|"on"|"needs-language"|"no-button"|"failed">}
   */
  async ensureOn({ retries = 2 } = {}) {
    if (MC.sel.captionRegion()) return "already-on";
    if (MC.sel.captionsState() === "on") return "already-on";

    for (let attempt = 0; attempt <= retries; attempt++) {
      const btn = MC.sel.ccButton();
      if (!btn) {
        // The toolbar may not be built yet.
        const later = await MC.waitFor(() => MC.sel.ccButton(), 2000);
        if (!later) return "no-button";
      }

      (MC.sel.ccButton() || btn).click();

      const got = await MC.waitFor(
        () => MC.sel.captionRegion() || MC.sel.openDialog() || null,
        3000
      );

      if (MC.sel.captionRegion()) return "on";

      // On first use Meet asks which caption language to use. Never pick for the user.
      if (got && MC.sel.openDialog()) return "needs-language";

      // No dialog and no caption region: we may have just clicked the wrong way.
      if (MC.sel.captionsState() === "on") return "on";
      (MC.sel.ccButton() || btn)?.click(); // put it back the way it was
      await sleep(1500);
    }

    return "failed";
  },

  /**
   * "Keep captions on": if the caption region disappears, re-enable exactly ONCE.
   * If the user turns it off a second time, respect that and stop fighting them.
   */
  watchStayOn(onResult) {
    let used = false;
    let timer = null;
    const obs = new MutationObserver(() => {
      if (used || MC.sel.captionRegion()) return;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (used || MC.sel.captionRegion()) return;
        used = true;
        const r = await this.ensureOn({ retries: 0 });
        onResult?.(r);
      }, 2000);
    });
    obs.observe(document.body, { childList: true, subtree: true });
    return () => {
      clearTimeout(timer);
      obs.disconnect();
    };
  },
};

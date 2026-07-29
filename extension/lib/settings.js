/* User settings — chrome.storage.sync so they follow the user to another machine.
   Content scripts cannot load ES modules, so they read storage directly; DEFAULTS
   here is the source of truth and content/detector.js keeps a mirrored copy. */

export const DEFAULTS = {
  /* automation */
  autoRecord: true,        // join a call, start recording
  autoCaption: true,       // click the CC button for the user
  keepCaptionOn: false,    // re-enable once if captions get turned off mid-call
  captureEnabled: true,    // capture images at all
  skipCodes: [],           // meeting codes to ignore

  /* capture thresholds — names match cfg in idea.js v7 */
  minChangeRatio: 0.05,
  settleRatio: 0.015,
  pixelTol: 12,
  threshold: 6,
  watchMs: 1000,

  /* Stored image quality — images are encoded at capture time, not at export.
     0 = keep the video stream's native resolution, no downscaling. Slides carry text
     and downscaling destroys it, so the default is not to downscale.
     Note: Meet lowers the stream resolution to match the displayed tile size, so a
     sharp image requires enlarging the presentation — see videoWarnWidth. */
  exportMaxSide: 0,
  exportQuality: 0.92,
  exportFormat: "image/webp",
  captureHardCap: 2560,     // upper bound for 4K screens, avoids 8 MB stills
  videoWarnWidth: 1000,     // narrower stream than this: HUD suggests enlarging the presentation

  /* stored data */
  retentionDays: 30,
  maxBytes: 4 * 1024 * 1024 * 1024,   // 4 GB — sharp images are far heavier
  copyMaxBytes: 25 * 1024 * 1024,     // above this, download a file instead of copying
};

export async function getSettings() {
  const got = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...got };
}

export async function setSettings(patch) {
  await chrome.storage.sync.set(patch);
}

export function onSettingsChanged(fn) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    const patch = {};
    for (const [k, v] of Object.entries(changes)) patch[k] = v.newValue;
    fn(patch);
  });
}

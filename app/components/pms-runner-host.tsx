"use client";

import { useEffect } from "react";
import { desktopBridge, startRunner } from "@/lib/pms/browser/desktop-runner";

/**
 * Runs the customer-authorized provider queue while the desktop app is open.
 *
 * Headless and mounted in the locale layout, because the work it drains is not
 * attached to a screen: a work order queued while somebody was looking at the
 * dashboard should still execute when they have navigated to settings. In the
 * browser build `desktopBridge()` is null and this does nothing at all, which
 * is the correct behaviour rather than a degraded one — a cloud tab has no PMS
 * session to operate inside.
 *
 * The device identifier is per browser profile and stable across restarts, so a
 * lease taken before a crash is recognisably this device's afterwards. It is a
 * label for leases and audit and never an authority: everything this runner is
 * allowed to do is decided by cloud, per claim.
 */
const DEVICE_KEY = "aval.pms.runner.device";

function deviceId(): string {
  try {
    const held = window.localStorage.getItem(DEVICE_KEY);
    if (held) return held;
    const minted = `device-${crypto.randomUUID()}`;
    window.localStorage.setItem(DEVICE_KEY, minted);
    return minted;
  } catch {
    // Private windows and blocked storage are ordinary. A per-session id still
    // leases correctly; it just will not be recognised after a restart.
    return `device-${crypto.randomUUID()}`;
  }
}

export function PmsRunnerHost() {
  useEffect(() => {
    if (!desktopBridge()) return;
    return startRunner({ runnerId: deviceId() });
  }, []);

  return null;
}

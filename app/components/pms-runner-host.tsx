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
 * Desktop main owns the encrypted device registration and workspace binding.
 * No identity, steps, payload, or device credential comes from this renderer.
 */

export function PmsRunnerHost() {
  useEffect(() => {
    if (!desktopBridge()) return;
    return startRunner({});
  }, []);

  return null;
}

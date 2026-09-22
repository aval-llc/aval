import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import localFont from "next/font/local";
import { NextIntlClientProvider } from "next-intl";
import { PmsRunnerHost } from "@/app/components/pms-runner-host";
import { getMessages } from "next-intl/server";
import "../globals.css";
import "../enterprise.css";
import "../agent-library.css";
import "../setup-graph.css";
import "../setup-library.css";
import { routing } from "./routing";

// Inter's variable font — one file covers the full 100-900 weight range
// this app already relies on across headings/buttons/labels, rather than
// loading several static weight files.
const inter = localFont({
  src: "../fonts/InterVariable.woff2",
  variable: "--font-inter",
  weight: "100 900",
  style: "normal",
  display: "swap",
});

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata(): Promise<Metadata> {
  const incomingHeaders = await headers();
  const host = incomingHeaders.get("x-forwarded-host") ?? incomingHeaders.get("host") ?? "localhost:3000";
  const protocol = incomingHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const title = "Aval: Property operations, connected";
  const description = "One calm workspace for leasing, accounting, resident conversations, maintenance, and the systems behind them.";

  return {
    title,
    description,
    icons: {
      icon: [{ url: "/favicon.png", type: "image/png", sizes: "64x64" }],
      shortcut: "/favicon.png",
      apple: "/icon-192.png",
    },
    manifest: "/manifest.webmanifest",
    appleWebApp: { capable: true, title: "Aval", statusBarStyle: "black-translucent" },
    openGraph: {
      title,
      description,
      type: "website",
      locale: "en_US",
      url: origin,
    },
    twitter: {
      card: "summary",
      title,
      description,
    },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f5f7" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0b0a" },
  ],
};

export default async function RootLayout({
  children,
  params,
}: Readonly<{ children: React.ReactNode; params: Promise<{ locale: string }> }>) {
  const { locale } = await params;
  if (!routing.locales.includes(locale as (typeof routing.locales)[number])) notFound();
  const messages = await getMessages();

  return (
    <html lang={locale}>
      <body className={inter.variable}>
        <NextIntlClientProvider locale={locale} messages={messages}>
          {children}
          {/* Drains authorized provider work while the desktop app is open.
              Renders nothing, and does nothing at all in the browser build. */}
          <PmsRunnerHost/>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

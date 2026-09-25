import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { AppShell } from "@/components/AppShell";
import { LocaleProvider } from "@/components/LocaleProvider";
import { SessionProvider } from "@/components/SessionProvider";
import { publicEnvironment } from "@/lib/env";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: publicEnvironment.applicationName,
    template: `%s · ${publicEnvironment.applicationName}`
  },
  description: "Operational application foundation for the AL-BERUNIY Operating System."
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "dark"
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" dir="ltr">
      <body><LocaleProvider><SessionProvider><AppShell>{children}</AppShell></SessionProvider></LocaleProvider></body>
    </html>
  );
}

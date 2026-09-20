import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { AppShell } from "@/components/AppShell";
import { I18nProvider } from "@/i18n/I18nProvider";
import { ToastHost } from "@/components/toast";
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
      <body className="bg-[#070e1e] text-slate-100 min-h-screen">
        <I18nProvider>
          <AppShell>
            {children}
            <ToastHost />
          </AppShell>
        </I18nProvider>
      </body>
    </html>
  );
}

import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";

import { getBrandConfig, getBrandTheme } from "@/lib/brand/config";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const brand = getBrandConfig();

export async function generateMetadata(): Promise<Metadata> {
  const theme = await getBrandTheme();
  return {
    title: theme.name,
    description: "Anonymous talent matching, powered by 8vance",
  };
}

export const viewport: Viewport = {
  themeColor: brand.primaryColor,
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  const messages = await getMessages();
  const theme = await getBrandTheme();
  const brandStyle = {
    ["--brand-primary" as string]: brand.primaryColor,
    ["--ft-accent" as string]: theme.accentColor,
  } as React.CSSProperties;

  return (
    <html
      lang={locale}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col" style={brandStyle}>
        <NextIntlClientProvider locale={locale} messages={messages}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "市场价差监控 | Market Monitor",
  description: "统一追踪原油与海力士价差、资金费率、历史走势和后台告警。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}

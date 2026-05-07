import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Stripe Discord Damage Deposit Tool",
  description: "Discord slash commands for Stripe damage deposit holds",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
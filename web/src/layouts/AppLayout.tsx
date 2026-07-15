import type { ReactNode } from "react";
import { Sidebar } from "../components/Sidebar";

export function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="main">{children}</main>
    </div>
  );
}

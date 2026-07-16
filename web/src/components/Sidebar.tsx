import { NavLink } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", icon: "◱" },
  { to: "/live-trading", label: "Live Trading", icon: "⚡" },
  { to: "/strategy", label: "Strategy Config", icon: "⚙" },
  { to: "/vault", label: "Vault Portal", icon: "🔒" },
  { to: "/logs", label: "Transaction Logs", icon: "≡" },
  { to: "/security", label: "System Security", icon: "🛡" },
];

export function Sidebar() {
  const { logout } = useAuth();

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">MemeScope Control</div>
      <nav className="sidebar__nav">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) => `sidebar__link${isActive ? " sidebar__link--active" : ""}`}
          >
            <span aria-hidden="true">{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="sidebar__footer">
        <button type="button" className="btn btn--secondary" style={{ width: "100%" }} onClick={() => void logout()}>
          Sign out
        </button>
      </div>
    </aside>
  );
}

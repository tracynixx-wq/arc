import Link from "next/link";

const sections = [
  { label: "Все медиа", count: "—", icon: "▦" },
  { label: "Недавно добавленные", count: "—", icon: "◷" },
  { label: "Избранное", count: "—", icon: "♡" },
  { label: "Видео", count: "—", icon: "▷" },
  { label: "GIF", count: "—", icon: "GIF" },
  { label: "Фото", count: "—", icon: "▧" },
  { label: "Корзина", count: "—", icon: "⌫" },
];

export default function HomePage() {
  return (
    <main className="shell">
      <aside className="sidebar">
        <Link className="brand" href="/" aria-label="ARC home">
          <span className="brand-mark">A</span>
          <span>ARC</span>
        </Link>
        <button className="primary-action" type="button" disabled title="Загрузка через Telegram-бота">
          <span>＋</span> Добавить через Telegram
        </button>
        <div className="nav-caption">БИБЛИОТЕКА</div>
        <nav className="navigation" aria-label="Разделы архива">
          {sections.map((section, index) => (
            <a className={index === 0 ? "nav-item active" : "nav-item"} href="#" key={section.label}>
              <span className="nav-icon">{section.icon}</span>
              <span>{section.label}</span>
              <small>{section.count}</small>
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="status-dot" />
          <span>ARC 1.0 · подготовка</span>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="breadcrumbs">Библиотека <span>/</span> Все медиа</div>
          <div className="topbar-actions">
            <label className="search">
              <span>⌕</span>
              <input aria-label="Поиск по архиву" placeholder="Поиск по названию, тегам…" disabled />
              <kbd>⌘ K</kbd>
            </label>
            <button className="avatar" type="button" aria-label="Профиль">A</button>
          </div>
        </header>

        <div className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">ЛИЧНЫЙ АРХИВ</div>
              <h1>Все медиа</h1>
              <p>Ваше пространство для фото, видео и GIF.</p>
            </div>
            <div className="heading-meta">Сначала новые <span>⌄</span></div>
          </div>

          <div className="empty-state">
            <div className="empty-art">
              <div className="art-card art-one">▧</div>
              <div className="art-card art-two">▷</div>
              <div className="art-card art-three">GIF</div>
            </div>
            <h2>Архив готов к наполнению</h2>
            <p>Отправляйте фото, видео и GIF своему Telegram-боту. После сохранения и проверки файлы появятся здесь.</p>
            <div className="empty-note"><span className="status-dot" /> Оригиналы будут храниться отдельно от обложек</div>
          </div>
          <footer className="footer-note">Приватный архив · Доступ только владельцу</footer>
        </div>
      </section>
    </main>
  );
}

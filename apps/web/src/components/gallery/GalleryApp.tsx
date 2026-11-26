"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type MediaItem = {
  id: string;
  filename: string;
  display_name: string | null;
  description: string | null;
  media_type: "photo" | "video" | "gif" | "other";
  mime_type: string;
  size_bytes: number;
  uploaded_at: string;
  original_created_at: string | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  processing_status: string;
  coverUrl: string | null;
  isFavorite: boolean;
};

type GalleryResponse = { items: MediaItem[]; page: number; pageSize: number; hasMore: boolean; total: number | null };
type ViewerFile = { url: string; mimeType: string };
type CollectionItem = { id: string; name: string; description: string | null; is_system: boolean; system_key: string | null; sort_order: number };
type TagItem = { id: string; name: string; color: string | null };

declare global {
  interface Window {
    Telegram?: { WebApp?: { initData?: string; ready?: () => void; expand?: () => void } };
  }
}

function formatSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} Б`;
  const units = ["КБ", "МБ", "ГБ", "ТБ"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ru", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value));
}

export default function GalleryApp() {
  const [items, setItems] = useState<MediaItem[]>([]);
  const requestVersion = useRef(0);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"loading" | "ready" | "telegram" | "error">("loading");
  const [message, setMessage] = useState("");
  const [active, setActive] = useState<MediaItem | null>(null);
  const [viewerFile, setViewerFile] = useState<ViewerFile | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [collections, setCollections] = useState<CollectionItem[]>([]);
  const [mediaCollectionIds, setMediaCollectionIds] = useState<string[]>([]);
  const [collectionsSaving, setCollectionsSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editDate, setEditDate] = useState("");
  const [metadataSaving, setMetadataSaving] = useState(false);
  const [tags, setTags] = useState<TagItem[]>([]);
  const [mediaTagIds, setMediaTagIds] = useState<string[]>([]);
  const [tagName, setTagName] = useState("");
  const [tagsSaving, setTagsSaving] = useState(false);
  const [activeCollectionId, setActiveCollectionId] = useState<string | null>(null);
  const [activeTagId, setActiveTagId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<"all" | "recent" | "favorites" | "videos" | "gifs" | "photos" | "trash">("all");
  const viewTitles = { all: "Все медиа", recent: "Недавно добавленные", favorites: "Избранное", videos: "Видео", gifs: "GIF", photos: "Фото", trash: "Корзина" };

  const loadPage = useCallback(async (nextPage: number, query: string, view: typeof activeView, collectionId: string | null = null, tagId: string | null = null) => {
    const requestId = ++requestVersion.current;
    const params = new URLSearchParams({ page: String(nextPage), q: query, view });
    if (collectionId) params.set("collection", collectionId);
    if (tagId) params.set("tag", tagId);
    const response = await fetch("/api/media?" + params.toString(), { cache: "no-store" });
    if (response.status === 401) return false;
    if (!response.ok) throw new Error("Не удалось загрузить архив.");
    const result = await response.json() as GalleryResponse;
    if (requestId !== requestVersion.current) return true;
    setItems(result.items);
    setPage(result.page);
    setPageInput(String(result.page));
    setHasMore(result.hasMore);
    setTotal(result.total);
    setFavoriteIds(new Set(result.items.filter((item) => item.isFavorite).map((item) => item.id)));
    setStatus("ready");
    return true;
  }, []);

  useEffect(() => {
    let alive = true;
    const initialize = async () => {
      try {
        const loaded = await loadPage(1, "", "all");
        if (loaded || !alive) return;
        const initData = window.Telegram?.WebApp?.initData;
        if (!initData) {
          setStatus("telegram");
          return;
        }
        window.Telegram?.WebApp?.ready?.();
        window.Telegram?.WebApp?.expand?.();
        const auth = await fetch("/api/auth/telegram", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ initData }),
          cache: "no-store",
        });
        if (!auth.ok) throw new Error("Не удалось подтвердить вход через Telegram.");
        await loadPage(1, "", "all");
      } catch (error) {
        if (alive) {
          setMessage(error instanceof Error ? error.message : "Ошибка подключения.");
          setStatus("error");
        }
      }
    };
    void initialize();
    return () => { alive = false; };
  }, [loadPage]);

  useEffect(() => {
    if (status !== "ready") return;
    const timer = window.setTimeout(() => {
      void loadPage(1, search, activeView, activeCollectionId, activeTagId).catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : "Ошибка поиска.");
        setStatus("error");
      });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [search, status, loadPage, activeView, activeCollectionId, activeTagId]);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    fetch(`/api/media/${active.id}/file?role=original`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Не удалось открыть оригинал.");
        return response.json() as Promise<ViewerFile>;
      })
      .then((file) => { if (alive) setViewerFile(file); })
      .catch((error: unknown) => { if (alive) setMessage(error instanceof Error ? error.message : "Ошибка просмотра."); })
      .finally(() => { if (alive) setViewerLoading(false); });
    return () => { alive = false; };
  }, [active]);

  const title = useMemo(() => active?.display_name || active?.filename || "", [active]);
  const currentTitle = activeCollectionId ? (collections.find((item) => item.id === activeCollectionId)?.name ?? "Коллекция") : activeTagId ? ("#" + (tags.find((item) => item.id === activeTagId)?.name ?? "Тег")) : viewTitles[activeView];

  async function changePage(nextPage: number) {
    const maxPage = Math.max(1, Math.ceil((total ?? 0) / 10));
    const safePage = Math.max(1, Math.min(maxPage, Math.trunc(nextPage) || 1));
    try {
      await loadPage(safePage, search, activeView, activeCollectionId, activeTagId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Ошибка загрузки страницы.");
    }
  }

  useEffect(() => {
    if (status !== "ready") return;
    let alive = true;
    fetch("/api/collections", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Не удалось загрузить коллекции.");
        return response.json() as Promise<{ items: CollectionItem[] }>;
      })
      .then((result) => { if (alive) setCollections(result.items); })
      .catch(() => { if (alive) setMessage("Не удалось загрузить коллекции."); });
    return () => { alive = false; };
  }, [status]);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    fetch("/api/media/" + active.id + "/collections", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Не удалось загрузить коллекции файла.");
        return response.json() as Promise<{ items: Array<{ collection_id: string }> }>;
      })
      .then((result) => { if (alive) setMediaCollectionIds(result.items.map((item) => item.collection_id)); })
      .catch(() => { if (alive) setMessage("Не удалось загрузить коллекции файла."); });
    return () => { alive = false; };
  }, [active]);

  async function createCollection() {
    const name = window.prompt("Название новой коллекции:");
    if (!name?.trim()) return;
    const response = await fetch("/api/collections", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name.trim() }),
    });
    const result = await response.json() as { item?: CollectionItem; error?: string };
    if (!response.ok || !result.item) { setMessage(result.error ?? "Не удалось создать коллекцию."); return; }
    setCollections((current) => [...current, result.item!].sort((a, b) => a.name.localeCompare(b.name, "ru")));
  }

  async function saveMediaCollections() {
    if (!active) return;
    setCollectionsSaving(true);
    try {
      const response = await fetch("/api/media/" + active.id + "/collections", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ collectionIds: mediaCollectionIds }),
      });
      if (!response.ok) throw new Error("Не удалось сохранить коллекции.");
      setMessage("Коллекции обновлены.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Ошибка сохранения коллекций.");
    } finally {
      setCollectionsSaving(false);
    }
  }

  useEffect(() => {
    if (status !== "ready") return;
    let alive = true;
    fetch("/api/tags", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Не удалось загрузить теги.");
        return response.json() as Promise<{ items: TagItem[] }>;
      })
      .then((result) => { if (alive) setTags(result.items); })
      .catch(() => { if (alive) setMessage("Не удалось загрузить теги."); });
    return () => { alive = false; };
  }, [status]);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    fetch("/api/media/" + active.id + "/tags", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Не удалось загрузить теги файла.");
        return response.json() as Promise<{ items: Array<{ tag_id: string }> }>;
      })
      .then((result) => { if (alive) setMediaTagIds(result.items.map((item) => item.tag_id)); })
      .catch(() => { if (alive) setMessage("Не удалось загрузить теги файла."); });
    return () => { alive = false; };
  }, [active]);

  async function createTag() {
    if (!tagName.trim()) return;
    const response = await fetch("/api/tags", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: tagName.trim() }),
    });
    const result = await response.json() as { item?: TagItem; error?: string };
    if (!response.ok || !result.item) { setMessage(result.error ?? "Не удалось создать тег."); return; }
    setTags((current) => [...current, result.item!].sort((a, b) => a.name.localeCompare(b.name, "ru")));
    setMediaTagIds((current) => current.includes(result.item!.id) ? current : [...current, result.item!.id]);
    setTagName("");
  }

  async function saveMediaTags() {
    if (!active) return;
    setTagsSaving(true);
    try {
      const response = await fetch("/api/media/" + active.id + "/tags", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ tagIds: mediaTagIds }),
      });
      if (!response.ok) throw new Error("Не удалось сохранить теги.");
      setMessage("Теги обновлены.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Ошибка сохранения тегов.");
    } finally {
      setTagsSaving(false);
    }
  }

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActive(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active]);

  async function selectView(view: typeof activeView) {
    setActiveCollectionId(null);
    setActiveTagId(null);
    setActiveView(view);
    setSearch("");
    setActive(null);
    try { await loadPage(1, "", view); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Ошибка загрузки раздела."); }
  }

  async function selectCollection(id: string) {
    setActiveCollectionId(id);
    setActiveTagId(null);
    setActiveView("all");
    setSearch("");
    setActive(null);
    try { await loadPage(1, "", "all", id, null); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Ошибка загрузки коллекции."); }
  }

  async function selectTag(id: string) {
    setActiveTagId(id);
    setActiveCollectionId(null);
    setActiveView("all");
    setSearch("");
    setActive(null);
    try { await loadPage(1, "", "all", null, id); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Ошибка загрузки тега."); }
  }

  function startEditing() {
    if (!active) return;
    setEditName(active.display_name ?? "");
    setEditDescription(active.description ?? "");
    setEditDate(active.original_created_at ? active.original_created_at.slice(0, 10) : "");
    setEditing(true);
  }

  async function saveMetadata() {
    if (!active) return;
    setMetadataSaving(true);
    try {
      const response = await fetch("/api/media/" + active.id, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          display_name: editName.trim() || null,
          description: editDescription.trim() || null,
          original_created_at: editDate ? new Date(editDate + "T12:00:00").toISOString() : null,
        }),
      });
      const result = await response.json() as { item?: { display_name: string | null; description: string | null; original_created_at: string | null }; error?: string };
      if (!response.ok || !result.item) throw new Error(result.error ?? "Не удалось сохранить изменения.");
      const updated = { ...active, ...result.item };
      setActive(updated);
      setItems((current) => current.map((item) => item.id === active.id ? updated : item));
      setEditing(false);
      setMessage("Изменения сохранены.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Ошибка сохранения.");
    } finally {
      setMetadataSaving(false);
    }
  }

  async function toggleFavorite(item: MediaItem) {
    const already = favoriteIds.has(item.id);
    const response = await fetch(`/api/media/${item.id}/favorite`, { method: already ? "DELETE" : "POST" });
    if (!response.ok) {
      setMessage("Не удалось обновить избранное.");
      return;
    }
    setFavoriteIds((current) => {
      const next = new Set(current);
      if (already) next.delete(item.id); else next.add(item.id);
      return next;
    });
  }

  async function moveToTrash(item: MediaItem) {
    const response = await fetch(`/api/media/${item.id}`, { method: "DELETE" });
    if (!response.ok) {
      setMessage("Не удалось переместить файл в корзину.");
      return;
    }
    setItems((current) => current.filter((entry) => entry.id !== item.id));
    setActive(null);
  }

  async function permanentlyDelete(item: MediaItem) {
    const confirmed = window.confirm("Удалить оригинал и обложки без возможности восстановления из корзины? Резервные копии, если они есть, сохранятся.");
    if (!confirmed) return;
    const response = await fetch(`/api/media/${item.id}/purge`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }),
    });
    if (!response.ok) { setMessage("Не удалось завершить удаление. Можно повторить попытку."); return; }
    setItems((current) => current.filter((entry) => entry.id !== item.id));
    setActive(null);
  }

  async function restoreItem(item: MediaItem) {
    const response = await fetch(`/api/media/${item.id}/restore`, { method: "POST" });
    if (!response.ok) { setMessage("Не удалось восстановить файл."); return; }
    setItems((current) => current.filter((entry) => entry.id !== item.id));
    setActive(null);
  }

  async function openItem(item: MediaItem) {
    setEditing(false);
    setMediaCollectionIds([]);
    setMediaTagIds([]);
    setViewerFile(null);
    setViewerLoading(true);
    setActive(item);
    setMessage("");
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setItems([]);
    setStatus("telegram");
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <Link className="brand" href="/" aria-label="ARC home"><span className="brand-mark">A</span><span>ARC</span></Link>
        <div className="primary-action" title="Добавление доступно через Telegram-бота"><span>＋</span> Добавить через Telegram</div>
        <div className="nav-caption">БИБЛИОТЕКА</div>
        <nav className="navigation" aria-label="Разделы архива">
          <button className={activeView === "all" ? "nav-item active" : "nav-item"} type="button" onClick={() => void selectView("all")}><span className="nav-icon">▦</span><span>Все медиа</span></button>
          <button className={activeView === "recent" ? "nav-item active" : "nav-item"} type="button" onClick={() => void selectView("recent")}><span className="nav-icon">◷</span><span>Недавно добавленные</span></button>
          <button className={activeView === "favorites" ? "nav-item active" : "nav-item"} type="button" onClick={() => void selectView("favorites")}><span className="nav-icon">♡</span><span>Избранное</span></button>
          <button className={activeView === "videos" ? "nav-item active" : "nav-item"} type="button" onClick={() => void selectView("videos")}><span className="nav-icon">▷</span><span>Видео</span></button>
          <button className={activeView === "gifs" ? "nav-item active" : "nav-item"} type="button" onClick={() => void selectView("gifs")}><span className="nav-icon">GIF</span><span>GIF</span></button>
          <button className={activeView === "photos" ? "nav-item active" : "nav-item"} type="button" onClick={() => void selectView("photos")}><span className="nav-icon">▧</span><span>Фото</span></button>
          <button className={activeView === "trash" ? "nav-item active" : "nav-item"} type="button" onClick={() => void selectView("trash")}><span className="nav-icon">⌫</span><span>Корзина</span></button>
        </nav>
        {collections.some((item) => !item.is_system) && <div className="custom-collections"><div className="nav-caption">МОИ КОЛЛЕКЦИИ</div>{collections.filter((item) => !item.is_system).map((item) => <div className="custom-collection-row" key={item.id}><button className="custom-collection-select" type="button" onClick={() => void selectCollection(item.id)}>{item.name}</button><button type="button" aria-label={"Удалить коллекцию " + item.name} onClick={async () => { if (!window.confirm("Удалить коллекцию «" + item.name + "»? Медиа останутся в архиве.")) return; const response = await fetch("/api/collections?id=" + item.id, { method: "DELETE" }); if (response.ok) setCollections((current) => current.filter((entry) => entry.id !== item.id)); else setMessage("Не удалось удалить коллекцию."); }}>×</button></div>)}</div>}
        {tags.length > 0 && <div className="custom-collections"><div className="nav-caption">ТЕГИ</div>{tags.map((tag) => <div className="custom-collection-row" key={tag.id}><button className="custom-collection-select" type="button" onClick={() => void selectTag(tag.id)}>#{tag.name}</button></div>)}</div>}
        <button className="create-collection" type="button" onClick={() => void createCollection()}>＋ Новая коллекция</button>
        <div className="sidebar-bottom"><span className="status-dot" /><span>ARC 1.0 · приватный архив</span></div>
        <Link className="admin-link" href="/admin">Мониторинг системы ↗</Link>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="breadcrumbs">Библиотека <span>/</span> {currentTitle}</div>
          <div className="topbar-actions">
            <label className="search"><span>⌕</span><input aria-label="Поиск по архиву" placeholder="Поиск по названию…" value={search} onChange={(event) => setSearch(event.target.value)} /><kbd>⌘ K</kbd></label>
            <button className="avatar" type="button" aria-label="Выйти" onClick={logout}>A</button>
          </div>
        </header>

        <div className="content">
          <div className="page-heading">
            <div><div className="eyebrow">ЛИЧНЫЙ АРХИВ</div><h1>{currentTitle}</h1><p>Фото, видео и GIF в одном приватном пространстве.</p></div>
            <div className="heading-meta">Сначала новые <span>⌄</span></div>
          </div>

          {status === "loading" && <div className="state-panel"><span className="loader" /><h2>Подключение к архиву</h2><p>Проверяем защищённую сессию.</p></div>}
          {status === "telegram" && <div className="state-panel"><div className="state-icon">↗</div><h2>Войдите через Telegram</h2><p>Откройте ARC из личного Telegram-бота. Вход доступен только владельцу архива.</p><div className="empty-note"><span className="status-dot" /> Сессия сохраняется до выхода или отзыва доступа</div></div>}
          {status === "error" && <div className="state-panel"><div className="state-icon">!</div><h2>Не удалось подключиться</h2><p>{message}</p><button className="secondary-button" onClick={() => window.location.reload()}>Повторить</button></div>}
          {status === "ready" && items.length === 0 && <div className="state-panel"><div className="empty-art"><div className="art-card art-one">▧</div><div className="art-card art-two">▷</div><div className="art-card art-three">GIF</div></div><h2>{search ? "Ничего не найдено" : activeView === "trash" ? "Корзина пуста" : activeView === "favorites" ? "Избранное пока пусто" : "Архив пока пуст"}</h2><p>{search ? "Измените поисковый запрос." : activeView === "trash" ? "Удалённые файлы будут храниться здесь до окончательного удаления." : activeView === "favorites" ? "Отмечайте файлы сердечком, чтобы собрать их здесь." : "Отправляйте фото, видео и GIF своему Telegram-боту. После сохранения они появятся здесь."}</p></div>}
          {status === "ready" && items.length > 0 && <div className="masonry" aria-label="Медиаархив">
            {items.map((item) => <article className="media-card" key={item.id}>
              <button className="media-open" type="button" onClick={() => void openItem(item)} aria-label={`Открыть ${item.filename}`}>
                {item.coverUrl ? <Image src={item.coverUrl} alt={item.display_name || item.filename} width={item.width ?? 800} height={item.height ?? 600} unoptimized style={{ width: "100%", height: "auto" }} /> : <div className="media-placeholder">{item.media_type === "video" ? "▷" : item.media_type === "gif" ? "GIF" : "▧"}</div>}
                {item.media_type === "video" && <span className="media-type-pill">VIDEO</span>}
                {item.media_type === "gif" && <span className="media-type-pill">GIF</span>}
              </button>
              <div className="media-meta"><div><strong>{item.display_name || item.filename}</strong><small>{formatDate(item.uploaded_at)} · {formatSize(item.size_bytes)}</small></div><button className={favoriteIds.has(item.id) ? "mini-action selected" : "mini-action"} type="button" aria-label="В избранное" onClick={() => void toggleFavorite(item)}>♡</button></div>
            </article>)}
          </div>}
          {status === "ready" && items.length > 0 && <div className="pagination"><button className="secondary-button" disabled={page <= 1} onClick={() => void changePage(page - 1)}>Назад</button><label className="page-jump">Страница <input aria-label="Номер страницы" inputMode="numeric" type="number" min="1" max={Math.max(1, Math.ceil((total ?? 0) / 10))} value={pageInput} onChange={(event) => setPageInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void changePage(Number(pageInput)); }} onBlur={() => setPageInput(String(page))} /><span>{total !== null ? `из ${Math.max(1, Math.ceil(total / 10))} · ${total} файлов` : ""}</span></label><button className="secondary-button" disabled={!hasMore} onClick={() => void changePage(page + 1)}>Дальше</button><button className="secondary-button" onClick={() => void changePage(Number(pageInput))}>Перейти</button></div>}
          <footer className="footer-note">Приватный архив · Доступ только владельцу</footer>
        </div>
      </section>

      {active && <div className="viewer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setActive(null); }}>
        <section className="viewer" role="dialog" aria-modal="true" aria-label="Просмотр медиа">
          <header className="viewer-header"><div><strong>{title}</strong><small>{formatSize(active.size_bytes)} · {formatDate(active.uploaded_at)}</small></div><button className="viewer-close" type="button" onClick={() => setActive(null)} aria-label="Закрыть">×</button></header>
          <div className="viewer-stage">
            {viewerLoading && <span className="loader" />}
            {!viewerLoading && viewerFile && active.media_type === "video" && <video src={viewerFile.url} controls playsInline preload="metadata" />}
            {!viewerLoading && viewerFile && active.media_type !== "video" && <Image src={viewerFile.url} alt={title} width={1600} height={1200} unoptimized style={{ width: "auto", height: "auto", maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />}
            {!viewerLoading && !viewerFile && <p>Не удалось загрузить оригинал.</p>}
          </div>
          {editing && <div className="viewer-edit"><label>Название<input value={editName} maxLength={240} onChange={(event) => setEditName(event.target.value)} placeholder={active.filename} /></label><label>Описание<textarea value={editDescription} maxLength={10000} onChange={(event) => setEditDescription(event.target.value)} placeholder="Описание файла" /></label><label>Дата создания<input type="date" value={editDate} onChange={(event) => setEditDate(event.target.value)} /></label><div><button className="secondary-button" type="button" disabled={metadataSaving} onClick={() => void saveMetadata()}>{metadataSaving ? "Сохранение…" : "Сохранить изменения"}</button><button className="secondary-button" type="button" onClick={() => setEditing(false)}>Отмена</button></div></div>}
          <div className="viewer-tags"><strong>Теги</strong><div className="tag-list">{tags.map((tag) => <label key={tag.id} className="tag-check"><input type="checkbox" checked={mediaTagIds.includes(tag.id)} onChange={(event) => setMediaTagIds((current) => event.target.checked ? [...current, tag.id] : current.filter((id) => id !== tag.id))} /><span>{tag.name}</span></label>)}</div><div className="tag-create"><input aria-label="Новый тег" value={tagName} maxLength={40} onChange={(event) => setTagName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void createTag(); }} placeholder="Создать тег…" /><button className="secondary-button" type="button" onClick={() => void createTag()}>Добавить</button><button className="secondary-button" type="button" disabled={tagsSaving} onClick={() => void saveMediaTags()}>{tagsSaving ? "Сохранение…" : "Сохранить теги"}</button></div></div>
          <div className="viewer-collections"><strong>Коллекции</strong>{collections.length === 0 && <span className="collection-empty">Коллекций пока нет</span>}{collections.map((collection) => <label key={collection.id} className="collection-check"><input type="checkbox" checked={mediaCollectionIds.includes(collection.id)} onChange={(event) => setMediaCollectionIds((current) => event.target.checked ? [...current, collection.id] : current.filter((id) => id !== collection.id))} /><span>{collection.name}</span></label>)}<button className="secondary-button" type="button" disabled={collectionsSaving} onClick={() => void saveMediaCollections()}>{collectionsSaving ? "Сохранение…" : "Сохранить коллекции"}</button></div>
          <footer className="viewer-footer"><button className="secondary-button" type="button" onClick={() => editing ? setEditing(false) : startEditing()}>{editing ? "Закрыть редактирование" : "Изменить сведения"}</button><a className="secondary-button" href={viewerFile?.url ?? "#"} download={active.filename} aria-disabled={!viewerFile}>Скачать оригинал</a><button className="secondary-button" type="button" onClick={() => void toggleFavorite(active)}>{favoriteIds.has(active.id) ? "Убрать из избранного" : "В избранное"}</button>{activeView === "trash" ? <><button className="secondary-button" type="button" onClick={() => void restoreItem(active)}>Восстановить</button><button className="danger-button" type="button" onClick={() => void permanentlyDelete(active)}>Удалить навсегда</button></> : <button className="danger-button" type="button" onClick={() => void moveToTrash(active)}>В корзину</button>}</footer>
        </section>
      </div>}
      {message && status !== "error" && <div className="toast" role="status">{message}<button type="button" onClick={() => setMessage("")}>×</button></div>}
    </main>
  );
}

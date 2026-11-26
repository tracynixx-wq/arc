"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Overview = {
  archive: {
    media?: { active?: number; trash?: number; bytes?: number; photos?: number; videos?: number; gifs?: number };
    processing_queue?: Record<string, number>;
    telegram_queue?: Record<string, number>;
    exports?: Record<string, number>;
    backups?: Record<string, number>;
    storage_objects?: Record<string, number>;
  };
  runtime: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number; uptimeSeconds: number; sampledAt: string };
};

function bytes(value: number | undefined) {
  if (typeof value !== "number") return "—";
  if (value < 1024) return `${value} Б`;
  const units = ["КБ", "МБ", "ГБ", "ТБ"];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(1)} ${units[unit]}`;
}

function QueueTable({ title, values }: { title: string; values?: Record<string, number> }) {
  const entries = Object.entries(values ?? {});
  return <section className="admin-card"><h2>{title}</h2>{entries.length ? entries.map(([name, count]) => <div className="admin-row" key={name}><span>{name}</span><strong>{count}</strong></div>) : <p className="admin-muted">Очередь пуста</p>}</section>;
}

export default function AdminPanel() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const response = await fetch("/api/admin/overview", { cache: "no-store" });
        if (response.status === 401) throw new Error("Сначала войдите через Telegram.");
        if (!response.ok) throw new Error("Не удалось получить метрики.");
        const result = await response.json() as Overview;
        if (alive) { setData(result); setError(""); }
      } catch (reason) {
        if (alive) setError(reason instanceof Error ? reason.message : "Ошибка мониторинга.");
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 30_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  const media = data?.archive.media;
  return <main className="admin-shell">
    <header className="admin-header"><Link href="/" className="admin-brand">ARC <span>/ Мониторинг</span></Link><Link href="/" className="admin-back">← В архив</Link></header>
    <div className="admin-content">
      <div className="eyebrow">СИСТЕМНЫЙ КОНТРОЛЬ</div>
      <h1>Мониторинг</h1>
      <p className="admin-subtitle">Очереди, архив и ресурсы текущего экземпляра приложения.</p>
      {loading && <p className="admin-muted">Загрузка метрик…</p>}
      {error && <div className="admin-error">{error}</div>}
      {data && <>
        <div className="admin-grid">
          <div className="admin-card"><span>Активные медиа</span><strong>{media?.active ?? 0}</strong></div>
          <div className="admin-card"><span>Корзина</span><strong>{media?.trash ?? 0}</strong></div>
          <div className="admin-card"><span>Объём архива</span><strong>{bytes(media?.bytes)}</strong></div>
          <div className="admin-card"><span>Память процесса (RSS)</span><strong>{bytes(data.runtime.rssBytes)}</strong></div>
          <div className="admin-card"><span>Heap used</span><strong>{bytes(data.runtime.heapUsedBytes)}</strong></div>
          <div className="admin-card"><span>Uptime</span><strong>{Math.floor(data.runtime.uptimeSeconds / 3600)} ч</strong></div>
        </div>
        <div className="admin-queues">
          <QueueTable title="Обработка медиа" values={data.archive.processing_queue} />
          <QueueTable title="Telegram" values={data.archive.telegram_queue} />
          <QueueTable title="Экспорт ZIP" values={data.archive.exports} />
          <QueueTable title="Резервные копии" values={data.archive.backups} />
        </div>
        <section className="admin-card admin-storage"><h2>Хранилища по учёту файлов</h2>{Object.entries(data.archive.storage_objects ?? {}).map(([bucket, size]) => <div className="admin-row" key={bucket}><span>{bucket}</span><strong>{bytes(size)}</strong></div>)}</section>
        <p className="admin-muted admin-sampled">Обновлено: {new Date(data.runtime.sampledAt).toLocaleString("ru")}. Память и uptime относятся только к текущему экземпляру веб-приложения.</p>
      </>}
    </div>
  </main>;
}

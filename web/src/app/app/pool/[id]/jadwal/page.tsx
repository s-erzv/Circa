'use client';

import { use, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { initTelegramView, isInsideTelegram } from '@/lib/telegram-client';

type ScheduleEntry = { position: number; label: string; approxDateMs: number };
type Schedule = {
  name: string;
  currentCycle: number;
  closed: boolean;
  schedule: ScheduleEntry[];
};

const fmt = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * Live "siapa dapet bulan ini, siapa bulan depan" view — reads the queue
 * fresh from the contract on every load rather than replaying the one-time
 * activation announcement, so it stays accurate after a skip/kick/exit
 * reorders things.
 */
export default function PoolJadwalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<Schedule | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    initTelegramView();
    if (!isInsideTelegram()) {
      setError('Buka lewat Telegram ya.');
      return;
    }
    apiFetch<Schedule>(`/api/pools/${id}/schedule`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [id]);

  return (
    <main className="flex min-h-dvh flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Jadwal: {data?.name ?? 'Arisan'}</h1>

      {error && (
        <div className="rounded-xl border border-red-300/40 bg-red-500/10 p-4 text-sm">
          {error}
        </div>
      )}

      {!data && !error && <p className="text-sm opacity-60">Sebentar…</p>}

      {data && (
        <>
          <p className="text-xs opacity-60">
            ⚠️ Proyeksi, bukan janji pasti — bisa geser kalau ada yang di-skip, keluar,
            atau dikeluarkan lewat voting. Siklus berjalan sekarang: {data.currentCycle + 1}.
          </p>
          <ul className="flex flex-col gap-2">
            {data.schedule.map((entry) => (
              <li
                key={entry.position}
                className={`rounded-xl border p-3 text-sm ${
                  entry.position === data.currentCycle + 1
                    ? 'border-foreground'
                    : 'border-black/10 dark:border-white/15'
                }`}
              >
                <span className="font-medium">
                  Siklus {entry.position}: {entry.label}
                </span>
                <span className="ml-2 opacity-60">sekitar {fmt.format(entry.approxDateMs)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

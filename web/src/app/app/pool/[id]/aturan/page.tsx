'use client';

import { use, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { initTelegramView, isInsideTelegram } from '@/lib/telegram-client';

type Phase = 'loading' | 'ready' | 'error';

/**
 * The rules page — meant to be readable anytime, not just at the moment
 * they were announced (draft confirmation, join DM, /aturan in the group).
 * Content comes from formatArisanRules() server-side, the same formatter
 * every other rules-announcing message already uses, so this page can
 * never say something different from what got announced elsewhere.
 */
export default function AturanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [phase, setPhase] = useState<Phase>('loading');
  const [rules, setRules] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    initTelegramView();
    if (!isInsideTelegram()) {
      setError('Buka lewat Telegram ya.');
      setPhase('error');
      return;
    }
    load();
  }, []);

  async function load() {
    try {
      const res = await apiFetch<{ rules: string }>(`/api/pools/${id}/aturan`);
      setRules(res.rules);
      setPhase('ready');
    } catch (e) {
      setError((e as Error).message);
      setPhase('error');
    }
  }

  return (
    <main className="flex min-h-dvh flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Aturan Main</h1>

      {error && (
        <div className="rounded-xl border border-red-300/40 bg-red-500/10 p-4 text-sm">
          {error}
        </div>
      )}

      {phase === 'loading' && <p className="text-sm opacity-60">Sebentar…</p>}

      {phase === 'ready' && (
        <div className="whitespace-pre-wrap rounded-xl border border-black/10 p-4 text-sm leading-relaxed dark:border-white/15">
          {rules}
        </div>
      )}
    </main>
  );
}

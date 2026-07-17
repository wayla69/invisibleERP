'use client';

// W3 (docs/27) — public NPS answer page. The URL carries only the single-use random token (no PII,
// CWE-598); the page shows the 0–10 question and posts the answer once.
import { use, useEffect, useState } from 'react';
import { useLang } from '@/lib/i18n';
import { currentLang } from '@/lib/i18n-static';

const API = process.env.NEXT_PUBLIC_API_URL ?? '';

export default function NpsPage({ params }: { params: Promise<{ token: string }> }) {
  const { t } = useLang();
  const { token } = use(params);
  const [state, setState] = useState<'loading' | 'ready' | 'answered' | 'expired' | 'missing' | 'done'>('loading');
  const [question, setQuestion] = useState('');
  const [score, setScore] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    fetch(`${API}/api/nps/${encodeURIComponent(token)}`)
      .then(async (r) => {
        if (!r.ok) { setState('missing'); return; }
        const j = await r.json();
        setQuestion(j.question);
        setState(j.answered ? 'answered' : j.expired ? 'expired' : 'ready');
      })
      .catch(() => setState('missing'));
  }, [token]);

  const submit = async () => {
    if (score == null) return;
    setErr('');
    const r = await fetch(`${API}/api/nps/${encodeURIComponent(token)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ score, comment: comment || undefined }),
    });
    if (r.ok) setState('done');
    else {
      const j = await r.json().catch(() => ({}));
      const localized = currentLang() === 'th' ? j?.error?.messageTh ?? j?.error?.message : j?.error?.message ?? j?.error?.messageTh;
      setErr(localized ?? t('pub.nps.failed'));
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-6 text-center">
      {state === 'loading' && <p>{t('pub.nps.loading')}</p>}
      {state === 'missing' && <p>{t('pub.nps.missing')}</p>}
      {state === 'expired' && <p>{t('pub.nps.expired')}</p>}
      {state === 'answered' && <p>{t('pub.nps.answered')}</p>}
      {state === 'done' && <p className="text-lg">{t('pub.nps.done')}</p>}
      {state === 'ready' && (
        <>
          <h1 className="text-lg font-semibold">{question}</h1>
          <div className="grid grid-cols-11 gap-1">
            {Array.from({ length: 11 }, (_, i) => (
              <button key={i} onClick={() => setScore(i)}
                className={`rounded border py-2 text-sm ${score === i ? 'bg-black font-semibold text-white' : 'bg-white'}`}>
                {i}
              </button>
            ))}
          </div>
          <div className="flex justify-between text-xs text-gray-500"><span>{t('pub.nps.detractor')}</span><span>{t('pub.nps.promoter')}</span></div>
          <textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t('pub.nps.comment_ph')}
            className="min-h-20 rounded border p-2 text-sm" maxLength={500} />
          <button onClick={submit} disabled={score == null}
            className="rounded bg-black px-4 py-2 text-white disabled:opacity-40">{t('pub.nps.submit')}</button>
          {err && <p className="text-sm text-red-600">{err}</p>}
        </>
      )}
    </main>
  );
}

import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/session';
import { formatArisanRules, getPool } from '@/lib/pools';

/**
 * Read-only, same visibility as the rest of pool info: anyone who knows the
 * id may read it (mirrors "Pools are viewable by everyone"). Rules aren't
 * sensitive — the whole point is that everyone in the arisan can check them
 * whenever, not just whoever was paying attention when they were announced.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireUser(request);
  } catch {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const pool = await getPool(id);
  if (!pool) {
    return NextResponse.json({ error: 'Arisan tidak ditemukan.' }, { status: 404 });
  }

  return NextResponse.json({ rules: formatArisanRules(pool) });
}

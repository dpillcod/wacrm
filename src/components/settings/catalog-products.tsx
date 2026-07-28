'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { RefreshCw, ShoppingBag } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';
import type { CatalogProduct } from '@/types';

export function CatalogProducts() {
  const t = useTranslations('Settings.catalog');
  const supabase = createClient();
  const { accountId } = useAuth();

  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [hasCatalogId, setHasCatalogId] = useState(false);
  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchProducts = useCallback(
    async (acctId: string) => {
      setLoading(true);
      try {
        const [{ data: config }, { data: rows, error }] = await Promise.all([
          supabase
            .from('whatsapp_config')
            .select('catalog_id')
            .eq('account_id', acctId)
            .maybeSingle(),
          supabase
            .from('catalog_products')
            .select('*')
            .eq('account_id', acctId)
            .order('name', { ascending: true }),
        ]);
        setHasCatalogId(Boolean(config?.catalog_id));
        if (error) {
          console.error('Failed to load catalog products:', error);
        }
        setProducts(rows ?? []);
      } finally {
        setLoading(false);
      }
    },
    [supabase],
  );

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchProducts(accountId);
  }, [accountId, fetchProducts]);

  async function handleSync() {
    if (!accountId) return;
    setSyncing(true);
    try {
      const res = await fetch('/api/whatsapp/catalog/sync', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || `Sync failed (HTTP ${res.status})`);
      }
      toast.success(
        t('toastSyncCount', { total: data.total }) +
          (data.inserted || data.updated
            ? t('toastSyncDetails', { inserted: data.inserted, updated: data.updated })
            : ''),
      );
      if (Array.isArray(data.errors) && data.errors.length > 0) {
        const preview = data.errors
          .slice(0, 3)
          .map((e: { retailer_id: string }) => e.retailer_id)
          .join(', ');
        toast.error(t('toastSyncFailed', { preview }));
      }
      if (data.truncated) {
        toast.error(t('toastSyncTruncated'), { duration: 10000 });
      }
      await fetchProducts(accountId);
    } catch (err) {
      console.error('Catalog sync error:', err);
      toast.error(err instanceof Error ? err.message : t('toastSyncError'));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <section className="animate-in fade-in-50 space-y-4 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          <Button
            variant="outline"
            onClick={handleSync}
            disabled={syncing || loading || !hasCatalogId}
            title={t('syncTitle')}
          >
            <RefreshCw className={`size-4 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? t('syncing') : t('syncFromMeta')}
          </Button>
        }
      />

      {!loading && !hasCatalogId ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <ShoppingBag className="size-8 text-muted-foreground mb-2" />
            <p className="text-muted-foreground text-sm">{t('noCatalog')}</p>
            <p className="text-muted-foreground text-xs mt-1">{t('noCatalogHint')}</p>
          </CardContent>
        </Card>
      ) : !loading && products.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-muted-foreground text-sm">{t('noProducts')}</p>
            <p className="text-muted-foreground text-xs mt-1">{t('noProductsHint')}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {products.map((p) => (
            <Card key={p.id} className={p.is_stale ? 'opacity-60' : undefined}>
              <CardContent className="flex items-start gap-3 p-4">
                {p.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={p.image_url}
                    alt={p.name}
                    className="size-14 shrink-0 rounded-md border border-border object-cover"
                  />
                ) : (
                  <div className="flex size-14 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
                    <ShoppingBag className="size-5 text-muted-foreground" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {p.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {p.price != null
                      ? `${p.price}${p.currency ? ` ${p.currency}` : ''}`
                      : p.retailer_id}
                  </p>
                  {p.is_stale && (
                    <Badge variant="outline" className="mt-1 text-[10px]">
                      {t('stale')}
                    </Badge>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

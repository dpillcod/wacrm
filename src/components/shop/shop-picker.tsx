"use client";

// The customer's product picker (/pedir/<token>): search, sections,
// filters, photo + price, a round "+" that turns into "− 2 +", and a
// dark pill "Ver pedido (n) · $total". "Enviar" puts the list in the
// customer's WhatsApp chat (prices are taken again on the server).
// Built for everyone: big touch targets, plain words, list view first.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ShopFacets, ShopItem, ShopSort } from "@/lib/catalog/shop-search";
import styles from "./shop-picker.module.css";

const SORTS: { key: ShopSort; label: string }[] = [
  { key: "pop", label: "Más vendidos" },
  { key: "low", label: "Menor precio" },
  { key: "high", label: "Mayor precio" },
  { key: "az", label: "A-Z" },
];
const MAX_QTY = 999;
const SALE = "__sale__";

type CartLine = { qty: number; title: string; price: number; thumb: string | null };
export type Cart = Record<string, CartLine>;
/** A product the customer ordered before, with the quantity they last asked for. */
export type UsualItem = ShopItem & { lastQty: number };
type Page = { items: ShopItem[]; total: number; facets?: ShopFacets | null };
type Filters = { q: string; dep: string | null; cat: string | null; sort: ShopSort; sale: boolean };

/** The cart as the server stores it (compared to skip saving what didn't change). */
function cartKey(cart: Cart, note: string): string {
  return JSON.stringify({ items: Object.entries(cart).map(([sku, l]) => ({ sku, qty: l.qty })), note });
}

function money(n: number): string {
  return `$${n.toFixed(2).replace(".", ",")}`;
}

function unitPrice(p: { price: number; salePrice: number | null }): number {
  return p.salePrice !== null && p.salePrice < p.price ? p.salePrice : p.price;
}

/** A readable product name: the shop's are POS-style capitals. */
function niceTitle(t: string): string {
  const lower = t.toLocaleLowerCase("es");
  return lower.charAt(0).toLocaleUpperCase("es") + lower.slice(1);
}

function queryString(f: Filters, page: number): string {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.dep) p.set("dep", f.dep);
  if (f.cat) p.set("cat", f.cat);
  if (f.sort !== "pop") p.set("sort", f.sort);
  if (f.sale) p.set("sale", "1");
  if (page) p.set("page", String(page));
  return p.toString();
}

function ProductImage({ item, className }: { item: { thumb: string | null; image?: string | null; title: string }; className?: string }) {
  // Keyed by product where it's used, so a new product starts fresh.
  const [src, setSrc] = useState<string | null>(item.thumb ?? item.image ?? null);
  if (!src) {
    return (
      <span className={`${styles.noPhoto} ${className ?? ""}`} aria-hidden="true">
        📦
      </span>
    );
  }
  return (
    // Plain <img>: shop thumbnails are already small; the image
    // optimizer would only add a hop.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={className}
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setSrc(src === item.thumb && item.image && item.image !== src ? item.image : null)}
    />
  );
}

function Qty({
  qty,
  name,
  onChange,
}: {
  qty: number;
  name: string;
  onChange: (delta: number) => void;
}) {
  if (!qty) {
    return (
      <button type="button" className={styles.plus} onClick={() => onChange(1)} aria-label={`Agregar ${name}`}>
        +
      </button>
    );
  }
  return (
    <span className={styles.stepper}>
      <button type="button" onClick={() => onChange(-1)} aria-label={qty === 1 ? `Quitar ${name}` : `Uno menos de ${name}`}>
        {qty === 1 ? <TrashIcon /> : "−"}
      </button>
      <span aria-live="polite">{qty}</span>
      <button type="button" onClick={() => onChange(1)} aria-label={`Uno más de ${name}`} disabled={qty >= MAX_QTY}>
        +
      </button>
    </span>
  );
}

export function ShopPicker({
  token,
  storeName,
  customerName,
  backHref,
  hasOffers,
  initial,
  serverCart,
  usual,
  deliveryNote,
}: {
  token: string;
  storeName: string;
  customerName: string;
  backHref: string;
  /** Any product on offer? Without, the "Ofertas" filter is hidden. */
  hasOffers: boolean;
  initial: { items: ShopItem[]; total: number; facets: ShopFacets };
  /** The cart kept on the server (from an earlier link), used when this phone has none for this link. */
  serverCart: { cart: Cart; note: string };
  /** "Sus productos de siempre", from past orders (empty for a new customer). */
  usual: UsualItem[];
  /** One line about delivery for the cart ('' = none). */
  deliveryNote: string;
}) {
  const storageKey = `pedir:${token.slice(-22)}`;
  const [filters, setFilters] = useState<Filters>({ q: "", dep: null, cat: null, sort: "pop", sale: false });
  const [typed, setTyped] = useState("");
  const [items, setItems] = useState<ShopItem[]>(initial.items);
  const [total, setTotal] = useState(initial.total);
  const [page, setPage] = useState(0);
  const [categories, setCategories] = useState<ShopFacets["categories"]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<null | "expired" | "network">(null);
  const [view, setView] = useState<"list" | "grid">("list");
  const [cart, setCart] = useState<Cart>({});
  const [note, setNote] = useState("");
  const [sheet, setSheet] = useState<null | "cart" | "filters">(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<null | { text: string; back?: boolean }>(null);
  const [done, setDone] = useState<null | { total: number }>(null);
  const [restored, setRestored] = useState(false);
  // What the server has, so only real changes are sent (and re-arm the reminder).
  const synced = useRef<string | null>(null);

  // Pages already fetched (by query), so going back to a section is instant.
  const [cache] = useState(() => new Map<string, Page>([[queryString({ q: "", dep: null, cat: null, sort: "pop", sale: false }, 0), initial]]));
  const reqId = useRef(0);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const departments = initial.facets.departments;

  // Restore the cart / note / view saved on this phone for this link
  // (after hydration: the server can't know them).
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null") as
        | { cart?: Cart; note?: string; view?: "list" | "grid" }
        | null;
      const hasLocal = !!saved?.cart && typeof saved.cart === "object";
      setCart(hasLocal ? saved!.cart! : serverCart.cart);
      setNote(typeof saved?.note === "string" && hasLocal ? saved.note : serverCart.note);
      if (saved?.view === "grid") setView("grid");
    } catch {
      // private mode / blocked storage: the server's cart
      setCart(serverCart.cart);
      setNote(serverCart.note);
    }
    synced.current = cartKey(serverCart.cart, serverCart.note);
    setRestored(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [storageKey, serverCart]);

  useEffect(() => {
    if (!restored) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ cart, note, view }));
    } catch {
      // ignore
    }
  }, [cart, note, view, restored, storageKey]);

  // Keep the cart on the server too (a short pause after the last change):
  // a new link opens with it, and the bot can remind them if they leave.
  useEffect(() => {
    if (!restored || done) return;
    const key = cartKey(cart, note);
    if (key === synced.current) return;
    const t = setTimeout(() => {
      fetch(`/api/pedir/${encodeURIComponent(token)}/cart`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: key,
        keepalive: true,
      })
        .then((res) => {
          if (res.ok) synced.current = key;
        })
        .catch(() => undefined);
    }, 1200);
    return () => clearTimeout(t);
  }, [cart, note, restored, done, token]);

  // Type → search after a short pause.
  useEffect(() => {
    const q = typed.trim().slice(0, 80);
    if (q === filters.q) return;
    const t = setTimeout(() => setFilters((f) => ({ ...f, q })), 250);
    return () => clearTimeout(t);
  }, [typed, filters.q]);

  const fetchPage = useCallback(
    async (f: Filters, p: number): Promise<Page | null> => {
      const qs = queryString(f, p);
      const hit = cache.get(qs);
      if (hit) return hit;
      const res = await fetch(`/api/pedir/${encodeURIComponent(token)}/products?${qs}`);
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as Page;
      if (cache.size > 60) cache.clear();
      cache.set(qs, data);
      return data;
    },
    [token, cache],
  );

  // New filters → first page.
  useEffect(() => {
    const id = ++reqId.current;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- spinner for the request this effect starts
    setLoading(true);
    setLoadError(null);
    fetchPage(filters, 0)
      .then((data) => {
        if (id !== reqId.current || !data) return;
        setItems(data.items);
        setTotal(data.total);
        setPage(0);
        if (data.facets) setCategories(filters.dep ? data.facets.categories : []);
      })
      .catch((err: Error) => {
        if (id !== reqId.current) return;
        setItems([]);
        setTotal(0);
        setLoadError(/^(401|410)$/.test(err.message) ? "expired" : "network");
      })
      .finally(() => id === reqId.current && setLoading(false));
  }, [filters, fetchPage]);

  const hasMore = items.length < total;
  const loadMore = useCallback(() => {
    if (loading || !hasMore) return;
    const id = ++reqId.current;
    setLoading(true);
    fetchPage(filters, page + 1)
      .then((data) => {
        if (id !== reqId.current || !data) return;
        setItems((prev) => {
          const seen = new Set(prev.map((i) => i.sku));
          return [...prev, ...data.items.filter((i) => !seen.has(i.sku))];
        });
        setTotal(data.total);
        setPage((n) => n + 1);
      })
      .catch((err: Error) => id === reqId.current && setLoadError(/^(401|410)$/.test(err.message) ? "expired" : "network"))
      .finally(() => id === reqId.current && setLoading(false));
  }, [loading, hasMore, fetchPage, filters, page]);

  // Scrolling near the end loads more.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && loadMore(), { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  // No page scroll behind an open sheet.
  useEffect(() => {
    if (!sheet) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSheet(null);
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [sheet]);

  const changeQty = useCallback((item: { sku: string; title: string; price: number; salePrice: number | null; thumb: string | null }, delta: number) => {
    setSendError(null);
    setCart((c) => {
      const qty = Math.min(MAX_QTY, (c[item.sku]?.qty ?? 0) + delta);
      const next = { ...c };
      if (qty <= 0) delete next[item.sku];
      else next[item.sku] = { qty, title: item.title, price: unitPrice(item), thumb: item.thumb };
      return next;
    });
  }, []);

  const cartLines = useMemo(() => Object.entries(cart), [cart]);
  const units = cartLines.reduce((a, [, l]) => a + l.qty, 0);
  const cartTotal = cartLines.reduce((a, [, l]) => a + l.qty * l.price, 0);
  const filtersOn = filters.sort !== "pop" || !!filters.cat || filters.sale;

  function pickChip(dep: string | null) {
    window.scrollTo({ top: 0 });
    if (dep === SALE) setFilters((f) => ({ ...f, dep: null, cat: null, sale: !f.sale }));
    else setFilters((f) => ({ ...f, dep, cat: null, sale: false }));
  }

  function addAllUsual() {
    setSendError(null);
    setCart((c) => {
      const next = { ...c };
      for (const u of usual) {
        if (!next[u.sku]) next[u.sku] = { qty: Math.min(MAX_QTY, Math.max(1, u.lastQty)), title: u.title, price: unitPrice(u), thumb: u.thumb };
      }
      return next;
    });
  }

  const showUsual = usual.length > 0 && !filters.q && !filters.dep && !filters.cat && !filters.sale;
  const usualAllIn = usual.every((u) => cart[u.sku]);

  function renderItem(item: ShopItem) {
    const price = unitPrice(item);
    const onSale = price < item.price;
    return (
      <article key={item.sku} className={styles.item}>
        <div className={styles.img}>
          <ProductImage key={item.sku} item={item} />
          {onSale && <span className={styles.off}>-{Math.round((1 - price / item.price) * 100)}%</span>}
        </div>
        <div className={styles.info}>
          <div className={styles.nm}>{niceTitle(item.title)}</div>
          <div className={styles.sys}>Cód. {item.sku}</div>
          <div className={styles.row}>
            <span className={styles.pr}>
              {money(price)}
              {onSale && <s>{money(item.price)}</s>}
            </span>
            <Qty qty={cart[item.sku]?.qty ?? 0} name={niceTitle(item.title)} onChange={(d) => changeQty(item, d)} />
          </div>
        </div>
      </article>
    );
  }

  function addTypedToNote() {
    const q = typed.trim();
    if (!q) return;
    setNote((n) => (n.trim() ? `${n.trim()}\n${q}` : q));
    setTyped("");
    setSheet("cart");
  }

  async function send() {
    if (sending) return;
    if (!cartLines.length && !note.trim()) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch(`/api/pedir/${encodeURIComponent(token)}/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: cartLines.map(([sku, l]) => ({ sku, qty: l.qty })), note }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; total?: number };
      if (res.ok) {
        setDone({ total: data.total ?? cartTotal });
        setCart({});
        setNote("");
        setSheet(null);
        window.scrollTo({ top: 0 });
        return;
      }
      if (data.error === "window_closed") {
        setSendError({ text: "Para recibir su lista, primero escríbanos un “hola” por WhatsApp y luego vuelva a tocar Enviar. Su lista queda guardada.", back: true });
      } else if (data.error === "expired" || data.error === "invalid") {
        setSendError({ text: "Este enlace ya venció. Pida uno nuevo en el chat de WhatsApp; su lista queda guardada en este teléfono.", back: true });
      } else if (data.error === "rate_limited") {
        setSendError({ text: "Espere un momento y vuelva a intentar." });
      } else {
        setSendError({ text: "No se pudo enviar. Revise su internet y vuelva a intentar." });
      }
    } catch {
      setSendError({ text: "No se pudo enviar. Revise su internet y vuelva a intentar." });
    } finally {
      setSending(false);
    }
  }

  if (done) {
    return (
      <div className={styles.app}>
        <section className={styles.done}>
          <div className={styles.big}>✅</div>
          <h1>Listo, su lista llegó a su chat de WhatsApp</h1>
          {done.total > 0 && <p className={styles.doneTotal}>Total estimado: {money(done.total)}</p>}
          <p className={styles.hint}>En el chat elige cómo desea su factura y el asesor le confirma disponibilidad y envío.</p>
          <a className={styles.waBtn} href={backHref}>
            Volver a WhatsApp
          </a>
          <button type="button" className={styles.ghost} onClick={() => setDone(null)}>
            Agregar más productos
          </button>
        </section>
      </div>
    );
  }

  return (
    <div className={styles.app}>
      <header className={styles.top}>
        <div className={styles.bar1}>
          <a className={styles.ib} href={backHref} aria-label="Volver a WhatsApp">
            <BackIcon />
          </a>
          <h1>
            {storeName}
            <small>{customerName ? `Pedido de ${customerName}` : "Su pedido llega a su chat"}</small>
          </h1>
          <div className={styles.icons}>
            <button type="button" className={styles.ib} onClick={() => setSheet("cart")} aria-label={`Ver mi pedido, ${units} productos`}>
              <CartIcon />
              {units > 0 && <span className={styles.badge}>{units > 99 ? "99+" : units}</span>}
            </button>
            <button type="button" className={styles.ib} onClick={() => setSheet("filters")} aria-label="Ordenar y filtrar">
              <FilterIcon />
              {filtersOn && <span className={styles.dot} />}
            </button>
            <button
              type="button"
              className={styles.ib}
              onClick={() => setView((v) => (v === "list" ? "grid" : "list"))}
              aria-label={view === "list" ? "Ver en cuadrícula" : "Ver en lista"}
            >
              {view === "list" ? <GridIcon /> : <ListIcon />}
            </button>
          </div>
        </div>
        <form
          className={styles.search}
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            (document.activeElement as HTMLElement | null)?.blur();
            setFilters((f) => ({ ...f, q: typed.trim().slice(0, 80) }));
          }}
        >
          <SearchIcon />
          <input
            type="search"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Buscar: atún, foco led, pintura…"
            aria-label="Buscar productos"
            autoComplete="off"
            enterKeyHint="search"
            maxLength={80}
          />
          {typed && (
            <button type="button" className={styles.clear} onClick={() => setTyped("")} aria-label="Borrar búsqueda">
              ×
            </button>
          )}
        </form>
        <nav className={styles.chips} aria-label="Secciones">
          <button type="button" className={styles.chip} aria-pressed={!filters.dep && !filters.sale} onClick={() => pickChip(null)}>
            Todo
          </button>
          {hasOffers && (
            <button type="button" className={styles.chip} aria-pressed={filters.sale} onClick={() => pickChip(SALE)}>
              🔥 Ofertas
            </button>
          )}
          {departments.map((d) => (
            <button key={d.name} type="button" className={styles.chip} aria-pressed={filters.dep === d.name} onClick={() => pickChip(d.name)}>
              {niceTitle(d.name)}
            </button>
          ))}
        </nav>
      </header>

      {units === 0 && !note && (
        <p className={styles.tip}>
          Toque <b>+</b> para agregar. Al final toque <b>Ver pedido</b> y su lista llega a su chat de WhatsApp.
        </p>
      )}

      <div className={styles.meta} aria-live="polite">
        <span>
          {loading && page === 0
            ? "Buscando…"
            : loadError
              ? ""
              : `${total.toLocaleString("es-EC")} producto${total === 1 ? "" : "s"}${filters.q ? ` para “${filters.q}”` : ""}`}
          {filters.cat ? ` · ${niceTitle(filters.cat)}` : ""}
        </span>
        <span>{SORTS.find((s) => s.key === filters.sort)?.label}</span>
      </div>

      {showUsual && (
        <section className={styles.usual} aria-label="Sus productos de siempre">
          <div className={styles.sectionHead}>
            <h2>⭐ Sus productos de siempre</h2>
            <button type="button" className={styles.addAll} onClick={addAllUsual} disabled={usualAllIn}>
              {usualAllIn ? "✓ Agregados" : `Agregar todo (${usual.length})`}
            </button>
          </div>
          <div className={`${styles.items} ${view === "grid" ? styles.grid : ""}`}>{usual.map((u) => renderItem(u))}</div>
          <div className={styles.sectionHead}>
            <h2>🔥 Más vendidos</h2>
          </div>
        </section>
      )}

      <main className={`${styles.items} ${view === "grid" ? styles.grid : ""} ${loading && page === 0 ? styles.fading : ""}`}>
        {items.filter((item) => !showUsual || !usual.some((u) => u.sku === item.sku)).map((item) => renderItem(item))}
      </main>

      {loadError === "expired" && (
        <div className={styles.empty}>
          <b>Este enlace ya venció</b>
          <span>Pida uno nuevo en el chat de WhatsApp. Lo que ya agregó queda guardado en este teléfono.</span>
          <a className={styles.waBtn} href={backHref}>
            Volver a WhatsApp
          </a>
        </div>
      )}
      {loadError === "network" && (
        <div className={styles.empty}>
          <b>No se pudo cargar</b>
          <span>Revise su internet.</span>
          <button type="button" className={styles.ghost} onClick={() => setFilters((f) => ({ ...f }))}>
            Reintentar
          </button>
        </div>
      )}

      {!loading && !loadError && total === 0 && (
        <div className={styles.empty}>
          <b>{filters.q ? `No encontramos “${filters.q}”` : "No hay productos aquí"}</b>
          <span>Pruebe con otra palabra, o anótelo y el asesor lo busca por usted.</span>
          {filters.q && (
            <button type="button" className={styles.ghost} onClick={addTypedToNote}>
              ✍️ Anotar “{filters.q}” en mi pedido
            </button>
          )}
        </div>
      )}

      {hasMore && !loadError && (
        <div ref={sentinel} className={styles.more}>
          <button type="button" className={styles.ghost} onClick={loadMore} disabled={loading}>
            {loading ? "Cargando…" : "Ver más productos"}
          </button>
        </div>
      )}

      {!hasMore && total > 0 && filters.q && (
        <div className={styles.more}>
          <span className={styles.hint}>¿No está lo que busca?</span>
          <button type="button" className={styles.ghost} onClick={addTypedToNote}>
            ✍️ Anotar “{filters.q}” en mi pedido
          </button>
        </div>
      )}

      {(units > 0 || note.trim()) && !sheet && (
        <div className={styles.pillwrap}>
          <button type="button" className={styles.pill} onClick={() => setSheet("cart")}>
            <span>Ver pedido ({units})</span>
            <span>{money(cartTotal)}</span>
          </button>
        </div>
      )}

      {sheet && <div className={styles.sheetBg} onClick={() => setSheet(null)} aria-hidden="true" />}

      {sheet === "filters" && (
        <section className={styles.sheet} role="dialog" aria-modal="true" aria-label="Ordenar y filtrar">
          <div className={styles.sheetHead}>
            <h2>Ordenar y filtrar</h2>
            <button type="button" className={styles.close} onClick={() => setSheet(null)} aria-label="Cerrar">
              ×
            </button>
          </div>
          <h3>Ordenar</h3>
          <div className={styles.opts}>
            {SORTS.map((s) => (
              <button
                key={s.key}
                type="button"
                className={styles.chip}
                aria-pressed={filters.sort === s.key}
                onClick={() => setFilters((f) => ({ ...f, sort: s.key }))}
              >
                {s.label}
              </button>
            ))}
          </div>
          {hasOffers && (
            <>
              <h3>Mostrar</h3>
              <div className={styles.opts}>
                <button
                  type="button"
                  className={styles.chip}
                  aria-pressed={filters.sale}
                  onClick={() => setFilters((f) => ({ ...f, sale: !f.sale }))}
                >
                  🔥 Solo ofertas
                </button>
              </div>
            </>
          )}
          {filters.dep && categories.length > 0 && (
            <>
              <h3>Categoría de {niceTitle(filters.dep)}</h3>
              <div className={styles.opts}>
                <button type="button" className={styles.chip} aria-pressed={!filters.cat} onClick={() => setFilters((f) => ({ ...f, cat: null }))}>
                  Todas
                </button>
                {categories.slice(0, 40).map((c) => (
                  <button
                    key={c.name}
                    type="button"
                    className={styles.chip}
                    aria-pressed={filters.cat === c.name}
                    onClick={() => setFilters((f) => ({ ...f, cat: c.name }))}
                  >
                    {niceTitle(c.name)} <small>{c.n}</small>
                  </button>
                ))}
              </div>
            </>
          )}
          {!filters.dep && <p className={styles.hint}>Elija una sección arriba (por ejemplo {departments[0] ? niceTitle(departments[0].name) : "Ferretería"}) para ver sus categorías.</p>}
          <button type="button" className={styles.dark} onClick={() => setSheet(null)}>
            Ver {total.toLocaleString("es-EC")} producto{total === 1 ? "" : "s"}
          </button>
          {filtersOn && (
            <button
              type="button"
              className={styles.ghostWide}
              onClick={() => setFilters((f) => ({ ...f, sort: "pop", cat: null, sale: false }))}
            >
              Quitar filtros
            </button>
          )}
        </section>
      )}

      {sheet === "cart" && (
        <section className={styles.sheet} role="dialog" aria-modal="true" aria-label="Mi pedido">
          <div className={styles.sheetHead}>
            <h2>Mi pedido</h2>
            <button type="button" className={styles.close} onClick={() => setSheet(null)} aria-label="Cerrar">
              ×
            </button>
          </div>
          {cartLines.length === 0 ? (
            <p className={styles.hint}>Todavía no agregó productos. Toque + en los productos, o escriba abajo lo que necesita.</p>
          ) : (
            cartLines.map(([sku, l]) => (
              <div key={sku} className={styles.line}>
                <ProductImage key={sku} item={{ thumb: l.thumb, title: l.title }} className={styles.lineImg} />
                <div>
                  <div className={styles.t}>{niceTitle(l.title)}</div>
                  <div className={styles.s}>
                    {money(l.price)} c/u · <b>{money(l.price * l.qty)}</b>
                  </div>
                </div>
                <Qty qty={l.qty} name={niceTitle(l.title)} onChange={(d) => changeQty({ sku, title: l.title, price: l.price, salePrice: null, thumb: l.thumb }, d)} />
              </div>
            ))
          )}
          {cartLines.length > 0 && (
            <div className={styles.total}>
              <span>Total estimado</span>
              <b>{money(cartTotal)}</b>
            </div>
          )}
          <p className={styles.hint}>Precios con IVA. El asesor confirma disponibilidad y el costo de envío.</p>
          {deliveryNote && <p className={styles.delivery}>{deliveryNote}</p>}
          <h3>¿Algo que no encontró?</h3>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 1000))}
            placeholder="Ej.: 20 metros de hilo grilón, 1 libra de queso"
            aria-label="Productos que no encontró"
            rows={3}
          />
          {sendError && (
            <p className={styles.error} role="alert">
              {sendError.text}
              {sendError.back && (
                <>
                  {" "}
                  <a href={backHref}>Abrir WhatsApp</a>
                </>
              )}
            </p>
          )}
          <button type="button" className={styles.primary} onClick={send} disabled={sending || (!cartLines.length && !note.trim())}>
            {sending ? "Enviando…" : "Enviar a mi chat de WhatsApp"}
          </button>
          {cartLines.length > 0 && (
            <button type="button" className={styles.ghostWide} onClick={() => setSheet(null)}>
              Seguir agregando
            </button>
          )}
        </section>
      )}
    </div>
  );
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}
function CartIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="9" cy="20" r="1.3" />
      <circle cx="18" cy="20" r="1.3" />
      <path d="M2 3h3l2.6 12.2a1.5 1.5 0 0 0 1.5 1.2h9.3a1.5 1.5 0 0 0 1.5-1.1L22 8H6" />
    </svg>
  );
}
function FilterIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </svg>
  );
}
function GridIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
    </svg>
  );
}
function ListIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M9 6h11M9 12h11M9 18h11" />
      <circle cx="4.5" cy="6" r="1" />
      <circle cx="4.5" cy="12" r="1" />
      <circle cx="4.5" cy="18" r="1" />
    </svg>
  );
}
function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
    </svg>
  );
}

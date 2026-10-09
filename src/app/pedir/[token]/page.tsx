import type { Metadata, Viewport } from "next";
import { Barlow, Barlow_Semi_Condensed } from "next/font/google";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { readOrderLinkToken } from "@/lib/catalog/order-link";
import { searchShop, shopFacets, type ShopFacets, type ShopItem } from "@/lib/catalog/shop-search";
import { refreshShopIfStale } from "@/lib/catalog/shop-sync";
import { loadBusinessSettings } from "@/lib/business/settings";
import { ShopPicker } from "@/components/shop/shop-picker";
import styles from "@/components/shop/shop-picker.module.css";

// /pedir/<token> — the customer's product picker. The signed link (sent
// by the bot, valid 24 h) is the only key: it names the account, the
// contact and the chat the picked products go back to.

const barlow = Barlow({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--shop-font", display: "swap" });
const barlowCond = Barlow_Semi_Condensed({ subsets: ["latin"], weight: ["700"], variable: "--shop-font-cond", display: "swap" });

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Elegir productos",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
  colorScheme: "light",
  width: "device-width",
  initialScale: 1,
};

function waLink(number: string): string {
  const digits = number.replace(/\D/g, "");
  return digits ? `https://wa.me/${digits}` : "https://wa.me/";
}

function Message({ title, text, href }: { title: string; text: string; href: string }) {
  return (
    <div className={`${styles.app} ${barlow.variable} ${barlowCond.variable}`}>
      <section className={styles.done}>
        <div className={styles.big}>🕑</div>
        <h1>{title}</h1>
        <p className={styles.hint}>{text}</p>
        <a className={styles.waBtn} href={href}>
          Volver a WhatsApp
        </a>
      </section>
    </div>
  );
}

export default async function PedirPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const check = readOrderLinkToken(token);
  if (!check.ok) {
    return (
      <Message
        title={check.reason === "expired" ? "Este enlace ya venció" : "Enlace no válido"}
        text="Escríbanos por WhatsApp y le enviamos un enlace nuevo para elegir sus productos."
        href="https://wa.me/"
      />
    );
  }

  const { accountId, contactId } = check.link;
  const db = supabaseAdmin();
  const [biz, contact] = await Promise.all([
    loadBusinessSettings(db, accountId),
    db.from("contacts").select("name").eq("id", contactId).eq("account_id", accountId).maybeSingle(),
  ]);
  const backHref = waLink(biz.whatsappNumber);

  let items: ShopItem[] = [];
  let total = 0;
  let facets: ShopFacets = { departments: [], categories: [] };
  try {
    const [r, f] = await Promise.all([
      searchShop(db, accountId, { sort: "pop", page: 0 }),
      shopFacets(db, accountId, "", null),
    ]);
    items = r.items;
    total = r.total;
    facets = f;
  } catch (err) {
    console.error("[pedir] first page failed:", err);
  }
  void refreshShopIfStale(db, accountId);

  if (total === 0) {
    return (
      <Message
        title="El catálogo no está disponible ahora"
        text="Escríbanos su pedido por WhatsApp (texto, foto o audio) y con gusto lo atendemos."
        href={backHref}
      />
    );
  }

  const fullName = ((contact.data as { name?: string | null } | null)?.name ?? "").trim();
  const firstName = /\d/.test(fullName) ? "" : fullName.split(/\s+/)[0] ?? "";

  return (
    <div className={`${barlow.variable} ${barlowCond.variable}`}>
      <ShopPicker
        token={token}
        storeName={biz.name || "Elegir productos"}
        customerName={firstName}
        backHref={backHref}
        initial={{ items, total, facets }}
      />
    </div>
  );
}

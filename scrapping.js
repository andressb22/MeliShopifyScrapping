import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import cron from "node-cron";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const filePath = path.join(__dirname, "../");

//export const startCronJobs = () => {
//  cron.schedule("*/2 * * * *", () => {
//    console.log("Ejecutando tarea cada 2 minutos:", new Date());
//    getProducts(SOURCES.stock);
//    getProducts(SOURCES.preventa);
//  });
//};

export const runScraping = async () => {
  await getProducts(SOURCES.stock);
  await getProducts(SOURCES.preventa);
};

runScraping();

// ─── FUENTES A MONITOREAR ────────────────────────────────────
const SOURCES = {
  stock: {
    label: "📦 STOCK",
    url: "https://cddistribution.com/co/categoria-producto/juguetes-nuevos/pokemon-tcg/",
    stateFile: path.join(filePath, "pokemon_state_stock.json"),
    emailSubjectLabel: "Stock",
    emailBodyHeader:
      "📦 URL DE STOCK\nhttps://cddistribution.com/co/categoria-producto/juguetes-nuevos/pokemon-tcg/",
  },
  preventa: {
    label: "🛒 PREVENTA",
    url: "https://cddistribution.com/co/backorderjuguetes/",
    stateFile: path.join(filePath, "pokemon_state_preventa.json"),
    emailSubjectLabel: "Preventa",
    emailBodyHeader:
      "🛒 URL DE PREVENTA\nhttps://cddistribution.com/co/backorderjuguetes/",
  },
};

// ─── CONFIGURACIÓN GENERAL ───────────────────────────────────
const CONFIG = {
  perPageMax: "100",
  timeout: 30_000,
};

// ─── ALERTAS ─────────────────────────────────────────────────
async function sendAlert({
  source,
  type,
  previousCount,
  currentCount,
  diff,
  newProducts,
}) {
  let msg = "";

  if (type === "increase") {
    const productLines = newProducts.map((p) => `  • ${p.name}`).join("\n");
    msg =
      `${source.emailBodyHeader}\n` +
      `${"─".repeat(50)}\n` +
      `🚨 AUMENTO de productos Pokemon TCG\n` +
      `   Antes: ${previousCount} → Ahora: ${currentCount} (+${diff})\n\n` +
      `📦 Productos nuevos detectados:\n${productLines}`;
  } else {
    msg =
      `${source.emailBodyHeader}\n` +
      `${"─".repeat(50)}\n` +
      `ℹ️  Disminución de productos Pokemon TCG\n` +
      `   Antes: ${previousCount} → Ahora: ${currentCount} (-${Math.abs(diff)})`;
  }

  console.log("\n" + msg + "\n");

  const transporter = nodemailer.createTransport({
    host: "smtp.zoho.com",
    port: 465,
    secure: true,
    auth: {
      user: "asierra447@bcssascol.com",
      pass: "1015412015Af$",
    },
  });

  await transporter.sendMail({
    from: "asierra447@bcssascol.com",
    to: "hakooboxcol@gmail.com",
    subject:
      type === "increase"
        ? `🚨 [${source.emailSubjectLabel}] ${diff} producto(s) nuevo(s) en Pokemon TCG`
        : `ℹ️ [${source.emailSubjectLabel}] Disminución de productos Pokemon TCG`,
    text: msg,
  });
}

// ─── ESTADO PERSISTENTE ──────────────────────────────────────
function loadState(source) {
  try {
    if (fs.existsSync(source.stateFile)) {
      return JSON.parse(fs.readFileSync(source.stateFile, "utf8"));
    }
  } catch (_) {}
  return { count: null, products: [], lastChecked: null };
}

function saveState(source, state) {
  fs.writeFileSync(source.stateFile, JSON.stringify(state, null, 2));
}

// ─── SELECCIONAR MÁX PRODUCTOS POR PÁGINA ────────────────────
async function applyMaxPerPage(page) {
  try {
    await page.waitForSelector(
      "#woocommerce-sort-by-columns, select[name='ppp'], select.ppp",
      { timeout: 5_000 },
    );
    await page.select(
      "#woocommerce-sort-by-columns, select[name='ppp'], select.ppp",
      CONFIG.perPageMax,
    );
    await page
      .waitForNavigation({
        waitUntil: "domcontentloaded",
        timeout: CONFIG.timeout,
      })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
  } catch (_) {}
}

// ─── OBTENER LISTA COMPLETA DE PRODUCTOS ─────────────────────
async function getAllProducts(page, baseUrl) {
  let products = [];
  let pageNum = 1;

  while (true) {
    const url = pageNum === 1 ? baseUrl : `${baseUrl}page/${pageNum}/`;

    if (pageNum > 1) {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: CONFIG.timeout,
      });
      await applyMaxPerPage(page);
    }

    // Verificar si hay productos en la página (puede estar vacía)
    const hasProducts = await page.$("ul.products li.product");
    if (!hasProducts) {
      console.log(`  → Página ${pageNum}: sin productos`);
      break;
    }

    const pageProducts = await page.$$eval("ul.products li.product", (items) =>
      items.map((item) => {
        const h3 = item.querySelector("h3");
        if (!h3) return { name: "Sin nombre", url: "" };

        // El primer <a> del h3 está vacío, el segundo tiene el texto del producto
        const links = Array.from(h3.querySelectorAll("a"));
        const anchor = links.find((a) => a.textContent.trim() !== "");

        const name = anchor?.textContent?.trim() || "Sin nombre";
        const url = anchor?.href || "";
        return { name, url };
      }),
    );

    products = [...products, ...pageProducts];
    console.log(`  → Página ${pageNum}: ${pageProducts.length} productos`);

    const hasNext = await page.$(
      "nav.woocommerce-pagination a.next.page-numbers",
    );
    if (!hasNext) break;

    pageNum++;
  }

  return products;
}

// ─── LÓGICA PRINCIPAL POR FUENTE ─────────────────────────────
const getProducts = async (source) => {
  const now = new Date().toISOString();
  console.log(`\n[${now}] Iniciando monitoreo ${source.label}...`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  // Bloquear imágenes y fuentes para ir más rápido
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (["image", "font", "media"].includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });

  try {
    await page.goto(source.url, {
      waitUntil: "domcontentloaded",
      timeout: CONFIG.timeout,
    });

    // ── Verificar si la página tiene productos ────────────────
    const hasProducts = await page.$("ul.products li.product");

    if (!hasProducts) {
      console.log(
        `  ℹ️  ${source.label}: página vacía, sin productos. Omitiendo.`,
      );

      // Si antes había productos y ahora está vacío, actualizamos a 0
      const state = loadState(source);
      if (state.count !== null && state.count > 0) {
        console.log(
          `  ⬇️  ${source.label}: pasó de ${state.count} productos a 0`,
        );
        saveState(source, { count: 0, products: [], lastChecked: now });
      }

      return;
    }

    // Seleccionar 100 por página
    await applyMaxPerPage(page);

    // Obtener todos los productos
    const currentProducts = await getAllProducts(page, source.url);
    const currentCount = currentProducts.length;
    console.log(
      `  ✓ ${source.label} - Total actual: ${currentCount} productos`,
    );

    // Cargar estado anterior
    const state = loadState(source);
    const previousCount = state.count;
    const previousProducts = state.products || [];

    if (previousCount === null) {
      console.log(
        `  ℹ️  Primera ejecución ${source.label}. Guardando estado inicial.`,
      );
      saveState(source, {
        count: currentCount,
        products: currentProducts,
        lastChecked: now,
      });
    } else {
      const diff = currentCount - previousCount;

      if (diff > 0) {
        // ── Detectar productos nuevos ──────────────────────
        const previousUrls = new Set(previousProducts.map((p) => p.url));
        const previousNames = new Set(previousProducts.map((p) => p.name));

        const newProducts = currentProducts.filter(
          (p) => !previousUrls.has(p.url) && !previousNames.has(p.name),
        );

        console.log(
          `  ⬆️  ${source.label}: aumento detectado +${diff} productos`,
        );
        newProducts.forEach((p) => console.log(`     ✨ Nuevo: ${p.name}`));

        await sendAlert({
          source,
          type: "increase",
          previousCount,
          currentCount,
          diff,
          newProducts,
        });
        saveState(source, {
          count: currentCount,
          products: currentProducts,
          lastChecked: now,
        });
      } else if (diff < 0) {
        console.log(
          `  ⬇️  ${source.label}: disminución detectada ${diff} productos`,
        );
        saveState(source, {
          count: currentCount,
          products: currentProducts,
          lastChecked: now,
        });
      } else {
        console.log(`  ✓ ${source.label}: sin cambios.`);
        saveState(source, {
          count: previousCount,
          products: previousProducts,
          lastChecked: now,
        });
      }
    }
  } catch (err) {
    console.error(`  ✗ Error en ${source.label}:`, err.message);
  } finally {
    await browser.close();
  }

  console.log(
    `[${new Date().toISOString()}] Monitoreo ${source.label} finalizado.\n`,
  );
};


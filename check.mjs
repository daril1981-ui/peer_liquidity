// Vigilante de liquidez en Peer (app.peer.xyz) -> aviso por Telegram.
// Sin dependencias: solo necesita Node 20 o superior.

const cfg = {
  currency: process.env.CURRENCY || 'EUR',
  platform: process.env.PLATFORM || 'revolut',
  maxPremiumPct: Number(process.env.MAX_PREMIUM_PCT || '0.5'), // umbral sobre mercado, en %
  minUsdc: Number(process.env.MIN_USDC || '50'),               // ignora ofertas mas pequenas
  hours: (process.env.CHECK_HOURS || '6,10,14,18,22').split(',').map(Number), // hora de Madrid
  force: process.env.FORCE === 'true',                         // ejecucion manual de prueba
  tgToken: process.env.TELEGRAM_BOT_TOKEN,
  tgChat: process.env.TELEGRAM_CHAT_ID,
};

const API = 'https://api.zkp2p.xyz/v3/orderbook/table';

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// EUR que vale 1 USDC en mercado. Coinbase primero, BCE (Frankfurter) de reserva.
async function marketRate(currency) {
  try {
    const j = await getJson('https://api.coinbase.com/v2/exchange-rates?currency=USDC');
    const r = Number(j?.data?.rates?.[currency]);
    if (r > 0) return { rate: r, source: 'Coinbase' };
  } catch (e) {
    console.log('Coinbase no disponible:', e.message);
  }
  const j = await getJson(`https://api.frankfurter.app/latest?from=USD&to=${currency}`);
  const r = Number(j?.rates?.[currency]);
  if (!(r > 0)) throw new Error('No se pudo obtener el tipo de mercado');
  return { rate: r, source: 'BCE' };
}

async function orderbook() {
  const q = new URLSearchParams({
    currency: cfg.currency,
    paymentPlatform: cfg.platform,
    sortBy: 'price',
    sortDirection: 'asc',
    limit: '50',
  });
  const j = await getJson(`${API}?${q}`);
  const body = j?.responseObject ?? j;
  if (!Array.isArray(body?.rows)) {
    throw new Error('Respuesta inesperada de Peer: ' + JSON.stringify(j).slice(0, 500));
  }
  return body.rows;
}

// El precio puede venir como "0.8979" o con 18 decimales ("897900000000000000").
const toRate = (v) => {
  const n = Number(v);
  return n > 1e6 ? n / 1e18 : n;
};

// El USDC puede venir como "10061.98" o en unidades minimas ("10061980000").
function amountParser(rows) {
  const vals = rows.map((r) => String(r.availableTokenAmount ?? ''));
  const raw = !vals.some((v) => v.includes('.')) && Math.max(...vals.map(Number)) >= 1e6;
  return (v) => (raw ? Number(v) / 1e6 : Number(v));
}

const fmt = (n, d) => n.toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d });

async function telegram(text) {
  if (!cfg.tgToken || !cfg.tgChat) throw new Error('Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID');
  const res = await fetch(`https://api.telegram.org/bot${cfg.tgToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: cfg.tgChat, text, disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`Telegram -> HTTP ${res.status}: ${await res.text()}`);
}

async function main() {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', hourCycle: 'h23' }).format(new Date()),
  );
  if (!cfg.force && !cfg.hours.includes(hour)) {
    console.log(`Son las ${hour}h en Madrid: no toca comprobar (horas: ${cfg.hours.join(', ')}).`);
    return;
  }

  const [rows, market] = await Promise.all([orderbook(), marketRate(cfg.currency)]);
  console.log(`Mercado: ${market.rate} ${cfg.currency}/USDC (${market.source}). Filas recibidas: ${rows.length}`);
  if (rows[0]) console.log('Primera fila en bruto:', JSON.stringify(rows[0]));

  const toUsdc = amountParser(rows);
  const offers = rows
    .map((r) => {
      const price = toRate(r.takerConversionRate ?? r.conversionRate);
      return { price, usdc: toUsdc(r.availableTokenAmount), premium: (price / market.rate - 1) * 100 };
    })
    .filter((o) => Number.isFinite(o.price) && Number.isFinite(o.usdc));

  // Si los precios no tienen sentido, el formato de la API ha cambiado: mejor fallar que avisar mal.
  if (offers.some((o) => o.price < market.rate * 0.5 || o.price > market.rate * 3)) {
    throw new Error('Precios fuera de rango: revisar el formato de la API (ver "Primera fila en bruto").');
  }

  const hits = offers
    .filter((o) => o.premium < cfg.maxPremiumPct && o.usdc >= cfg.minUsdc)
    .sort((a, b) => a.price - b.price);

  for (const o of offers.slice(0, 10)) {
    console.log(`  ${o.price.toFixed(4)}  ${o.premium >= 0 ? '+' : ''}${o.premium.toFixed(2)}%  ${o.usdc.toFixed(2)} USDC`);
  }

  if (hits.length === 0) {
    console.log(`Nada por debajo de +${cfg.maxPremiumPct}%.`);
    if (cfg.force) {
      await telegram(`Prueba OK. Ahora mismo no hay liquidez ${cfg.platform}/${cfg.currency} por debajo de +${fmt(cfg.maxPremiumPct, 2)}% en Peer.`);
    }
    return;
  }

  const total = hits.reduce((s, o) => s + o.usdc, 0);
  const lines = hits
    .slice(0, 15)
    .map((o) => `• ${fmt(o.price, 4)}  (${o.premium >= 0 ? '+' : ''}${fmt(o.premium, 2)}%)  ${fmt(o.usdc, 2)} USDC`);
  const text = [
    `🟢 Peer: liquidez ${cfg.platform}/${cfg.currency} por debajo de +${fmt(cfg.maxPremiumPct, 2)}%`,
    `Mercado: ${fmt(market.rate, 4)} ${cfg.currency}/USDC (${market.source})`,
    '',
    ...lines,
    hits.length > 15 ? `… y ${hits.length - 15} más` : null,
    '',
    `Total: ${fmt(total, 2)} USDC en ${hits.length} oferta(s)`,
    'https://app.peer.xyz/buy',
  ]
    .filter((l) => l !== null)
    .join('\n');

  await telegram(text);
  console.log('Aviso enviado:\n' + text);
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});

// Rozpočet – widget pre appku Scriptable (iPhone)
// Pri prvom spustení sa opýta na adresu Google skriptu a kľúč a uloží ich do Keychainu v telefóne.
// V tomto súbore nie sú žiadne tajné údaje.

const K_URL = 'rozpocet_url';
const K_TOKEN = 'rozpocet_token';
const C = {
  bg: new Color('#141933'),
  text: new Color('#ECEAF6'),
  muted: new Color('#9A9CC0'),
  mint: new Color('#5EE0AE'),
  coral: new Color('#FF7466'),
  bar: new Color('#262D55')
};

async function ask(title, key, placeholder) {
  const a = new Alert();
  a.title = title;
  a.addTextField(placeholder, Keychain.contains(key) ? Keychain.get(key) : '');
  a.addAction('Uložiť');
  a.addCancelAction('Zrušiť');
  if ((await a.present()) === -1) return null;
  const v = a.textFieldValue(0).trim();
  if (v) Keychain.set(key, v);
  return v;
}

async function setup() {
  await ask('Adresa Google skriptu', K_URL, 'https://script.google.com/macros/s/…/exec');
  await ask('Kľúč', K_TOKEN, 'kľúč z appky Rozpočet');
}

function pad(n) { return String(n).padStart(2, '0'); }
function money(n, dec) {
  const v = Math.round(n * 100) / 100;
  return v.toLocaleString('sk-SK', { minimumFractionDigits: dec ? 2 : 0, maximumFractionDigits: dec ? 2 : 0 }) + ' €';
}

function compute(data) {
  const s = data.settings || {};
  const cats = s.categories || [];
  const now = new Date();
  const key = now.getFullYear() + '-' + pad(now.getMonth() + 1);
  const tx = (data.tx || []).filter(t => String(t.date).slice(0, 7) === key);
  const guess = m => {
    const low = String(m || '').toLowerCase();
    for (const c of cats) for (const k of c.keywords || []) if (k && low.includes(String(k).toLowerCase())) return c.id;
    return 'ostatne';
  };
  const catOf = t => (cats.find(c => c.id === t.category) ? t.category : guess(t.merchant));
  const incomeLogged = tx.filter(t => t.amount > 0 && t.category !== 'sporenie').reduce((a, t) => a + Number(t.amount), 0);
  const incomeExpected = (s.income || []).reduce((a, i) => a + Number(i.amount || 0), 0);
  const income = Math.max(incomeLogged, incomeExpected);
  const fixed = (s.fixed || []).reduce((a, f) => a + Number(f.amount || 0), 0);
  const byCat = {};
  let variable = 0;
  for (const t of tx) {
    if (t.amount >= 0) continue;
    const c = catOf(t);
    if (c === 'pevne' || c === 'sporenie') continue;
    byCat[c] = (byCat[c] || 0) - Number(t.amount);
    variable -= Number(t.amount);
  }
  const left = income - fixed - variable;
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeft = lastDay - now.getDate() + 1;
  const envs = cats
    .filter(c => c.id !== 'pevne' && c.id !== 'sporenie' && Number(c.limit) > 0)
    .map(c => ({ name: c.name, color: c.color, limit: Number(c.limit), left: Number(c.limit) - (byCat[c.id] || 0) }))
    .sort((a, b) => a.left / a.limit - b.left / b.limit);
  return { left, perDay: daysLeft > 0 ? left / daysLeft : 0, envs };
}

function bar(stack, ratio, color, width) {
  const ctx = new DrawContext();
  ctx.size = new Size(width, 6);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  const p1 = new Path(); p1.addRoundedRect(new Rect(0, 0, width, 6), 3, 3);
  ctx.addPath(p1); ctx.setFillColor(C.bar); ctx.fillPath();
  const w = Math.max(0, Math.min(1, ratio)) * width;
  if (w > 0) {
    const p2 = new Path(); p2.addRoundedRect(new Rect(0, 0, w, 6), 3, 3);
    ctx.addPath(p2); ctx.setFillColor(color); ctx.fillPath();
  }
  const img = stack.addImage(ctx.getImage());
  img.imageSize = new Size(width, 6);
}

function build(r, family, error) {
  const w = new ListWidget();
  w.backgroundColor = C.bg;
  w.setPadding(14, 14, 12, 14);
  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);

  const label = w.addText(error ? 'Rozpočet' : 'Ostáva tento mesiac');
  label.font = Font.mediumSystemFont(12);
  label.textColor = C.muted;

  if (error) {
    w.addSpacer(6);
    const e = w.addText(error);
    e.font = Font.systemFont(12);
    e.textColor = C.coral;
    return w;
  }

  const big = w.addText(money(r.left, false));
  big.font = Font.heavyRoundedSystemFont(family === 'small' ? 30 : 34);
  big.textColor = r.left < 0 ? C.coral : C.text;
  big.minimumScaleFactor = 0.6;

  const pd = w.addText(r.left > 0 ? money(r.perDay, true) + ' na deň' : 'Prečerpané');
  pd.font = Font.mediumSystemFont(13);
  pd.textColor = r.left > 0 ? C.mint : C.coral;

  if (family !== 'small') {
    w.addSpacer(8);
    for (const e of r.envs.slice(0, 3)) {
      const row = w.addStack();
      row.centerAlignContent();
      const n = row.addText(e.name);
      n.font = Font.systemFont(11);
      n.textColor = C.text;
      n.lineLimit = 1;
      row.addSpacer();
      const v = row.addText(money(e.left, false));
      v.font = Font.semiboldSystemFont(11);
      v.textColor = e.left < 0 ? C.coral : C.text;
      w.addSpacer(2);
      bar(w, 1 - e.left / e.limit, e.left < 0 ? C.coral : new Color(e.color || '#5EE0AE'), 290);
      w.addSpacer(4);
    }
  }

  w.addSpacer();
  const now = new Date();
  const upd = w.addText('Aktualizované ' + pad(now.getHours()) + ':' + pad(now.getMinutes()));
  upd.font = Font.systemFont(9);
  upd.textColor = C.muted;
  return w;
}

async function main() {
  if (config.runsInApp && (!Keychain.contains(K_URL) || !Keychain.contains(K_TOKEN) || args.queryParameters.setup)) {
    await setup();
  } else if (config.runsInApp) {
    const a = new Alert();
    a.title = 'Rozpočet widget';
    a.addAction('Zobraziť náhľad');
    a.addAction('Zmeniť adresu a kľúč');
    a.addCancelAction('Zavrieť');
    const pick = await a.present();
    if (pick === 1) await setup();
    if (pick === -1) return Script.complete();
  }

  const family = config.widgetFamily || 'medium';
  let widget;
  if (!Keychain.contains(K_URL) || !Keychain.contains(K_TOKEN)) {
    widget = build(null, family, 'Otvor Scriptable a nastav adresu a kľúč.');
  } else {
    try {
      const url = Keychain.get(K_URL) + '?action=all&token=' + encodeURIComponent(Keychain.get(K_TOKEN));
      const req = new Request(url);
      req.timeoutInterval = 20;
      const data = await req.loadJSON();
      if (!data.ok) throw new Error(data.error || 'Chyba servera');
      widget = build(compute(data), family);
    } catch (e) {
      widget = build(null, family, 'Nepodarilo sa načítať: ' + e.message);
    }
  }

  if (config.runsInWidget) Script.setWidget(widget);
  else await widget.presentMedium();
  Script.complete();
}

await main();

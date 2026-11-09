// Rozpočet – zavádzač widgetu pre Scriptable. Doplň adresu a kľúč, zvyšok sa načíta z GitHubu.
const URL_SKRIPTU = 'SEM_ADRESU_SKRIPTU';
const KLUC = 'SEM_KLUC';

const fm = FileManager.local();
const cache = fm.joinPath(fm.documentsDirectory(), 'rozpocet-core.js');
let code;
try {
  const r = new Request('https://raw.githubusercontent.com/veakwolf/budget/main/widget-core.js?t=' + Date.now());
  r.timeoutInterval = 15;
  code = await r.loadString();
  if (!/Script\.complete/.test(code)) throw new Error('neúplný kód');
  fm.writeString(cache, code);
} catch (e) {
  code = fm.fileExists(cache) ? fm.readString(cache) : null;
}
if (!code) {
  const w = new ListWidget();
  w.addText('Rozpočet: bez internetu, skús neskôr.');
  Script.setWidget(w);
  Script.complete();
} else {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction('URL_SKRIPTU', 'KLUC', code)(URL_SKRIPTU, KLUC);
}

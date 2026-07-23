/**
 * Stap 1: Haal Fluvius historische data op via de backend endpoint
 * /geo/fluvius-historie/:id. De backend zit dichter bij Fluvius en
 * heeft geen netwerk-restricties.
 *
 * Output: output/historie-per-gemeente.json
 */
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const config = require('./config');

async function haalHistorie(gem) {
  const url = `${config.BACKEND_URL}/geo/fluvius-historie/${gem.id}?vanaf=${config.HISTORIE_VANAF}&tot=${config.HISTORIE_TOT}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Backend ${resp.status} voor ${gem.naam}: ${await resp.text()}`);
  }
  return await resp.json();
}

async function main() {
  console.log(`Ophalen historie via ${config.BACKEND_URL} voor ${config.GEMEENTEN.length} gemeenten...`);
  const alles = {};
  for (const gem of config.GEMEENTEN) {
    process.stdout.write(` ${gem.naam}...`);
    try {
      const res = await haalHistorie(gem);
      alles[gem.id] = {
        naam: gem.naam,
        cumulatief: Object.fromEntries(
          Object.entries(res.cumulatief).map(([j, n]) => [j, { fluvius_cumulatief: n }])
        ),
        totaal: res.totaalRecords,
        mislukt: res.mislukt || [],
      };
      console.log(` ${res.totaalRecords} records, 2025 = ${res.cumulatief[config.HISTORIE_TOT]}`);
    } catch (e) {
      console.log(` MISLUKT (${e.message})`);
      alles[gem.id] = { naam: gem.naam, cumulatief: {}, totaal: 0, mislukt: 'ALL' };
    }
  }
  const uit = path.join(config.OUTPUT_DIR, 'historie-per-gemeente.json');
  fs.writeFileSync(uit, JSON.stringify(alles, null, 2));
  console.log(`Klaar: ${uit}`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

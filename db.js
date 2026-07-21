// db.js — PostgreSQL verbinding + schema setup
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

// ── Schema aanmaken als het nog niet bestaat ─────────────────────────
async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS gemeenten (
        id           TEXT PRIMARY KEY,
        naam         TEXT NOT NULL,
        provincie    TEXT,
        inwoners     INTEGER,
        voertuigen   INTEGER,
        center_lat   DOUBLE PRECISION,
        center_lng   DOUBLE PRECISION,
        zoom         INTEGER DEFAULT 13,
        bbox         JSONB,
        kleur        TEXT DEFAULT '#2B5F6E',
        land         TEXT DEFAULT 'België',
        aangemaakt   TIMESTAMPTZ DEFAULT NOW(),
        bijgewerkt   TIMESTAMPTZ DEFAULT NOW(),
        aangemaakt_door TEXT DEFAULT 'belli'
      );

      CREATE TABLE IF NOT EXISTS wijken (
        id             TEXT NOT NULL,
        gemeente_id    TEXT NOT NULL REFERENCES gemeenten(id) ON DELETE CASCADE,
        naam           TEXT NOT NULL,
        inwoners       INTEGER,
        voertuigen     INTEGER,
        aandeel_app    DOUBLE PRECISION DEFAULT 0.25,
        lat            DOUBLE PRECISION,
        lng            DOUBLE PRECISION,
        wijktype       TEXT DEFAULT 'residentieel',
        seg_bewoners   DOUBLE PRECISION DEFAULT 0.55,
        seg_bezoekers  DOUBLE PRECISION DEFAULT 0.25,
        seg_logistiek  DOUBLE PRECISION DEFAULT 0.12,
        seg_ov         DOUBLE PRECISION DEFAULT 0.08,
        volgorde       INTEGER DEFAULT 0,
        PRIMARY KEY (id, gemeente_id)
      );

      CREATE TABLE IF NOT EXISTS gemeente_metadata (
        gemeente_id  TEXT PRIMARY KEY REFERENCES gemeenten(id) ON DELETE CASCADE,
        data_kwaliteit_inwoners  TEXT DEFAULT 'Standaardwaarde',
        data_kwaliteit_voertuigen TEXT DEFAULT 'Standaardwaarde',
        data_kwaliteit_woningmix  TEXT DEFAULT 'Standaardwaarde',
        bron_url     TEXT,
        opmerkingen  TEXT,
        bijgewerkt   TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_wijken_gemeente ON wijken(gemeente_id);
      CREATE INDEX IF NOT EXISTS idx_gemeenten_naam  ON gemeenten(naam);

      -- Landelijke cache van Rijksregister-bevolkingscijfers (alle ~581
      -- Belgische gemeenten, niet alleen de al onboarde), zodat onboarding
      -- een snelle, lokale opzoeking doet in plaats van elke keer een
      -- extern bestand te bevragen. Ververst via ververBevolkingscijfers().
      CREATE TABLE IF NOT EXISTS bevolking_rijksregister (
        naam         TEXT PRIMARY KEY,
        inwoners     INTEGER NOT NULL,
        bron         TEXT DEFAULT 'Rijksregister (IBZ)',
        bijgewerkt   TIMESTAMPTZ DEFAULT NOW()
      );

      -- Migratie voor het herziene rekenmodel (zie Leeswijzer Strategisch
      -- Laadplan Modellering): welvaartsindex-correctie, berekend privé%,
      -- optionele lokale EV-aandeel-override, en wijktype als array (i.p.v.
      -- vaste tekstwaarde) zodat een wijk hybride kan zijn (bijv. woonwijk +
      -- bedrijventerrein). De oude wijktype/seg_*/aandeel_app-kolommen
      -- blijven bestaan (niet destructief), maar worden niet meer gebruikt.
      ALTER TABLE gemeenten ADD COLUMN IF NOT EXISTS welvaartsindex DOUBLE PRECISION DEFAULT 106.9;
      ALTER TABLE gemeenten ADD COLUMN IF NOT EXISTS prive_pct_berekend DOUBLE PRECISION DEFAULT 0.5;
      ALTER TABLE gemeenten ADD COLUMN IF NOT EXISTS ev_aandeel_override JSONB;
      ALTER TABLE wijken ADD COLUMN IF NOT EXISTS wijktype_v2 JSONB DEFAULT '["woonwijk"]'::jsonb;
      ALTER TABLE wijken ADD COLUMN IF NOT EXISTS ov_aandeel DOUBLE PRECISION DEFAULT 0;
      ALTER TABLE wijken ADD COLUMN IF NOT EXISTS oppervlakte_km2 DOUBLE PRECISION;
      ALTER TABLE wijken ADD COLUMN IF NOT EXISTS oppervlakte_is_proxy BOOLEAN DEFAULT true;
      ALTER TABLE gemeenten ADD COLUMN IF NOT EXISTS oppervlakte_km2 DOUBLE PRECISION;
      ALTER TABLE gemeenten ADD COLUMN IF NOT EXISTS postcodes JSONB DEFAULT '[]'::jsonb;
    `);

    // Backfill voor de drie startgemeenten: als deze al bestonden vóór deze
    // migratie (bijvoorbeeld Leuven, uit eerder werk deze week), kregen ze
    // zojuist de generieke standaardwaarde (106,9 / 50%) i.p.v. hun eigen,
    // gevalideerde cijfers, want seedStartdata() slaat lege databases over.
    // Deze UPDATE zet de juiste waarden altijd terug, ook op een bestaande rij.
    for (const g of STARTDATA) {
      await client.query(
        `UPDATE gemeenten SET welvaartsindex=$1, prive_pct_berekend=$2, ev_aandeel_override=$3, oppervlakte_km2=$4, postcodes=$5, inwoners=$6, voertuigen=$7
         WHERE id=$8`,
        [g.welvaartsindex ?? 106.9, g.privePctBerekend ?? 0.5,
         g.evAandeelOverride ? JSON.stringify(g.evAandeelOverride) : null, g.oppervlakte ?? null,
         JSON.stringify(g.postcodes ?? []), g.inwoners, g.voertuigen, g.id]);
      for (const w of g.wijken) {
        await client.query(
          `UPDATE wijken SET wijktype_v2=$1, ov_aandeel=$2, oppervlakte_km2=$3, oppervlakte_is_proxy=false WHERE id=$4 AND gemeente_id=$5`,
          [JSON.stringify(w.type), w.ov, w.opp ?? null, w.id, g.id]);
      }
    }
    console.log('✓ Schema gereed');
  } finally {
    client.release();
  }
}

// ── Seed-data: de drie startgemeenten (ook gebruikt door het herstel-
//    mechanisme in geo.js om corrupte wijken terug te zetten) ────────
const STARTDATA = [
  {
    id:'leuven', naam:'Leuven', provincie:'Vlaams-Brabant', land:'België',
    inwoners:105233, voertuigen:48200, oppervlakte:56.63,
    welvaartsindex:115, privePctBerekend:0.636, evAandeelOverride:{2030:0.376, 2035:0.595},
    postcodes:['3000','3001','3010','3012','3018'], // extern geverifieerd (bpost)
    lat:50.8798, lng:4.7005, zoom:13, kleur:'#2B5F6E',
    bbox:[50.82,4.65,50.94,4.77],
    wijken:[
      { id:'LV01', naam:'Leuven Centrum',      inw:18400, vrt:7200,  lat:50.8793, lng:4.7009, type:['binnenstad'],       ov:0, opp:10.17 },
      { id:'LV02', naam:'Kessel-Lo',            inw:22100, vrt:9800,  lat:50.8900, lng:4.7280, type:['woonwijk'],         ov:0, opp:12.21 },
      { id:'LV03', naam:'Heverlee',             inw:19600, vrt:9100,  lat:50.8560, lng:4.7050, type:['woonwijk'],         ov:0, opp:10.83 },
      { id:'LV04', naam:'Wilsele',              inw:12300, vrt:5600,  lat:50.9100, lng:4.7050, type:['woonwijk'],         ov:0, opp:6.80 },
      { id:'LV05', naam:'Wijgmaal',             inw:5200,  vrt:2400,  lat:50.9280, lng:4.7120, type:['woonwijk'],         ov:0, opp:2.87 },
      { id:'LV06', naam:'Haasrode/Korbeek-Lo',  inw:8900,  vrt:4200,  lat:50.8420, lng:4.7400, type:['bedrijventerrein'], ov:0, opp:4.92 },
      { id:'LV07', naam:'Binnenstad Oost',      inw:9800,  vrt:3200,  lat:50.8780, lng:4.7160, type:['binnenstad'],       ov:0, opp:5.41 },
      { id:'LV08', naam:'Arenberg/Wetenschap',  inw:6200,  vrt:4800,  lat:50.8640, lng:4.6880, type:['woonwijk'],         ov:0, opp:3.43 },
    ],
  },
  {
    id:'olen', naam:'Olen', provincie:'Antwerpen', land:'België',
    inwoners:12943, voertuigen:8200, oppervlakte:23.10,
    welvaartsindex:107, privePctBerekend:0.70,
    postcodes:['2250'], // extern geverifieerd (bpost/Wikipedia)
    lat:51.1400, lng:4.8600, zoom:13, kleur:'#3A6B4A',
    bbox:[51.10,4.82,51.18,4.91],
    wijken:[
      { id:'OL01', naam:'Olen Centrum',   inw:5200, vrt:3100, lat:51.1380, lng:4.8580, type:['binnenstad'],       ov:0, opp:8.58 },
      { id:'OL02', naam:'Olen Noord',     inw:3800, vrt:2300, lat:51.1520, lng:4.8550, type:['woonwijk'],         ov:0, opp:6.27 },
      { id:'OL03', naam:'Industriezone',  inw:800,  vrt:1200, lat:51.1350, lng:4.8750, type:['bedrijventerrein'], ov:0, opp:1.32 },
      { id:'OL04', naam:'Olen Oost',      inw:4200, vrt:2600, lat:51.1380, lng:4.8820, type:['woonwijk'],         ov:0, opp:6.93 },
    ],
  },
  {
    id:'gent', naam:'Gent', provincie:'Oost-Vlaanderen', land:'België',
    inwoners:273665, voertuigen:96409, oppervlakte:156.18,
    welvaartsindex:98, privePctBerekend:0.60,
    postcodes:['9000','9030','9031','9032','9040','9050','9051','9052'], // beste inschatting, mogelijk niet volledig
    lat:51.0543, lng:3.7174, zoom:12, kleur:'#9EC5CB',
    bbox:[50.99,3.64,51.12,3.80],
    wijken:[
      { id:'GN01', naam:'Gent Centrum',       inw:28000, vrt:9800,  lat:51.0543, lng:3.7174, type:['binnenstad'],       ov:0, opp:39.75 },
      { id:'GN02', naam:'Ledeberg',           inw:18000, vrt:7200,  lat:51.0380, lng:3.7350, type:['woonwijk'],         ov:0, opp:25.56 },
      { id:'GN03', naam:'Wondelgem',          inw:22000, vrt:9400,  lat:51.0850, lng:3.7100, type:['woonwijk'],         ov:0, opp:31.24 },
      { id:'GN04', naam:'Mariakerke',         inw:19000, vrt:8200,  lat:51.0620, lng:3.6900, type:['woonwijk'],         ov:0, opp:26.98 },
      { id:'GN05', naam:'Gentse Kanaalzone',  inw:8000,  vrt:5800,  lat:51.0900, lng:3.7500, type:['bedrijventerrein'], ov:0, opp:11.36 },
      { id:'GN06', naam:'Drongen',            inw:15000, vrt:6800,  lat:51.0350, lng:3.6650, type:['woonwijk'],         ov:0, opp:21.30 },
    ],
  },
];

// ── Seed-functie: de drie startgemeenten ─────────────────────────────
async function seedStartdata() {
  const { rowCount } = await pool.query('SELECT 1 FROM gemeenten LIMIT 1');
  if (rowCount > 0) return; // al geseeded

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const g of STARTDATA) {
      await client.query(`
        INSERT INTO gemeenten (id,naam,provincie,land,inwoners,voertuigen,center_lat,center_lng,zoom,kleur,bbox,welvaartsindex,prive_pct_berekend,ev_aandeel_override,oppervlakte_km2,postcodes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        ON CONFLICT (id) DO NOTHING`,
        [g.id, g.naam, g.provincie, g.land, g.inwoners, g.voertuigen,
         g.lat, g.lng, g.zoom, g.kleur, JSON.stringify(g.bbox),
         g.welvaartsindex ?? 106.9, g.privePctBerekend ?? 0.5,
         g.evAandeelOverride ? JSON.stringify(g.evAandeelOverride) : null,
         g.oppervlakte ?? null, JSON.stringify(g.postcodes ?? [])]);

      for (let i = 0; i < g.wijken.length; i++) {
        const w = g.wijken[i];
        await client.query(`
          INSERT INTO wijken (id,gemeente_id,naam,inwoners,voertuigen,lat,lng,wijktype_v2,ov_aandeel,volgorde,oppervlakte_km2,oppervlakte_is_proxy)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (id,gemeente_id) DO NOTHING`,
          [w.id, g.id, w.naam, w.inw, w.vrt, w.lat, w.lng,
           JSON.stringify(w.type), w.ov, i, w.opp ?? null, false]);
      }
    }
    await client.query('COMMIT');
    console.log('✓ Startdata geseeded (3 gemeenten)');
    
    // Geo onboarding startgemeenten (op achtergrond, niet blokkerend)
    setTimeout(async () => {
      try {
        const { onboardGemeenteGeo, matchSectorenAanWijken } = require('./geo');
        for (const g of [
          { id:'leuven', naam:'Leuven', land:'België', nis:'24062' },
          { id:'olen',   naam:'Olen',   land:'België', nis:'13025' },
          { id:'gent',   naam:'Gent',   land:'België', nis:'44021' },
        ]) {
          const { rows } = await pool.query(
            'SELECT COUNT(*) FROM geo_sectoren WHERE gemeente_id=$1', [g.id]
          );
          if (parseInt(rows[0].count) === 0) {
            await onboardGemeenteGeo(g.id, g.naam, g.land, g.nis);
          }
          await matchSectorenAanWijken(g.id);
        }
        console.log('✓ Geo sectoren klaar voor startgemeenten');
      } catch(e) {
        console.warn('Geo seed niet kritiek:', e.message);
      }
    }, 3000);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Seed fout:', e.message);
  } finally {
    client.release();
  }
}

module.exports = { pool, initSchema, seedStartdata, STARTDATA, ververBevolkingscijfers };

// Haalt het maandelijks bijgewerkte, landelijke bevolkingsbestand van het
// Rijksregister op (stabiele URL, geen datum in de bestandsnaam) en vult
// de bevolking_rijksregister-tabel. Bron:
// https://www.ibz.rrn.fgov.be/nl/burger/rijksregister-en-bevolking/bevolking/statistieken-van-bevolking
//
// LET OP: de exacte kolomstructuur van dit bestand kon niet vooraf worden
// geverifieerd (netwerkbeperking bij het bouwen van deze functie). De
// parsing zoekt daarom naar kolomkoppen op naam (gemeente/commune/inwoners/
// population/aantal), in plaats van een vaste kolomindex aan te nemen, om
// robuuster te zijn tegen kleine structuurverschillen. Bij een eerste
// gebruik moet dit gecontroleerd worden tegen de echte respons.
async function ververBevolkingscijfers() {
  const XLSX = require('xlsx');
  const url = 'https://www.ibz.rrn.fgov.be/sites/default/files/documents/nl/bevolking/statistieken/stat-1-1_n.xlsx';
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Rijksregister-bestand niet bereikbaar (HTTP ${resp.status})`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rijen = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

  // Zoek de headerrij (de eerste rij met herkenbare kolomkoppen), want
  // dit soort overheidsbestanden begint vaak met een paar titelregels.
  let headerIdx = -1, gemeenteKol = -1, inwonersKol = -1;
  for (let i = 0; i < Math.min(rijen.length, 15); i++) {
    const rij = rijen[i].map(c => String(c ?? '').toLowerCase());
    const gIdx = rij.findIndex(c => c.includes('gemeente') || c.includes('commune'));
    const iIdx = rij.findIndex(c => c.includes('inwoners') || c.includes('population') || c.includes('aantal') || c === 'totaal' || c === 'total');
    if (gIdx >= 0 && iIdx >= 0) { headerIdx = i; gemeenteKol = gIdx; inwonersKol = iIdx; break; }
  }
  if (headerIdx === -1) {
    throw new Error('Kon de kolomkoppen (gemeente/inwoners) niet herkennen in het Rijksregister-bestand. Structuur controleren.');
  }

  let bijgewerkt = 0;
  const rijksregisterMap = new Map(); // naam (lowercase, getrimd) -> inwoners
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = headerIdx + 1; i < rijen.length; i++) {
      const rij = rijen[i];
      const naamRuw = rij?.[gemeenteKol];
      const inwonersRuw = rij?.[inwonersKol];
      if (!naamRuw || inwonersRuw == null) continue;
      const naam = String(naamRuw).trim();
      const inwoners = parseInt(String(inwonersRuw).replace(/\./g, '').replace(/,/g, ''));
      if (!Number.isFinite(inwoners) || inwoners <= 0) continue;
      await client.query(
        `INSERT INTO bevolking_rijksregister (naam, inwoners, bijgewerkt)
         VALUES ($1,$2,NOW())
         ON CONFLICT (naam) DO UPDATE SET inwoners=$2, bijgewerkt=NOW()`,
        [naam, inwoners]);
      rijksregisterMap.set(naam.toLowerCase(), inwoners);
      bijgewerkt++;
    }

    // Werk ook meteen alle al onboarde gemeenten bij (naam-matching,
    // hoofdletterongevoelig), zodat een ververs niet alleen de landelijke
    // referentietabel vult maar ook direct de eigen gemeenten actualiseert.
    // Bewust losse, simpele UPDATE-statements per gemeente i.p.v. één
    // bulk-SQL-statement (UPDATE...FROM met aliassen, en ook een
    // correlated-subquery-variant), want beide bleken problematisch, de
    // eerste gaf op de echte database 0 in plaats van het verwachte
    // aantal, en dit eenvoudigere patroon is hetzelfde, al meermaals
    // succesvol geteste patroon als de rest van dit bestand.
    const { rows: bestaandeGemeenten } = await client.query('SELECT id, naam, inwoners FROM gemeenten');
    let gemeentenBijgewerkt = 0;
    for (const g of bestaandeGemeenten) {
      const nieuw = rijksregisterMap.get(String(g.naam).trim().toLowerCase());
      if (nieuw == null) continue; // geen match in het Rijksregister-bestand
      if (g.inwoners === nieuw) continue; // al up-to-date
      await client.query('UPDATE gemeenten SET inwoners=$1 WHERE id=$2', [nieuw, g.id]);
      gemeentenBijgewerkt++;
    }

    await client.query('COMMIT');
    return { bijgewerkt, gemeentenBijgewerkt, bron: url };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

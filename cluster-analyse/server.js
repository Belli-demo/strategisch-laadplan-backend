// server.js — Belli Laadkaart API
require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const { pool, initSchema, seedStartdata, ververBevolkingscijfers } = require('./db');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ───────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET','POST','PUT','PATCH','DELETE'],
}));
app.use(express.json({ limit:'1mb' }));
app.use(rateLimit({ windowMs:60*1000, max:120, message:'Te veel verzoeken' }));

// ── Helper: rij → gemeente-object ───────────────────────────────────
function rowToGemeente(row, wijken = []) {
  return {
    id:         row.id,
    naam:       row.naam,
    provincie:  row.provincie,
    land:       row.land,
    inwoners:   row.inwoners,
    voertuigen: row.voertuigen,
    welvaartsindex:   row.welvaartsindex != null ? parseFloat(row.welvaartsindex) : 106.9,
    privePctBerekend: row.prive_pct_berekend != null ? parseFloat(row.prive_pct_berekend) : 0.5,
    evAandeelOverride: row.ev_aandeel_override || undefined,
    oppervlakteKm2: row.oppervlakte_km2 != null ? parseFloat(row.oppervlakte_km2) : null,
    postcodes: row.postcodes || [],
    center:     [parseFloat(row.center_lat), parseFloat(row.center_lng)],
    zoom:       row.zoom,
    kleur:      row.kleur,
    bbox:       row.bbox,
    aangemaakt: row.aangemaakt,
    bijgewerkt: row.bijgewerkt,
    wijken:     wijken.map(w => ({
      id:          w.id,
      naam:        w.naam,
      inwoners:    w.inwoners,
      voertuigen:  w.voertuigen,
      lat:         parseFloat(w.lat),
      lng:         parseFloat(w.lng),
      // wijktype_v2 is de nieuwe, gevalideerde kolom (array, ondersteunt
      // hybride wijken). Oudere rijen zonder deze kolom vallen terug op
      // ['woonwijk'] i.p.v. de vroegere, niet meer gebruikte tekstwaarde.
      wijktype:    (w.wijktype_v2 && w.wijktype_v2.length) ? w.wijktype_v2 : ['woonwijk'],
      ovAandeel:   w.ov_aandeel != null ? parseFloat(w.ov_aandeel) : 0,
      oppervlakteKm2: w.oppervlakte_km2 != null ? parseFloat(w.oppervlakte_km2) : null,
      oppervlakteIsProxy: w.oppervlakte_is_proxy !== false,
    })),
  };
}

// ══════════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════════

// ── GET /health ──────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status:'ok', ts: new Date().toISOString() }));

// ── GET /gemeenten — alle gemeenten (zonder wijkdetail) ──────────────
app.get('/gemeenten', async (_, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM gemeenten ORDER BY naam');
    res.json(rows.map(r => rowToGemeente(r)));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /gemeenten/:id — één gemeente met alle wijken ────────────────
app.get('/gemeenten/:id', async (req, res) => {
  try {
    const { rows: gRows } = await pool.query(
      'SELECT * FROM gemeenten WHERE id=$1', [req.params.id]);
    if (!gRows.length) return res.status(404).json({ error:'Gemeente niet gevonden' });

    const { rows: wRows } = await pool.query(
      'SELECT * FROM wijken WHERE gemeente_id=$1 ORDER BY volgorde', [req.params.id]);

    res.json(rowToGemeente(gRows[0], wRows));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /gemeenten — nieuwe gemeente aanmaken ───────────────────────
app.post('/gemeenten', async (req, res) => {
  const g = req.body;
  if (!g.id || !g.naam) return res.status(400).json({ error:'id en naam zijn verplicht' });

  // Sanitize id
  g.id = g.id.toLowerCase().replace(/[^a-z0-9_]/g,'_').slice(0,50);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      INSERT INTO gemeenten (id,naam,provincie,land,inwoners,voertuigen,center_lat,center_lng,zoom,kleur,bbox,welvaartsindex,prive_pct_berekend,ev_aandeel_override,oppervlakte_km2,postcodes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [ g.id, g.naam, g.provincie||'', g.land||'België',
        g.inwoners||0, g.voertuigen||0,
        g.center?.[0]||0, g.center?.[1]||0,
        g.zoom||13, g.kleur||'#2B5F6E',
        JSON.stringify(g.bbox||[]),
        g.welvaartsindex ?? 106.9,
        g.privePctBerekend ?? 0.5,
        g.evAandeelOverride ? JSON.stringify(g.evAandeelOverride) : null,
        g.oppervlakteKm2 ?? null,
        JSON.stringify(g.postcodes ?? []) ]);

    if (g.wijken?.length) {
      for (let i=0; i<g.wijken.length; i++) {
        const w = g.wijken[i];
        await client.query(`
          INSERT INTO wijken (id,gemeente_id,naam,inwoners,voertuigen,lat,lng,wijktype_v2,ov_aandeel,volgorde,oppervlakte_km2,oppervlakte_is_proxy)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [ w.id||`WK${String(i+1).padStart(2,'0')}`, g.id,
            w.naam||`Wijk ${i+1}`, w.inwoners||0, w.voertuigen||0,
            w.lat||0, w.lng||0,
            JSON.stringify(w.wijktype && w.wijktype.length ? w.wijktype : ['woonwijk']),
            w.ovAandeel || 0,
            i,
            w.oppervlakteKm2 ?? null,
            w.oppervlakteIsProxy !== false ]);
      }
    }

    // Metadata aanmaken
    await client.query(
      `INSERT INTO gemeente_metadata (gemeente_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [g.id]);

    await client.query('COMMIT');

    // Geef volledig object terug
    const { rows: gRows } = await pool.query('SELECT * FROM gemeenten WHERE id=$1', [g.id]);
    const { rows: wRows } = await pool.query('SELECT * FROM wijken WHERE gemeente_id=$1 ORDER BY volgorde', [g.id]);
    res.status(201).json(rowToGemeente(gRows[0], wRows));
  } catch(e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error:`Gemeente-ID "${g.id}" bestaat al` });
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── PUT /gemeenten/:id — gemeente volledig bijwerken ─────────────────
app.put('/gemeenten/:id', async (req, res) => {
  const g = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      UPDATE gemeenten SET
        naam=$1, provincie=$2, land=$3, inwoners=$4, voertuigen=$5,
        center_lat=$6, center_lng=$7, zoom=$8, kleur=$9, bbox=$10,
        welvaartsindex=$11, prive_pct_berekend=$12, ev_aandeel_override=$13,
        oppervlakte_km2=$14, postcodes=$15,
        bijgewerkt=NOW()
      WHERE id=$16`,
      [ g.naam, g.provincie, g.land, g.inwoners, g.voertuigen,
        g.center?.[0], g.center?.[1], g.zoom, g.kleur,
        JSON.stringify(g.bbox),
        g.welvaartsindex ?? 106.9,
        g.privePctBerekend ?? 0.5,
        g.evAandeelOverride ? JSON.stringify(g.evAandeelOverride) : null,
        g.oppervlakteKm2 ?? null,
        JSON.stringify(g.postcodes ?? []),
        req.params.id ]);

    // Verwijder bestaande wijken en herplaats
    await client.query('DELETE FROM wijken WHERE gemeente_id=$1', [req.params.id]);
    if (g.wijken?.length) {
      for (let i=0; i<g.wijken.length; i++) {
        const w = g.wijken[i];
        await client.query(`
          INSERT INTO wijken (id,gemeente_id,naam,inwoners,voertuigen,lat,lng,wijktype_v2,ov_aandeel,volgorde,oppervlakte_km2,oppervlakte_is_proxy)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [ w.id, req.params.id, w.naam, w.inwoners, w.voertuigen,
            w.lat, w.lng,
            JSON.stringify(w.wijktype && w.wijktype.length ? w.wijktype : ['woonwijk']),
            w.ovAandeel || 0, i,
            w.oppervlakteKm2 ?? null,
            w.oppervlakteIsProxy !== false ]);
      }
    }
    await client.query('COMMIT');

    const { rows: gRows } = await pool.query('SELECT * FROM gemeenten WHERE id=$1', [req.params.id]);
    const { rows: wRows } = await pool.query('SELECT * FROM wijken WHERE gemeente_id=$1 ORDER BY volgorde', [req.params.id]);
    res.json(rowToGemeente(gRows[0], wRows));
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── PATCH /gemeenten/:id — gemeente gedeeltelijk bijwerken ──────────
app.patch('/gemeenten/:id', async (req, res) => {
  const fields = req.body;
  const allowed = ['naam','provincie','inwoners','voertuigen','kleur','zoom','welvaartsindex','privePctBerekend','evAandeelOverride','oppervlakteKm2','postcodes'];
  const kolomNaam = { privePctBerekend:'prive_pct_berekend', evAandeelOverride:'ev_aandeel_override', oppervlakteKm2:'oppervlakte_km2' };
  const gefilterd = Object.entries(fields).filter(([k]) => allowed.includes(k));
  const updates = gefilterd.map(([k], i) => `${kolomNaam[k]||k}=$${i+2}`);

  if (!updates.length) return res.status(400).json({ error:'Geen geldige velden' });

  try {
    const waarden = gefilterd.map(([k,v]) => (k==='evAandeelOverride' || k==='postcodes') && v ? JSON.stringify(v) : v);
    await pool.query(
      `UPDATE gemeenten SET ${updates.join(',')},bijgewerkt=NOW() WHERE id=$1`,
      [req.params.id, ...waarden]);
    res.json({ ok:true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /gemeenten/:id — gemeente verwijderen ─────────────────────
app.delete('/gemeenten/:id', async (req, res) => {
  const { id } = req.params;
  if (['leuven','olen','gent'].includes(id)) {
    return res.status(403).json({ error:'Standaardgemeenten kunnen niet verwijderd worden' });
  }
  try {
    await pool.query('DELETE FROM gemeenten WHERE id=$1', [id]);
    res.json({ ok:true, verwijderd: id });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /gemeenten/:id/wijken — wijken van een gemeente ──────────────
app.get('/gemeenten/:id/wijken', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM wijken WHERE gemeente_id=$1 ORDER BY volgorde', [req.params.id]);
    res.json(rows);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PATCH /gemeenten/:gid/wijken/:wid — wijk bijwerken ──────────────
app.patch('/gemeenten/:gid/wijken/:wid', async (req, res) => {
  const { gid, wid } = req.params;
  const w = req.body;
  try {
    await pool.query(`
      UPDATE wijken SET
        naam=$1, inwoners=$2, voertuigen=$3,
        wijktype_v2=$4, ov_aandeel=$5, oppervlakte_km2=$6, oppervlakte_is_proxy=$7
      WHERE id=$8 AND gemeente_id=$9`,
      [ w.naam, w.inwoners, w.voertuigen,
        JSON.stringify(w.wijktype && w.wijktype.length ? w.wijktype : ['woonwijk']),
        w.ovAandeel || 0,
        w.oppervlakteKm2 ?? null,
        w.oppervlakteIsProxy !== false,
        wid, gid ]);
    res.json({ ok:true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /stats — gebruiksstatistieken ───────────────────────────────
app.get('/stats', async (_, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM gemeenten)    AS gemeenten,
        (SELECT COUNT(*) FROM wijken)       AS wijken,
        (SELECT SUM(inwoners) FROM gemeenten) AS totaal_inwoners,
        (SELECT MAX(bijgewerkt) FROM gemeenten) AS laatste_update
    `);
    res.json(rows[0]);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════════════════
// GET /geo/sync-wijken/:id — trigger via browser (zelfde als POST)
app.get('/geo/sync-wijken/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows: gRows } = await pool.query('SELECT * FROM gemeenten WHERE id=$1', [id]);
    if (!gRows.length) return res.status(404).json({ error: 'Gemeente niet gevonden' });
    const { matchSectorenAanWijken } = require('./geo');
    const result = await matchSectorenAanWijken(id);
    if (!result.sectoren) return res.status(404).json({ error: 'Geen sectoren — trigger eerst /geo/trigger/:id' });
    res.json({ ok: true, gemeente: gRows[0].naam, ...result, bron: 'statbel' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /geo/sync-wijken/:id — koppel Statbel-sectoren aan bestaande wijken
// (wizard-input in de wijken-tabel blijft ongewijzigd, dit voegt alleen
// geometrie toe voor de kaartweergave)
app.post('/geo/sync-wijken/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows: gRows } = await pool.query('SELECT * FROM gemeenten WHERE id=$1', [id]);
    if (!gRows.length) return res.status(404).json({ error: 'Gemeente niet gevonden' });

    const { matchSectorenAanWijken } = require('./geo');
    const result = await matchSectorenAanWijken(id);
    if (!result.sectoren) return res.status(404).json({ error: 'Geen sectoren gevonden — trigger eerst /geo/trigger/:id' });

    res.json({ ok: true, ...result, bron: 'statbel' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /geo/herstel-wijken/:id — verwijder automatisch gegenereerde
// nep-wijken (van de oude, kapotte sync-wijken-route) en zet voor de
// standaardgemeenten de originele wijken terug
app.get('/geo/herstel-wijken/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows: gRows } = await pool.query('SELECT naam FROM gemeenten WHERE id=$1', [id]);
    if (!gRows.length) return res.status(404).json({ error: 'Gemeente niet gevonden' });
    const { herstelWijken } = require('./geo');
    const result = await herstelWijken(id);
    res.json({ ok: true, gemeente: gRows[0].naam, ...result });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /geo/laadpalen/:id — bestaande laadpalen uit de officiële MOW-dataset
// (Departement Mobiliteit en Openbare Werken, gratis herbruikbaar, bron:
// https://metadata.vlaanderen.be/srv/api/records/d46516ca-c159-41bc-9c54-aa256c337228)
// De live WFS wordt geblokkeerd door bot-detectie voor niet-browserverkeer
// (bevestigd vanaf zowel deze server als vanuit meerdere andere omgevingen),
// daarom wordt hier een periodiek handmatig ververst exportbestand gebruikt
// (CSV-download via MOW's eigen FME Flow-tool, laatst ververst: 17/07/2026).
// Zelfde route en response-vorm als voorheen, zodat de frontend ongewijzigd
// kan blijven werken.
const mowLaadpunten = require('./geo-data/mow-laadpunten.json');

// Gemeentenamen bij handmatig onboarden zijn vrije tekst (de gebruiker typt
// ze zelf in de wizard), dus een exacte match op hoofdlettergebruik/spaties/
// accenten is te broos. Normaliseer daarom éénmalig bij opstarten een index.
function normaliseerNaam(s) {
  return (s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // accenten weg
    .trim().toLowerCase();
}
const mowLaadpuntenIndex = new Map();
for (const [naam, punten] of Object.entries(mowLaadpunten)) {
  mowLaadpuntenIndex.set(normaliseerNaam(naam), punten);
}

app.get('/geo/laadpalen/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query('SELECT naam FROM gemeenten WHERE id=$1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Gemeente niet gevonden' });

    const gemeenteNaam = rows[0].naam;
    const punten = mowLaadpuntenIndex.get(normaliseerNaam(gemeenteNaam)) || [];
    console.log(`  Laadpalen ${id} (${gemeenteNaam}): ${punten.length} via MOW-dataset (17/07/2026)`);

    // Omzetten naar dezelfde { lat, lon, tags } vorm die de frontend al
    // gebruikte voor Overpass-data, plus de extra, betrouwbaardere
    // MOW-velden (toegankelijkheid, snelheid) als aanvullende tags.
    const elements = punten.map(p => ({
      lat: p.lat,
      lon: p.lon,
      tags: {
        operator: p.uitbater,
        network: p.uitbater,
        maxpower: p.kw,
        mow_toegankelijkheid: p.toegankelijkheid, // 'publiek' | 'semi-publiek'
        mow_snelheid: p.snelheid,                 // 'normaal' | 'snel' | 'ultrasnel'
        mow_stroomtype: p.stroomtype,
        mow_connector: p.connector,
        mow_adres: p.adres,
      },
    }));

    res.json({ elements, bron: 'mow' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /geo/fluvius-prive/:id — geregistreerde private laadpunten (Fluvius
// Open Data) per postcode van deze gemeente. Geeft de ruwe telling terug;
// het omrekenen naar een privé%-voorstel gebeurt in de frontend, die al de
// EV-aandeel-logica heeft (welvaartsindex-correctie / override) om door de
// juiste, actuele EV-populatie te delen.
app.get('/geo/fluvius-prive/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query('SELECT postcodes FROM gemeenten WHERE id=$1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Gemeente niet gevonden' });
    const postcodes = rows[0].postcodes || [];
    if (!postcodes.length) {
      return res.status(400).json({ error: 'Geen postcodes ingesteld voor deze gemeente. Vul die eerst in via Bewerken.' });
    }

    const perPostcode = {};
    let totaal = 0;
    let mislukt = [];
    for (const postcode of postcodes) {
      try {
        const url = `https://opendata.fluvius.be/api/v2/catalog/datasets/1_21-aangemelde-oplaadpunten-voor-ev/records?where=postcode%3D%22${encodeURIComponent(postcode)}%22&limit=1`;
        const resp = await fetch(url);
        if (!resp.ok) { mislukt.push(postcode); continue; }
        const data = await resp.json();
        const aantal = data.total_count ?? 0;
        perPostcode[postcode] = aantal;
        totaal += aantal;
      } catch {
        mislukt.push(postcode);
      }
    }

    if (Object.keys(perPostcode).length === 0) {
      return res.status(502).json({ error: 'Fluvius Open Data kon voor geen enkele postcode bereikt worden.', mislukt });
    }

    res.json({
      postcodes, perPostcode, totaalPrivePunten: totaal, mislukt,
      bron: 'Fluvius Open Data, dataset 1_21-aangemelde-oplaadpunten-voor-ev',
      opgehaald: new Date().toISOString(),
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /geo/fluvius-historie/:id?vanaf=2019&tot=2025 — cumulatieve Fluvius
// privé-laadpunten per jaar, voor cluster-analyse. Gebruikt jaar_indienstname
// veld in de dataset.
app.get('/geo/fluvius-historie/:id', async (req, res) => {
  const { id } = req.params;
  const vanaf = parseInt(req.query.vanaf) || 2019;
  const tot   = parseInt(req.query.tot)   || 2025;
  try {
    const { rows } = await pool.query('SELECT postcodes FROM gemeenten WHERE id=$1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Gemeente niet gevonden' });
    const postcodes = rows[0].postcodes || [];
    if (!postcodes.length) {
      return res.status(400).json({ error: 'Geen postcodes ingesteld.' });
    }

    // Cumulatieve stand per jaar: som van records waar jaar_indienstname <= jaar
    const cumulatief = {};
    for (let j = vanaf; j <= tot; j++) cumulatief[j] = 0;
    let totaal = 0;
    let mislukt = [];

    for (const postcode of postcodes) {
      try {
        // Haal alle records per postcode op met jaar_indienstname veld
        const url = `https://opendata.fluvius.be/api/explore/v2.1/catalog/datasets/1_21-aangemelde-oplaadpunten-voor-ev/records?where=postcode%3D%22${encodeURIComponent(postcode)}%22&limit=100&select=jaar_indienstname`;
        const resp = await fetch(url);
        if (!resp.ok) { mislukt.push(postcode); continue; }
        const data = await resp.json();
        const records = data.results || [];
        totaal += records.length;
        for (const rec of records) {
          const jaar = rec.jaar_indienstname;
          if (jaar == null) continue;
          for (let j = Math.max(jaar, vanaf); j <= tot; j++) {
            cumulatief[j] += 1;
          }
        }
      } catch {
        mislukt.push(postcode);
      }
    }

    res.json({
      postcodes, cumulatief, totaalRecords: totaal, mislukt,
      periode: { vanaf, tot },
      bron: 'Fluvius Open Data, dataset 1_21-aangemelde-oplaadpunten-voor-ev, veld jaar_indienstname',
      opgehaald: new Date().toISOString(),
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /geo/ev-aandeel/:nisCode — EV-aandeel per gemeente via Provincies in
// Cijfers ODS API (Swing). Variabelecodes: v2101_personenwagens_elektriciteit
// plus de vijf overige brandstoftypen. Peiljaar: 2025 (meest recent beschikbaar).
// Vereist mogelijk een API-key: stel PROVINCIES_INCIJFERS_API_KEY in als Railway
// environment variable als de API een 401/403 teruggeeft.
app.get('/geo/ev-aandeel/:nisCode', async (req, res) => {
  const { nisCode } = req.params;

  if (!nisCode || !/^\d{5}$/.test(nisCode)) {
    return res.status(400).json({ error: 'Ongeldige NIS-code. Verwacht 5 cijfers, bv. 24062.' });
  }

  const SWING_BASE = 'https://provincies.incijfers.be/viewerservices/odata';
  const PEILJAAR   = 'year_2025';
  const GEOLEVEL   = 'gemeente';
  const VARIABELEN = [
    'v2101_personenwagens_elektriciteit',
    'v2101_personenwagens_benzine',
    'v2101_personenwagens_diesel',
    'v2101_personenwagens_lpg',
    'v2101_personenwagens_hybride',
    'v2101_personenwagens_andere',
  ];
  const apiKey = process.env.PROVINCIES_INCIJFERS_API_KEY || null;

  async function fetchVar(variabele) {
    const url = `${SWING_BASE}/Indicators/${variabele}/Data` +
      `?$filter=GeoLevel eq '${GEOLEVEL}' and Period eq '${PEILJAAR}'` +
      ` and ExternalCode eq '${nisCode}'`;
    const headers = { Accept: 'application/json' };
    if (apiKey) headers['apikey'] = apiKey;
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`Swing ODS ${variabele}: ${r.status} ${r.statusText}`);
    const json = await r.json();
    return json.value || [];
  }

  try {
    const resultaten = await Promise.all(VARIABELEN.map(fetchVar));

    const waarden = {};
    VARIABELEN.forEach((v, i) => {
      const kortNaam = v.replace('v2101_personenwagens_', '');
      const record   = resultaten[i].find(r => r.ValueType === 'Regular');
      waarden[kortNaam] = record ? (record.Value ?? 0) : 0;
    });

    const evAantal     = waarden['elektriciteit'] || 0;
    const totaalAantal = Object.values(waarden).reduce((s, v) => s + v, 0);
    const evAandeel    = totaalAantal > 0 ? evAantal / totaalAantal : 0;
    const eersteRecord = resultaten[0].find(r => r.ValueType === 'Regular');

    return res.json({
      nisCode,
      gemeente:     eersteRecord?.GeoName || eersteRecord?.Name || null,
      evAandeel:    parseFloat(evAandeel.toFixed(4)),    // bv. 0.0530
      evAandeelPct: parseFloat((evAandeel * 100).toFixed(2)), // bv. 5.30
      evAantal,
      totaalAantal,
      waarden,
      peiljaar: 2025,
      bron: 'Statbel via provincies.incijfers.be',
    });

  } catch (err) {
    console.error('ev-aandeel fout:', err.message);
    if (err.message.includes('401') || err.message.includes('403')) {
      return res.status(503).json({
        error: 'Provincies in Cijfers API vereist een API-key.',
        instructie: 'Stel PROVINCIES_INCIJFERS_API_KEY in als Railway environment variable.',
      });
    }
    return res.status(500).json({ error: err.message });
  }
});

// POST /geo/ververs-bevolking — haalt het landelijke Rijksregister-bestand
// opnieuw op en vult bevolking_rijksregister. Handmatig te triggeren, of
// periodiek (bijv. maandelijks) aan te roepen; niet automatisch bij elke
// serverstart, om het externe bestand niet onnodig vaak te bevragen.
app.post('/geo/ververs-bevolking', async (req, res) => {
  try {
    const resultaat = await ververBevolkingscijfers();
    res.json(resultaat);
  } catch(e) {
    res.status(502).json({ error: e.message });
  }
});

// GET /geo/bevolking/:naam — snelle, lokale opzoeking in de gecachete
// Rijksregister-tabel, i.p.v. bij elke onboarding een extern bestand of
// Wikidata te bevragen.
app.get('/geo/bevolking/:naam', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT naam, inwoners, bron, bijgewerkt FROM bevolking_rijksregister WHERE naam ILIKE $1 LIMIT 1',
      [req.params.naam]);
    if (!rows.length) return res.status(404).json({ error: 'Geen bevolkingscijfer gevonden voor deze naam. Probeer /geo/ververs-bevolking als de tabel nog leeg is.' });
    res.json(rows[0]);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

async function start() {
  try {
    await initSchema();
    await seedStartdata();
    const { initGeoSchema } = require('./geo');
    await initGeoSchema();
    app.listen(PORT, () => {
      console.log(`✓ Belli Laadkaart API draait op poort ${PORT}`);
      console.log(`  Omgeving: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch(e) {
    console.error('Start fout:', e);
    process.exit(1);
  }
}

start();

// ══════════════════════════════════════════════════════════════════════
// GEO ROUTES (sectoren & NIS-lookup)
// ══════════════════════════════════════════════════════════════════════
const { initGeoSchema, getNisCode, onboardGemeenteGeo, getSectorenFromDb } = require('./geo');

// GET /geo/nis-lookup?naam=Mechelen&land=België
app.get('/geo/nis-lookup', async (req, res) => {
  const { naam, land = 'België' } = req.query;
  if (!naam) return res.status(400).json({ error: 'naam parameter verplicht' });
  try {
    const info = await getNisCode(naam, land);
    res.json(info);
  } catch(e) {
    res.status(404).json({ error: e.message });
  }
});

// POST /geo/onboard/:id — sectoren ophalen en opslaan voor gemeente
app.post('/geo/onboard/:id', async (req, res) => {
  const { id } = req.params;
  const { nisCode } = req.body;

  // Haal gemeente op uit DB
  const { rows } = await pool.query('SELECT naam, land FROM gemeenten WHERE id=$1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'Gemeente niet gevonden' });

  try {
    const result = await onboardGemeenteGeo(id, rows[0].naam, rows[0].land, nisCode);
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /geo/sectoren/:id — sectoren ophalen voor gemeente (als GeoJSON FeatureCollection)
app.get('/geo/sectoren/:id', async (req, res) => {
  try {
    const features = await getSectorenFromDb(req.params.id);
    res.json({
      type: 'FeatureCollection',
      features,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// GET /geo/trigger/:id — handmatig triggeren geo seeding via browser
app.get('/geo/trigger/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query('SELECT naam, land FROM gemeenten WHERE id=$1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Gemeente niet gevonden' });
    const result = await onboardGemeenteGeo(id, rows[0].naam, rows[0].land);
    res.json({ ok: true, gemeente: rows[0].naam, ...result });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// server.js — Belli Laadkaart API
require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const fs           = require('fs');
const path         = require('path');
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
// privé-laadpunten per jaar op basis van 'jaartal_indienstname'.
// Bewust GEEN select-parameter (die is niet gegarandeerd in Fluvius' /api/v2/
// alias); we vragen alle velden en lezen alleen jaartal_indienstname uit.
// Response format van Fluvius volgt Opendatasoft: {records:[{record:{fields:{...}}}]}
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

    // Cumulatieve stand per jaar: som van records waar jaartal_indienstname <= jaar
    const cumulatief = {};
    for (let j = vanaf; j <= tot; j++) cumulatief[j] = 0;
    let totaal = 0;
    let mislukt = [];
    // Debug info per postcode, zichtbaar in Railway logs én terug in de response
    // zodat we bij problemen precies weten wat Fluvius teruggaf.
    const debug = [];

    for (const postcode of postcodes) {
      const info = { postcode, http_status: null, pages: 0, records_this_postcode: 0, sample_field: null, sample_year: null, error: null };
      try {
        // Pagineer door alle records per postcode (v2 API cap is 100/pagina).
        let offset = 0;
        let doorgaan = true;
        let maxPages = 20; // veiligheid tegen oneindige lus
        while (doorgaan && maxPages > 0) {
          const url = `https://opendata.fluvius.be/api/v2/catalog/datasets/1_21-aangemelde-oplaadpunten-voor-ev/records?where=postcode%3D%22${encodeURIComponent(postcode)}%22&limit=100&offset=${offset}`;
          const resp = await fetch(url);
          info.http_status = resp.status;
          if (!resp.ok) {
            info.error = `HTTP ${resp.status}`;
            mislukt.push(postcode);
            break;
          }
          const data = await resp.json();
          // Fluvius /api/v2/ response format is Opendatasoft standaard: data.records array
          const records = data.records || [];
          if (info.pages === 0 && records.length > 0) {
            // Sla één sample op voor debugging
            const sample = records[0];
            info.sample_field = sample.record?.fields ?? sample.fields ?? sample;
            info.sample_year = sample.record?.fields?.jaartal_indienstname
              ?? sample.fields?.jaartal_indienstname
              ?? sample.jaartal_indienstname
              ?? null;
          }
          for (const rec of records) {
            const jaarStr = rec.record?.fields?.jaartal_indienstname
              ?? rec.fields?.jaartal_indienstname
              ?? rec.jaartal_indienstname;
            const jaar = jaarStr ? parseInt(jaarStr, 10) : null;
            if (jaar == null || isNaN(jaar)) continue;
            for (let j = Math.max(jaar, vanaf); j <= tot; j++) {
              cumulatief[j] += 1;
            }
          }
          info.records_this_postcode += records.length;
          info.pages++;
          if (records.length < 100) doorgaan = false;
          offset += 100;
          maxPages--;
        }
        totaal += info.records_this_postcode;
      } catch (e) {
        info.error = e.message;
        mislukt.push(postcode);
      }
      debug.push(info);
      console.log(`  Fluvius-historie ${id} pc=${postcode}: ${info.pages} pagina's, ${info.records_this_postcode} records${info.error ? ', FOUT: '+info.error : ''}`);
    }

    res.json({
      postcodes, cumulatief, totaalRecords: totaal, mislukt, debug,
      periode: { vanaf, tot },
      bron: 'Fluvius Open Data, dataset 1_21-aangemelde-oplaadpunten-voor-ev, veld jaartal_indienstname',
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

// GET /admin/vul-postcodes-aan — vult automatisch postcodes in voor
// Belgische gemeenten die er nog geen hebben. Niet onder /gemeenten/ gemount
// omdat de :id-route daar de path zou vangen.
const POSTCODES_LOOKUP = {
  'antwerpen':    ['2000','2018','2020','2030','2040','2050','2060','2100','2140','2170','2180','2600','2610','2660'],
  'hasselt':      ['3500','3501','3510','3511','3512'],
  'vilvoorde':    ['1800'],
  'brasschaat':   ['2930'],
  'bonheiden':    ['2820'],
  'knokke-heist': ['8300','8301'],
  'oostende':     ['8400'],
  'brugge':       ['8000','8200','8310','8380'],
  'mechelen':     ['2800','2801','2811','2812'],
  'genk':         ['3600'],
  'diest':        ['3290','3293'],
  'beveren':      ['9120'],
};
app.get('/admin/vul-postcodes-aan', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, naam, postcodes FROM gemeenten');
    const bijgewerkt = [];
    const overgeslagen = [];
    const geenLookup = [];
    for (const g of rows) {
      const heeftPostcodes = Array.isArray(g.postcodes) && g.postcodes.length > 0;
      if (heeftPostcodes) { overgeslagen.push({ id: g.id, reden: 'heeft al postcodes' }); continue; }
      const sleutel = normaliseerNaam(g.naam);
      const postcodes = POSTCODES_LOOKUP[sleutel];
      if (!postcodes) { geenLookup.push({ id: g.id, naam: g.naam }); continue; }
      await pool.query('UPDATE gemeenten SET postcodes=$1 WHERE id=$2', [JSON.stringify(postcodes), g.id]);
      bijgewerkt.push({ id: g.id, naam: g.naam, postcodes });
    }
    res.json({
      bijgewerkt: bijgewerkt.length,
      details: bijgewerkt,
      overgeslagen: overgeslagen.length,
      geenLookup: geenLookup,
      opgehaald: new Date().toISOString(),
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /cluster/data — verzamelt in één response alle data voor cluster-analyse:
// per Belgische gemeente in de database (of alleen ?ids=a,b,c): fluvius-historie
// (2019-2025), MOW gewogen tellingen per publiek/semi × AC/DC/HPC, inwoners,
// oppervlakte, welvaartsindex. Bedoeld als "bulk fetch" zodat cluster-analyse
// buiten de backend één keer alle input tegelijk krijgt.
app.get('/cluster/data', async (req, res) => {
  try {
    const idsParam = req.query.ids;
    let query = 'SELECT id, naam, inwoners, oppervlakte_km2, welvaartsindex, postcodes FROM gemeenten';
    let params = [];
    if (idsParam) {
      const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean);
      query += ' WHERE id = ANY($1::text[])';
      params = [ids];
    }
    const { rows } = await pool.query(query, params);

    const perGemeente = {};

    // Helper: Fluvius historie ophalen (hergebruik van bestaande code)
    async function fluviusHistorie(postcodes) {
      const cumulatief = {};
      for (let j = 2019; j <= 2025; j++) cumulatief[j] = 0;
      let totaal = 0;
      const mislukt = [];
      for (const postcode of postcodes) {
        try {
          let offset = 0;
          let doorgaan = true;
          let maxPages = 20;
          while (doorgaan && maxPages > 0) {
            const url = `https://opendata.fluvius.be/api/v2/catalog/datasets/1_21-aangemelde-oplaadpunten-voor-ev/records?where=postcode%3D%22${encodeURIComponent(postcode)}%22&limit=100&offset=${offset}`;
            const resp = await fetch(url);
            if (!resp.ok) { mislukt.push(postcode); break; }
            const data = await resp.json();
            const records = data.records || [];
            for (const rec of records) {
              const jaarStr = rec.record?.fields?.jaartal_indienstname ?? rec.fields?.jaartal_indienstname ?? rec.jaartal_indienstname;
              const jaar = jaarStr ? parseInt(jaarStr, 10) : null;
              if (jaar == null || isNaN(jaar)) continue;
              for (let j = Math.max(jaar, 2019); j <= 2025; j++) cumulatief[j] += 1;
            }
            totaal += records.length;
            if (records.length < 100) doorgaan = false;
            offset += 100;
            maxPages--;
          }
        } catch(e) { mislukt.push(postcode); }
      }
      return { cumulatief, totaal, mislukt };
    }

    // MOW: telling per publiek/semi × AC/DC/HPC via lokale index
    function mowTellingen(gemeenteNaam) {
      const punten = mowLaadpuntenIndex.get(normaliseerNaam(gemeenteNaam)) || [];
      const tel = { Qp_AC:0, Qp_DC:0, Qp_HPC:0, Qs_AC:0, Qs_DC:0, Qs_HPC:0 };
      for (const p of punten) {
        const type = p.snelheid === 'ultrasnel' ? 'HPC' : p.snelheid === 'snel' ? 'DC' : 'AC';
        const isSemi = p.toegankelijkheid === 'semi-publiek';
        tel[(isSemi ? 'Qs_' : 'Qp_') + type] += 1;
      }
      return tel;
    }

    // Parallel Fluvius (batch van 5 tegelijk om rate limit te beheersen)
    const gemeenten = rows.filter(g => Array.isArray(g.postcodes) && g.postcodes.length);
    const batchGrootte = 5;
    for (let i = 0; i < gemeenten.length; i += batchGrootte) {
      const batch = gemeenten.slice(i, i + batchGrootte);
      await Promise.all(batch.map(async (g) => {
        const fluv = await fluviusHistorie(g.postcodes);
        const mow = mowTellingen(g.naam);
        perGemeente[g.id] = {
          naam: g.naam,
          inwoners: g.inwoners,
          oppervlakte_km2: g.oppervlakte_km2 != null ? parseFloat(g.oppervlakte_km2) : null,
          welvaartsindex: g.welvaartsindex != null ? parseFloat(g.welvaartsindex) : null,
          fluvius_cumulatief: fluv.cumulatief,
          fluvius_totaal: fluv.totaal,
          fluvius_mislukt: fluv.mislukt,
          mow: mow,
        };
      }));
    }

    res.json({
      gemeenten: perGemeente,
      aantal: Object.keys(perGemeente).length,
      opgehaald: new Date().toISOString(),
      bron: 'Fluvius Open Data + MOW-dataset 17/07/2026 + interne database',
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

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

// ══════════════════════════════════════════════════════════════════════
// POSTCODES PER NIS (Statbel/Bpost conversietabel, peildatum 01-01-2025)
// ══════════════════════════════════════════════════════════════════════
// In-memory Map: NIS-code (string) → array van postcodes (strings).
// Wordt bij server-start eerst geladen uit lokaal bestand; ontbreekt dat
// (of is de Map leeg), dan wordt de dataset asynchroon gedownload vanuit
// de Statbel-conversietabel op opendata.brussels.be. Endpoints blijven
// bereikbaar tijdens de download; geven 404 zolang de Map leeg is.
const POSTCODES_PATH = path.join(__dirname, 'geo-data', 'postcodes-per-nis.json');
const POSTCODES_API_URL = 'https://opendata.brussels.be/api/explore/v2.1/catalog/datasets/codes-postaux-et-codes-ins-communes-belges-20250101/records';
let postcodesPerNis = new Map();

async function downloadPostcodesPerNis() {
  const alles = {};
  let offset = 0;
  let doorgaan = true;
  let maxPages = 20; // 20 × 100 = 2000 records; dataset is ~1200
  let totaalRecords = 0;
  while (doorgaan && maxPages > 0) {
    const url = `${POSTCODES_API_URL}?limit=100&offset=${offset}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} bij offset=${offset}`);
    const data = await resp.json();
    const results = data.results || [];
    totaalRecords += results.length;
    for (const rec of results) {
      const nis = rec.refnis_code;
      const postcode = rec.postal_code;
      if (!nis || !postcode) continue;
      if (!alles[nis]) alles[nis] = [];
      if (!alles[nis].includes(postcode)) alles[nis].push(postcode);
    }
    if (results.length < 100) doorgaan = false;
    offset += 100;
    maxPages--;
  }
  return { alles, totaalRecords };
}

async function initPostcodesPerNis() {
  // Probeer eerst lokaal bestand (kan gecommit zijn in de repo)
  try {
    const inhoud = fs.readFileSync(POSTCODES_PATH, 'utf8');
    const data = JSON.parse(inhoud);
    postcodesPerNis = new Map(Object.entries(data));
    console.log(`  Postcodes per NIS geladen uit bestand: ${postcodesPerNis.size} gemeenten`);
    return;
  } catch(_) {
    console.log(`  Postcodes per NIS-bestand ontbreekt; downloaden vanuit Statbel/Bpost...`);
  }
  // Fallback: async download; server blijft in tussentijd draaien
  try {
    const { alles, totaalRecords } = await downloadPostcodesPerNis();
    postcodesPerNis = new Map(Object.entries(alles));
    console.log(`  Postcodes per NIS gedownload: ${postcodesPerNis.size} gemeenten (${totaalRecords} records)`);
    // Best-effort opslaan (Railway heeft ephemeral fs; falen is OK).
    try {
      const dir = path.dirname(POSTCODES_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(POSTCODES_PATH, JSON.stringify(alles, null, 2));
      console.log(`    ook opgeslagen: ${POSTCODES_PATH}`);
    } catch(_) { /* stil */ }
  } catch(e) {
    console.warn(`  Download postcodes-per-NIS mislukt: ${e.message}. Endpoint /geo/postcodes/:nis geeft 404 tot handmatige refresh via /admin/download-postcodes.`);
  }
}
// Async gestart bij module load; server.listen wacht hier niet op
initPostcodesPerNis();

// GET /geo/postcodes/:nis — postcodes voor één NIS-code (bijv. 23088 → [1800])
app.get('/geo/postcodes/:nis', (req, res) => {
  const { nis } = req.params;
  const postcodes = postcodesPerNis.get(nis);
  if (!postcodes) {
    return res.status(404).json({
      error: postcodesPerNis.size === 0
        ? 'Postcode-dataset nog niet geladen. Wacht enkele seconden of roep /admin/download-postcodes aan.'
        : `Geen postcodes gevonden voor NIS ${nis}.`,
      dataset_geladen: postcodesPerNis.size > 0,
      dataset_aantal_gemeenten: postcodesPerNis.size,
    });
  }
  res.json({ nis, postcodes, aantal: postcodes.length, bron: 'Statbel/Bpost 01-01-2025' });
});

// GET /admin/download-postcodes — handmatige refresh van de postcodes-dataset
app.get('/admin/download-postcodes', async (req, res) => {
  try {
    const { alles, totaalRecords } = await downloadPostcodesPerNis();
    postcodesPerNis = new Map(Object.entries(alles));
    // Best-effort opslaan
    try {
      const dir = path.dirname(POSTCODES_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(POSTCODES_PATH, JSON.stringify(alles, null, 2));
    } catch(_) { /* stil */ }
    res.json({
      succesvol: true,
      aantalGemeenten: postcodesPerNis.size,
      totaalRecords,
      opgeslagen: POSTCODES_PATH,
      bron: 'Statbel/Bpost via opendata.brussels.be, peildatum 01-01-2025',
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════

// GET /geo/gemeenten-lijst?land=België  — volledige lijst Vlaamse gemeenten
// voor de zoekbalk in het onboarding-paneel. Wordt bij pagina-load opgehaald,
// zodat de frontend niet meer met een hardcoded shortlist werkt.
// Bron: nis-lookup.js (Statbel 2024). Provincie wordt afgeleid uit de eerste
// twee cijfers van de NIS-code.
const { NIS_CODES } = require('./nis-lookup');

// Enkel Vlaamse provincies. Waalse (5/6/8/9), Waals-Brabant (25),
// Brussels-Hoofdstedelijk (21) worden hier uitgesloten.
const VLAAMSE_NIS_PREFIXES = {
  '11': 'Antwerpen', '12': 'Antwerpen', '13': 'Antwerpen',
  '23': 'Vlaams-Brabant', '24': 'Vlaams-Brabant',
  '31': 'West-Vlaanderen', '32': 'West-Vlaanderen', '33': 'West-Vlaanderen',
  '34': 'West-Vlaanderen', '35': 'West-Vlaanderen', '36': 'West-Vlaanderen',
  '37': 'West-Vlaanderen', '38': 'West-Vlaanderen',
  '41': 'Oost-Vlaanderen', '42': 'Oost-Vlaanderen', '43': 'Oost-Vlaanderen',
  '44': 'Oost-Vlaanderen', '45': 'Oost-Vlaanderen', '46': 'Oost-Vlaanderen',
  '71': 'Limburg', '72': 'Limburg', '73': 'Limburg',
};

// Nederlandse tussenvoegsels blijven klein: "Heist-op-den-Berg", niet
// "Heist-Op-Den-Berg". Namen in nis-lookup.js zijn lowercase.
const KLEIN_WOORDEN = new Set(['op','de','den','der','ter','van','en','met','aan','bij']);
function capitaliseerGemeentenaam(naam) {
  return naam.split(/([-\s])/).map((deel, i) => {
    if (deel === '-' || deel === ' ') return deel;
    const laag = deel.toLowerCase();
    if (i > 0 && KLEIN_WOORDEN.has(laag)) return laag;
    // Eerste letter naar hoofdletter, rest zoals is (behandelt apostrof correct: 's Gravenbrakel).
    return deel.charAt(0).toUpperCase() + deel.slice(1);
  }).join('');
}

app.get('/geo/gemeenten-lijst', (req, res) => {
  const land = req.query.land || 'België';
  // Nederlandse lijst blijft nog client-side hardcoded; enkel Belgische
  // gemeenten worden hier server-side geleverd.
  if (land !== 'België') {
    return res.json({ gemeenten: [], land, bron: 'geen (België-only)' });
  }
  const gemeenten = Object.entries(NIS_CODES)
    .filter(([, nis]) => VLAAMSE_NIS_PREFIXES[nis.substring(0, 2)] != null)
    .map(([naam, nis]) => ({
      naam: capitaliseerGemeentenaam(naam),
      nis,
      provincie: VLAAMSE_NIS_PREFIXES[nis.substring(0, 2)],
    }))
    .sort((a, b) => a.naam.localeCompare(b.naam, 'nl'));
  res.json({ gemeenten, land, aantal: gemeenten.length, bron: 'Statbel 2024 via nis-lookup.js' });
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

// server.js — Belli Laadkaart API
require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const { pool, initSchema, seedStartdata } = require('./db');

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
      aandeel_app: parseFloat(w.aandeel_app),
      lat:         parseFloat(w.lat),
      lng:         parseFloat(w.lng),
      wijktype:    w.wijktype,
      seg: {
        bew: parseFloat(w.seg_bewoners),
        bez: parseFloat(w.seg_bezoekers),
        log: parseFloat(w.seg_logistiek),
        ov:  parseFloat(w.seg_ov),
      },
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
    const { rows } = await pool.query(
      `SELECT id,naam,provincie,land,inwoners,voertuigen,
              center_lat,center_lng,zoom,kleur,bbox,aangemaakt,bijgewerkt
       FROM gemeenten ORDER BY naam`);
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
      INSERT INTO gemeenten (id,naam,provincie,land,inwoners,voertuigen,center_lat,center_lng,zoom,kleur,bbox)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [ g.id, g.naam, g.provincie||'', g.land||'België',
        g.inwoners||0, g.voertuigen||0,
        g.center?.[0]||0, g.center?.[1]||0,
        g.zoom||13, g.kleur||'#2B5F6E',
        JSON.stringify(g.bbox||[]) ]);

    if (g.wijken?.length) {
      for (let i=0; i<g.wijken.length; i++) {
        const w = g.wijken[i];
        await client.query(`
          INSERT INTO wijken (id,gemeente_id,naam,inwoners,voertuigen,aandeel_app,lat,lng,wijktype,seg_bewoners,seg_bezoekers,seg_logistiek,seg_ov,volgorde)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [ w.id||`WK${String(i+1).padStart(2,'0')}`, g.id,
            w.naam||`Wijk ${i+1}`, w.inwoners||0, w.voertuigen||0,
            w.aandeel_app||0.25, w.lat||0, w.lng||0,
            w.wijktype||'residentieel',
            w.seg?.bew||0.55, w.seg?.bez||0.25, w.seg?.log||0.12, w.seg?.ov||0.08,
            i ]);
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
        bijgewerkt=NOW()
      WHERE id=$11`,
      [ g.naam, g.provincie, g.land, g.inwoners, g.voertuigen,
        g.center?.[0], g.center?.[1], g.zoom, g.kleur,
        JSON.stringify(g.bbox), req.params.id ]);

    // Verwijder bestaande wijken en herplaats
    await client.query('DELETE FROM wijken WHERE gemeente_id=$1', [req.params.id]);
    if (g.wijken?.length) {
      for (let i=0; i<g.wijken.length; i++) {
        const w = g.wijken[i];
        await client.query(`
          INSERT INTO wijken (id,gemeente_id,naam,inwoners,voertuigen,aandeel_app,lat,lng,wijktype,seg_bewoners,seg_bezoekers,seg_logistiek,seg_ov,volgorde)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [ w.id, req.params.id, w.naam, w.inwoners, w.voertuigen,
            w.aandeel_app, w.lat, w.lng, w.wijktype||'residentieel',
            w.seg?.bew, w.seg?.bez, w.seg?.log, w.seg?.ov, i ]);
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
  const allowed = ['naam','provincie','inwoners','voertuigen','kleur','zoom'];
  const updates = Object.entries(fields)
    .filter(([k]) => allowed.includes(k))
    .map(([k,v], i) => `${k}=$${i+2}`);

  if (!updates.length) return res.status(400).json({ error:'Geen geldige velden' });

  try {
    await pool.query(
      `UPDATE gemeenten SET ${updates.join(',')},bijgewerkt=NOW() WHERE id=$1`,
      [req.params.id, ...Object.values(fields).filter((_,i) => allowed.includes(Object.keys(fields)[i]))]);
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
        naam=$1, inwoners=$2, voertuigen=$3, aandeel_app=$4,
        wijktype=$5, seg_bewoners=$6, seg_bezoekers=$7,
        seg_logistiek=$8, seg_ov=$9
      WHERE id=$10 AND gemeente_id=$11`,
      [ w.naam, w.inwoners, w.voertuigen, w.aandeel_app, w.wijktype,
        w.seg?.bew, w.seg?.bez, w.seg?.log, w.seg?.ov,
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


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
    `);
    console.log('✓ Schema gereed');
  } finally {
    client.release();
  }
}

// ── Seed-data: de drie startgemeenten ───────────────────────────────
async function seedStartdata() {
  const { rowCount } = await pool.query('SELECT 1 FROM gemeenten LIMIT 1');
  if (rowCount > 0) return; // al geseeded

  const STARTDATA = [
    {
      id:'leuven', naam:'Leuven', provincie:'Vlaams-Brabant', land:'België',
      inwoners:104906, voertuigen:48200,
      lat:50.8798, lng:4.7005, zoom:13, kleur:'#2B5F6E',
      bbox:[50.82,4.65,50.94,4.77],
      wijken:[
        { id:'LV01', naam:'Leuven Centrum',      inw:18400, vrt:7200,  app:0.48, lat:50.8793, lng:4.7009, type:'centrum',       bew:0.45, bez:0.38, log:0.10, ov:0.07 },
        { id:'LV02', naam:'Kessel-Lo',            inw:22100, vrt:9800,  app:0.28, lat:50.8900, lng:4.7280, type:'residentieel',  bew:0.62, bez:0.20, log:0.12, ov:0.06 },
        { id:'LV03', naam:'Heverlee',             inw:19600, vrt:9100,  app:0.22, lat:50.8560, lng:4.7050, type:'residentieel',  bew:0.65, bez:0.18, log:0.11, ov:0.06 },
        { id:'LV04', naam:'Wilsele',              inw:12300, vrt:5600,  app:0.18, lat:50.9100, lng:4.7050, type:'landelijk',     bew:0.70, bez:0.15, log:0.10, ov:0.05 },
        { id:'LV05', naam:'Wijgmaal',             inw:5200,  vrt:2400,  app:0.15, lat:50.9280, lng:4.7120, type:'landelijk',     bew:0.72, bez:0.14, log:0.09, ov:0.05 },
        { id:'LV06', naam:'Haasrode/Korbeek-Lo',  inw:8900,  vrt:4200,  app:0.12, lat:50.8420, lng:4.7400, type:'industrieel',   bew:0.68, bez:0.16, log:0.12, ov:0.04 },
        { id:'LV07', naam:'Binnenstad Oost',      inw:9800,  vrt:3200,  app:0.62, lat:50.8780, lng:4.7160, type:'centrum',       bew:0.38, bez:0.42, log:0.12, ov:0.08 },
        { id:'LV08', naam:'Arenberg/Wetenschap',  inw:6200,  vrt:4800,  app:0.20, lat:50.8640, lng:4.6880, type:'studentenwijk', bew:0.52, bez:0.22, log:0.18, ov:0.08 },
      ],
    },
    {
      id:'olen', naam:'Olen', provincie:'Antwerpen', land:'België',
      inwoners:14000, voertuigen:8200,
      lat:51.1400, lng:4.8600, zoom:13, kleur:'#3A6B4A',
      bbox:[51.10,4.82,51.18,4.91],
      wijken:[
        { id:'OL01', naam:'Olen Centrum',   inw:5200, vrt:3100, app:0.25, lat:51.1380, lng:4.8580, type:'centrum',     bew:0.58, bez:0.25, log:0.12, ov:0.05 },
        { id:'OL02', naam:'Olen Noord',     inw:3800, vrt:2300, app:0.15, lat:51.1520, lng:4.8550, type:'residentieel',bew:0.68, bez:0.18, log:0.11, ov:0.03 },
        { id:'OL03', naam:'Industriezone',  inw:800,  vrt:1200, app:0.08, lat:51.1350, lng:4.8750, type:'industrieel', bew:0.25, bez:0.20, log:0.48, ov:0.07 },
        { id:'OL04', naam:'Olen Oost',      inw:4200, vrt:2600, app:0.12, lat:51.1380, lng:4.8820, type:'residentieel',bew:0.70, bez:0.16, log:0.10, ov:0.04 },
      ],
    },
    {
      id:'gent', naam:'Gent', provincie:'Oost-Vlaanderen', land:'België',
      inwoners:268000, voertuigen:112000,
      lat:51.0543, lng:3.7174, zoom:12, kleur:'#9EC5CB',
      bbox:[50.99,3.64,51.12,3.80],
      wijken:[
        { id:'GN01', naam:'Gent Centrum',       inw:28000, vrt:9800,  app:0.65, lat:51.0543, lng:3.7174, type:'centrum',     bew:0.35, bez:0.45, log:0.12, ov:0.08 },
        { id:'GN02', naam:'Ledeberg',           inw:18000, vrt:7200,  app:0.45, lat:51.0380, lng:3.7350, type:'gemengd',     bew:0.55, bez:0.28, log:0.12, ov:0.05 },
        { id:'GN03', naam:'Wondelgem',          inw:22000, vrt:9400,  app:0.28, lat:51.0850, lng:3.7100, type:'residentieel',bew:0.65, bez:0.20, log:0.10, ov:0.05 },
        { id:'GN04', naam:'Mariakerke',         inw:19000, vrt:8200,  app:0.22, lat:51.0620, lng:3.6900, type:'residentieel',bew:0.68, bez:0.18, log:0.10, ov:0.04 },
        { id:'GN05', naam:'Gentse Kanaalzone',  inw:8000,  vrt:5800,  app:0.15, lat:51.0900, lng:3.7500, type:'industrieel', bew:0.30, bez:0.18, log:0.44, ov:0.08 },
        { id:'GN06', naam:'Drongen',            inw:15000, vrt:6800,  app:0.18, lat:51.0350, lng:3.6650, type:'landelijk',   bew:0.70, bez:0.16, log:0.10, ov:0.04 },
      ],
    },
  ];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const g of STARTDATA) {
      await client.query(`
        INSERT INTO gemeenten (id,naam,provincie,land,inwoners,voertuigen,center_lat,center_lng,zoom,kleur,bbox)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (id) DO NOTHING`,
        [g.id, g.naam, g.provincie, g.land, g.inwoners, g.voertuigen,
         g.lat, g.lng, g.zoom, g.kleur, JSON.stringify(g.bbox)]);

      for (let i = 0; i < g.wijken.length; i++) {
        const w = g.wijken[i];
        await client.query(`
          INSERT INTO wijken (id,gemeente_id,naam,inwoners,voertuigen,aandeel_app,lat,lng,wijktype,seg_bewoners,seg_bezoekers,seg_logistiek,seg_ov,volgorde)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
          ON CONFLICT (id,gemeente_id) DO NOTHING`,
          [w.id, g.id, w.naam, w.inw, w.vrt, w.app, w.lat, w.lng, w.type,
           w.bew, w.bez, w.log, w.ov, i]);
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

module.exports = { pool, initSchema, seedStartdata };

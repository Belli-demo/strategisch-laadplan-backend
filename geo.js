// geo.js — Geografische data via statische Statbel dataset (geen externe API)
// Bron: Statbel Statistische Sectoren 2024, FOD Economie open data licentie

const { pool } = require('./db');
const { findNisCode } = require('./nis-lookup');
const { getSectorenVoorNis } = require('./geo-data/index');

// ── Schema ───────────────────────────────────────────────────────────
async function initGeoSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS geo_sectoren (
        id          SERIAL PRIMARY KEY,
        gemeente_id TEXT NOT NULL REFERENCES gemeenten(id) ON DELETE CASCADE,
        nis_code    TEXT NOT NULL,
        naam        TEXT,
        subnaam     TEXT,
        geojson     JSONB NOT NULL,
        aangemaakt  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(gemeente_id, nis_code)
      );
      CREATE INDEX IF NOT EXISTS idx_geo_gem ON geo_sectoren(gemeente_id);
    `);
    // Voeg subnaam kolom toe als die nog niet bestaat (migratie)
    await client.query(`
      ALTER TABLE geo_sectoren ADD COLUMN IF NOT EXISTS subnaam TEXT;
    `);
    console.log('✓ Geo schema gereed');
  } finally {
    client.release();
  }
}

// ── Sectoren opslaan ─────────────────────────────────────────────────
async function saveSectoren(gemeenteId, features) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM geo_sectoren WHERE gemeente_id=$1', [gemeenteId]);
    let n = 0;
    for (const f of features) {
      if (!f.geometry) continue;
      const p = f.properties || {};
      await client.query(
        `INSERT INTO geo_sectoren (gemeente_id, nis_code, naam, subnaam, geojson)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (gemeente_id, nis_code) DO UPDATE SET naam=$3, subnaam=$4, geojson=$5`,
        [gemeenteId, p.NISCODE || `SEC_${n}`, p.NAAM || `Sector ${n+1}`,
         p.SUBNAAM || null, JSON.stringify(f)]
      );
      n++;
    }
    await client.query('COMMIT');
    return n;
  } catch(e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ── Sectoren ophalen uit DB ──────────────────────────────────────────
async function getSectorenFromDb(gemeenteId) {
  const { rows } = await pool.query(
    'SELECT nis_code, naam, subnaam, geojson FROM geo_sectoren WHERE gemeente_id=$1',
    [gemeenteId]
  );
  return rows.map(r => ({
    ...r.geojson,
    properties: {
      ...(r.geojson?.properties || {}),
      NAAM:    r.naam,
      NISCODE: r.nis_code,
      SUBNAAM: r.subnaam,
    }
  }));
}

// ── Hoofd-functie: onboard geo voor één gemeente ─────────────────────
async function onboardGemeenteGeo(gemeenteId, gemeenteNaam, land, nisOverride = null) {
  console.log(`  Geo: ${gemeenteNaam}`);

  // NIS-code bepalen
  const nisGem = nisOverride || findNisCode(gemeenteNaam);
  if (!nisGem) {
    console.warn(`  Geen NIS-code voor ${gemeenteNaam}`);
    return { saved: 0, source: 'none' };
  }

  // Sectoren ophalen uit statische Statbel data
  const features = getSectorenVoorNis(nisGem);
  if (features.length === 0) {
    console.warn(`  Geen sectoren voor NIS ${nisGem} (${gemeenteNaam})`);
    return { saved: 0, source: 'none', nisGem };
  }

  // Opslaan in database
  const saved = await saveSectoren(gemeenteId, features);
  console.log(`  ✓ ${saved} sectoren opgeslagen (Statbel)`);
  return { saved, source: 'statbel', nisGem };
}

module.exports = { initGeoSchema, onboardGemeenteGeo, getSectorenFromDb };

// geo-data/index.js — Centrale lookup voor alle Belgische statistische sectoren
// Laadt het juiste provinciebestand op basis van NIS-code

const PROVINCIE_MAP = {
  '11':'antwerpen','12':'antwerpen','13':'antwerpen',
  '21':'brussel',
  '23':'vlaams-brabant','24':'vlaams-brabant',
  '31':'west-vlaanderen','32':'west-vlaanderen','33':'west-vlaanderen',
  '34':'west-vlaanderen','35':'west-vlaanderen','36':'west-vlaanderen',
  '37':'west-vlaanderen','38':'west-vlaanderen',
  '41':'oost-vlaanderen','42':'oost-vlaanderen','43':'oost-vlaanderen',
  '44':'oost-vlaanderen','45':'oost-vlaanderen','46':'oost-vlaanderen',
  '51':'henegouwen','52':'henegouwen','53':'henegouwen','54':'henegouwen',
  '55':'henegouwen','56':'henegouwen','57':'henegouwen','58':'henegouwen',
  '61':'luik','62':'luik','63':'luik','64':'luik',
  '71':'limburg','72':'limburg','73':'limburg',
  '81':'luxemburg','82':'luxemburg','83':'luxemburg','84':'luxemburg','85':'luxemburg',
  '91':'namen','92':'namen','93':'namen',
};

function getSectorenVoorNis(nisCode) {
  if (!nisCode || nisCode.length < 2) return [];
  const prefix   = nisCode.substring(0, 2);
  const provincie = PROVINCIE_MAP[prefix] || 'overig';
  try {
    const mod  = require(`./sectoren-${provincie}`);
    const data = Object.values(mod)[0]; // eerste export van het module
    return data[nisCode] || [];
  } catch(e) {
    console.warn(`Geo data niet gevonden voor provincie ${provincie}:`, e.message);
    return [];
  }
}

function getSectorenVoorGemeente(gemeenteNaam) {
  const { findNisCode } = require('../nis-lookup');
  const nis = findNisCode(gemeenteNaam);
  if (!nis) return [];
  return getSectorenVoorNis(nis);
}

module.exports = { getSectorenVoorNis, getSectorenVoorGemeente };

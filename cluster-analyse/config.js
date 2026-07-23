/**
 * Configuratie voor de cluster-analyse module.
 * Pas hier de scope aan (aantal gemeenten, jaren, features).
 */
module.exports = {
  // Backend URL (waarnaartoe we het historie-endpoint aanroepen)
  BACKEND_URL: process.env.BACKEND_URL || 'https://strategisch-laadplan-backend-production.up.railway.app',

  // Jaren waarvoor we historische Fluvius-data ophalen (jaar_indienstname)
  HISTORIE_VANAF: 2019,
  HISTORIE_TOT: 2025,

  // Gemeenten in scope. Moeten IDs zijn die in de backend database bestaan
  // (voor postcode-lookup). Voor gemeenten die nog niet in de database staan,
  // eerst via de app aanmaken met postcodes.
  GEMEENTEN: [
    { id: 'antwerpen',    naam: 'Antwerpen' },
    { id: 'gent',         naam: 'Gent' },
    { id: 'leuven',       naam: 'Leuven' },
    { id: 'brugge',       naam: 'Brugge' },
    { id: 'mechelen',     naam: 'Mechelen' },
    { id: 'wemmel',       naam: 'Wemmel' },
    { id: 'meise',        naam: 'Meise' },
    { id: 'brasschaat',   naam: 'Brasschaat' },
    { id: 'kraainem',     naam: 'Kraainem' },
    { id: 'oud-heverlee', naam: 'Oud-Heverlee' },
    { id: 'zaventem',     naam: 'Zaventem' },
    { id: 'machelen',     naam: 'Machelen' },
    { id: 'vilvoorde',    naam: 'Vilvoorde' },
    { id: 'genk',         naam: 'Genk' },
    { id: 'olen',         naam: 'Olen' },
    { id: 'geel',         naam: 'Geel' },
    { id: 'diest',        naam: 'Diest' },
    { id: 'hasselt',      naam: 'Hasselt' },
    { id: 'oostende',     naam: 'Oostende' },
    { id: 'knokke-heist', naam: 'Knokke-Heist' },
  ],

  // Features gebruikt voor clustering
  FEATURES: [
    'privePctHuidig',
    'privePctGroei',
    'bevolkingsdichtheid',
    'welvaartsindex',
  ],

  MAX_CLUSTERS: 5,
  CLUSTER_METHODE: 'ward',
  OUTPUT_DIR: './output',
};

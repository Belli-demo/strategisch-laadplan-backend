/**
 * Configuratie voor de cluster-analyse module.
 * Pas hier de scope aan (aantal gemeenten, jaren, features).
 */
module.exports = {
  // Jaren waarvoor we historische Fluvius-data ophalen (jaar_indienstname)
  HISTORIE_VANAF: 2019,
  HISTORIE_TOT: 2025,

  // Gemeenten in scope voor deze run (fase A: 20 gemeenten uit verschillende profielen).
  // Voor productie later uitbreiden naar alle ~300 Vlaamse gemeenten.
  GEMEENTEN: [
    // Centrumsteden
    { id: 'antwerpen', naam: 'Antwerpen', nis: '11002', postcodes: ['2000','2018','2020','2030','2040','2050','2060','2100','2140','2170','2180','2600','2610','2660'] },
    { id: 'gent',      naam: 'Gent',      nis: '44021', postcodes: ['9000','9030','9040','9050'] },
    { id: 'leuven',    naam: 'Leuven',    nis: '24062', postcodes: ['3000','3001','3010','3012','3018'] },
    { id: 'brugge',    naam: 'Brugge',    nis: '31005', postcodes: ['8000','8200','8310','8380'] },
    { id: 'mechelen',  naam: 'Mechelen',  nis: '12025', postcodes: ['2800','2801','2811','2812'] },
    // Woongemeenten residentieel
    { id: 'wemmel',    naam: 'Wemmel',    nis: '23102', postcodes: ['1780'] },
    { id: 'meise',     naam: 'Meise',     nis: '23050', postcodes: ['1860','1861'] },
    { id: 'brasschaat',naam: 'Brasschaat',nis: '11008', postcodes: ['2930'] },
    { id: 'kraainem',  naam: 'Kraainem',  nis: '23099', postcodes: ['1950'] },
    { id: 'oud-heverlee',naam:'Oud-Heverlee',nis:'24086',postcodes: ['3050','3051','3052'] },
    // Forensen/bedrijventerrein
    { id: 'zaventem',  naam: 'Zaventem',  nis: '23094', postcodes: ['1930','1932','1933'] },
    { id: 'machelen',  naam: 'Machelen',  nis: '23047', postcodes: ['1830','1831'] },
    { id: 'vilvoorde', naam: 'Vilvoorde', nis: '23088', postcodes: ['1800'] },
    { id: 'genk',      naam: 'Genk',      nis: '71016', postcodes: ['3600'] },
    // Landelijk/kleiner
    { id: 'olen',      naam: 'Olen',      nis: '13029', postcodes: ['2250'] },
    { id: 'geel',      naam: 'Geel',      nis: '13008', postcodes: ['2440'] },
    { id: 'diest',     naam: 'Diest',     nis: '24020', postcodes: ['3290','3293'] },
    { id: 'hasselt',   naam: 'Hasselt',   nis: '71022', postcodes: ['3500','3501','3510','3511','3512'] },
    // Kust/toeristisch
    { id: 'oostende',  naam: 'Oostende',  nis: '35013', postcodes: ['8400'] },
    { id: 'knokke-heist', naam: 'Knokke-Heist', nis: '31043', postcodes: ['8300','8301'] },
  ],

  // Fluvius API
  FLUVIUS_URL: 'https://opendata.fluvius.be/api/explore/v2.1/catalog/datasets/1_21-aangemelde-oplaadpunten-voor-ev/records',
  FLUVIUS_RATE_LIMIT_MS: 1100, // 1 call/seconde met marge

  // Features gebruikt voor clustering
  FEATURES: [
    'privePctHuidig',      // gemeten 2025 stand
    'privePctGroei',        // gemiddelde jaar-op-jaar verandering 2020-2025
    'bevolkingsdichtheid',  // inw/km2
    'welvaartsindex',
  ],

  // Clustering parameters
  MAX_CLUSTERS: 5,
  CLUSTER_METHODE: 'ward',

  // Output
  OUTPUT_DIR: './output',
};

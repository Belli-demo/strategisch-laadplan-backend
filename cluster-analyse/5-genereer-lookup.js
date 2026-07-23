/**
 * Stap 5: genereer eindresultaat cluster-lookup.json.
 * Per gemeente-id: welk cluster, welke slope (dalings-/groeifactor), r2 als betrouwbaarheid.
 *
 * Output: output/cluster-lookup.json
 * Wordt gelezen door backend endpoint /cluster/lookup/:gemeenteId
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');

async function main() {
  const clusters = JSON.parse(fs.readFileSync(path.join(config.OUTPUT_DIR, 'clusters.json')));
  const curves = JSON.parse(fs.readFileSync(path.join(config.OUTPUT_DIR, 'curves-per-cluster.json')));

  const lookup = {};
  for (const [id, c] of Object.entries(clusters)) {
    const curve = curves[c.cluster];
    lookup[id] = {
      cluster: c.cluster,
      privePctDalingPerJaar: -curve.slope,  // positieve waarde: hoeveel privé daalt/jaar
      betrouwbaarheid_r2: curve.r2,
      cluster_ledenAantal: curve.ledenAantal,
    };
  }

  const meta = {
    gegenereerd: new Date().toISOString(),
    aantalGemeenten: Object.keys(lookup).length,
    aantalClusters: Object.keys(curves).length,
    kappa: 1/0.65,
    features: config.FEATURES,
  };
  const uit = path.join(config.OUTPUT_DIR, 'cluster-lookup.json');
  fs.writeFileSync(uit, JSON.stringify({ meta, lookup }, null, 2));
  console.log(`Klaar: ${uit}`);
  console.log(`  ${Object.keys(lookup).length} gemeenten, ${Object.keys(curves).length} clusters`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

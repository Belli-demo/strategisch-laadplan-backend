# Cluster-analyse module

Vervangt de placeholder-daling (2%/jaar) in Stap 3 van het prognosemodel door een empirisch afgeleide dalingscurve per gemeente-cluster.

## Hoe werkt het

Gemeenten worden ingedeeld in clusters op basis van hun profiel (privePct-huidig, historische groei, bevolkingsdichtheid, welvaartsindex). Per cluster wordt de historische trend van de privé-fractie gefit (lineaire regressie). Elke gemeente krijgt de curve van zijn cluster als input voor de prognose.

## Structuur

```
cluster-analyse/
├── config.js              parameters (gemeenten, jaren, features)
├── 1-haal-historie.js     Fluvius jaar_indienstname → tijdreeks per gemeente
├── 2-bereken-features.js  feature-vector per gemeente
├── 3-cluster.js           Ward-linkage hiërarchische clustering
├── 4-fit-curves.js        per cluster: lineaire trend fitten
├── 5-genereer-lookup.js   eindresultaat cluster-lookup.json
├── output/                tussenresultaten en eindresultaat
└── package.json
```

## Uitvoeren

```bash
cd cluster-analyse
npm install
npm run all           # draait 1 → 5 achter elkaar
```

Losse stappen: `npm run 1-historie`, `npm run 2-features`, etc.

Runtime: ~5-10 minuten voor 20 gemeenten (Fluvius rate-limit 1 call/seconde).

## Output

`output/cluster-lookup.json` heeft per gemeente:

```json
{
  "leuven": {
    "cluster": 0,
    "privePctDalingPerJaar": 0.032,
    "betrouwbaarheid_r2": 0.87,
    "cluster_ledenAantal": 5
  }
}
```

Dit wordt gelezen door het backend endpoint `/cluster/lookup/:gemeenteId` en door de frontend gebruikt in plaats van de PRIVE_DALING_PER_JAAR placeholder in gemeenteData.js V5.

## Uitbreiden

- **Meer gemeenten**: voeg toe aan `config.GEMEENTEN`, herhaal
- **Meer features**: voeg toe aan `config.FEATURES` en `2-bereken-features.js`
- **Andere clustering-methode**: pas `config.CLUSTER_METHODE` aan (agnes options)
- **MOW-historie**: nu ongebruikt (dataset heeft geen datum-veld); zodra beschikbaar toevoegen in stap 1
- **Backtest**: hergebruik `historie-per-gemeente.json`, run model met 2020-startjaar, vergelijk met 2025-werkelijkheid

## Integratie in backend

Nieuwe endpoint in `server.js`:

```js
const clusterLookup = require('./cluster-analyse/output/cluster-lookup.json');
app.get('/cluster/lookup/:id', (req, res) => {
  const entry = clusterLookup.lookup[req.params.id];
  if (!entry) return res.status(404).json({ error: 'geen cluster' });
  res.json({ ...entry, meta: clusterLookup.meta });
});
```

## Integratie in frontend

In `gemeenteData.js` V5, laat `berekenPubliekSemiSplitV5` een optionele `priveDaling` accepteren (dat doet hij al). In `AppWithOnboarding.js`: haal `/cluster/lookup/:id` op bij gemeente-load, geef `entry.privePctDalingPerJaar` mee als `opts.priveDaling`.

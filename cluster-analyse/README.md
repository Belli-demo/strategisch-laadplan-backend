# Cluster-analyse module

Vervangt de placeholder-daling (2%/jaar) in Stap 3 door een empirisch afgeleide dalingscurve per cluster.

## Werking

1. Backend endpoint `/geo/fluvius-historie/:id` levert per gemeente de cumulatieve Fluvius-stand per jaar (2019-2025).
2. Feature-vector per gemeente wordt berekend (privePct nu, groei, dichtheid, welvaartsindex).
3. Hiërarchische clustering (Ward) groepeert gemeenten met vergelijkbaar profiel.
4. Per cluster: lineaire regressie op privé-fractie tijdreeks.
5. Output: `cluster-lookup.json` met per gemeente cluster + daling per jaar + R².

## Uitvoeren

Vereist: bij backend een endpoint `/geo/fluvius-historie/:id` (zie server.js).

```bash
cd cluster-analyse
npm install
BACKEND_URL=https://jouw-backend.up.railway.app npm run all
```

Runtime: ~1-2 minuten (rate-limiting zit in de backend).

## Output

`output/cluster-lookup.json` per gemeente:
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

Wordt door de app gebruikt in plaats van de PRIVE_DALING_PER_JAAR placeholder in gemeenteData.js V5.

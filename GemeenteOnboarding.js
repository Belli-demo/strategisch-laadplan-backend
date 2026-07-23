import React, { useState, useCallback } from 'react';

// ── Kleuren ─────────────────────────────────────────────────────────
const C = {
  darkBg:'#0d1c22', panelBg:'#122028', border:'#1e3a46',
  teal:'#9EC5CB', tealDark:'#2B5F6E', green:'#B7D2AE',
  darkGreen:'#3A6B4A', gold:'#D0AC41', warn:'#E8683A',
  text:'#e0eef2', textMid:'#7aacb4', textDim:'#3a6a74',
};

// Zelfde drie wijktypes als het gevalideerde rekenmodel (zie Leeswijzer §5).
// Een wijk kan er meerdere aanvinken (bijvoorbeeld woonwijk + bedrijventerrein
// voor een hybride wijk); calcWijk middelt dan de bijbehorende doelgroepenmix.
const WIJKTYPES = [
  { key:'binnenstad',       label:'Binnenstad' },
  { key:'woonwijk',         label:'Woonwijk' },
  { key:'bedrijventerrein', label:'Bedrijventerrein' },
];

// ── Stap-labels ──────────────────────────────────────────────────────
const STAPPEN = ['Gemeente zoeken', 'Wijken & Data', 'Wijktype', 'Bevestiging'];

// ── API calls ────────────────────────────────────────────────────────

// Nominatim: gemeente → center, bbox, NIS-code
// Robuuste versie: retry bij falen (Nominatim heeft rate-limit 1/sec + soms
// tijdelijke uitval). Fallback: probeer zonder land-suffix als eerste poging
// niets oplevert.
async function fetchNominatimSingle(query, land) {
  const q = encodeURIComponent(query);
  const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=5&addressdetails=1&countrycodes=${land === 'België' ? 'be' : 'nl'}`;
  const resp = await fetch(url, { headers:{ 'User-Agent':'Belli-Laadkaart/1.0 (info@belli.eu)' } });
  if (!resp.ok) {
    const err = new Error(`Nominatim HTTP ${resp.status}`);
    err.retryable = resp.status === 429 || resp.status >= 500;
    throw err;
  }
  const data = await resp.json();
  return data;
}

async function fetchNominatim(naam, land) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const queries = [`${naam}, ${land}`, naam]; // eerst met land, dan zonder
  let laatsteFout = null;

  for (const query of queries) {
    for (let poging = 0; poging < 3; poging++) {
      try {
        const data = await fetchNominatimSingle(query, land);
        // Filter op municipality/city/town/village en boundary
        const match = data.find(d => ['municipality','city','town','village'].includes(d.type) || d.class === 'boundary')
          || data[0];
        if (match) {
          const bb = match.boundingbox; // [south, north, west, east]
          return {
            center: [parseFloat(match.lat), parseFloat(match.lon)],
            bbox:   [parseFloat(bb[0]), parseFloat(bb[2]), parseFloat(bb[1]), parseFloat(bb[3])],
            displayName: match.display_name.split(',').slice(0,2).join(', '),
            osmId: match.osm_id,
            type:  match.type,
          };
        }
        break; // geen match voor deze query, probeer volgende query
      } catch (e) {
        laatsteFout = e;
        if (!e.retryable) break; // niet-retryable fout, ga naar volgende query
        await sleep(1500); // wacht voor rate-limit
      }
    }
  }

  if (laatsteFout) throw new Error(`Nominatim onbereikbaar (${laatsteFout.message}). Probeer opnieuw over 10-20 seconden.`);
  throw new Error(`Gemeente "${naam}" niet gevonden in OpenStreetMap. Controleer de spelling.`);
}

// Oppervlakte (km2) van een polygoon obv lat/lon-coördinaten, met een lokale
// equirectangulaire projectie (voldoende nauwkeurig op de schaal van een
// gemeente/wijk). Retourneert null als er geen bruikbare geometrie is.
function polygonOppervlakteKm2(coords) {
  if (!coords || coords.length < 3) return null;
  const R = 6371; // aardstraal in km
  const latRad = (coords.reduce((s,c) => s + c.lat, 0) / coords.length) * Math.PI / 180;
  const kmPerDegLat = R * Math.PI / 180;
  const kmPerDegLon = R * Math.cos(latRad) * Math.PI / 180;
  let opp = 0;
  for (let i = 0; i < coords.length; i++) {
    const j = (i + 1) % coords.length;
    const xi = coords[i].lon * kmPerDegLon, yi = coords[i].lat * kmPerDegLat;
    const xj = coords[j].lon * kmPerDegLon, yj = coords[j].lat * kmPerDegLat;
    opp += xi * yj - xj * yi;
  }
  return Math.abs(opp) / 2;
}

// Haalt uit een Overpass-element (way of relation, met "out geom") een
// bruikbare oppervlakte, indien de geometrie dat toelaat. Bij een relation
// (multipolygoon) wordt de "outer"-ring gebruikt, gaten in de polygoon
// worden dus niet afgetrokken, een bewuste, benoemde vereenvoudiging.
function elementOppervlakteKm2(el) {
  if (el.type === 'way' && el.geometry?.length >= 3) {
    return polygonOppervlakteKm2(el.geometry);
  }
  if (el.type === 'relation' && el.members?.length) {
    const outer = el.members.find(m => m.role === 'outer' && m.geometry?.length >= 3);
    if (outer) return polygonOppervlakteKm2(outer.geometry);
  }
  return null;
}

// Haalt de echte oppervlakte van de hele gemeente op via haar eigen
// administratieve grens (indien Overpass die teruggeeft). Valt terug op
// null als dat niet lukt, de aanroeper moet dan zelf een schatting maken
// (bijv. obv de bbox) en dat duidelijk als zodanig markeren.
async function fetchGemeenteOppervlakte(naam) {
  const query = `[out:json][timeout:20];
relation["boundary"="administrative"]["admin_level"~"8|9"]["name"="${naam}"];
out geom;`;
  try {
    const resp = await fetch('https://overpass-api.de/api/interpreter', {
      method:'POST', body:'data='+encodeURIComponent(query),
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    for (const el of (json.elements || [])) {
      const opp = elementOppervlakteKm2(el);
      if (opp) return opp;
    }
  } catch { /* stil falen, aanroeper valt terug op bbox-schatting */ }
  return null;
}

// Echte bevolkingsopzoeking via Wikidata (property P1082 = bevolking), i.p.v.
// de oude, foutief als "Bron: Statbel" gelabelde gok (oppervlakte × dichtheid).
// Filtert op P17=Q31 (land = België) om verwarring met gelijknamige plaatsen
// elders te voorkomen (bijv. Hasselt bestaat ook als buurtnaam in Nederland).
async function fetchGemeenteBevolking(naam) {
  try {
    const zoekUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(naam)}&language=nl&format=json&type=item&origin=*&limit=5`;
    const zoekResp = await fetch(zoekUrl);
    if (!zoekResp.ok) return null;
    const zoekData = await zoekResp.json();
    if (!zoekData.search?.length) return null;

    for (const kandidaat of zoekData.search) {
      const entityUrl = `https://www.wikidata.org/wiki/Special:EntityData/${kandidaat.id}.json`;
      const entityResp = await fetch(entityUrl);
      if (!entityResp.ok) continue;
      const entityData = await entityResp.json();
      const claims = entityData.entities?.[kandidaat.id]?.claims;
      const land = claims?.P17?.[0]?.mainsnak?.datavalue?.value?.id;
      if (land !== 'Q31') continue; // niet België, overslaan
      const bevolkingClaims = claims?.P1082;
      if (!bevolkingClaims?.length) continue;
      // Meest recente bevolkingsopgave (P1082 kan meerdere tijdstippen bevatten)
      const meestRecent = bevolkingClaims.reduce((best, c) => {
        const datum = c.qualifiers?.P585?.[0]?.datavalue?.value?.time || '';
        return (!best || datum > best.datum) ? { datum, waarde: c.mainsnak?.datavalue?.value?.amount } : best;
      }, null);
      const aantal = meestRecent?.waarde ?? bevolkingClaims[0].mainsnak?.datavalue?.value?.amount;
      if (aantal) return Math.abs(parseInt(aantal));
    }
  } catch { /* stil falen, aanroeper valt terug op de oude schatting */ }
  return null;
}

// Overpass: haal deelgemeenten/wijken op, mét grenzen waar beschikbaar
// (voor de dekkingsberekening o.b.v. MOW's 250m-norm), anders alleen als punt
// (naam + positie), de oppervlakte wordt dan later proportioneel verdeeld.
async function fetchWijkenViaOverpass(bbox) {
  const [s, w, n, e] = bbox;
  const query = `[out:json][timeout:25];
(
  node["place"~"suburb|neighbourhood|district|quarter"](${s},${w},${n},${e});
  way["place"~"suburb|neighbourhood|quarter"](${s},${w},${n},${e});
  relation["boundary"="administrative"]["admin_level"~"9|10"](${s},${w},${n},${e});
  way["boundary"="administrative"]["admin_level"~"9|10"](${s},${w},${n},${e});
);
out geom;`;
  const resp = await fetch('https://overpass-api.de/api/interpreter', {
    method:'POST', body:'data='+encodeURIComponent(query),
  });
  if (!resp.ok) return [];
  const json = await resp.json();
  return (json.elements || [])
    .filter(el => el.tags?.name)
    .map(el => {
      const isPoly = el.type === 'way' || el.type === 'relation';
      let lat = el.lat, lng = el.lon, oppervlakteKm2 = null;
      if (isPoly) {
        oppervlakteKm2 = elementOppervlakteKm2(el);
        const geom = el.type === 'way' ? el.geometry : el.members?.find(m => m.role === 'outer')?.geometry;
        if (geom?.length) {
          lat = geom.reduce((s,c) => s + c.lat, 0) / geom.length;
          lng = geom.reduce((s,c) => s + c.lon, 0) / geom.length;
        }
      }
      return {
        id:   `WK_${el.id}`,
        naam: el.tags.name,
        lat, lng, oppervlakteKm2,
        type: el.tags.place || el.tags.admin_level || 'wijk',
      };
    })
    .filter(w => w.lat != null && w.lng != null)
    // Zelfde wijk kan als los punt én als polygoon voorkomen (bijv. een
    // "place"-node naast een "boundary"-relation met dezelfde naam); geef
    // de voorkeur aan de versie mét een echte, gemeten oppervlakte.
    .reduce((acc, w) => {
      const bestaand = acc.find(x => x.naam === w.naam);
      if (!bestaand) acc.push(w);
      else if (!bestaand.oppervlakteKm2 && w.oppervlakteKm2) Object.assign(bestaand, w);
      return acc;
    }, [])
    .slice(0, 20); // max 20 wijken
}

// ══════════════════════════════════════════════════════════════════════
// COMPONENT
// ══════════════════════════════════════════════════════════════════════
export default function GemeenteOnboarding({ onComplete, onClose }) {
  const [stap,          setStap]         = useState(0);
  const [zoekNaam,      setZoekNaam]     = useState('');
  const [land,          setLand]         = useState('België');
  const [loading,       setLoading]      = useState(false);
  const [error,         setError]        = useState('');

  // Gemeente data
  const [geoData,       setGeoData]      = useState(null);
  const [wijken,        setWijken]       = useState([]);
  const [gemeenteNaam,  setGemeenteNaam] = useState('');
  const [inwoners,      setInwoners]     = useState('');
  const [voertuigen,    setVoertuigen]   = useState('');
  const [welvaartsindex,setWelvaartsindex] = useState('106.9');
  const [privePct,      setPrivePct]     = useState('50');
  const [gemeenteOppervlakteKm2, setGemeenteOppervlakteKm2] = useState(null);
  const [inwonersIsSchatting, setInwonersIsSchatting] = useState(true);

  // Wijk editing
  const [editIdx,       setEditIdx]      = useState(null);

  const kleur = C.tealDark;

  // ── Stap 1: zoek gemeente ────────────────────────────────────────
  const zoekGemeente = useCallback(async () => {
    if (!zoekNaam.trim()) return;
    setLoading(true); setError('');
    try {
      const geo = await fetchNominatim(zoekNaam.trim(), land);
      setGeoData(geo);
      setGemeenteNaam(zoekNaam.trim());

      // Ruwe bbox-proxy, ALLEEN als allerlaatste terugvaloptie als de echte
      // opzoeking hieronder niets oplevert.
      const latDiff  = geo.bbox[2] - geo.bbox[0];
      const lngDiff  = geo.bbox[3] - geo.bbox[1];
      const km2Schat = Math.round(latDiff * lngDiff * 12000);
      const inwSchatRuw = Math.min(Math.max(km2Schat * 80, 5000), 500000);

      // Echte bevolkingsopzoeking via Wikidata. Dit was voorheen een gok die
      // ten onrechte als "Bron: Statbel" werd getoond; nu een echte, actuele
      // opzoeking, met de oude gok alleen nog als terugvaloptie.
      const echteBevolking = await fetchGemeenteBevolking(zoekNaam.trim());
      const inwSchat = echteBevolking || inwSchatRuw;
      setInwonersIsSchatting(!echteBevolking);
      setInwoners(String(inwSchat));
      // Voertuigenratio obv het gemiddelde van onze vier geverifieerde
      // gemeenten (Leuven 0,459 / Gent 0,354 / Hasselt 0,501, gemiddeld
      // ~0,44), i.p.v. de eerdere, niet onderbouwde 0,45. Blijft een
      // schatting totdat er een echte, per-gemeente voertuigenbron is.
      setVoertuigen(String(Math.round(inwSchat * 0.44 / 100) * 100));

      // Echte gemeente-oppervlakte via Overpass; valt terug op de bbox-
      // schatting hierboven als er geen administratieve grens gevonden wordt
      // (in dat geval blijft de oppervlakte een schatting, niet een meting)
      const gemeenteOppervlakte = (await fetchGemeenteOppervlakte(zoekNaam.trim())) || km2Schat;
      setGemeenteOppervlakteKm2(gemeenteOppervlakte);

      // Haal wijken op via Overpass
      const wkData = await fetchWijkenViaOverpass(geo.bbox);
      if (wkData.length > 0) {
        const totInwSchat = wkData.length; // gelijk verdeeld als startpunt, hieronder proportioneel over gemeten oppervlaktes waar bekend
        setWijken(wkData.map((w, i) => {
          const wijkInwoners = Math.round(inwSchat / Math.max(wkData.length, 1) / 100) * 100;
          return {
            ...w,
            id:          `NK${String(i+1).padStart(2,'0')}`,
            inwoners:    wijkInwoners,
            voertuigen:  Math.round(inwSchat * 0.45 / Math.max(wkData.length, 1) / 50) * 50,
            // Echte, via Overpass gemeten oppervlakte blijft staan (w.oppervlakteKm2
            // uit fetchWijkenViaOverpass); is die er niet, dan een proxy op basis
            // van inwonersaandeel van de gemeente-oppervlakte, duidelijk als
            // zodanig te herkennen (oppervlakteIsProxy: true) totdat er een
            // echte meting beschikbaar komt.
            oppervlakteKm2: w.oppervlakteKm2 ?? (gemeenteOppervlakte / Math.max(wkData.length, 1)),
            oppervlakteIsProxy: w.oppervlakteKm2 == null,
            wijktype:    ['woonwijk'],
            ovAandeel:   0,
            actief:      true,
          };
        }));
      } else {
        // Fallback: maak 4 standaard wijken
        const kwarten = ['Noord','Zuid','Oost','West'];
        const offsets = [[0.01,0],[-0.01,0],[0,0.01],[0,-0.01]];
        setWijken(kwarten.map((naam, i) => ({
          id:          `NK0${i+1}`,
          naam,
          lat:         geo.center[0] + (offsets[i]?.[0] || 0),
          lng:         geo.center[1] + (offsets[i]?.[1] || 0),
          inwoners:    Math.round(inwSchat / 4 / 100) * 100,
          voertuigen:  Math.round(inwSchat * 0.45 / 4 / 50) * 50,
          oppervlakteKm2: gemeenteOppervlakte / 4,
          oppervlakteIsProxy: true,
          wijktype:    ['woonwijk'],
          ovAandeel:   0,
          actief:      true,
        })));
      }
      setStap(1);
    } catch(e) {
      setError(e.message);
    }
    setLoading(false);
  }, [zoekNaam, land]);

  // ── Stap 2: wijktype aan/uit ──────────────────────────────────────
  const toggleWijktype = (idx, key) => {
    setWijken(ws => ws.map((w, i) => {
      if (i !== idx) return w;
      const huidig = w.wijktype || [];
      const heeft = huidig.includes(key);
      const nieuw = heeft ? huidig.filter(t => t !== key) : [...huidig, key];
      return { ...w, wijktype: nieuw.length ? nieuw : ['woonwijk'] }; // nooit helemaal leeg
    }));
  };

  const updateWijk = (idx, field, val) => {
    setWijken(ws => ws.map((w, i) => i === idx ? { ...w, [field]: val } : w));
  };

  const toggleWijk = (idx) => {
    setWijken(ws => ws.map((w, i) => i === idx ? { ...w, actief: !w.actief } : w));
  };

  const addWijk = () => {
    const n = wijken.length + 1;
    setWijken(ws => [...ws, {
      id:`NK${String(n).padStart(2,'0')}`, naam:`Wijk ${n}`,
      lat: geoData.center[0] + (Math.random()-0.5)*0.02,
      lng: geoData.center[1] + (Math.random()-0.5)*0.02,
      inwoners: 5000, voertuigen: 2000,
      wijktype:['woonwijk'], ovAandeel:0, actief:true,
    }]);
  };

  // ── Stap 4: genereer gemeente-object ─────────────────────────────
  const bevestig = () => {
    const actieveWijken = wijken.filter(w => w.actief);
    const id = gemeenteNaam.toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_]/g, '');
    const gemeente = {
      id, naam: gemeenteNaam,
      provincie: land,
      inwoners:  parseInt(inwoners) || 50000,
      voertuigen:parseInt(voertuigen) || 22000,
      welvaartsindex:   parseFloat(welvaartsindex) || 106.9,
      privePctBerekend: (parseFloat(privePct) || 50) / 100,
      oppervlakteKm2:   gemeenteOppervlakteKm2,
      center:    geoData.center,
      zoom:      13,
      bbox:      geoData.bbox,
      kleur,
      wijken:    actieveWijken.map(w => ({
        id:         w.id,
        naam:       w.naam,
        inwoners:   parseInt(w.inwoners) || 5000,
        voertuigen: parseInt(w.voertuigen) || 2000,
        wijktype:   w.wijktype && w.wijktype.length ? w.wijktype : ['woonwijk'],
        ovAandeel:  w.ovAandeel || 0,
        oppervlakteKm2: w.oppervlakteKm2 || null,
        lat:        w.lat,
        lng:        w.lng,
      })),
    };
    onComplete(gemeente);
  };

  // ── Stijlen ───────────────────────────────────────────────────────
  const s = {
    overlay:  { position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:2000, display:'flex', alignItems:'center', justifyContent:'center' },
    modal:    { width:680, maxHeight:'90vh', background:C.panelBg, border:`1px solid ${C.border}`, borderRadius:12, display:'flex', flexDirection:'column', overflow:'hidden', boxShadow:'0 20px 60px rgba(0,0,0,0.6)' },
    header:   { padding:'18px 24px 14px', borderBottom:`1px solid ${C.border}`, display:'flex', justifyContent:'space-between', alignItems:'flex-start' },
    title:    { fontSize:16, fontWeight:800, color:C.text },
    subtitle: { fontSize:11, color:C.textDim, marginTop:3 },
    close:    { cursor:'pointer', color:C.textDim, fontSize:20, lineHeight:1 },
    steps:    { display:'flex', padding:'0 24px', borderBottom:`1px solid ${C.border}`, background:'#0a1620' },
    step:     (active, done) => ({ padding:'10px 0', marginRight:24, fontSize:11, fontWeight:700, color: done ? C.green : active ? C.teal : C.textDim, borderBottom:`2px solid ${done ? C.green : active ? C.teal : 'transparent'}`, cursor: done ? 'pointer' : 'default' }),
    body:     { flex:1, overflowY:'auto', padding:'20px 24px' },
    footer:   { padding:'14px 24px', borderTop:`1px solid ${C.border}`, display:'flex', justifyContent:'space-between', alignItems:'center' },
    input:    { width:'100%', background:'#0a1620', border:`1px solid ${C.border}`, borderRadius:6, padding:'8px 12px', color:C.text, fontSize:13, outline:'none' },
    label:    { fontSize:11, color:C.textMid, marginBottom:4, display:'block' },
    row:      { marginBottom:14 },
    btn:      (primary) => ({ padding:'8px 20px', borderRadius:6, fontSize:12, fontWeight:700, cursor:'pointer', border:'none', background: primary ? C.tealDark : '#1e3a46', color:'#fff', transition:'all 0.15s' }),
    error:    { background:'#3a0a0a', border:`1px solid ${C.warn}`, borderRadius:6, padding:'8px 12px', fontSize:11, color:C.warn, marginTop:8 },
    tag:      (active) => ({ display:'inline-block', padding:'3px 10px', borderRadius:4, fontSize:10, fontWeight:700, cursor:'pointer', margin:'3px 3px 3px 0', border:`1px solid ${active ? C.tealDark : C.border}`, background: active ? C.tealDark+'44' : 'transparent', color: active ? '#ffffff' : C.textDim }),
    wijkCard: (actief) => ({ background:'#0a1620', border:`1px solid ${actief ? C.border : '#0f2430'}`, borderRadius:8, padding:'12px 14px', marginBottom:8, opacity: actief ? 1 : 0.45 }),
    grid2:    { display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 },
    grid3:    { display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8 },
    hint:     { fontSize:10, color:C.textDim, marginTop:3, lineHeight:1.5 },
    divider:  { borderTop:`1px solid ${C.border}`, margin:'16px 0' },
    badge:    (color) => ({ display:'inline-block', padding:'2px 8px', borderRadius:3, fontSize:9, fontWeight:700, background:color+'22', color, border:`1px solid ${color}44` }),
    autoTag:  { fontSize:9, color:C.gold, background:'#D0AC4122', padding:'1px 6px', borderRadius:3, marginLeft:6 },
  };

  // ── Progressiebar ─────────────────────────────────────────────────
  const Progress = () => (
    <div style={s.steps}>
      {STAPPEN.map((naam, i) => (
        <div key={i} style={s.step(i===stap, i<stap)}
          onClick={() => i < stap && setStap(i)}>
          {i < stap ? '✓ ' : ''}{naam}
        </div>
      ))}
    </div>
  );

  const totaalInwoners = wijken.filter(w=>w.actief).reduce((s,w) => s + (parseInt(w.inwoners)||0), 0);

  return (
    <div style={s.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={s.modal}>

        {/* Header */}
        <div style={s.header}>
          <div>
            <div style={s.title}>Nieuwe gemeente toevoegen</div>
            <div style={s.subtitle}>Automatisch ophalen via OpenStreetMap &amp; Overpass · Handmatig bijstellen waar nodig</div>
          </div>
          <span style={s.close} onClick={onClose}>×</span>
        </div>

        <Progress />

        <div style={s.body}>

          {/* ══ STAP 0: ZOEKEN ══════════════════════════════════════ */}
          {stap === 0 && (
            <div>
              <div style={s.row}>
                <label style={s.label}>Gemeentenaam</label>
                <input style={s.input} value={zoekNaam}
                  onChange={e => setZoekNaam(e.target.value)}
                  onKeyDown={e => e.key==='Enter' && zoekGemeente()}
                  placeholder="bijv. Mechelen, Hasselt, Breda…" autoFocus />
              </div>
              <div style={s.row}>
                <label style={s.label}>Land</label>
                <div style={{ display:'flex', gap:8 }}>
                  {['België','Nederland'].map(l => (
                    <div key={l} style={s.tag(land===l)} onClick={() => setLand(l)}>{l}</div>
                  ))}
                </div>
              </div>

              {error && <div style={s.error}>⚠ {error}</div>}

              <div style={{ marginTop:16, padding:'12px 14px', background:'#0a1620', borderRadius:8, fontSize:11, color:C.textDim, lineHeight:1.8 }}>
                <div style={{ fontWeight:700, color:C.teal, marginBottom:6 }}>Wat wordt automatisch opgehaald?</div>
                <div>✓ Geografisch middelpunt &amp; bounding box (Nominatim / OSM)</div>
                <div>✓ Bestaande wijken &amp; buurtnamen (Overpass API)</div>
                <div>✓ Schatting inwoners op basis van oppervlakte</div>
                <div style={{ color:C.gold, marginTop:4 }}>⚡ Wijktype, welvaartsindex en privé%: jij stelt in / controleert</div>
              </div>
            </div>
          )}

          {/* ══ STAP 1: WIJKEN & DATA ════════════════════════════════ */}
          {stap === 1 && (
            <div>
              <div style={s.grid2}>
                <div style={s.row}>
                  <label style={s.label}>Gemeente</label>
                  <input style={s.input} value={gemeenteNaam} onChange={e => setGemeenteNaam(e.target.value)} />
                </div>
                <div style={s.row}>
                  <label style={s.label}>Centrum coördinaten</label>
                  <input style={{ ...s.input, color:C.textDim }} readOnly
                    value={`${geoData?.center[0].toFixed(4)}, ${geoData?.center[1].toFixed(4)}`} />
                </div>
                <div style={s.row}>
                  <label style={s.label}>Totaal inwoners</label>
                  <input style={{...s.input, border:`1px solid ${inwonersIsSchatting ? C.warn : C.darkGreen}`}} type="number" value={inwoners} onChange={e => { setInwoners(e.target.value); setInwonersIsSchatting(true); }} />
                  {inwonersIsSchatting ? (
                    <div style={{...s.hint, color:C.warn}}>⚠ Ruwe schatting (oppervlakte × aangenomen dichtheid): Wikidata-opzoeking is niet gelukt. Controleer en corrigeer dit handmatig, bijvoorbeeld via Statbel of AlleCijfers.be.</div>
                  ) : (
                    <div style={{...s.hint, color:C.darkGreen}}>✓ Wikidata (meest recente bevolkingsopgave)</div>
                  )}
                </div>
                <div style={s.row}>
                  <label style={s.label}>Totaal voertuigen</label>
                  <input style={{...s.input, border:`1px solid ${C.warn}`}} type="number" value={voertuigen} onChange={e => setVoertuigen(e.target.value)} />
                  <div style={{...s.hint, color:C.warn}}>⚠ Schatting (44% van inwoners, gemiddelde ratio van onze geverifieerde gemeenten), GEEN DIV/Febiac-cijfer. Controleer en corrigeer dit handmatig.</div>
                </div>
                <div style={s.row}>
                  <label style={s.label}>Welvaartsindex</label>
                  <input style={s.input} type="number" step="0.1" value={welvaartsindex} onChange={e => setWelvaartsindex(e.target.value)} />
                  <div style={s.hint}>Statbel. Vlaams gemiddelde: 106,9. Corrigeert het Vlaamse EV-aandeel lokaal.</div>
                </div>
                <div style={s.row}>
                  <label style={s.label}>Privé % (berekend)</label>
                  <input style={s.input} type="number" min="0" max="100" value={privePct} onChange={e => setPrivePct(e.target.value)} />
                  <div style={s.hint}>Stadsmonitor "private buitenruimte", of eigen dataset indien beschikbaar.</div>
                </div>
              </div>

              <div style={s.divider} />
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
                <div style={{ fontSize:12, fontWeight:700, color:C.text }}>
                  Wijken ({wijken.filter(w=>w.actief).length} actief)
                  {totaalInwoners > 0 && (
                    <span style={{ fontSize:10, color:C.textDim, marginLeft:8 }}>
                      Σ {totaalInwoners.toLocaleString('nl-NL')} inwoners
                    </span>
                  )}
                </div>
                <button style={s.btn(false)} onClick={addWijk}>+ Wijk toevoegen</button>
              </div>

              {wijken.map((wijk, idx) => (
                <div key={wijk.id} style={s.wijkCard(wijk.actief)}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                      <input
                        style={{ ...s.input, width:160, padding:'4px 8px', fontSize:12 }}
                        value={wijk.naam}
                        onChange={e => updateWijk(idx, 'naam', e.target.value)} />
                      <span style={s.badge(C.teal)}>{wijk.id}</span>
                    </div>
                    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                      <span style={{ fontSize:10, color: wijk.actief ? C.green : C.textDim }}>
                        {wijk.actief ? 'actief' : 'uitgeschakeld'}
                      </span>
                      <div style={{ width:34, height:18, borderRadius:9, background: wijk.actief ? C.darkGreen : '#1e3a46', position:'relative', cursor:'pointer' }}
                        onClick={() => toggleWijk(idx)}>
                        <div style={{ position:'absolute', top:2, left: wijk.actief ? 18 : 2, width:14, height:14, borderRadius:'50%', background:'#fff', transition:'left 0.2s' }} />
                      </div>
                    </div>
                  </div>

                  {wijk.actief && (
                    <div style={s.grid2}>
                      <div>
                        <label style={{ ...s.label, fontSize:10 }}>Inwoners</label>
                        <input style={{ ...s.input, fontSize:11, padding:'5px 8px' }}
                          type="number" value={wijk.inwoners}
                          onChange={e => updateWijk(idx, 'inwoners', e.target.value)} />
                      </div>
                      <div>
                        <label style={{ ...s.label, fontSize:10 }}>Voertuigen</label>
                        <input style={{ ...s.input, fontSize:11, padding:'5px 8px' }}
                          type="number" value={wijk.voertuigen}
                          onChange={e => updateWijk(idx, 'voertuigen', e.target.value)} />
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ══ STAP 2: WIJKTYPE ══════════════════════════════════════ */}
          {stap === 2 && (
            <div>
              <div style={{ fontSize:11, color:C.textDim, marginBottom:16, lineHeight:1.7 }}>
                Het <strong style={{color:C.teal}}>wijktype</strong> bepaalt automatisch de doelgroepenmix (bewoners,
                bezoekers, logistiek) van een wijk. Vink meerdere types aan voor een hybride wijk, bijvoorbeeld
                wonen + werken; het model middelt dan de bijbehorende mixen. OV telt alleen mee als je zelf een
                percentage invult, want openbaar vervoer laadt doorgaans op een eigen depot, niet op straat.
              </div>

              {wijken.filter(w=>w.actief).map((wijk) => {
                const idx = wijken.indexOf(wijk);
                return (
                  <div key={wijk.id} style={{ ...s.wijkCard(true), marginBottom:14 }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
                      <div style={{ fontSize:12, fontWeight:700, color:C.text }}>{wijk.naam}</div>
                    </div>

                    <div style={{ marginBottom:10 }}>
                      <label style={s.label}>Wijktype</label>
                      <div style={{ display:'flex', flexWrap:'wrap' }}>
                        {WIJKTYPES.map(t => (
                          <div key={t.key} style={s.tag((wijk.wijktype||[]).includes(t.key))}
                            onClick={() => toggleWijktype(idx, t.key)}>
                            {t.label}
                          </div>
                        ))}
                      </div>
                    </div>

                    <div>
                      <label style={s.label}>OV-aandeel (standaard 0%, alleen bij een bekend publiek/semi-publiek OV-laadpunt)</label>
                      <input
                        type="number" min="0" max="100" step="1"
                        style={{ width:80, background:'#0f1e24', border:`1px solid ${C.border}`, borderRadius:4, padding:'5px 8px', color:C.text, fontSize:12 }}
                        value={Math.round((wijk.ovAandeel||0)*100)}
                        onChange={e => updateWijk(idx, 'ovAandeel', (e.target.value===''?0:+e.target.value)/100)} />
                      <span style={{ fontSize:11, color:C.textDim, marginLeft:6 }}>%</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* ══ STAP 3: BEVESTIGING ══════════════════════════════════ */}
          {stap === 3 && (
            <div>
              <div style={{ background:'#0a1620', borderRadius:8, padding:'14px 16px', marginBottom:16 }}>
                <div style={{ fontSize:13, fontWeight:800, color:C.text, marginBottom:10 }}>{gemeenteNaam}</div>
                <div style={s.grid2}>
                  {[
                    ['Centrum',     `${geoData?.center[0].toFixed(4)}, ${geoData?.center[1].toFixed(4)}`],
                    ['Bbox',        geoData?.bbox.map(v=>v.toFixed(3)).join(', ')],
                    ['Inwoners',    parseInt(inwoners).toLocaleString('nl-NL')],
                    ['Voertuigen',  parseInt(voertuigen).toLocaleString('nl-NL')],
                    ['Welvaartsindex', welvaartsindex],
                    ['Privé %',     `${privePct}%`],
                    ['Actieve wijken', wijken.filter(w=>w.actief).length],
                    ['Land',        land],
                  ].map(([l,v]) => (
                    <div key={l} style={{ fontSize:11 }}>
                      <span style={{ color:C.textDim }}>{l}: </span>
                      <span style={{ color:C.text, fontWeight:600 }}>{v}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ fontSize:11, fontWeight:700, color:C.text, marginBottom:8 }}>Wijken</div>
              {wijken.filter(w=>w.actief).map(wijk => (
                <div key={wijk.id} style={{ display:'flex', justifyContent:'space-between', padding:'6px 10px', background:'#0a1620', borderRadius:5, marginBottom:4, fontSize:11 }}>
                  <span style={{ color:C.text, fontWeight:600 }}>{wijk.naam}</span>
                  <span style={{ color:C.textDim }}>
                    {parseInt(wijk.inwoners).toLocaleString('nl-NL')} inw. ·{' '}
                    {(wijk.wijktype||[]).join(' + ')}
                    {wijk.ovAandeel > 0 ? ` · OV ${Math.round(wijk.ovAandeel*100)}%` : ''}
                  </span>
                </div>
              ))}

              <div style={{ marginTop:16, padding:'10px 14px', background:'#0a2010', border:`1px solid ${C.darkGreen}`, borderRadius:6, fontSize:11, color:C.green, lineHeight:1.7 }}>
                ✓ Na bevestiging is de gemeente direct beschikbaar in de laadkaart.<br/>
                ✓ Bestaande laadpalen worden live opgehaald via de officiële MOW-dataset.<br/>
                ✓ De rekenparameters gelden direct voor alle wijken.
              </div>
            </div>
          )}

        </div>{/* end body */}

        {/* Footer */}
        <div style={s.footer}>
          <div style={{ fontSize:11, color:C.textDim }}>
            {stap === 0 && 'Typ een gemeentenaam en druk Enter of klik Zoeken'}
            {stap === 1 && `${wijken.filter(w=>w.actief).length} wijken gevonden via OpenStreetMap`}
            {stap === 2 && 'Wijktype bepaalt automatisch de doelgroepenmix'}
            {stap === 3 && 'Klaar om toe te voegen'}
          </div>
          <div style={{ display:'flex', gap:10 }}>
            {stap > 0 && (
              <button style={s.btn(false)} onClick={() => setStap(s => s-1)}>← Terug</button>
            )}
            {stap === 0 && (
              <button style={s.btn(true)} onClick={zoekGemeente} disabled={loading}>
                {loading ? 'Zoeken…' : 'Zoeken →'}
              </button>
            )}
            {stap > 0 && stap < 3 && (
              <button style={s.btn(true)} onClick={() => setStap(s => s+1)}>
                Volgende →
              </button>
            )}
            {stap === 3 && (
              <button style={{ ...s.btn(true), background:C.darkGreen }} onClick={bevestig}>
                ✓ Gemeente toevoegen
              </button>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}

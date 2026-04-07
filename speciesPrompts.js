/**
 * speciesPrompts.js
 * BlueWater Intel V2 — Species & Region Prompt Library
 *
 * Built from primary research across:
 *   - NOAA/FWC species profiles
 *   - Salt Water Sportsman, Marlin Magazine, On The Water
 *   - Charter captain reports for SE Florida, Mid-Atlantic, Northeast
 *
 * Usage:
 *   import { buildSystemPrompt, buildAnalysisPrompt } from './speciesPrompts.js';
 *   const system = buildSystemPrompt(species, region);
 *   const prompt = buildAnalysisPrompt(species, region, oceanData, searchBounds);
 */

// ─── Region Detection ─────────────────────────────────────────────────────────

/**
 * Detect fishing region from center lat/lon.
 * Returns one of: 'SE_FLORIDA' | 'MID_ATLANTIC' | 'NORTHEAST'
 */
export function detectRegion(centerLat, centerLon) {
  if (centerLat >= 24.5 && centerLat < 29.5) return 'SE_FLORIDA';
  if (centerLat >= 29.5 && centerLat < 37.5) return 'MID_ATLANTIC';
  if (centerLat >= 37.5 && centerLat <= 45.0) return 'NORTHEAST';
  return 'SE_FLORIDA'; // fallback
}

// ─── Region Context Blocks ───────────────────────────────────────────────────

const REGION_CONTEXT = {

  SE_FLORIDA: `
REGION: Southeast Florida — Treasure Coast, Palm Beach, Fort Lauderdale, Miami, Florida Keys
GEOGRAPHY:
- The Gulf Stream runs 2–15 miles from shore (closest at Palm Beach/Jupiter, farther at Miami)
- Continental shelf is extremely narrow south of Jupiter Inlet — drops fast to 200–300ft within 3–5 miles
- North of Jupiter, shelf widens — allows trolling dead bait vs. live bait kite fishing south of Jupiter
- Key reef structure: inner reef (60–80ft, 3–5mi out), outer reef (80–120ft, 6–10mi), reef ledge/edge (120–180ft, 10–14mi)
- Named hotspots: Sailfish Alley (Stuart to West Palm Beach), Juno Ledge, "Sailfish Capital" Stuart/St. Lucie Inlet
- Biscayne Bay green water pushes onto Gulf Stream edge off Miami — major bait concentrator
CURRENT DYNAMICS:
- Gulf Stream north current drives upwellings at ledges and humps (Juno Ledge especially)
- Post-cold-front NE current + NE wind combo is peak sailfish trigger (Nov–Feb)
- Easterly winds push bait inshore; strong north current concentrates bait at ledges
SEASON OVERVIEW:
- Sailfish: Nov–March peak (Dec–Feb prime), year-round resident fish possible
- Mahi: April–Oct peak, best April–June migration north
- Wahoo: year-round; best Oct–March cold fronts; Dec–Feb ledge stack-up
- Kingfish: Sept–Nov fall migration; resident year-round but peaks winter
- Blackfin Tuna: year-round; peaks Oct–May
- Yellowfin Tuna: spring–fall, across the Gulf Stream on the "other side"
- Swordfish: year-round daytime deep drop; night drift year-round
- Blue Marlin: May–Sept; peak June–Aug
- White Marlin: Feb–May migration north, Sept–Nov migration south
- Snapper/Grouper: year-round; closed seasons apply — always check FWC regulations
`,

  MID_ATLANTIC: `
REGION: Mid-Atlantic — North Carolina (Hatteras, Oregon Inlet, Cape Lookout), Virginia Beach, Maryland (Ocean City)
GEOGRAPHY:
- Continental shelf break 50–100+ miles offshore; underwater canyons are the dominant structure
- Key canyons: Washington Canyon, Norfolk Canyon, Poor Man's Canyon, Baltimore Canyon, Wilmington Canyon
- Cape Hatteras is where the cold Labrador Current meets warm Gulf Stream — extraordinary bait concentration
- Canyons run NE to SW along shelf edge; steep canyon walls create marlin and swordfish ambush zones
- "Triple 0s" (41000 Loran line) off Virginia is prime blue marlin grounds
- The 100-fathom (600ft) curve is the primary blue marlin depth starting point
- Hatteras: Gulf Stream closest to shore in summer — Hatteras called "Blue Marlin Capital of the World"
- Ocean City: home of the White Marlin Open tournament (August)
CURRENT DYNAMICS:
- Gulf Stream meanders and creates warm-water eddies that push over canyon structures
- Temperature breaks crossing canyon walls are the key marlin trigger — find the warm-water eddy edge
- Deep scattering layer (DSL) drives swordfish vertical migration — up at night, deep (1,000–2,000ft) by day
SEASON OVERVIEW:
- Sailfish: summer peak June–Sept, most common at Hatteras and Oregon Inlet
- White Marlin: peak Aug–Sept; pre-migration concentration at Virginia Beach/Hatteras
- Blue Marlin: June–Sept; peak July–Aug; Hatteras and Oregon Inlet primary ports
- Swordfish (day): July–Jan; peak Sept–Nov at Washington/Norfolk Canyons
- Yellowfin Tuna: May–Nov; peak July–Oct canyon edge and shelf break
- Bluefin Tuna: Nov–March at Hatteras (giant class); May–June migrants
- Blackfin Tuna: Nov–April at Hatteras; sporadic further north
- Wahoo: year-round; best full moon Oct–March cold fronts along canyon ledges
- Mahi: May–Oct; best June–Sept following weedlines and eddies
- Kingfish: spring and fall migration along the coast 50–150ft
- Snapper/Grouper: year-round structure fishing 100–300ft; gag grouper on hard bottom
`,

  NORTHEAST: `
REGION: Northeast — New Jersey, New York, Connecticut, Rhode Island, Massachusetts (Cape Cod, Stellwagen Bank)
GEOGRAPHY:
- Continental shelf very wide; canyons 75–130 miles offshore (Atlantis, Veatch, Hydrographer, Lydonia, Hudson)
- The "edge" — where Gulf Stream warm water meets cold coastal water — creates a world-class pelagic ecosystem
- Stellwagen Bank (MA) is a shallow bank 16mi from Provincetown; primary bluefin ground
- Coxes Ledge, Atlantis Canyon, The Fingers — key yellowfin/bigeye grounds off RI/CT/NY
- Block Island to Montauk: bluefin and yellowfin accessible Sept–Dec sometimes 1–2mi offshore
- New Jersey canyon waters: Chicken Canyon, Texas Tower, Atlantic Princess in 180–280ft, 45–65mi out
CURRENT DYNAMICS:
- Gulf Stream eddies spin off the main flow and push warm water over canyon structure
- Deep scattering layer (DSL) same as Mid-Atlantic — swordfish deep (1,500ft+) by day, shallower at night
- Sand eels and squid are primary bait species — matching the hatch is critical for bluefin
- Fall cooling drives bluefin inshore (sometimes 1 mile off NJ beach in Nov–Dec)
SEASON OVERVIEW:
- Bluefin Tuna: giants arrive May–June; school fish June–Nov; inshore gorge Nov–Dec
- Yellowfin Tuna: June–Nov; peak Aug–Oct on canyon edges and offshore lumps
- Bigeye Tuna: July–Nov at canyon depths; primarily night bite chunking
- Mahi: June–Sept; must run to Gulf Stream eddy or canyons
- Wahoo: July–Nov; canyon edges; much less common than mid-Atlantic
- White Marlin: Aug–Sept; sporadic, centered on canyon mouths
- Blue Marlin: July–Sept; rare but present on warm-water eddies
- Swordfish (day/night): June–Jan at canyons; best Sept–Nov
- Kingfish: spring/fall migration inshore; not as dominant as south
- Snapper/Grouper: sea bass and tilefish more dominant; golden/blueline tilefish 300–700ft
`
};

// ─── Species Knowledge Blocks ─────────────────────────────────────────────────

const SPECIES_DATA = {

  SAILFISH: {
    id: 'SAILFISH',
    name: 'Sailfish',

    biology: `
SAILFISH BIOLOGY:
- Atlantic sailfish (Istiophorus platypterus) — Florida's official state saltwater fish
- Prefer surface to 200ft; rarely exceed 300ft depth; true upper water column fish
- Optimal SST: 72–82°F (peak activity 75–80°F); avoid water below 70°F
- Migrate north with warming Gulf Stream in spring/summer; south in fall/winter ahead of cold fronts
- Feed aggressively on ballyhoo, pilchards, goggle eyes, blue runners, sardines, squid
- Highly social — often travel in loose groups following bait schools
- Post-cold-front NE wind + NE current for 3+ days = peak bite trigger in SE Florida
- "Tailing" condition: current running opposite to fish travel causes fins to break surface — target with pitch baits
- Visual hunters — look for them with tower or polarized glasses on calm days
`,

    depthByRegion: {
      SE_FLORIDA:   { min: 60,  max: 200, sweet: '80–150ft', notes: 'Reef edge 60–180ft; rarely beyond 200ft. The 100–150ft contour along the reef ledge is the money zone. 3–8 miles offshore.' },
      MID_ATLANTIC: { min: 60,  max: 300, sweet: '80–200ft', notes: 'Wider shelf — fish further out but still reef/ledge oriented. 20–50 fathom range primary.' },
      NORTHEAST:    { min: 80,  max: 400, sweet: '100–250ft', notes: 'Sporadic; follow warm water eddies in summer. Uncommon north of NJ.' },
    },

    techniquesByRegion: {
      SE_FLORIDA: `
TECHNIQUES — SE FLORIDA SAILFISH:
PRIMARY: Kite fishing with live baits (south of Jupiter Inlet where shelf drops fast)
  - Rig 2 kites with 3 lines each = 6 live baits dancing on surface
  - Live goggle eyes, pilchards, blue runners on 30–40lb fluorocarbon, 7/0 circle hooks
  - Stagger baits: short, medium, long position on each kite
  - Fish the 80–150ft contour 4–10 miles offshore
  - Work color change lines (reef green vs Gulf Stream blue)

SECONDARY: Slow-trolling dead bait spread (north of Jupiter where shelf widens)
  - Dead rigged ballyhoo on 7/0 circle hooks, 40lb fluorocarbon
  - 2 long-rigger baits + 2 flat-line baits
  - Add dredges (natural or squid chain) as teasers
  - Chase bait: Ilander combo (purple-and-black or blue-and-white) with ballyhoo

ANCHORING & CHUMMING:
  - Anchor outside reef in 75–120ft, heavy ballyhoo chum slick
  - Let yellowtails create commotion — draws sailfish into slick
  - Have 12+ live ballyhoo ready for when sails show up in slick

LOCATION TRIGGERS:
  - Target Juno Ledge (south of Jupiter Inlet) — north current upwelling concentrates bait
  - Color change line (green reef water meeting blue Gulf Stream)
  - Post cold-front NE wind + NE current for 3+ days = highest fish density
  - Frigate bird activity and ballyhoo "showers" (bait jumping) = active sail nearby
  - Wrecks/artificial structure between Palm Beach and Jupiter Inlet + outgoing tide

SEASONAL: Nov–March peak; December kite fishing = tournament season; summer resident fish on reefs
`,
      MID_ATLANTIC: `
TECHNIQUES — MID-ATLANTIC SAILFISH:
- Much less concentrated than SE Florida — treat as bonus while blue/white marlin fishing
- Slow-trolling ballyhoo at 4–6 knots around reef structure and warm-water eddies
- Same kite fishing approach can work June–Sept when Gulf Stream is closest to Hatteras
- Target temperature breaks on the shelf (50–80ft zone) in summer
- Oregon Inlet and Hatteras Inlet primary departure points July–Sept
- Look for sailfish mixing in white marlin bites on the 20–30 fathom zone
`,
      NORTHEAST: `
TECHNIQUES — NORTHEAST SAILFISH:
- Rare; treat as incidental catch on marlin/tuna trips
- Sporadic summer appearances on warm-water Gulf Stream eddies
- If encountered: pitch live bait or switch bait immediately
- July–Sept only window; most common off NJ/NY
`,
    }
  },

  // ─────────────────────────────────────────────────────────────

  MAHI: {
    id: 'MAHI',
    name: 'Mahi-Mahi (Dolphin)',

    biology: `
MAHI-MAHI BIOLOGY:
- Fastest-growing pelagic — can reach 40+ lbs in their first year
- Optimal SST: 75–85°F; avoid water below 68°F; drawn to warm Gulf Stream water
- Highly associated with floating objects: sargassum weedlines, debris, FADs, flotsam
- Schools — when you hook one, keep it in the water and others follow
- Peak feeding: dawn and dusk but hit all day when conditions are right
- Visual cue: frigate birds working low = mahi below; birds moving fast = tuna
- Color change rips (blue meets green) and weedlines are primary habitat edges
- Spring migration: move north from Keys through SE Florida April–June
- Summer: schoolie mahi throughout Gulf Stream; bull/cow mahi on deeper offshore structure
`,

    depthByRegion: {
      SE_FLORIDA:   { min: 100, max: 600, sweet: '200–500ft', notes: 'Gulf Stream edge 15–30mi; weedlines in 200–600ft water. Color change from 60ft out to 450ft+ is productive.' },
      MID_ATLANTIC: { min: 200, max: 1500, sweet: '400–800ft', notes: 'Must reach Gulf Stream or warm eddy. 50–120mi offshore. Canyon mouths and weedlines near the edge.' },
      NORTHEAST:    { min: 300, max: 2000, sweet: '600–1200ft', notes: 'Canyon edge and warm eddies. 75–130mi offshore. June–Sept only.' },
    },

    techniquesByRegion: {
      SE_FLORIDA: `
TECHNIQUES — SE FLORIDA MAHI:
PRIMARY: Trolling skirted lures or rigged ballyhoo along weedlines and color changes
  - Speed: 5–8 knots
  - Skirted ballyhoo in blue/white, orange/green, pink/purple
  - Work along sargassum weedlines — follow the edge, check tips and fingers of weed
  - When you find a weedline: troll along the clean-side edge; check the "backflow eddies" at weedline tips
  - Bull mahi hold at weedline fingers and color change intersections

SECONDARY: Live bait pitching to schools
  - When you hook one, leave it in the water — school will congregate
  - Have spinning rods ready with live pilchards, sardines, or small baitfish
  - Cast ahead of the school or right into them
  - Once the bite slows: chunk dead bait into school to keep them near the boat

ADDITIONAL TECHNIQUES:
  - Kite fishing: effective when mahi are mixed with sailfish on current edges
  - Chumming with bycatch near weedlines or floating debris
  - Drifting chunks of dead bait (bonito strips, ballyhoo chunks) into debris fields

LOCATION TRIGGERS:
  - Frigate birds flying low and slowly (5–15 mph) and diving = mahi below
  - Any floating debris offshore (boards, pallets, ropes, crab trap buoys)
  - Sargassum weedlines — especially "finger" tips and current rips
  - Color change where reef-green water meets Gulf Stream blue (60–450ft depth)
  - Warm-water (80°F+) core Gulf Stream in summer

SEASONAL: April–Oct peak; best April–June northward migration; fall fish follow cold fronts; Dec–Jan possible on weedlines near Gulf Stream edge
`,
      MID_ATLANTIC: `
TECHNIQUES — MID-ATLANTIC MAHI:
- Must reach Gulf Stream or warm eddy — typically 50–100mi run from NC/VA
- Troll skirted ballyhoo at 6–8 knots along temperature breaks and canyon edge weedlines
- Hatteras/Oregon Inlet: run SE to find warm water eddy pushing over shelf break
- Search for sargassum weedlines and color changes — same trigger as FL
- Canyon mouths in June–Sept hold consistent mahi
- Keep one in the water — same school behavior; have pitching rods ready
- Frigate birds and color changes = always worth a look
- Best months: May–Sept; peak June–Aug

COOLER WATER CONSIDERATION:
- In spring (May), mahi prefer warmer temperature breaks — cold water side holds bait but fish are on warm side
- In fall (Sept–Oct), fish follow sargassum as it drifts south — work the rips
`,
      NORTHEAST: `
TECHNIQUES — NORTHEAST MAHI:
- Full canyon run required (75–130mi); treat as bonus on canyon tuna/marlin trips
- Weedlines and warm eddy edges on the outside of the canyon are primary habitat
- Troll skirted ballyhoo; pitch live bait when they come to the surface
- June–Sept only; peak July–Aug
- If you find sargassum in warm water: mahi almost certainly present
`,
    }
  },

  // ─────────────────────────────────────────────────────────────

  WAHOO: {
    id: 'WAHOO',
    name: 'Wahoo',

    biology: `
WAHOO BIOLOGY:
- One of the fastest fish in the ocean — documented bursts to 60mph
- Solitary or small loose groups (unlike mahi which school tightly)
- Optimal SST: 70–85°F; drawn to thermoclines and temperature breaks; hold deep when water is warm on surface
- Associate with current edges, depth changes, and underwater structure (ledges, humps, canyon walls)
- Sharp teeth — always use wire or heavy fluorocarbon leader (single-strand #7 wire or 100–130lb mono)
- Moon phase matters: full and new moon = peak feed especially dawn/dusk
- Winter cold fronts push wahoo toward the reef edge in SE Florida (best ledge bite Nov–March)
- Summer: found farther offshore under floating debris, mixed with mahi
- Key feed windows: outgoing tide last 2 hours + dawn/dusk
`,

    depthByRegion: {
      SE_FLORIDA:   { min: 120, max: 600, sweet: '120–300ft', notes: 'Reef ledge (120–180ft) is winter hotspot; Gulf Stream edge (300–600ft) in summer. Jupiter and Palm Beach ledges 10–20mi out.' },
      MID_ATLANTIC: { min: 300, max: 1500, sweet: '500–1000ft', notes: 'Canyon walls and ledges at the shelf break; 50–100mi offshore. Full moon Oct–March most productive.' },
      NORTHEAST:    { min: 400, max: 2000, sweet: '600–1200ft', notes: 'Uncommon but present July–Nov on canyon edges. Treat as bonus catch.' },
    },

    techniquesByRegion: {
      SE_FLORIDA: `
TECHNIQUES — SE FLORIDA WAHOO:
PRIMARY WINTER (Nov–March): High-speed trolling the reef ledge
  - Troll 10–16 knots along the 120–180ft ledge off Jupiter/Palm Beach
  - Deep-diving plugs: Rapala X-Rap Magnum, Mann's Stretch 30+
  - Weighted sea witches with ballyhoo (12–24oz inline weights to get down to thermocline)
  - Color: black/purple, black/red — or high contrast color combos
  - Cold front aftermath = stack up on the ledge = prime time

SECONDARY: Inline-weight rig for deeper thermocline fish
  - 12–24oz egg sinker above swivel; sea witch + rigged ballyhoo behind it
  - Trolled at 8–10 knots — gets bait down 25–40ft in the water column where wahoo hold

SUMMER (June–Oct): High-speed trolling offshore + debris
  - Troll 12–16 knots through current edges and color changes
  - Under floaters and debris — same area as mahi; wahoo hold deeper under the debris
  - Wire leader with rigged ballyhoo or skirted lure
  - Planer + sea witch to get down to wahoo depth under debris

LOCATION TRIGGERS:
  - Last 2 hours of outgoing tide at Jupiter and Palm Beach = consistent bite window
  - Full/new moon dawn and dusk
  - Hard temperature break crossing ledge structure
  - Dense debris field with mahi on top = wahoo likely underneath

SEASONAL: Year-round; winter reef ledge (peak Dec–Feb) and summer offshore (peak June–Oct)
`,
      MID_ATLANTIC: `
TECHNIQUES — MID-ATLANTIC WAHOO:
- Canyon mouth ledges and walls at the shelf break (300–600ft bottom depth)
- High-speed trolling 10–16 knots along canyon rims and temperature breaks
- Same plug spread as SE Florida; heavier weights (16–32oz) for strong Gulf Stream current
- Best October–March on cold fronts; also peaks around full moon
- Washington Canyon and Norfolk Canyon — most consistent wahoo production
- Troll the temperature break where warm eddy crosses canyon wall
- Consider adding planer rigs to get baits deeper into canyon current
`,
      NORTHEAST: `
TECHNIQUES — NORTHEAST WAHOO:
- Rare; treat as surprise catch while tuna/marlin fishing
- If targeting: high-speed trolling (12–16 knots) on canyon edges July–Nov
- Same black/purple high-contrast color preference
- Atlantis, Veatch, Hudson Canyon edges most likely
`,
    }
  },

  // ─────────────────────────────────────────────────────────────

  KINGFISH: {
    id: 'KINGFISH',
    name: 'King Mackerel (Kingfish)',

    biology: `
KING MACKEREL BIOLOGY:
- Large schooling pelagic; record 90 lbs; typically 5–40 lbs inshore, larger offshore
- Preferred SST: 68–84°F; migratory — follow temperature corridors north in spring, south in fall
- SE Florida: fall migration (Sept–Nov) south; winter resident; spring migration north (March–May)
- Highly bait-driven — follow sardines, herring, pogies, blue runners, ribbonfish
- Found 50ft to 600ft but most productive in 60–150ft over reef/structure
- Visual hunters — silver flash of baitfish is primary trigger
- 30 razor teeth — ALWAYS use wire leader or heavy stainless; they bite the tail of baits, so run stinger hooks
- Structure-oriented: reefs, wrecks, artificial reefs concentrate both bait and kings
- Early morning and late afternoon most active feed windows; overnight charters allow higher bag limits
`,

    depthByRegion: {
      SE_FLORIDA:   { min: 60,  max: 300, sweet: '60–150ft', notes: 'Inner and outer reef (60–180ft); fall migration hugs the coast 60–120ft. Atlantic coast peak Sept–Nov.' },
      MID_ATLANTIC: { min: 60,  max: 300, sweet: '60–150ft', notes: 'Spring and fall migration along the reef and shelf (60–150ft). NC and VA most productive; peaks May–June and Sept–Oct.' },
      NORTHEAST:    { min: 60,  max: 200, sweet: '80–150ft', notes: 'Northernmost range; uncommon above NJ. Summer months only May–Sept.' },
    },

    techniquesByRegion: {
      SE_FLORIDA: `
TECHNIQUES — SE FLORIDA KINGFISH:
PRIMARY: Slow-trolling live bait over reefs and wrecks
  - Live blue runners, goggle eyes, pilchards, sardines
  - Stinger rig: front hook in nose, trailing stinger hook at tail (kings bite the tail)
  - Wire leader — single-strand #5–7 wire or 80–100lb mono
  - Troll at 2–4 knots over reef in 60–150ft
  - Work reef edges both directions — kings often chase bait in one direction with current

SECONDARY: High-speed trolling spoons and plugs
  - Silver spoons (Drone, Clark) at 5–7 knots
  - Trolling plugs: diving Rapala, planers + silver spoons
  - Effective when large schools are pushing bait to the surface

ADDITIONAL:
  - Slow drift with live bait below a float over wrecks and artificial reef
  - Planer + spoon combo to get baits down to suspended fish
  - Kite fishing: kings are a common kite target on SE FL reefs

LOCATION TRIGGERS:
  - Wrecks and artificial reefs — especially downCurrent eddy from structure
  - Reef edge in 80–130ft where bait is schooling
  - Current rips along outer reef — kings patrol the rip edge
  - Frigate birds or terns diving = bait pinned at surface = kings below

SEASONAL: Sept–Nov fall migration peak on Atlantic SE Florida; year-round fish possible on deeper reefs; check FWC bag limits (2/person Atlantic, 3/person Gulf)
`,
      MID_ATLANTIC: `
TECHNIQUES — MID-ATLANTIC KINGFISH:
- Spring migration (April–June): kings move north along the reef from FL — follow bait schools
- Fall migration (Sept–Nov): heading south — congregation off NC outer banks and Hatteras
- Slow-trolling live bait (menhaden, blue runners) over reef structure 60–150ft
- High-speed silver spoons and planers on the surface migration schools
- Hatteras produces large kings during fall migration — "smoker kings" 20–40lbs on live bait
- NC kings often taken while targeting false albacore in the fall
- Check state regulations — bag limits and size minimums differ NC/VA/MD
`,
      NORTHEAST: `
TECHNIQUES — NORTHEAST KINGFISH:
- Rare north of NJ; occasional summer presence in NJ/NY
- If encountered: same slow-troll live bait approach
- May–Sept only
`,
    }
  },

  // ─────────────────────────────────────────────────────────────

  BLACKFIN_TUNA: {
    id: 'BLACKFIN_TUNA',
    name: 'Blackfin Tuna',

    biology: `
BLACKFIN TUNA BIOLOGY:
- Smallest western Atlantic tuna; typically 5–30 lbs; world record 49 lbs
- Range: Cape Cod to Brazil; best fishing NC south through Keys and Gulf
- Optimal SST: 75–85°F; prefer warm Gulf Stream water
- School aggressively — most accessible tuna for day-trip anglers
- Often mix with skipjack, blackfin, and smaller yellowfin near surface
- Responds well to: chunking, live bait, small trolled feathers, vertical jigging, topwater
- Wrecks, reefs, and ledges concentrate blackfin in SE Florida
- Bigeye and bluefin occasionally show in same areas; use heavier tackle if targeting those
- Dawn and dusk peak feed windows; also respond to full/new moon tides
`,

    depthByRegion: {
      SE_FLORIDA:   { min: 100, max: 400, sweet: '100–300ft', notes: 'Reef ledge and Gulf Stream edge; 8–25mi offshore. Wrecks in 100–200ft productive year-round.' },
      MID_ATLANTIC: { min: 200, max: 800, sweet: '300–600ft', notes: 'Canyon edges and Gulf Stream; less common than yellowfin but present Nov–April at Hatteras.' },
      NORTHEAST:    { min: 300, max: 1000, sweet: '400–700ft', notes: 'Cape Cod to NJ; sporadic; treat as bonus during tuna trips.' },
    },

    techniquesByRegion: {
      SE_FLORIDA: `
TECHNIQUES — SE FLORIDA BLACKFIN TUNA:
PRIMARY: Chunking over wrecks and reef ledge
  - Anchor or drift upcurrent of wreck; throw chunks (bonito strips, sardines, ballyhoo pieces) every 30–60 sec
  - Hook baits: sardine or ballyhoo chunk on 4/0–6/0 circle hook, 30–40lb fluorocarbon
  - Set baits at multiple depths — surface, mid-column, near bottom
  - "Stripper" bait: unweighted bait sinks naturally with chunks — deadly

SECONDARY: Trolling small lures at reef edge
  - Cedar plugs, feathers, small skirted lures on 20–30lb tackle
  - Rapala CD Mag 14 trolled at 10mph along upcurrent side of wrecks
  - Small spreader bars with squid or small ballyhoo

VERTICAL JIGGING:
  - Flutter jigs and butterfly jigs on spinning gear over wrecks in 100–200ft
  - At dawn and dusk — fish mark on sounder; drop jig, work aggressively
  - Topwater poppers when fish are boiling on surface (calm, early morning)

LOCATION TRIGGERS:
  - Birds diving on bait schools near reef edge
  - Marks on sounder in 100–200ft over or near wrecks
  - Slick on the water surface (oil slick from feeding fish) near reef
  - Kite fishing with live bait for incidental blackfin while sailfishing

SEASONAL: Year-round; peaks Oct–May; summer fish on deeper Gulf Stream edge and wrecks
`,
      MID_ATLANTIC: `
TECHNIQUES — MID-ATLANTIC BLACKFIN TUNA:
- Cape Hatteras is best location: Nov–April, blackfin stack at the Gulf Stream/Labrador current meeting point
- Chunking butterfish and sardines in 200–400ft at the stream edge
- Trolled small feathers and cedar plugs on the 100-fathom curve
- Often mixed with big yellowfin and bluefin — have heavier gear ready
- Oregon Inlet and Hatteras Inlet departure points for Nov–March trips
`,
      NORTHEAST: `
TECHNIQUES — NORTHEAST BLACKFIN TUNA:
- Rarely targeted specifically; incidental on yellowfin/bluefin trips
- Canyon edge chunking may produce blackfin Sept–Nov
- Not a primary target north of NJ
`,
    }
  },

  // ─────────────────────────────────────────────────────────────

  YELLOWFIN_TUNA: {
    id: 'YELLOWFIN_TUNA',
    name: 'Yellowfin Tuna',

    biology: `
YELLOWFIN TUNA BIOLOGY:
- 20 to 200+ lbs; school fish under 100lbs, more solitary above 100lbs
- Optimal SST: 72–82°F; school on temperature breaks and leading edge of warm eddies
- Feed heavily on sand eels, mackerel, sardines, squid, and flying fish
- Extremely acute eyesight — scale down leader when fish are finicky
- Respond to: trolling spreader bars/ballyhoo, chunking butterfish/sardines, live bait, kite fishing, surface popping
- Early season: tight schools on Gulf Stream eddy edges — easiest targeting
- Late season: cautious and finicky — scale down leader (30lb→25lb fluoro), hide hooks in bait
- Bigeye and bluefin mix in same areas; use 80–130lb gear if big bluefin present
`,

    depthByRegion: {
      SE_FLORIDA:   { min: 400, max: 2000, sweet: '600–1500ft', notes: '"The other side" of the Gulf Stream, 30–80mi from Port Canaveral/Palm Beach area. Need to cross the full Gulf Stream.' },
      MID_ATLANTIC: { min: 300, max: 2000, sweet: '500–1200ft', notes: 'Canyon edge and shelf break; 40–100mi offshore. Peak July–Oct.' },
      NORTHEAST:    { min: 400, max: 2500, sweet: '600–1500ft', notes: 'Canyon grounds 75–130mi; also inshore lumps Sept–Dec when eddies push warm water close.' },
    },

    techniquesByRegion: {
      SE_FLORIDA: `
TECHNIQUES — SE FLORIDA YELLOWFIN TUNA:
- Must cross the Gulf Stream to the "other side" — 30–80mi depending on departure port
- Find western and eastern edges of the Gulf Stream — bird activity on each side
- Position of warm-water eddies or bulges determines which angle to run
- SST charts essential — find cooler water on the back side of the stream where tuna feed

PRIMARY: Trolling spreader bars and skirted ballyhoo
  - Mixed spread: spreader bars (squid), skirted ballyhoo, surface and diving lures
  - 5–8 knots; look for bird packs and breaking fish
  - If trolling isn't working: look for the correct temperature break

SECONDARY: Chunking when fish are located
  - Drift in the zone; chunk butterfish or sardines every 30 seconds
  - Multiple depth baits: surface, 30ft, 60ft, near bottom
  - 40lb fluorocarbon leader; scale down to 25–30lb if fish are finicky
  - Kite fishing when visible fish are at surface

SEASONAL: April–Sept; peak May–Aug; SST charts critical — call ahead to marinas for current intel
`,
      MID_ATLANTIC: `
TECHNIQUES — MID-ATLANTIC YELLOWFIN TUNA:
- Canyon grounds are primary: Washington, Norfolk, Baltimore, Wilmington Canyons
- Trolling spreader bars early season (May–June) on leading edge of warm eddies
- Chunking with butterfish (4–5 flats per trip) + sardines + squid bait
- As summer warms (July–Aug): fish move inshore closer to lumps and reefs off NJ/NY
- NJ lumps and wrecks: 40–65mi out in 180–280ft — chunking and jigging produces
- Leader: 40lb fluorocarbon standard; drop to 25–30lb when finicky
- Kite fishing when visible on surface; popping with topwater when boiling
- Late season (Oct–Nov): close inshore NJ/NY; sometimes 2–10mi off the beach
- Butterfish + squid chunk spread = bread and butter of mid-Atlantic canyon chunking

INSHORE TACTIC (Late Season):
- When yellowfin move within 20mi of shore: look for whales, porpoise, diving birds
- Mark sand eels and sardines on sounder — yellowfin right below
- Chunk and cast metals/jigs into boiling fish
`,
      NORTHEAST: `
TECHNIQUES — NORTHEAST YELLOWFIN TUNA:
- Canyon grounds 75–130mi offshore June–Nov
- Trolling mixed spreader bar/ballyhoo spread early season (June–July) on warm eddy edges
- Chunking butterfish on canyon edges (Aug–Oct prime)
- Inshore closures: Oct–Dec, bluefin and yellowfin can appear 1–10mi off NJ/NY/RI beaches
- Identify by bird activity, whale spouting (both on same bait schools)
- Jig and pop (6oz metals, topwater plugs) when fish are close to surface
- Sand eel match the hatch: if fish are on sand eels, try slender soft plastics or small spoons
- Bigeye mixed in — same chunking but deeper baits needed (50–80ft)
`,
    }
  },

  // ─────────────────────────────────────────────────────────────

  BLUEFIN_TUNA: {
    id: 'BLUEFIN_TUNA',
    name: 'Bluefin Tuna',

    biology: `
BLUEFIN TUNA BIOLOGY:
- Atlantic apex tuna; giants exceed 1,000 lbs; average recreational catch 30–400 lbs
- Cold-water tolerant: comfortable 60–72°F; can extend range into cooler water than yellowfin
- Highly migratory: giants move north from SE coast spring; south past Hatteras Nov–March
- School fish (school/medium class 30–300lbs) and solitary giants (300lb+)
- Extraordinary eyesight — use fluorocarbon leader, hide hooks
- Require federal HMS (Highly Migratory Species) permit; report within 24hr if kept
- Strong sandeel, herring, mackerel preference in NE; butterfish in mid-Atlantic
- IGFA records and strict quota system — check NOAA HMS for current year status
- Gear: 80–130lb class tackle; stand-up or chair; electric reel assist for deep fish
`,

    depthByRegion: {
      SE_FLORIDA:   { min: 200, max: 2000, sweet: '300–800ft', notes: 'Rare; Feb–May migratory window. Deep Atlantic water east of Gulf Stream.' },
      MID_ATLANTIC: { min: 200, max: 2000, sweet: '400–1000ft', notes: 'Hatteras Nov–March (giants); shelf break canyon grounds May–June. 100-fathom zone primary.' },
      NORTHEAST:    { min: 50,  max: 2000, sweet: '50–600ft', notes: 'Stellwagen Bank MA (giants, Sept–Nov); NJ/NY close inshore (Nov–Dec); canyon grounds (June–Oct).' },
    },

    techniquesByRegion: {
      SE_FLORIDA: `
TECHNIQUES — SE FLORIDA BLUEFIN TUNA:
- Rare appearance; Feb–May window only; must fish Atlantic deep water east of Stream
- If bluefin are reported: use same chunking approach as yellowfin with heavier gear
- 130lb class stand-up; spreader bars for trolling
- Primarily a bonus catch — no reliable SE Florida season
`,
      MID_ATLANTIC: `
TECHNIQUES — MID-ATLANTIC BLUEFIN TUNA:
HATTERAS GIANT BLUEFIN (Nov–March):
- Giants (300–1,000+lbs) stage at Hatteras where Labrador current meets Gulf Stream
- Chunking: butterfish (whole and halved) + squid; set baits at multiple depths (10ft off bottom, mid, surface)
- Live bait: live herring, menhaden, or large mackerel slow-trolled
- 130lb class chair tackle; heavy fluorocarbon leader (200–300lb)
- Require HMS permit and NOAA reporting within 24hr; strict retention quota

CANYON SCHOOL/MEDIUM BLUEFIN (May–Oct):
- Mixed in with yellowfin on canyon edges; 200–800ft bottom depth
- Chunking butterfish on mixed spreads; use heavier gear ready in rod holders
- Trolling spreader bars at 5–7 knots
- When large bluefin appear in chunk line: switch to heavier stand-up gear
`,
      NORTHEAST: `
TECHNIQUES — NORTHEAST BLUEFIN TUNA:
STELLWAGEN BANK GIANTS (MA, Aug–Nov):
- Giants stage on Stellwagen 16mi from Provincetown — world class giant bluefin
- Live bait: live herring or mackerel on heavy stand-up 130lb class
- Chunking: herring, mackerel, butterfish; stagger depths heavily
- Look for whales on the bank — both feeding on same sand eel/herring schools
- Birds + whale spouts = tuna right there

INSHORE GORGE SCHOOLS (NJ/NY/RI/MA, Oct–Dec):
- School and medium fish (30–300lbs) move close to beach as water cools
- Sometimes 1–5 miles off Montauk, Sandy Hook, RI beaches
- Birds, porpoise, sand lance — visual cues from boat or even beach
- Casting metals and topwater poppers (3–5oz) into boiling fish
- Chunking from drifting boat; 65lb braid + 80lb fluorocarbon topshot + 4-6ft leader

CANYON FISH (June–Oct):
- Similar to mid-Atlantic; spreader bars, chunking butterfish/sardines
- Bigeye mix-in at night during chunking — set deep baits at 100ft+
- HMS permit required; report all bluefin kept within 24hr
`,
    }
  },

  // ─────────────────────────────────────────────────────────────

  BLUE_MARLIN: {
    id: 'BLUE_MARLIN',
    name: 'Blue Marlin',

    biology: `
BLUE MARLIN BIOLOGY:
- Atlantic's apex billfish; females reach 1,000+ lbs (granders); typical recreational catch 200–500 lbs
- Deep-water and warm-water species: optimal SST 78–85°F; rarely in water below 72°F
- Primarily found at 100 fathoms (600ft) and deeper; range to 500 fathoms
- Feed from below — ambush technique; rise to the surface to eat
- Aggressive feeders on large skirted lures and natural baits; also eat mahi, tuna, squid
- Spawn North Atlantic July–Sept
- Follow warm-water bait schools (bonito, tuna, mahi) — find the bait/find the blue
- Hatteras, NC: "Blue Marlin Capital of the World" — Gulf Stream closest to shore in summer
- HMS angling permit required; release encouraged; weight limit for retention varies by state
`,

    depthByRegion: {
      SE_FLORIDA:   { min: 400, max: 3000, sweet: '600–2000ft', notes: 'Gulf Stream edge; rare inshore. May–Sept window. Primary fishing off Miami/Palm Beach Gulf Stream.' },
      MID_ATLANTIC: { min: 400, max: 3000, sweet: '600–1800ft', notes: '100-fathom curve starting point; canyon walls and seamounts. June–Sept peak. Hatteras and Oregon Inlet primary.' },
      NORTHEAST:    { min: 500, max: 3000, sweet: '800–2000ft', notes: 'Sporadic; warm-water eddy dependent. July–Sept only. Canyon grounds off NJ/NY/RI.' },
    },

    techniquesByRegion: {
      SE_FLORIDA: `
TECHNIQUES — SE FLORIDA BLUE MARLIN:
- Gulf Stream and warm eddies beyond the reef; 400ft+ bottom depth required
- Trolling spread at 6–9 knots: 6–8 lines total
  - Flatlines: large skirted horse ballyhoo or naked ballyhoo close to boat
  - Short riggers: Black Bart Breakfast or Brazilliano lures + squid teasers
  - Long riggers: large skirted lures or Spanish mackerel
  - Center/shotgun: large diving plug or weighted skirted ballyhoo
- Look for: frigate birds, mahi schools, tuna concentrations — blue marlin underneath/nearby
- Color: red-and-black, blue-and-white, black-and-purple are proven blue marlin colors
- Seasonal: May–Sept; peak June–Aug; offshore of Miami produces July–Aug
`,
      MID_ATLANTIC: `
TECHNIQUES — MID-ATLANTIC BLUE MARLIN:
- 100-fathom curve (600ft) and deeper along canyon walls
- Trolling spread 6–9 knots with large natural and artificial baits
  - Horse skirted ballyhoo on short riggers
  - Black Bart lures, Hawaiian chuggers, custom plugs on long riggers and center
  - Squid chain teaser + big Mold Craft or squid combination
  - Spanish mackerel if available — top-tier blue marlin bait
- "Triangulation" method: mark each strike, find the triangle pattern, work inside triangle
- Temperature break crossing canyon wall = prime setup; follow the warm-water eddy edge
- Peak: July–Aug at Hatteras (closest Gulf Stream) and Oregon Inlet
- Look for warm eddy (78°F+) intersecting canyon structure; marlin will be there
- NC Governor's Cup and Big Rock tournaments drive the high-season blue marlin fishery
`,
      NORTHEAST: `
TECHNIQUES — NORTHEAST BLUE MARLIN:
- Warm-water eddy dependent; must find 78°F+ water over deep structure
- Canyon mouths and outside edges July–Sept
- Same trolling spread approach as mid-Atlantic
- Less concentrated than mid-Atlantic; most are incidental catches on tuna/white marlin trips
- Hudson Canyon and Atlantis Canyon produce some each summer
`,
    }
  },

  // ─────────────────────────────────────────────────────────────

  WHITE_MARLIN: {
    id: 'WHITE_MARLIN',
    name: 'White Marlin',

    biology: `
WHITE MARLIN BIOLOGY:
- Smallest Atlantic marlin; typically 40–80 lbs; world record 181 lbs
- Prefer slightly shallower and closer-to-shore than blue marlin: 50–300 fathoms common
- Optimal SST: 74–82°F; follow same Gulf Stream-driven migration corridor as sailfish
- Feed near the surface; often visible as dorsal fin and tail tip
- Fast runners and aerial acrobats; light tackle (30lb class) is ideal sportfishing
- Live tinker mackerel = legendary white marlin bait (Virginia Beach captains built careers on it)
- Ocean City, MD: home of the White Marlin Open — richest billfish tournament
- Peak concentration: pre-migration stack-up at Virginia Beach/Hatteras late Aug–Sept
- Often travel in groups following bait schools; double-digit release days common at Virginia Beach
- HMS permit required; catch-and-release strongly encouraged; retention closely regulated
`,

    depthByRegion: {
      SE_FLORIDA:   { min: 200, max: 1500, sweet: '300–800ft', notes: 'Feb–May migration north; Sept–Nov migration south. Much less common than sailfish.' },
      MID_ATLANTIC: { min: 200, max: 2000, sweet: '300–900ft', notes: 'THE primary white marlin region. 50–300 fathom zone from canyon mouths to shelf break. Aug–Sept peak concentration.' },
      NORTHEAST:    { min: 300, max: 2000, sweet: '400–1000ft', notes: 'Late Aug–Sept only; canyon grounds. Less common than mid-Atlantic.' },
    },

    techniquesByRegion: {
      SE_FLORIDA: `
TECHNIQUES — SE FLORIDA WHITE MARLIN:
- Incidental catch during sailfish and blue marlin season
- Trolling dead rigged ballyhoo on 30–50lb class tackle
- If whites are around: add small flat-line ballyhoo between the bigger lures
- Feb–April migration north is primary window; Sept–Nov south migration
`,
      MID_ATLANTIC: `
TECHNIQUES — MID-ATLANTIC WHITE MARLIN:
PRIMARY: Slow-trolling live bait
  - Live tinker mackerel (small Atlantic mackerel) on 30lb class tackle
  - Deploy 4 lines; troll at 4–5 knots over canyon edges and temperature breaks
  - Circle hooks on live bait; light wire on cut bait
  - Captain Randy Butler method: slow-troll live tinkers = 400+ white marlin in best season

SECONDARY: Dead bait and artificial spread
  - Small skirted ballyhoo on flat lines
  - Artificial: small Black Bart or Pakula Sprocket on short rigger; small ballyhoo on flat lines
  - High-speed option (10 knots): covers more ground; artificial lures + small skirted ballyhoo
  - Small squid teasers (2-tier dredge) to attract whites to the spread

LOCATION:
  - Washington Canyon and Poor Man's Canyon off Virginia Beach
  - 50–500 fathom spread; start at 50 fathoms and work out
  - Temperature break crossing canyon wall = highest white marlin density
  - First full moon in August at Oregon Inlet = historically best bite timing
  - Virginia Beach pre-migration stack: late Aug–Sept before they sprint to FL

TOURNAMENT STRATEGY:
  - White Marlin Open (Ocean City, MD): Aug 4–10 window typically
  - Fish within 100mi of sea buoy; target 50–300 fathom zone
  - Live tinker mackerel unavailable? High-speed lure spread to cover more ground
`,
      NORTHEAST: `
TECHNIQUES — NORTHEAST WHITE MARLIN:
- Late Aug–Sept only; incidental on marlin/tuna trips
- Canyon mouths and warm eddy edges
- Trolling small skirted ballyhoo and small artificial lures at 5–6 knots
- Much less consistent than mid-Atlantic; rarely a primary target
`,
    }
  },

  // ─────────────────────────────────────────────────────────────

  SWORDFISH: {
    id: 'SWORDFISH',
    name: 'Swordfish (Broadbill)',

    biology: `
SWORDFISH BIOLOGY:
- Broadbill swordfish; apex deep-water predator; 50–600+ lbs common; can exceed 1,000 lbs
- Deep scattering layer (DSL) dictates behavior:
  * DAYTIME: 90% of time near bottom in 1,000–2,000ft (some tagged fish to 4,750ft)
  * NIGHTTIME: Rise to 200–600ft following squid and baitfish in DSL ascent
- Primary food: squid (large portion of diet), also mackerel, herring, mahi, various fish
- Daytime fish are larger on average than night fish; fighting up from 1,500ft is epic
- Find structure (seamounts, canyon walls, humps) in 1,000–2,000ft — swords hold in current eddies behind structure
- "Stemming the tide" technique: drive boat against current to maintain bait position while drifting deep
- Strobe lights essential: attach 12ft above bait to help swords find it in the dark
- Electric reels highly recommended — retrieving 1,500ft of empty line by hand is brutal
- No HMS permit required; federal reporting if retained; check state size limits
`,

    depthByRegion: {
      SE_FLORIDA:   { min: 1000, max: 3000, sweet: '1000–2000ft', notes: 'Daytime deep drop: 15+ miles offshore into deep Gulf Stream water. Night drift: 400–800ft water 10–20mi out.' },
      MID_ATLANTIC: { min: 1000, max: 3000, sweet: '1000–1800ft', notes: 'Canyon edges and canyon walls in 1,000–1,800ft. Washington, Norfolk canyons prime. July–Jan.' },
      NORTHEAST:    { min: 1000, max: 3000, sweet: '1000–1800ft', notes: 'Northeast canyons (Atlantis, Veatch, Atlantis, Hydrographer) 75–130mi out. Daytime and night; June–Jan.' },
    },

    techniquesByRegion: {
      SE_FLORIDA: `
TECHNIQUES — SE FLORIDA SWORDFISH:
DAYTIME DEEP DROP (primary):
  - Target 1,000–2,000ft water 15+ miles offshore in deep Gulf Stream
  - Rig: 10/0 hook + 12ft of 300lb mono bite leader + 100ft of 150lb mono + 80lb hollow braid
  - Bait: rigged mahi belly, wahoo strip, or large whole squid — sew to hook
  - Add 10lb breakaway lead or cannon ball weight to get bait to bottom
  - Attach strobe light 12ft above bait
  - Deploy to bottom (100ft above) — takes 15+ min to reach 1,500ft
  - Technique: drive into current (Gulf Stream 3+ knots) just fast enough to maintain 1.5-knot northward troll
  - The "bump troll": slowly move across current to cover structure
  - Set lines at 3 different depths: near bottom, 800ft, 1,300ft
  - Rod tip movement = bite; reel as fast as possible — 90% of the fight is the retrieve

NIGHTTIME DRIFT:
  - Much simpler: anchor or drift in 500–800ft
  - Bait: rigged large squid or live blue runner with strobe 12ft above bait
  - Set multiple baits at staggered depths (50ft, 150ft, 300ft)
  - Squids/baits drift in current column where night-feeding swords are hunting
  - Night fish: 30–100lbs common; daytime fish larger

SEASONAL: Year-round; daytime producing consistently; November–March when Gulf Stream pulls close
`,
      MID_ATLANTIC: `
TECHNIQUES — MID-ATLANTIC SWORDFISH:
DAYTIME DEEP DROP:
  - Same Florida technique adapted for stronger currents
  - Canyon walls and structure in 1,000–1,600ft at Washington and Norfolk Canyons
  - "Chinks and drops" in canyon (mini-canyons in larger canyon) = highest concentration
  - Set up so drift takes you up or down along a canyon edge
  - Watch sounder for bait marks — swords hold in current eddies behind structure
  - Current: backside of structure is where swords ambush bait swept by current

NIGHTTIME:
  - Drift in 500–800ft at canyon mouth
  - Strobe lights + rigged squid at 50ft, 150ft, 300ft depths
  - Overnight trips: can produce multiple fish

SEASONAL: July–January; peak Sept–Nov at Washington/Norfolk Canyon; boat-ride from Virginia Beach/Ocean City
`,
      NORTHEAST: `
TECHNIQUES — NORTHEAST SWORDFISH:
DAYTIME DEEP DROP (growing fishery since ~2014):
  - Canyons 75–130mi offshore: Atlantis, Veatch, Hydrographer
  - Same rig as Florida/mid-Atlantic; adapt weight for lower Gulf Stream current influence
  - Water 1,000–1,800ft; bait near bottom
  - Less current in NE canyons — bump-troll at very slow speed
  - June–January; peak Sept–Oct

NIGHTTIME (longer history in NE):
  - Overnight canyon trips; drift in 500–800ft on canyon edge
  - Rigged squid + strobe lights at 50–300ft staggered depths
  - RI and MA: night drift has produced consistently for decades
  - Best months: Aug–Nov

TRANSITION TACTIC:
  - Many NE canyon captains: troll for tuna/marlin all morning; switch to sword drop midday when tuna bite slows
  - Can produce tuna + swordfish in same day trip
`,
    }
  },

  // ─────────────────────────────────────────────────────────────

  SNAPPER_GROUPER: {
    id: 'SNAPPER_GROUPER',
    name: 'Snapper & Grouper (Bottom)',

    biology: `
SNAPPER & GROUPER BIOLOGY:
GROUPER SPECIES:
  - Gag grouper: reef and hard bottom 60–400ft; 5–50lbs; aggressive feeders; Jan–April closed on Atlantic
  - Black grouper: reef structure 60–300ft; 10–100lbs; powerful structure fighters
  - Red grouper: Gulf primary; hard bottom 60–300ft; 3–15lbs common
  - Scamp grouper: prized flavor; 60–200ft reef and ledge structure
  - Snowy grouper: deep reef 300–600ft; slow-pitch jigging and live bait
  - Goliath grouper: fully protected catch-and-release only; structure and wrecks 20–150ft

SNAPPER SPECIES:
  - Yellowtail snapper: reef in 40–200ft; best at night with chum; SE Florida and Keys year-round
  - Mutton snapper: reef structure 60–200ft; excellent table fish; SE Florida spring/summer spawn
  - Mangrove (gray) snapper: nearshore to 200ft; ubiquitous; responds to chum
  - Red snapper: Gulf primary; hard bottom 60–300ft; federally managed quota seasons
  - Vermilion snapper (beeliners): 100–400ft; extremely responsive to chum; mid-Atlantic common
  - Cubera snapper: large aggressive snapper 100–300ft; SE Florida and Keys

DEEPWATER SPECIES (Mid-Atlantic/NE):
  - Golden tilefish: 400–800ft; sandy/muddy bottom canyon walls; burrow nesters
  - Blueline tilefish: 200–400ft; slightly shallower than golden; excellent eating
  - Snowy grouper: 300–600ft canyon structure
  - Barrel fish: 400–1000ft deep canyon; bizarre looking, fantastic eating
  - Blackbelly rosefish: 300–600ft; uncommon but present in NE canyons
`,

    depthByRegion: {
      SE_FLORIDA:   { min: 40,  max: 400, sweet: '60–200ft', notes: 'Reef structure (60–180ft) for snapper/grouper. Deeper ledge (180–400ft) for scamp, snowy grouper. Year-round but seasonal closures apply.' },
      MID_ATLANTIC: { min: 60,  max: 1000, sweet: '80–400ft', notes: 'Reef and hard bottom 60–200ft for snapper/gag; canyon walls 300–600ft for tilefish and snowy grouper. Seasonal closures vary.' },
      NORTHEAST:    { min: 60,  max: 1000, sweet: '100–700ft', notes: 'Sea bass and tilefish dominant. Canyon walls 300–700ft for blueline and golden tilefish. Sea bass 60–200ft. Seasonal regulations.' },
    },

    techniquesByRegion: {
      SE_FLORIDA: `
TECHNIQUES — SE FLORIDA SNAPPER & GROUPER:
YELLOWTAIL SNAPPER (40–120ft reef):
  - Anchor over reef; heavy chum bag + hand-thrown chunks of frozen chum block
  - Ultralight fluorocarbon leader (10–15lb) with small hook (2/0–4/0) + cut baitfish or shrimp
  - Fish "in the slick" — baits drift back in the chum; no weight on hook
  - Night chumming over reef = spectacular yellowtail action
  - Kite fishing produces incidental sailfish and wahoo over same reef

GROUPER (80–180ft reef and ledge):
  - Bottom fish on hard structure — ledges, rock piles, wrecks, artificial reefs
  - Heavy egg sinker (4–8oz) + fluorocarbon leader + large circle hook (6/0–9/0)
  - Live bait: pinfish, blue runners, grunts — best for big gag and black grouper
  - Cut bait: chunks of bonito, grunt, sardine
  - Vertical jigging: lead-head jigs 2–4oz; work near bottom aggressively
  - CRITICAL: turn grouper away from structure immediately on hookup — they dive for holes

DEEP BOTTOM (180–400ft):
  - Electric reel or conventional with heavy braid (60–80lb)
  - Slow-pitch jigging: 100–200g slow-pitch jigs worked at bottom
  - Scamp and snowy grouper respond well to whole squid and large cut baits
  - Check FWC for seasonal closures — Atlantic grouper complex closes Jan–April

SEASONAL: Yellowtail year-round (peaks Oct–June); grouper closures Jan–April Atlantic check FWC
`,
      MID_ATLANTIC: `
TECHNIQUES — MID-ATLANTIC SNAPPER & GROUPER:
REEF AND HARD BOTTOM (60–200ft):
  - Vermilion snapper (beeliners): chum heavy, small hook + small cut squid; 80–200ft hard bottom
  - Gag grouper: canyon mouth hard bottom and ledges; live bait pinfish/grunts; check seasonal closures
  - Deep drop over ledge: squid strip and cut fish; 4–8oz weight

TILEFISH AND DEEP BOTTOM (300–700ft):
  - Golden tilefish: burrow in sandy/muddy slopes on canyon walls 400–800ft
  - Electric reel essential; 100lb braid; heavy lead (2–4lb)
  - Bait: squid, cut bonito, clam — fished right on bottom or dragged slowly
  - Blueline tilefish: shallower (200–400ft); more accessible; responds to cut squid
  - Barrel fish and snowy grouper: same depths on hard structure — prize catches

VIRGINIA BEACH/NC:
  - Norfolk Canyon deep bottom: target tile and snowy grouper 300–600ft
  - Spring trips (April–June): bottom fishing trip with tilefish focus
  - Combine with tuna trolling on same canyon edge trip
`,
      NORTHEAST: `
TECHNIQUES — NORTHEAST SNAPPER & GROUPER:
SEA BASS (60–200ft):
  - Most common bottom fish from NJ to MA
  - Clam, squid, cut fish on high-low bottom rigs
  - Rocky reef and wreck structure
  - Seasonal opening/closing; check NOAA regulations annually

GOLDEN/BLUELINE TILEFISH (200–800ft):
  - Northeast canyons: electric reel, 100lb braid, 2–3lb lead
  - Blueline: 200–400ft sandy slopes; golden: 400–800ft — both take squid and clam
  - Spring and fall best; summer too warm for some deep species
  - Drop to bottom, reel up 5 cranks — tile are close to bottom but not always on it

DEEP CANYON (400–1000ft):
  - Barrelfish, snowy grouper, rosefish — prize catches when encountered
  - Same deep drop electric reel approach
  - Often caught while targeting swordfish or tilefish
`,
    }
  }
};

// ─── Prompt Builders ──────────────────────────────────────────────────────────

/**
 * Build the system prompt for a given species + region combination.
 * This replaces the single-sentence system prompt in claude.js line 165.
 */
export function buildSystemPrompt(speciesId, region) {
  const species = SPECIES_DATA[speciesId];
  if (!species) return buildGenericSystemPrompt(region);

  const regionCtx = REGION_CONTEXT[region] || REGION_CONTEXT['SE_FLORIDA'];
  const depthInfo = species.depthByRegion[region] || species.depthByRegion['SE_FLORIDA'];
  const techniques = species.techniquesByRegion[region] || species.techniquesByRegion['SE_FLORIDA'];

  return `You are an expert offshore fishing guide with deep knowledge of ${region.replace('_', ' ')} fishing for ${species.name}.

${regionCtx}

${species.biology}

DEPTH CONSTRAINTS — CRITICAL:
For ${species.name} in this region, ONLY recommend spots in ${depthInfo.sweet} depth range.
Minimum depth: ${depthInfo.min}ft. Maximum depth: ${depthInfo.max}ft.
${depthInfo.notes}
NEVER place a ${species.name} hotspot outside this depth range. If your generated coordinates fall in wrong-depth water, move them to the correct depth zone before outputting.

${techniques}

OUTPUT RULES:
- Respond ONLY with valid JSON — no markdown, no preamble, no explanation outside JSON
- Hotspot coordinates MUST fall within the user's specified search boundary
- Hotspot coordinates MUST correspond to the correct depth for this species
- Always explain WHY this location is a hotspot using actual ocean conditions from the data provided
- Recommend specific techniques relevant to current conditions (season, SST, current direction, chlorophyll)
- Depth in feet must match the species depth range above — never exceed or go shallower than the range
`.trim();
}

/**
 * Build the user-side analysis prompt with ocean data.
 * Call this from the frontend to replace the generic prompt.
 */
export function buildAnalysisPrompt({
  speciesId,
  region,
  bounds,         // { north, south, east, west }
  sstData,        // { min, max, avg, gradient } in °F
  chlorData,      // { min, max, avg, unit }
  currentData,    // { speed_kt, dir_deg, source }
  fronts,         // array of front objects with location description
  eddies,         // array of eddy objects
  date,           // ISO date string
  season,         // 'winter' | 'spring' | 'summer' | 'fall'
  reportSignal,   // optional — from fishing-reports.js Stage 4 output
  numHotspots = 4
}) {
  const species = SPECIES_DATA[speciesId];
  const depthInfo = species?.depthByRegion?.[region] || { sweet: '60–300ft', min: 60, max: 300 };
  const speciesName = species?.name || speciesId;

  const frontsStr = fronts?.length
    ? fronts.map(f => `- ${f.description || JSON.stringify(f)}`).join('\n')
    : 'No distinct fronts detected in current data';

  const eddiesStr = eddies?.length
    ? eddies.map(e => `- ${e.description || JSON.stringify(e)}`).join('\n')
    : 'No eddies detected';

  return `Find the top ${numHotspots} ${speciesName} hotspots within these exact boundaries:
North: ${bounds.north}°N  South: ${bounds.south}°N  East: ${bounds.east}°W  West: ${bounds.west}°W
Date: ${date}  Season: ${season}  Region: ${region.replace('_', ' ')}

OCEAN CONDITIONS:
Sea Surface Temperature: ${sstData?.avg?.toFixed(1) || 'unknown'}°F (range: ${sstData?.min?.toFixed(1) || '?'}–${sstData?.max?.toFixed(1) || '?'}°F, gradient: ${sstData?.gradient?.toFixed(2) || '?'}°F/km)
Chlorophyll: ${chlorData?.avg?.toFixed(2) || 'unknown'} ${chlorData?.unit || 'mg/m³'} (range: ${chlorData?.min?.toFixed(2) || '?'}–${chlorData?.max?.toFixed(2) || '?'})
Currents: ${currentData?.speed_kt?.toFixed(2) || 'unknown'} knots from ${currentData?.dir_deg?.toFixed(0) || '?'}° (source: ${currentData?.source || 'unknown'})
Detected fronts:
${frontsStr}
Detected eddies/features:
${eddiesStr}

${buildReportSignalBlock(reportSignal, speciesName)}
DEPTH REQUIREMENT: All hotspots MUST be in ${depthInfo.sweet} water depth. Do not place any ${speciesName} hotspot outside ${depthInfo.min}ft–${depthInfo.max}ft depth range.

COORDINATE VALIDATION: Before finalizing each hotspot, verify the lat/lon falls within the search boundary above AND corresponds to the correct depth for ${speciesName}. If a coordinate would land in too-deep or too-shallow water, adjust it toward the correct depth contour.

Respond ONLY with this exact JSON structure:
{
  "hotspots": [
    {
      "rank": 1,
      "name": "Descriptive location name",
      "confidence": "High|Medium|Low",
      "lat": 00.0000,
      "lon": -00.0000,
      "depthFt": 000,
      "distanceMi": 0,
      "bearing": "NE|SE|etc from nearest inlet",
      "species": ["${speciesName}"],
      "why": "Specific explanation referencing actual SST, current, chlorophyll, or front data above",
      "technique": "Specific technique for these exact conditions",
      "tip": "One pro tip for this exact location and condition"
    }
  ],
  "overallConditions": "Brief summary of how today's ocean conditions affect ${speciesName} in this area",
  "proTip": "One overall strategic tip for today"
}`;
}

/**
 * Build the report signal block for injection into the analysis prompt.
 * Always labeled LOW WEIGHT so Claude treats it as activity confirmation only.
 */
function buildReportSignalBlock(signal, speciesName) {
  if (!signal || signal.activity_level === 'unknown' || signal.report_count === 0) {
    return `RECENT FISHING REPORT SIGNAL: No recent reports found — base hotspots entirely on ocean data above.\n`;
  }

  const freshness = signal.freshest_hours <= 24  ? `${signal.freshest_hours}h ago`
                  : signal.freshest_hours <= 72  ? `${Math.round(signal.freshest_hours / 24)}d ago`
                  : `${Math.round(signal.freshest_hours / 24)}d ago (stale)`;

  const techniqueHint = signal.techniques_mentioned?.length
    ? `Technique mentioned: ${signal.techniques_mentioned[0]}.`
    : '';

  return `RECENT FISHING REPORT SIGNAL (LOW WEIGHT — activity confirmation only, NOT a location source):
Activity level: ${signal.activity_level.toUpperCase()}
Summary: ${signal.summary}
Reports used: ${signal.report_count} (freshest: ${freshness})
${techniqueHint}
Confidence adjustment: ${signal.confidence_adjustment.replace('_', ' ')}
RULE: Use this signal only to confirm whether ${speciesName} are actively feeding in the region. Do NOT use report location hints to place hotspot coordinates — hotspot placement must come from the ocean data above.
`;
}

/**
 * Get all available species for a given region.
 */
export function getSpeciesForRegion(region) {
  const allSpecies = Object.values(SPECIES_DATA);
  return allSpecies.filter(s => s.depthByRegion[region]);
}

/**
 * Generic fallback system prompt when species is not in library.
 */
function buildGenericSystemPrompt(region) {
  const regionCtx = REGION_CONTEXT[region] || REGION_CONTEXT['SE_FLORIDA'];
  return `You are an expert offshore fishing guide for ${region.replace('_', ' ')}.
${regionCtx}
Respond ONLY with valid JSON. Place hotspots only within the user's specified search boundary and at depths appropriate for the target species.`;
}

export { SPECIES_DATA, REGION_CONTEXT };

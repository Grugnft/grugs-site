// Grug body renderer — the canonical, polished renderer.
// Extracted from body-iterations.mjs after the V2L body was locked in.
//
// Exports:
//   P            — palette
//   px, darker, lighter — pixel helpers
//   renderGrug(traits, opts) — full 24x32 grug portrait SVG
//   drawBackground(t), drawBody(t), drawHead(t), drawHair(t), drawHat(t) — parts
//
// Traits shape:
//   { skin, brow, eyes, mouth, teeth, facePaint, hairColor, hairStyle,
//     hat, clothing, item, background, legs?: 'bare' | 'loincloth' (default 'bare') }

export const P = {
  darkBlueBlack: '#0a0e1a', darkBlueMid: '#141a2a',
  moonBg:        '#0e1424', moonMid: '#161e2e', moonRim: '#c8d4e8',
  ochreWall:     '#3a2010', ochreDark: '#2a1808', ochrePaint: '#e8a848',
  waterTeal:     '#0e1e28', waterMid: '#1a2e3a', waterDrop: '#8ac8e0',
  iceBlue:       '#3a5060', iceMid: '#2a3a4a', iceHighlight: '#c8d8e8',
  redRock:       '#2a0a08', redRockMid: '#40140a', redRockDark: '#180505',
  stormGrey:     '#20202a', stormMid: '#161620', stormFlash: '#f8f4d8',
  mossGreen:     '#1a2a18', mossDark: '#0e180e', mossLight: '#6a8a48',
  sunsetOrange:  '#3a1810', sunsetPink: '#4a1e2a', sunsetPurple: '#1e1428',
  fireGlow:      '#ffb400', fireGlowFaint: '#8a5a10', fireBase: '#1a0a04',

  caveBackDark:  '#100a04', caveBackMid: '#1a1108',
  bodyRim:       '#0f0806',      // near-black rim for body silhouette
  vignette:      '#000000',

  skinPale: '#d4a486', skinMid: '#b57a52', skinDark: '#6a3820', skinAsh: '#96795e',

  hairBlack: '#241a12', hairBlackHi: '#3a2a1c',
  hairBrown: '#4a2c18', hairBrownHi: '#6a4028',
  hairGrey:  '#5a4a40', hairGreyHi: '#8a7a70',
  hairRed:   '#6a2810', hairRedHi: '#a04020',

  furBrown: '#4d3020', furGrey: '#5a5048', furWhite: '#b8a898', furBlack: '#161010',
  leafGreen:'#3a6a2c', bonePale:'#d8c8a8', clayRed:'#8a2820',

  mudRed:'#8a2820', mudWhite:'#d8c8b0', mudBlack:'#0a0505', mudOchre:'#c88a30',
  toothWhite:'#e8dcc0', eyeWhite:'#e8d8c0', eyeBlack:'#0a0505',

  rockGrey:'#6a5c50', boneWhite:'#d8c8a8', stickBrown:'#4a3020',
  gold:'#f4c542', goldDark:'#a67810',
  berryRed:'#a01818', fishSilver:'#8ab0c0',
};

export const SKIN = { pale:P.skinPale, mid:P.skinMid, dark:P.skinDark, ash:P.skinAsh };
export const HAIR = { black:[P.hairBlack,P.hairBlackHi], brown:[P.hairBrown,P.hairBrownHi],
                     grey:[P.hairGrey,P.hairGreyHi], red:[P.hairRed,P.hairRedHi] };
export const PELT_COLOR = { 'brown pelt':P.furBrown,'grey pelt':P.furGrey,
                            'black pelt':P.furBlack,'white pelt':P.furWhite };

export const W = 24, H = 32, SCALE = 20;

export const px = (x, y, w, h, c) =>
  `<rect x="${x*SCALE}" y="${y*SCALE}" width="${w*SCALE}" height="${h*SCALE}" fill="${c}" shape-rendering="crispEdges"/>`;

export const darker = (hex, amt = 32) => {
  const r = Math.max(0, parseInt(hex.slice(1,3),16)-amt);
  const g = Math.max(0, parseInt(hex.slice(3,5),16)-amt);
  const b = Math.max(0, parseInt(hex.slice(5,7),16)-amt);
  return `#${[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('')}`;
};
export const lighter = (hex, amt = 24) => {
  const r = Math.min(255, parseInt(hex.slice(1,3),16)+amt);
  const g = Math.min(255, parseInt(hex.slice(3,5),16)+amt);
  const b = Math.min(255, parseInt(hex.slice(5,7),16)+amt);
  return `#${[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('')}`;
};

// ---------- Background (V2 polish — depth + vignette + rich decoration) ----------
export function drawBackground(t) {
  const parts = [];
  const bg = t.background;

  const fills = {
    'cold cave':      [P.darkBlueBlack, P.darkBlueMid],
    'moonlit cave':   [P.moonBg, P.moonMid],
    'cave paintings': [P.ochreWall, P.ochreDark],
    'dripping water': [P.waterTeal, P.waterMid],
    'fire glow':      [P.fireBase, P.caveBackMid],
    'ice cave':       [P.iceMid, lighter(P.iceMid, 12)],
    'red rock':       [P.redRockMid, P.redRock],
    'storm cave':     [P.stormMid, P.stormGrey],
    'moss cave':      [P.mossDark, P.mossGreen],
    'sunset mouth':   [P.sunsetPurple, P.sunsetOrange],
  };
  const [base, mid] = fills[bg] || fills['cold cave'];
  parts.push(`<rect width="${W*SCALE}" height="${H*SCALE}" fill="${base}"/>`);

  // Back-wall gradient — lighter rim near the ceiling, gradually darker
  const rim1 = lighter(base, 22);
  const rim2 = lighter(base, 14);
  const rim3 = lighter(base, 6);
  parts.push(px(4, 3, 16, 2, rim1));         // brightest ring at top
  parts.push(px(3, 5, 18, 1, rim2));
  parts.push(px(3, 6, 18, 1, rim3));
  parts.push(px(2, 7, 20, 1, rim3));

  // Scattered rock chunks along the walls (bigger + varied)
  const rocks = [
    [0,0,4,3], [20,0,4,4], [10,0,3,2], [6,1,2,2], [16,2,2,2],
    [0,10,2,3], [22,12,2,3],
    [0,18,3,2], [21,20,3,2],
  ];
  for (const [x,y,w,h] of rocks) parts.push(px(x,y,w,h,mid));

  // Small speckles for cave dust/pebbles
  const specks = [[3,12,1,1],[20,14,1,1],[2,16,1,1],[21,17,1,1],[4,22,1,1],[19,23,1,1]];
  for (const [x,y,w,h] of specks) parts.push(px(x,y,w,h,darker(mid, 12)));

  // Cave floor — 2 rows at bottom for grounding
  parts.push(px(0, 30, W, 2, darker(base, 20)));
  parts.push(px(0, 29, W, 1, darker(base, 8)));

  // Focal darkening BEHIND grug — soft vignette pocket where the character sits
  // This is what makes any grug pop against any background.
  const pocket = darker(base, 26);
  parts.push(px(4, 8, 16, 12, pocket));   // large soft dark rect where body sits
  parts.push(px(3, 20, 18, 8, pocket));   // extends down for legs/feet
  parts.push(px(5, 7, 14, 1, darker(base, 16)));  // pocket top edge (softer)
  parts.push(px(4, 28, 16, 1, darker(base, 16))); // pocket bottom edge

  // Corner vignette — always darkens the 4 corners for center-focus
  const shadow = darker(base, 36);
  parts.push(px(0, 0, 3, 1, shadow));   parts.push(px(0, 0, 1, 3, shadow));
  parts.push(px(21, 0, 3, 1, shadow));  parts.push(px(23, 0, 1, 3, shadow));
  parts.push(px(0, 31, 3, 1, shadow));  parts.push(px(0, 29, 1, 3, shadow));
  parts.push(px(21, 31, 3, 1, shadow)); parts.push(px(23, 29, 1, 3, shadow));

  // Per-background decoration on top of depth layers
  if (bg === 'fire glow') {
    // amber glow from below (the fire is behind/below the grug)
    parts.push(px(0, 24, W, 8, P.fireGlowFaint));
    parts.push(px(0, 28, W, 4, P.fireGlow));
    parts.push(px(0, 26, W, 1, lighter(P.fireGlow, 20)));
    // little sparks in the air
    parts.push(px(3, 20, 1, 1, P.fireGlow));
    parts.push(px(20, 19, 1, 1, P.fireGlow));
    parts.push(px(6, 17, 1, 1, P.fireGlowFaint));
    parts.push(px(18, 16, 1, 1, P.fireGlowFaint));
  } else if (bg === 'moonlit cave') {
    // Moon disc in top-right + rim light on wall
    parts.push(px(18, 1, 4, 4, P.moonRim));
    parts.push(px(17, 2, 1, 2, P.moonRim));
    parts.push(px(22, 2, 1, 2, P.moonRim));
    parts.push(px(19, 2, 2, 2, lighter(P.moonRim, 20)));
    parts.push(px(4, 3, 16, 1, lighter(P.moonBg, 30)));  // moon-lit rim
    // Small stars
    parts.push(px(2, 1, 1, 1, P.moonRim));
    parts.push(px(11, 0, 1, 1, P.moonRim));
    parts.push(px(15, 5, 1, 1, P.moonRim));
    parts.push(px(6, 6, 1, 1, P.moonRim));
  } else if (bg === 'cave paintings') {
    // Bright ochre stick figures on darkened walls — POP now
    parts.push(px(2, 4, 1, 2, P.ochrePaint));
    parts.push(px(2, 6, 1, 4, P.ochrePaint));
    parts.push(px(1, 7, 3, 1, P.ochrePaint));
    parts.push(px(2, 10, 1, 3, P.ochrePaint));
    parts.push(px(1, 12, 1, 1, P.ochrePaint));
    parts.push(px(3, 12, 1, 1, P.ochrePaint));
    // Mammoth silhouette painting on right wall
    parts.push(px(20, 10, 3, 2, P.ochrePaint));
    parts.push(px(19, 11, 1, 1, P.ochrePaint));
    parts.push(px(23, 11, 1, 1, P.ochrePaint));
    parts.push(px(20, 12, 1, 1, P.ochrePaint));
    parts.push(px(22, 12, 1, 1, P.ochrePaint));
    // Handprint
    parts.push(px(21, 22, 3, 2, P.ochrePaint));
    parts.push(px(21, 21, 1, 1, P.ochrePaint));
    parts.push(px(23, 21, 1, 1, P.ochrePaint));
  } else if (bg === 'dripping water') {
    // Stalactites hanging + water drops
    parts.push(px(3, 0, 2, 3, darker(P.waterTeal, 20)));
    parts.push(px(3, 3, 1, 1, darker(P.waterTeal, 12)));
    parts.push(px(20, 0, 2, 4, darker(P.waterTeal, 20)));
    parts.push(px(20, 4, 1, 1, darker(P.waterTeal, 12)));
    parts.push(px(3, 5, 1, 1, P.waterDrop));
    parts.push(px(20, 7, 1, 1, P.waterDrop));
    parts.push(px(11, 3, 1, 1, P.waterDrop));
    // Pool at floor
    parts.push(px(0, 30, W, 2, lighter(P.waterTeal, 16)));
    parts.push(px(0, 30, W, 1, P.waterDrop));
  } else if (bg === 'ice cave') {
    // Ice crystals + frost
    parts.push(px(1, 10, 2, 2, P.iceHighlight));
    parts.push(px(21, 12, 2, 2, P.iceHighlight));
    parts.push(px(2, 20, 1, 1, P.iceHighlight));
    parts.push(px(22, 22, 1, 1, P.iceHighlight));
    parts.push(px(0, 29, W, 2, lighter(P.iceMid, 20)));
    parts.push(px(0, 31, W, 1, P.iceHighlight));
    // Frost cracks on the wall
    parts.push(px(5, 12, 1, 3, lighter(P.iceMid, 30)));
    parts.push(px(18, 15, 1, 2, lighter(P.iceMid, 30)));
  } else if (bg === 'red rock') {
    // Horizontal strata + jagged formations
    parts.push(px(0, 5, W, 1, lighter(P.redRockMid, 16)));
    parts.push(px(0, 14, W, 1, lighter(P.redRockMid, 20)));
    parts.push(px(0, 25, W, 1, lighter(P.redRockMid, 12)));
    parts.push(px(0, 8, 2, 3, lighter(P.redRockMid, 24)));
    parts.push(px(22, 6, 2, 4, lighter(P.redRockMid, 24)));
  } else if (bg === 'storm cave') {
    // Lightning bolt through the cave mouth
    parts.push(px(19, 0, 1, 3, P.stormFlash));
    parts.push(px(18, 3, 1, 2, P.stormFlash));
    parts.push(px(19, 5, 1, 2, P.stormFlash));
    parts.push(px(20, 7, 1, 1, P.stormFlash));
    // Distant flash lighting the wall behind
    parts.push(px(15, 4, 4, 3, lighter(P.stormMid, 16)));
    parts.push(px(4, 12, 1, 1, P.stormFlash));
  } else if (bg === 'moss cave') {
    // Moss clumps
    parts.push(px(1, 15, 2, 3, P.mossLight));
    parts.push(px(21, 18, 2, 3, P.mossLight));
    parts.push(px(0, 25, 4, 3, P.mossLight));
    parts.push(px(20, 26, 4, 3, P.mossLight));
    parts.push(px(2, 14, 1, 1, lighter(P.mossLight, 20)));
    parts.push(px(22, 17, 1, 1, lighter(P.mossLight, 20)));
    // Small mushroom
    parts.push(px(1, 22, 2, 1, '#a04a4a'));
    parts.push(px(1, 23, 1, 1, P.mossLight));
  } else if (bg === 'sunset mouth') {
    // Sky bands (sunset) in top half
    parts.push(px(0, 0, W, 4, P.sunsetPurple));
    parts.push(px(0, 4, W, 3, P.sunsetPink));
    parts.push(px(0, 7, W, 2, lighter(P.sunsetOrange, 10)));
    // Sun
    parts.push(px(10, 4, 4, 3, '#f8c460'));
    parts.push(px(11, 3, 2, 1, '#f8c460'));
    parts.push(px(11, 7, 2, 1, '#c88030'));
  }

  return parts.join('');
}

// ---------- Head (V2 polish — jaw taper, ears, nose bridge, cheek shading) ----------
export function drawHead(t) {
  const parts = [];
  const hx = 7, hy = 8, hw = 10, hh = 12;
  const skin = SKIN[t.skin];
  const skinShade = darker(skin, 20);
  const skinDeep  = darker(skin, 36);
  const skinLight = lighter(skin, 12);

  // Main head block — full width for top 10 rows
  parts.push(px(hx, hy, hw, hh - 2, skin));
  // Jaw taper — bottom 2 rows are 1 pixel narrower on each side (proper chin)
  parts.push(px(hx + 1, hy + hh - 2, hw - 2, 1, skin));
  parts.push(px(hx + 2, hy + hh - 1, hw - 4, 1, skin));

  // Ears — 1-pixel bumps on both sides at eye/nose height
  parts.push(px(hx - 1, hy + 4, 1, 3, skin));
  parts.push(px(hx + hw, hy + 4, 1, 3, skin));
  // Ear inner shadow (canal)
  parts.push(px(hx - 1, hy + 5, 1, 1, skinDeep));
  parts.push(px(hx + hw, hy + 5, 1, 1, skinDeep));

  // Head outline — top, sides, jaw, chin
  parts.push(px(hx, hy, hw, 1, skinShade));                      // top
  parts.push(px(hx, hy, 1, hh - 2, skinShade));                  // left side
  parts.push(px(hx + hw - 1, hy, 1, hh - 2, skinShade));         // right side
  parts.push(px(hx + 1, hy + hh - 2, 1, 1, skinShade));          // jaw corner L
  parts.push(px(hx + hw - 2, hy + hh - 2, 1, 1, skinShade));     // jaw corner R
  parts.push(px(hx + 2, hy + hh - 1, hw - 4, 1, skinShade));     // chin underside

  // Cheek highlight — subtle lighter patch just below eyes for cheekbone hint
  parts.push(px(hx + 1, hy + 8, 1, 1, skinLight));
  parts.push(px(hx + hw - 2, hy + 8, 1, 1, skinLight));

  // Brow (heavy caveman)
  const browColor = darker(skin, 72);
  if (t.brow === 'heavy' || t.brow === 'ultra heavy')
    parts.push(px(hx + 1, hy + 2, hw - 2, 1, browColor));
  if (t.brow === 'ultra heavy' || t.brow === 'unibrow')
    parts.push(px(hx + 1, hy + 3, hw - 2, 1, browColor));
  // Brow shadow row under the brow for depth
  if (t.brow === 'ultra heavy')
    parts.push(px(hx + 1, hy + 4, hw - 2, 1, darker(skin, 24)));

  // Eyes — same pixel positions, now with proper eye sockets
  const eyeY = hy + 4;
  // Eye socket shadow (creates depth under brow)
  parts.push(px(hx + 2, eyeY, 2, 1, darker(skin, 28)));
  parts.push(px(hx + 6, eyeY, 2, 1, darker(skin, 28)));
  if (t.eyes === 'wide') {
    parts.push(px(hx + 2, eyeY, 2, 2, P.eyeWhite));
    parts.push(px(hx + 6, eyeY, 2, 2, P.eyeWhite));
    parts.push(px(hx + 3, eyeY, 1, 1, P.eyeBlack));
    parts.push(px(hx + 7, eyeY, 1, 1, P.eyeBlack));
    // eye glint (life)
    parts.push(px(hx + 2, eyeY, 1, 1, P.mudWhite));
    parts.push(px(hx + 6, eyeY, 1, 1, P.mudWhite));
  } else if (t.eyes === 'small') {
    parts.push(px(hx + 3, eyeY, 1, 1, P.eyeBlack));
    parts.push(px(hx + 7, eyeY, 1, 1, P.eyeBlack));
  } else {
    parts.push(px(hx + 2, eyeY + 1, 2, 1, P.eyeBlack));
    parts.push(px(hx + 6, eyeY + 1, 2, 1, P.eyeBlack));
  }

  // Nose — proper bridge + tip with two-tone shading
  parts.push(px(hx + 5, hy + 4, 1, 3, darker(skin, 12)));         // bridge shadow
  parts.push(px(hx + 4, hy + 6, 2, 2, darker(skin, 24)));         // nose body
  parts.push(px(hx + 4, hy + 7, 1, 1, darker(skin, 44)));         // nostril L
  parts.push(px(hx + 5, hy + 7, 1, 1, darker(skin, 44)));         // nostril R
  parts.push(px(hx + 6, hy + 6, 1, 1, lighter(skin, 8)));          // nose highlight

  // Mouth
  const mY = hy + 9;
  if (t.mouth === 'grunt') parts.push(px(hx + 3, mY, 4, 1, P.mudBlack));
  else if (t.mouth === 'yell') {
    parts.push(px(hx + 3, mY, 4, 2, P.mudBlack));
    if (t.teeth !== 'none') parts.push(px(hx + 4, mY, 2, 1, P.toothWhite));
  } else if (t.mouth === 'oh') {
    parts.push(px(hx + 4, mY, 2, 2, P.mudBlack));
    parts.push(px(hx + 4, mY, 1, 1, darker(skin, 40)));           // lip shadow
  } else {
    parts.push(px(hx + 3, mY + 1, 4, 1, P.mudBlack));
    parts.push(px(hx + 3, mY, 4, 1, darker(skin, 18)));           // upper lip shadow
  }

  if (t.teeth === 'one') parts.push(px(hx + 5, mY + 1, 1, 1, P.toothWhite));
  else if (t.teeth === 'some') {
    parts.push(px(hx + 4, mY + 1, 1, 1, P.toothWhite));
    parts.push(px(hx + 6, mY + 1, 1, 1, P.toothWhite));
  } else if (t.teeth === 'all') parts.push(px(hx + 3, mY + 1, 4, 1, P.toothWhite));

  const fp = t.facePaint;
  if (fp === 'red stripe') parts.push(px(hx + 1, hy + 6, hw - 2, 1, P.mudRed));
  else if (fp === 'ochre line') parts.push(px(hx, hy + 5, hw, 1, P.mudOchre));
  else if (fp === 'black dots') {
    parts.push(px(hx + 2, hy + 7, 1, 1, P.mudBlack));
    parts.push(px(hx + 5, hy + 7, 1, 1, P.mudBlack));
    parts.push(px(hx + 8, hy + 7, 1, 1, P.mudBlack));
  } else if (fp === 'white handprint') {
    parts.push(px(hx + 2, hy + 5, 1, 3, P.mudWhite));
    parts.push(px(hx + 3, hy + 5, 1, 4, P.mudWhite));
    parts.push(px(hx + 4, hy + 5, 1, 3, P.mudWhite));
  }
  return parts.join('');
}

// ---------- Hair (V2 polish — more strands, depth, texture) ----------
export function drawHair(t) {
  if (t.hairStyle === 'bald') return '';
  const [c, hi] = HAIR[t.hairColor];
  const dark = darker(c, 30);
  const hx = 7, hy = 8;
  const parts = [];
  if (t.hairStyle === 'wild') {
    // Full cap of hair
    parts.push(px(hx-1, hy-2, 12, 3, c));
    // Side flaps hanging down past ears
    parts.push(px(hx-2, hy-1, 2, 5, c));
    parts.push(px(hx+10, hy-1, 2, 5, c));
    // Extra sprigs poking up
    parts.push(px(hx+1, hy-3, 2, 1, c));
    parts.push(px(hx+4, hy-4, 1, 2, c));
    parts.push(px(hx+7, hy-3, 2, 1, c));
    parts.push(px(hx+9, hy-4, 1, 2, c));
    // Individual strands hanging past bottom of hair
    parts.push(px(hx+2, hy+1, 1, 1, c));
    parts.push(px(hx+8, hy+1, 1, 1, c));
    // Highlights and dark shading
    parts.push(px(hx+2, hy-2, 1, 1, hi));
    parts.push(px(hx+8, hy-2, 1, 1, hi));
    parts.push(px(hx+5, hy-1, 1, 1, hi));
    parts.push(px(hx, hy-1, 1, 3, dark));           // left side dark
    parts.push(px(hx+9, hy-1, 1, 3, dark));         // right side dark
  } else if (t.hairStyle === 'matted') {
    // Chunky matted clumps
    parts.push(px(hx-1, hy-1, 12, 3, c));
    parts.push(px(hx-1, hy+2, 1, 5, c));
    parts.push(px(hx+10, hy+2, 1, 5, c));
    // Central mat clumps
    parts.push(px(hx+1, hy-1, 2, 2, dark));
    parts.push(px(hx+5, hy, 2, 1, dark));
    parts.push(px(hx+7, hy-1, 2, 2, dark));
    // Highlights on mat tops
    parts.push(px(hx+2, hy-1, 1, 1, hi));
    parts.push(px(hx+6, hy, 1, 1, hi));
    parts.push(px(hx+8, hy-1, 1, 1, hi));
    // Longer strands hanging
    parts.push(px(hx-1, hy+7, 1, 1, c));
    parts.push(px(hx+10, hy+7, 1, 1, c));
  } else if (t.hairStyle === 'spiky') {
    // Base band
    parts.push(px(hx-1, hy-1, 12, 1, c));
    // Alternating tall + short spikes for texture
    parts.push(px(hx-1, hy-3, 1, 2, c));
    parts.push(px(hx+1, hy-4, 1, 3, c));           // tall
    parts.push(px(hx+3, hy-3, 1, 2, c));
    parts.push(px(hx+5, hy-4, 1, 3, c));           // tall
    parts.push(px(hx+7, hy-3, 1, 2, c));
    parts.push(px(hx+9, hy-5, 1, 4, c));           // tallest
    // Highlights on spike tips
    parts.push(px(hx+1, hy-4, 1, 1, hi));
    parts.push(px(hx+5, hy-4, 1, 1, hi));
    parts.push(px(hx+9, hy-5, 1, 1, hi));
    // Dark shading between spikes
    parts.push(px(hx, hy-2, 1, 1, dark));
    parts.push(px(hx+2, hy-2, 1, 1, dark));
    parts.push(px(hx+8, hy-2, 1, 1, dark));
  } else if (t.hairStyle === 'tuft') {
    // Central tuft
    parts.push(px(hx+3, hy-3, 4, 3, c));
    parts.push(px(hx+2, hy-1, 6, 1, c));
    // Extra fringe
    parts.push(px(hx+4, hy-4, 2, 1, c));
    parts.push(px(hx+3, hy-2, 1, 1, dark));
    parts.push(px(hx+6, hy-2, 1, 1, dark));
    // Highlight
    parts.push(px(hx+4, hy-3, 1, 1, hi));
    parts.push(px(hx+5, hy-2, 1, 1, hi));
  } else if (t.hairStyle === 'mohawk') {
    // Taller wider mohawk
    parts.push(px(hx+4, hy-5, 2, 7, c));
    parts.push(px(hx+3, hy-4, 1, 2, c));
    parts.push(px(hx+6, hy-4, 1, 2, c));
    parts.push(px(hx+3, hy-2, 1, 1, c));
    parts.push(px(hx+6, hy-2, 1, 1, c));
    // Highlight ridge
    parts.push(px(hx+4, hy-4, 1, 4, hi));
    // Dark base
    parts.push(px(hx+5, hy-3, 1, 3, dark));
    parts.push(px(hx+4, hy+1, 2, 1, dark));
    // Sides of head are shaved (skin peeks through — no hair drawn there)
  }
  return parts.join('');
}

// ---------- Hats ----------
export function drawHat(t) {
  const h = t.hat;
  if (h === 'none') return '';
  const parts = [];
  if (h === 'leaf') {
    parts.push(px(9,6,6,2,P.leafGreen));
    parts.push(px(10,5,4,1,P.leafGreen));
    parts.push(px(11,4,2,1,P.leafGreen));
    parts.push(px(12,7,1,1,darker(P.leafGreen)));
  } else if (h === 'straw thatch') {
    parts.push(px(6,7,12,2,P.mudOchre));
    parts.push(px(7,5,10,2,P.mudOchre));
    parts.push(px(8,4,8,1,P.mudOchre));
    parts.push(px(9,5,1,1,darker(P.mudOchre)));
    parts.push(px(13,4,1,1,darker(P.mudOchre)));
  } else if (h === 'skull cap') {
    parts.push(px(7,7,10,2,P.bonePale));
    parts.push(px(8,5,8,2,P.bonePale));
    parts.push(px(9,6,2,1,P.mudBlack));
    parts.push(px(13,6,2,1,P.mudBlack));
  } else if (h === 'fur cap') {
    parts.push(px(6,7,12,2,P.furBrown));
    parts.push(px(7,4,10,3,P.furBrown));
    parts.push(px(8,3,8,1,P.furBrown));
    parts.push(px(9,4,1,1,darker(P.furBrown)));
    parts.push(px(13,5,1,1,darker(P.furBrown)));
  } else if (h === 'bone crown') {
    parts.push(px(6,8,12,1,P.bonePale));
    parts.push(px(6,7,12,1,P.bonePale));
    parts.push(px(7,5,1,2,P.bonePale));
    parts.push(px(10,4,1,3,P.bonePale));
    parts.push(px(13,4,1,3,P.bonePale));
    parts.push(px(16,5,1,2,P.bonePale));
  } else if (h === 'feather') {
    parts.push(px(7,7,10,1,P.stickBrown));
    parts.push(px(7,8,10,1,darker(P.stickBrown)));
    parts.push(px(11,2,1,6,P.hairRed));
    parts.push(px(10,3,1,3,P.hairRed));
    parts.push(px(12,3,1,3,P.hairRed));
    parts.push(px(11,3,1,1,lighter(P.hairRed, 30)));
  } else if (h === 'antlers') {
    parts.push(px(7,7,10,1,P.stickBrown));
    parts.push(px(7,8,10,1,darker(P.stickBrown)));
    parts.push(px(5,2,1,5,P.bonePale));
    parts.push(px(3,4,2,1,P.bonePale));
    parts.push(px(4,6,2,1,P.bonePale));
    parts.push(px(4,3,1,1,P.bonePale));
    parts.push(px(18,2,1,5,P.bonePale));
    parts.push(px(19,4,2,1,P.bonePale));
    parts.push(px(18,6,2,1,P.bonePale));
    parts.push(px(19,3,1,1,P.bonePale));
  } else if (h === 'mammoth tusk') {
    parts.push(px(7,8,10,1,P.stickBrown));
    parts.push(px(5,7,14,1,P.bonePale));
    parts.push(px(4,6,2,1,P.bonePale));
    parts.push(px(18,6,2,1,P.bonePale));
    parts.push(px(3,5,1,1,P.bonePale));
    parts.push(px(20,5,1,1,P.bonePale));
    parts.push(px(11,7,1,1,darker(P.bonePale)));
  } else if (h === 'golden crown') {
    parts.push(px(6,7,12,2,P.gold));
    parts.push(px(6,5,1,2,P.gold));
    parts.push(px(9,4,1,3,P.gold));
    parts.push(px(12,3,1,4,P.gold));
    parts.push(px(15,4,1,3,P.gold));
    parts.push(px(17,5,1,2,P.gold));
    parts.push(px(7,8,10,1,P.goldDark));
    parts.push(px(12,4,1,1,'#fff8d0'));
  }
  return parts.join('');
}

// ---------- Items ----------
export function drawItemAt(item, ax, ay) {
  const parts = [];
  if (item === 'club') {
    parts.push(px(ax-1,ay-8,2,10,P.stickBrown));
    parts.push(px(ax-2,ay-10,4,3,P.rockGrey));
    parts.push(px(ax-1,ay-9,1,1,darker(P.rockGrey)));
  } else if (item === 'rock') {
    parts.push(px(ax-2,ay-3,4,4,P.rockGrey));
    parts.push(px(ax-1,ay-3,1,1,darker(P.rockGrey)));
  } else if (item === 'bone') {
    parts.push(px(ax-1,ay-9,2,10,P.boneWhite));
    parts.push(px(ax-2,ay-10,4,2,P.boneWhite));
    parts.push(px(ax-2,ay-1,4,2,P.boneWhite));
  } else if (item === 'stick') {
    parts.push(px(ax,ay-11,1,12,P.stickBrown));
    parts.push(px(ax-1,ay-11,1,1,P.stickBrown));
    parts.push(px(ax+1,ay-11,1,1,P.stickBrown));
  } else if (item === 'torch') {
    parts.push(px(ax,ay-7,1,8,P.stickBrown));
    parts.push(px(ax-1,ay-11,3,4,P.fireGlow));
    parts.push(px(ax,ay-13,1,2,P.fireGlow));
    parts.push(px(ax-1,ay-9,1,1,'#fff8d0'));
    parts.push(px(ax+1,ay-9,1,1,P.fireGlowFaint));
  } else if (item === 'spear') {
    parts.push(px(ax,ay-9,1,10,P.stickBrown));
    parts.push(px(ax-1,ay-12,3,2,P.rockGrey));
    parts.push(px(ax,ay-13,1,1,P.rockGrey));
  } else if (item === 'berry basket') {
    parts.push(px(ax-2,ay-3,5,4,P.stickBrown));
    parts.push(px(ax-2,ay+0,5,1,darker(P.stickBrown)));
    parts.push(px(ax-1,ay-5,4,1,P.berryRed));
    parts.push(px(ax,ay-6,2,1,P.berryRed));
  } else if (item === 'fish') {
    parts.push(px(ax-2,ay-2,4,3,P.fishSilver));
    parts.push(px(ax+2,ay-3,1,5,P.fishSilver));
    parts.push(px(ax-1,ay-1,1,1,P.eyeBlack));
    parts.push(px(ax-2,ay,4,1,darker(P.fishSilver)));
  } else if (item === 'mammoth tooth') {
    parts.push(px(ax-2,ay-7,5,8,P.bonePale));
    parts.push(px(ax-2,ay+0,5,1,darker(P.bonePale)));
    parts.push(px(ax,ay-4,2,3,darker(P.bonePale)));
  } else if (item === 'pet rock') {
    parts.push(px(ax-2,ay-3,4,4,P.rockGrey));
    parts.push(px(ax-1,ay-2,1,1,P.eyeBlack));
    parts.push(px(ax+1,ay-2,1,1,P.eyeBlack));
    parts.push(px(ax-1,ay,3,1,P.mudBlack));
  } else if (item === 'drumstick') {
    parts.push(px(ax-2,ay-6,5,4,P.mudRed));
    parts.push(px(ax-2,ay-6,1,1,darker(P.mudRed)));
    parts.push(px(ax,ay-2,1,4,P.bonePale));
    parts.push(px(ax-1,ay+1,3,1,P.bonePale));
  } else if (item === 'shiny rock') {
    parts.push(px(ax-2,ay-3,4,4,P.gold));
    parts.push(px(ax-1,ay-3,1,1,'#fff8d0'));
    parts.push(px(ax+1,ay,1,1,P.goldDark));
    parts.push(px(ax-3,ay-5,1,1,P.gold));
    parts.push(px(ax+3,ay-5,1,1,P.gold));
  }
  return parts.join('');
}

function clothingFill(t) {
  const c = t.clothing;
  if (c === 'naked')          return { fill: SKIN[t.skin], notch: false };
  if (c === 'leaf wrap')      return { fill: P.leafGreen, notch: true };
  if (c === 'bone armor')     return { fill: P.bonePale, notch: false, ribs: true };
  if (c === 'tribal painted') return { fill: SKIN[t.skin], notch: false, paint: true };
  return { fill: PELT_COLOR[c] || P.furBrown, notch: true };
}

// Body silhouette rim — dark 1px outline around every body part so grug
// always pops off any background. Called BEFORE the body pixels are drawn.
function drawBodyRim(t) {
  const parts = [];
  const rim = P.bodyRim;
  const item = t.item && t.item !== 'none';

  // Head rim (around the 10-wide head at y=8..19, taper at bottom)
  // Left + right sides of head
  parts.push(px(6, 8, 1, 12, rim));    // left side of head (includes ear area)
  parts.push(px(17, 8, 1, 12, rim));   // right side of head
  parts.push(px(5, 12, 1, 3, rim));    // outside left ear
  parts.push(px(18, 12, 1, 3, rim));   // outside right ear
  parts.push(px(7, 7, 10, 1, rim));    // top of head (hair covers usually, safety)

  // Chin rim
  parts.push(px(8, 20, 1, 1, rim));
  parts.push(px(15, 20, 1, 1, rim));

  // Neck rim
  parts.push(px(10, 20, 1, 1, rim));
  parts.push(px(13, 20, 1, 1, rim));

  // Shoulder + torso rim
  parts.push(px(6, 21, 1, 1, rim));    // upper shoulder corner L
  parts.push(px(17, 21, 1, 1, rim));   // upper shoulder corner R
  parts.push(px(4, 22, 1, 1, rim));    // wide shoulder edge L
  parts.push(px(19, 22, 1, 1, rim));   // wide shoulder edge R
  parts.push(px(4, 23, 1, 4, rim));    // torso outer L
  parts.push(px(19, 23, 1, 4, rim));   // torso outer R

  // Leg rim
  parts.push(px(6, 27, 1, 2, rim));    // outer left leg
  parts.push(px(17, 27, 1, 2, rim));   // outer right leg
  parts.push(px(10, 27, 1, 2, rim));   // inner left leg / gap
  parts.push(px(13, 27, 1, 2, rim));   // inner right leg / gap

  // Foot rim
  parts.push(px(5, 29, 1, 2, rim));    // outer left foot
  parts.push(px(11, 29, 1, 2, rim));   // between feet (left of right foot)
  parts.push(px(12, 29, 1, 2, rim));   // between feet (right of left foot)
  parts.push(px(18, 29, 1, 2, rim));   // outer right foot

  // Arm rim
  parts.push(px(2, 23, 1, 5, rim));    // outer left arm
  if (item) {
    // Raised right arm rim
    parts.push(px(22, 21, 1, 4, rim));
    parts.push(px(19, 20, 3, 1, rim));   // above the raised knuckles
  } else {
    // Hanging right arm rim
    parts.push(px(21, 23, 1, 5, rim));
  }

  // Ground shadow underneath (part of the rim system)
  parts.push(px(4, 31, 16, 1, 'rgba(0,0,0,0.55)'));
  parts.push(px(5, 30, 14, 1, 'rgba(0,0,0,0.25)'));

  return parts.join('');
}

// ---------- Body (V2 polish — chest muscle, biceps, toes, rim outline) ----------
export function drawBody(t) {
  const legs = t.legs || 'bare';
  const parts = [];
  const skin = SKIN[t.skin];
  const skinShade = darker(skin);
  const skinDeep  = darker(skin, 48);
  const skinLight = lighter(skin, 12);
  const cf = clothingFill(t);

  // Rim outline FIRST so body pixels draw on top of it
  parts.push(drawBodyRim(t));

  // Neck
  parts.push(px(11, 20, 2, 1, skin));
  parts.push(px(11, 20, 1, 1, skinShade));
  parts.push(px(12, 20, 1, 1, skinShade));                          // neck shadow underside

  // Sloped shoulders — wider at top for a bulkier caveman silhouette
  parts.push(px(7, 21, 10, 1, skin));                               // upper shoulder line
  parts.push(px(5, 22, 14, 1, skin));                               // wide shoulder line
  parts.push(px(7, 21, 1, 1, skinShade));
  parts.push(px(16, 21, 1, 1, skinShade));
  parts.push(px(5, 22, 1, 1, skinShade));                           // outer shoulder shadow
  parts.push(px(18, 22, 1, 1, skinShade));

  // Torso (4 rows) with proper 3-tone shading
  parts.push(px(5, 23, 14, 4, cf.fill));
  parts.push(px(5, 23, 14, 1, lighter(cf.fill, 14)));               // top highlight
  parts.push(px(5, 23, 1, 4, lighter(cf.fill, 8)));                 // left highlight
  parts.push(px(18, 23, 1, 4, darker(cf.fill, 16)));                // right shadow
  parts.push(px(5, 26, 14, 1, darker(cf.fill, 8)));                 // bottom shadow

  // Chest muscle V-shading — subtle line down center + pec dividers
  if (cf.fill !== SKIN[t.skin] || cf.paint) {
    parts.push(px(11, 24, 2, 1, darker(cf.fill, 20)));              // sternum shadow
    parts.push(px(11, 25, 2, 1, darker(cf.fill, 14)));
    parts.push(px(8, 24, 1, 1, lighter(cf.fill, 10)));              // left pec highlight
    parts.push(px(15, 24, 1, 1, lighter(cf.fill, 10)));             // right pec highlight
  } else {
    // Naked chest — show pec definition in skin
    parts.push(px(11, 24, 2, 1, darker(skin, 24)));
    parts.push(px(8, 24, 1, 1, skinLight));
    parts.push(px(15, 24, 1, 1, skinLight));
  }

  if (cf.ribs) for (let y = 24; y <= 26; y += 2) parts.push(px(5, y, 14, 1, darker(cf.fill)));
  if (cf.paint) {
    parts.push(px(7, 24, 3, 1, P.clayRed));
    parts.push(px(13, 25, 4, 1, P.clayRed));
    parts.push(px(9, 26, 2, 1, P.mudWhite));
  }

  // Pelt hem + legs
  if (legs === 'loincloth') {
    if (cf.notch) {
      parts.push(px(5, 27, 4, 1, cf.fill));
      parts.push(px(15, 27, 4, 1, cf.fill));
    }
    parts.push(px(10, 27, 4, 3, cf.fill));
    parts.push(px(11, 30, 2, 1, cf.fill));
    parts.push(px(10, 27, 1, 3, lighter(cf.fill, 8)));
    parts.push(px(13, 27, 1, 3, darker(cf.fill, 12)));
    parts.push(px(7, 28, 3, 2, skin));
    parts.push(px(14, 28, 3, 2, skin));
    parts.push(px(7, 29, 1, 2, skinShade));
    parts.push(px(14, 29, 1, 2, skinShade));
    parts.push(px(6, 30, 4, 1, skin));
    parts.push(px(14, 30, 4, 1, skin));
    parts.push(px(6, 30, 1, 1, skinShade));
    parts.push(px(14, 30, 1, 1, skinShade));
  } else {
    if (cf.notch) {
      for (const [x, w] of [[5, 2], [8, 3], [12, 2], [15, 3]]) parts.push(px(x, 27, w, 1, cf.fill));
    }
    // Legs — bulkier caveman legs with knee shading
    parts.push(px(7, 27, 3, 2, skin));
    parts.push(px(14, 27, 3, 2, skin));
    parts.push(px(7, 28, 1, 1, skinShade));                         // left leg outer shadow
    parts.push(px(14, 28, 1, 1, skinShade));                        // right leg outer shadow
    parts.push(px(9, 27, 1, 1, skinShade));                         // left leg inner shadow
    parts.push(px(16, 27, 1, 1, skinShade));                        // right leg inner shadow
    parts.push(px(8, 28, 1, 1, skinLight));                         // knee highlight L
    parts.push(px(15, 28, 1, 1, skinLight));                        // knee highlight R
    // Feet — wider with toe definition
    parts.push(px(6, 29, 5, 1, skin));
    parts.push(px(13, 29, 5, 1, skin));
    parts.push(px(6, 30, 5, 1, skinDeep));                          // sole
    parts.push(px(13, 30, 5, 1, skinDeep));
    // Toe creases — small dark lines separating toes
    parts.push(px(7, 29, 1, 1, skinShade));
    parts.push(px(9, 29, 1, 1, skinShade));
    parts.push(px(14, 29, 1, 1, skinShade));
    parts.push(px(16, 29, 1, 1, skinShade));
    // Big toe hint (leftmost of each foot slightly lighter)
    parts.push(px(6, 29, 1, 1, skinLight));
    parts.push(px(13, 29, 1, 1, skinLight));
  }

  // Left arm — with bicep bulge
  parts.push(px(4, 22, 2, 1, skin));                                // shoulder cap
  parts.push(px(3, 23, 2, 2, skin));                                // bicep bulge
  parts.push(px(4, 25, 1, 3, skin));                                // forearm
  parts.push(px(3, 25, 2, 3, skin));                                // hand area
  parts.push(px(3, 23, 1, 2, lighter(skin, 8)));                    // bicep highlight
  parts.push(px(3, 25, 1, 3, skinShade));                           // forearm shadow
  parts.push(px(4, 27, 1, 1, skinDeep));                            // knuckle shadow
  parts.push(px(3, 28, 2, 1, skinDeep));                            // hand bottom

  // Right arm
  if (t.item !== 'none' && t.item) {
    // Raised arm holding item — bicep + forearm going up
    parts.push(px(18, 22, 2, 1, skin));                             // shoulder cap
    parts.push(px(19, 23, 2, 2, skin));                             // bicep raised
    parts.push(px(19, 23, 1, 2, lighter(skin, 8)));                 // bicep highlight
    parts.push(px(20, 21, 2, 2, skin));                             // forearm up
    parts.push(px(20, 21, 1, 2, lighter(skin, 8)));                 // forearm highlight
    // Fingers gripping item
    parts.push(px(20, 20, 2, 1, darker(skin, 12)));                 // knuckles
    parts.push(drawItemAt(t.item, 21, 21));
  } else {
    // Arm hanging with bicep bulge
    parts.push(px(18, 22, 2, 1, skin));                             // shoulder cap
    parts.push(px(19, 23, 2, 2, skin));                             // bicep
    parts.push(px(19, 25, 1, 3, skin));                             // forearm
    parts.push(px(19, 25, 2, 3, skin));                             // hand area
    parts.push(px(20, 23, 1, 2, lighter(skin, 8)));                 // bicep highlight
    parts.push(px(20, 25, 1, 3, skinShade));                        // forearm shadow
    parts.push(px(19, 27, 1, 1, skinDeep));
    parts.push(px(19, 28, 2, 1, skinDeep));                         // hand bottom
  }

  return parts.join('');
}

// ---------- Compose ----------
export function renderGrug(t, opts = {}) {
  const width = opts.width ?? 480;
  const height = opts.height ?? 640;
  const body = [
    drawBackground(t),
    drawBody(t),
    drawHead(t),
    drawHair(t),
    drawHat(t),
  ].join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W*SCALE} ${H*SCALE}" width="${width}" height="${height}" style="image-rendering:pixelated;display:block">${body}</svg>`;
}

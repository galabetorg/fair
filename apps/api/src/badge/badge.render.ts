export type BadgeState = 'active' | 'revoked' | 'pending' | 'unknown';

/**
 * Flat two-segment badge, shields style, no gradients. Text is outlined-safe system sans
 * because SVG badges cannot load web fonts.
 */
export function renderBadge(state: BadgeState, spec = 'GFS/1.0', notary = false): string {
  const label = 'provably fair';
  const value = state === 'active' ? `${spec} verified${notary ? ' + notary' : ''}` : state === 'pending' ? 'pending' : state === 'revoked' ? 'revoked' : 'not listed';
  const valueColor = state === 'active' ? '#F2B84B' : state === 'pending' ? '#7553FF' : '#5B5B67';
  const valueText = state === 'active' ? '#181225' : '#FFFFFF';
  const charW = 6.6;
  const lw = Math.round(label.length * charW + 20);
  const vw = Math.round(value.length * charW + 20);
  const w = lw + vw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="24" role="img" aria-label="${label}: ${value}">
<title>${label}: ${value}</title>
<rect width="${lw}" height="24" fill="#181225"/>
<rect x="${lw}" width="${vw}" height="24" fill="${valueColor}"/>
<rect width="${w}" height="24" fill="none" stroke="#30145F" stroke-width="1"/>
<g font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11" text-rendering="geometricPrecision">
<text x="${lw / 2}" y="16" fill="#FFFFFF" text-anchor="middle" font-weight="600">${label}</text>
<text x="${lw + vw / 2}" y="16" fill="${valueText}" text-anchor="middle" font-weight="700">${value}</text>
</g>
</svg>`;
}

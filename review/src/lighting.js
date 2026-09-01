// lighting.json consumer (issue #4) — reads the pipeline's estimate_lighting.py output.
// Contract (research/2026-08-21-lighting-estimate-spike.md): sun_position/azimuth are
// AUTHORITATIVE (validated); shadow_opacity is ADVISORY (n=1 anchor) — a default, never
// an override. This module is PURE: it loads the file and computes an application plan;
// the caller decides what to do with it (the rig's setLighting mutated the catcher's
// shared cfg — that coupling is deliberately gone).

export async function loadLighting(base, scene) {
  for (const name of [`${scene}.lighting.json`, `urban-grove-${scene}.lighting.json`]) {
    try {
      const r = await fetch(`${base}/${name}`);
      if (r.ok) { const j = await r.json(); j._file = name; return j; }
    } catch {}
  }
  return null;
}

// sunOverride: [x,y,z] from ?sun= (position override; still aimed at room_centre).
// opacityOverride: number from ?op= (wins over the advisory shadow_opacity).
export function lightingPlan(json, { sunOverride = null, opacityOverride = null } = {}) {
  const position = sunOverride ?? json.sun_position;
  const lookAt = json.room_centre ?? [0, 0, 0];
  return {
    position, lookAt,
    strength: opacityOverride ?? json.shadow_opacity,
    strengthIsOverride: opacityOverride != null,
    advisory: json.opacity_advisory !== false,
    file: json._file,
    azimuth: json.sun_azimuth_deg,
    elevation: json.sun_elevation_deg,
  };
}

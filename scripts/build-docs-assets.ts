/** Génère les PNG de docs/assets (bannière du README, aperçu pour les réseaux) à partir des SVG. */
import { readFileSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

for (const [name, width] of [["banner", 2560], ["banner.en", 2560], ["social-preview", 1280]] as const) {
  const svg = readFileSync(`docs/assets/${name}.svg`, "utf8");
  const png = new Resvg(svg, { fitTo: { mode: "width", value: width }, font: { loadSystemFonts: true } }).render().asPng();
  writeFileSync(`docs/assets/${name}.png`, png);
  console.log(`${name}.png`);
}

/** Génère les PNG de l'extension à partir des SVG de extension/icons/. */
import { readFileSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const dir = "extension/icons";
const sources = { small: readFileSync(`${dir}/icon-small.svg`, "utf8"), full: readFileSync(`${dir}/icon.svg`, "utf8") };
// Petites tailles : dessin simplifié ; grandes : dessin détaillé.
const sizes: [number, keyof typeof sources][] = [[16, "small"], [32, "small"], [48, "full"], [128, "full"]];

for (const [size, kind] of sizes) {
  const png = new Resvg(sources[kind], { fitTo: { mode: "width", value: size } }).render().asPng();
  writeFileSync(`${dir}/icon-${size}.png`, png);
  console.log(`icon-${size}.png`);
}

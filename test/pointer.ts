/**
 * Souris réelle (sans écran) : trajets de main et scripts xdotool.
 * Lancer avec : node test/pointer.ts
 */
import assert from "node:assert";
import { dragLines, humanPath, moveLines, pressLines, wheelLines, createPointer } from "../server/pointer.ts";

// Hasard reproductible : les propriétés doivent tenir pour toute graine.
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

for (let seed = 1; seed <= 200; seed++) {
  const rand = seeded(seed);
  const from = { x: Math.round(rand() * 1900), y: Math.round(rand() * 1060) };
  const to = { x: Math.round(rand() * 1900), y: Math.round(rand() * 1060) };
  const path = humanPath(from, to, rand);
  const dist = Math.hypot(to.x - from.x, to.y - from.y);

  assert.ok(path.length >= 2, `graine ${seed} : au moins deux points`);
  assert.deepStrictEqual({ x: path.at(-1)!.x, y: path.at(-1)!.y }, to, `graine ${seed} : le trajet finit sur la cible`);
  for (const s of path) {
    assert.ok(Number.isInteger(s.x) && Number.isInteger(s.y), `graine ${seed} : pixels entiers`);
    assert.ok(s.wait >= 1 && s.wait < 400, `graine ${seed} : pause plausible (${s.wait} ms)`);
  }
  const total = path.reduce((t, s) => t + s.wait, 0);
  if (dist > 50) {
    // Loi de Fitts : ni téléportation, ni lenteur d'escargot.
    assert.ok(total > 150 && total < 2500, `graine ${seed} : durée ${total} ms pour ${Math.round(dist)} px`);
    // Jamais une droite : au moins un point s'écarte du segment.
    const off = Math.max(...path.map((p) => Math.abs((to.x - from.x) * (from.y - p.y) - (from.x - p.x) * (to.y - from.y)) / dist));
    assert.ok(off >= 1, `graine ${seed} : le trajet décrit un arc`);
  }
  // Pas de saut : aucun pas ne dépasse une fraction du trajet.
  let prev = from;
  for (const s of path) {
    assert.ok(Math.hypot(s.x - prev.x, s.y - prev.y) <= Math.max(60, dist / 4), `graine ${seed} : pas trop grand`);
    prev = s;
  }
}

// Sur place : un mouvement quand même (la page doit voir le pointeur arriver).
const surPlace = humanPath({ x: 100, y: 100 }, { x: 100, y: 100 });
assert.strictEqual(surPlace.length, 2);
assert.deepStrictEqual({ x: surPlace[1].x, y: surPlace[1].y }, { x: 100, y: 100 });

// Scripts xdotool : seulement des commandes connues, des nombres, des touches de la liste.
const ok = /^(sleep \d+\.\d{3}|mousemove -?\d+ -?\d+|mousedown [123]|mouseup [123]|click [4-7]|key(down|up) (ctrl|alt|shift|super))$/;
const lignes = [
  ...moveLines(humanPath({ x: 0, y: 0 }, { x: 800, y: 600 }, seeded(7))),
  ...pressLines("left", 2, ["ctrl"], seeded(8)),
  ...pressLines("right", 1, [], seeded(9)),
  ...wheelLines("down", 3, seeded(10)),
  ...dragLines([{ x: 10, y: 10 }, { x: 200, y: 40 }, { x: 260, y: 300 }], ["shift"], seeded(11)),
];
for (const l of lignes) assert.match(l, ok);
assert.deepStrictEqual(pressLines("left", 2, [], seeded(3)).filter((l) => !l.startsWith("sleep")), ["mousedown 1", "mouseup 1", "mousedown 1", "mouseup 1"]);
assert.deepStrictEqual(pressLines("left", 1, ["ctrl", "shift"], seeded(3)).filter((l) => l.startsWith("key")), ["keydown ctrl", "keydown shift", "keyup shift", "keyup ctrl"]);
assert.strictEqual(wheelLines("up", 4, seeded(4)).filter((l) => l === "click 4").length, 4);
const glisser = dragLines([{ x: 0, y: 0 }, { x: 70, y: 0 }], [], seeded(5));
assert.strictEqual(glisser.filter((l) => l === "mousedown 1").length, 1);
assert.strictEqual(glisser.at(-1), "mouseup 1");
assert.strictEqual(glisser.filter((l) => l.startsWith("mousemove")).at(-1), "mousemove 70 0");

// Demandes refusées avant tout geste (coordonnées, touches, bouton, action).
const pointer = createPointer({ display: ":99" });
for (const bad of [
  { action: "move", x: "1; rm -rf /", y: 3 },
  { action: "move", x: 1e9, y: 3 },
  { action: "press", button: "left; reboot" },
  { action: "press", keys: ["ctrl", "Return"] },
  { action: "wheel", direction: "sideways" },
  { action: "drag", points: [[1, 2]] },
  { action: "teleport" },
]) {
  await assert.rejects(pointer.run(bad), `refusé : ${JSON.stringify(bad)}`);
}
if (process.platform !== "linux") assert.deepStrictEqual((await pointer.status()).ok, false);

console.log("souris réelle : ok");

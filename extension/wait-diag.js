/**
 * Diagnostics d'attente et inventaire d'images (wait_for, save_image, read_page).
 * JavaScript simple, sans dépendance : service worker (importScripts) et tests Node.
 * Ne touche jamais au DOM : travaille sur des inventaires simples
 * [{ tag, w, h, srcType, src, loaded }].
 */
const MIN_IMAGE_AREA = 6400; // 80x80 : seuil de la "plus grande image" (save_image).

/** Signature stable d'une image pour détecter les nouveautés. */
function imageSignature(img) {
  const src = String(img.src ?? "").slice(0, 40);
  return `${img.tag}|${img.w}x${img.h}|${img.srcType}|${src}`;
}

/** Images substantielles apparues depuis la référence (page de génération...). */
function newSubstantialSince(baselineSigs, current, minArea = MIN_IMAGE_AREA) {
  const before = new Set(baselineSigs);
  return current.filter((img) => img.w * img.h >= minArea && !before.has(imageSignature(img)));
}

/** Plus grande image substantielle, ou null (mode attente de save_image). */
function largestUsable(images, minArea = MIN_IMAGE_AREA) {
  let best = null;
  for (const img of images) {
    if (img.w * img.h >= minArea && (!best || img.w * img.h > best.w * best.h)) best = img;
  }
  return best;
}

/** "3 images visibles : 1 blob (1024×559), 1 http (300×250), 1 canvas (800×600)". */
function describeImages(images) {
  if (!images.length) return "aucune image visible à l'écran";
  const kinds = {};
  for (const img of images) {
    const key = `${img.srcType} (${img.w}×${img.h})`;
    kinds[key] = (kinds[key] ?? 0) + 1;
  }
  const parts = Object.entries(kinds).map(([k, n]) => (n > 1 ? `${n} ${k}` : k));
  const total = images.length;
  return `${total} image${total > 1 ? "s" : ""} visible${total > 1 ? "s" : ""} : ${parts.join(", ")}`;
}

/**
 * Conseils au timeout, à partir de ce qui a été OBSERVÉ pendant l'attente
 * (pas de devinette). hadNetworkQuiet / hadDomSettled : la condition a-t-elle
 * été vraie au moins une fois ? textGrew : le texte a-t-il bougé ?
 */
function diagnoseTimeout({ failed, hadNetworkQuiet, hadDomSettled, selector, images, spinnerSample, textGrew }) {
  const hints = [];
  if (failed.includes("networkIdle") && !hadNetworkQuiet) {
    hints.push("le réseau ne s'est jamais tu (polling, streaming ?) : relancez sans networkIdle, avec la seule condition utile");
  }
  if (failed.includes("domSettled") && !hadDomSettled) {
    hints.push("le DOM n'a jamais été stable : augmentez le timeout ou retirez domSettled");
  }
  if (failed.includes("selector") && images.length) {
    hints.push(`${describeImages(images)} mais sélecteur absent : lisez la page (section Images à l'écran) ou utilisez image:true`);
  }
  if (failed.includes("selector") && !images.length) {
    hints.push("aucune image et sélecteur absent : la génération n'a peut-être pas démarré (vérifiez le prompt / le bouton)");
  }
  if (failed.includes("textGone") && spinnerSample) {
    hints.push(`indicateur encore visible (« ${spinnerSample} ») : la génération continue, augmentez le timeout`);
  }
  if (failed.includes("textGone") && !spinnerSample) {
    hints.push("plus d'indicateur visible : vérifiez que le libellé textGone est exact (lisez la page)");
  }
  if (failed.includes("image") && !images.length) {
    hints.push("aucune image apparue : la génération n'a peut-être pas démarré");
  }
  if (textGrew) {
    hints.push("le texte de la page a bougé pendant l'attente : quelque chose se passe, insistez sur la bonne condition");
  }
  return hints;
}

globalThis.AbcWaitDiag = {
  MIN_IMAGE_AREA,
  imageSignature,
  newSubstantialSince,
  largestUsable,
  describeImages,
  diagnoseTimeout,
};
